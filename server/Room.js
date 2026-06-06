// 房间/对局状态机：等待(lobby) -> 进行(playing) -> 结算(ended)。
// 角色分配：第一个进房者为搜寻者，其余为隐藏者 (GDD：1 搜寻者 vs 3-5 隐藏者)。
import { CONFIG } from './config.js';
import { Game } from './Game.js';
import { S2C, ROLE } from './protocol.js';

export class Room {
  constructor() {
    this.players = new Map();   // playerId -> { id, name, ws, role, ready }
    this.state = 'lobby';
    this.game = null;
    this.loop = null;
    this.pendingDevCfg = null;  // 最近一次 dev_config，开局时自动套用
  }

  get seeker() { return [...this.players.values()].find(p => p.role === ROLE.SEEKER); }
  get hiders() { return [...this.players.values()].filter(p => p.role === ROLE.HIDER); }

  addPlayer(player) {
    // 上一局已结束时，新玩家进入自动把房间重置回大厅，避免卡在 ended 状态无法开始
    if (this.state === 'ended') this._resetToLobby();
    // 没有搜寻者则该玩家成为搜寻者，否则为隐藏者
    player.role = this.seeker ? ROLE.HIDER : ROLE.SEEKER;
    player.ready = false;
    this.players.set(player.id, player);
    this.send(player, { type: S2C.WELCOME, playerId: player.id, role: player.role });
    this.broadcastLobby();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    // 搜寻者掉线则结束对局
    if (this.state === 'playing' && p.role === ROLE.SEEKER) {
      this.endGame(ROLE.HIDER, '搜寻者离开了');
    } else if (this.state === 'playing' && p.role === ROLE.HIDER && this.game) {
      // 隐藏者掉线视为其蚂蚁被移除
      const ant = this.game.ants.find(a => a.playerId === id);
      if (ant) ant.marked = true;
      this.game._checkWin();
    }
    // 房间空了则彻底重置，避免下次进来卡在残留状态
    if (this.players.size === 0) { this._resetToLobby(); return; }
    // 大厅中搜寻者离开 -> 提升一名剩余玩家为搜寻者
    if (this.state === 'lobby' && !this.seeker) {
      const first = [...this.players.values()][0];
      if (first) first.role = ROLE.SEEKER;
    }
    this.broadcastLobby();
  }

  // 把房间重置回大厅状态（清理对局循环、游戏实例与准备标记）
  _resetToLobby() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    this.game = null;
    this.state = 'lobby';
    for (const p of this.players.values()) p.ready = false;
  }

  setReady(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.ready = true;
    this.broadcastLobby();
    // 搜寻者与所有在场隐藏者都准备好才开始 (隐藏者不足时用 bot 占位)
    const allHidersReady = this.hiders.every(h => h.ready);
    if (this.state === 'lobby' && this.seeker && this.seeker.ready && allHidersReady) {
      this.startGame();
    }
  }

  canStart() { return !!this.seeker; }

  broadcastLobby() {
    const players = [...this.players.values()].map(p => ({ id: p.id, name: p.name, role: p.role, ready: p.ready }));
    this.broadcast({ type: S2C.LOBBY, players, canStart: this.canStart(), state: this.state });
  }

  startGame() {
    // 组装隐藏者列表，不足 MIN_HIDERS 用 bot 占位
    let hiders = this.hiders.map(p => ({ id: p.id, bot: false }));
    let botIdx = 0;
    while (hiders.length < CONFIG.MIN_HIDERS) hiders.push({ id: `bot_${botIdx++}`, bot: true });
    if (this.hiders.length === 0) {
      // 单人(仅搜寻者)测试：补 2 个 bot 隐藏者制造目标
      while (hiders.length < 2) hiders.push({ id: `bot_${botIdx++}`, bot: true });
    }
    this._beginPlaying(hiders);
  }

  // 单机调试：指定角色立即开局（仅房间只有自己时可用）
  startSolo(playerId, role) {
    if (this.state === 'playing') return;
    const p = this.players.get(playerId);
    if (!p || this.players.size !== 1) return;
    if (this.state === 'ended') this._resetToLobby();

    p.role = role === ROLE.HIDER ? ROLE.HIDER : ROLE.SEEKER;
    p.ready = true;

    let hiders;
    let botIdx = 0;
    if (p.role === ROLE.SEEKER) {
      hiders = [];
      while (hiders.length < Math.max(CONFIG.MIN_HIDERS, 2)) {
        hiders.push({ id: `bot_${botIdx++}`, bot: true });
      }
    } else {
      hiders = [{ id: p.id, bot: false }];
      while (hiders.length < CONFIG.MIN_HIDERS) {
        hiders.push({ id: `bot_${botIdx++}`, bot: true });
      }
    }
    this._beginPlaying(hiders);
  }

  // 启动对局循环并通知各玩家
  _beginPlaying(hiders) {
    this.state = 'playing';
    this.game = new Game(hiders);
    // 开局立即套用已缓存的调试参数，避免首帧仍用默认 AI 数量/速度
    if (this.pendingDevCfg) this.game.setDevConfig(this.pendingDevCfg);

    for (const p of this.players.values()) {
      const ant = p.role === ROLE.HIDER ? this.game.ants.find(a => a.playerId === p.id) : null;
      this.send(p, {
        type: S2C.START,
        role: p.role,
        world: { w: CONFIG.WORLD_W, h: CONFIG.WORLD_H, viewRatio: CONFIG.SEEKER_VIEW_RATIO, tools: CONFIG.TOOLS },
        antId: ant ? ant.id : null,
      });
    }

    const dt = 1 / CONFIG.TICK_RATE;
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(dt), 1000 / CONFIG.TICK_RATE);
  }

  tick(dt) {
    if (!this.game) return;
    this.game.update(dt);
    const events = this.game.drainEvents();

    for (const p of this.players.values()) {
      const snap = this.game.snapshot(p.role, p.id);
      this.send(p, { type: S2C.SNAPSHOT, snap, events });
    }

    if (this.game.over) {
      this.endGame(this.game.winner, this.game.reason);
    }
  }

  endGame(winner, reason) {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    this.state = 'ended';
    this.broadcast({ type: S2C.END, winner, reason, score: this.game ? this.game.score : 0, quota: this.game ? this.game.quota : 0 });
  }

  restart() {
    this._resetToLobby();
    this.broadcastLobby();
  }

  // ---------- 输入路由 ----------
  handle(id, msg) {
    const p = this.players.get(id);
    if (!p) return;
    const g = this.game;
    switch (msg.type) {
      case 'ready': this.setReady(id); break;
      case 'solo_start':
        if (this.state === 'lobby' || this.state === 'ended') this.startSolo(id, msg.role);
        break;
      case 'restart': if (this.state === 'ended') this.restart(); break;
      case 'move': if (g && p.role === ROLE.HIDER) g.setHiderMove(id, msg.dx || 0, msg.dy || 0); break;
      case 'pickup': if (g && p.role === ROLE.HIDER) g.setHiderPickup(id, !!msg.active); break;
      case 'mark': if (g && p.role === ROLE.SEEKER) g.markAnt(msg.antId); break;
      case 'use_tool': if (g && p.role === ROLE.SEEKER) g.useTool(msg.tool, msg.x, msg.y); break;
      case 'dev_config': {
        this.pendingDevCfg = msg;
        // #region agent log
        fetch('http://127.0.0.1:7839/ingest/a610e76a-a66c-4ae5-8774-a8686212ae81',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9db26e'},body:JSON.stringify({sessionId:'9db26e',location:'Room.js:dev_config',message:'server dev_config received',data:{hasGame:!!g,state:this.state,AI_SPEED_BASE:msg.AI_SPEED_BASE,AI_ANT_COUNT:msg.AI_ANT_COUNT,cached:true},timestamp:Date.now(),hypothesisId:'H2',runId:'post-fix'})}).catch(()=>{});
        // #endregion
        if (g) g.setDevConfig(msg);
        break;
      }
    }
  }

  send(p, obj) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}
