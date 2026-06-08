// 房间状态机：等待(lobby) -> 进行(playing) -> 结算(ended)。
import { CONFIG } from './config.js';
import { Game } from './Game.js';
import { getGlobalDevConfig, stripDevConfigMsg } from './globalDevConfig.js';
import { S2C, ROLE } from './protocol.js';

export class Room {
  /**
   * @param {object} opts
   * @param {string} opts.id       - 房间唯一 ID
   * @param {string} opts.name     - 房间显示名称
   * @param {boolean} [opts.isPrivate] - 是否私有（单机调试）
   * @param {Function} [opts.onChange] - 状态变化回调，通知 manager 刷新列表
   */
  constructor({ id, name, isPrivate = false, onChange = null }) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.onChange = onChange;

    this.players = new Map();   // playerId -> { id, name, ws, role, ready }
    this.hostId = null;
    this.state = 'lobby';
    this.game = null;
    this.loop = null;
    this.matchDurationMin = CONFIG.MATCH_DURATION / 60; // 对局时长 (分钟)，房主可改
  }

  get seeker() { return [...this.players.values()].find(p => p.role === ROLE.SEEKER); }
  get hiders() { return [...this.players.values()].filter(p => p.role === ROLE.HIDER); }

  /** 进入房间人数 */
  get count() { return this.players.size; }

  /** 摘要信息，供 manager 推送 room_list 使用 */
  summary() {
    const host = this.players.get(this.hostId);
    return {
      id: this.id,
      name: this.name,
      count: this.count,
      state: this.state,
      hostName: host ? host.name : '',
      matchMinutes: this.matchDurationMin,
    };
  }

  addPlayer(player) {
    if (this.state === 'ended') this._resetToLobby();

    // 默认角色：无搜寻者则为搜寻者，否则为隐藏者
    player.role = this.seeker ? ROLE.HIDER : ROLE.SEEKER;
    player.ready = false;
    this.players.set(player.id, player);

    // 第一个进房者成为房主
    if (!this.hostId) this.hostId = player.id;

    const cs = this.canStart();
    this.send(player, {
      type: S2C.WELCOME,
      playerId: player.id,
      role: player.role,
      roomId: this.id,
      roomName: this.name,
      hostId: this.hostId,
    });
    this.broadcastLobby();
    this.onChange?.();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);

    if (this.state === 'playing' && p.role === ROLE.SEEKER) {
      this.endGame(ROLE.HIDER, '搜寻者离开了');
    } else if (this.state === 'playing' && p.role === ROLE.HIDER && this.game) {
      const ant = this.game.ants.find(a => a.playerId === id);
      if (ant) ant.eliminated = true;
      this.game._checkWin();
    }

    if (this.players.size === 0) {
      this._resetToLobby();
      this.onChange?.();
      return;
    }

    // 房主离开则转交给剩余首位玩家
    if (this.hostId === id) {
      this.hostId = [...this.players.keys()][0];
    }

    // 大厅中搜寻者离开 -> 提升首位剩余玩家
    if (this.state === 'lobby' && !this.seeker) {
      const first = [...this.players.values()][0];
      if (first) first.role = ROLE.SEEKER;
    }

    this.broadcastLobby();
    this.onChange?.();
  }

  /** 切换玩家角色（大厅期间自由切换，不自动校验） */
  switchRole(id, role) {
    if (this.state !== 'lobby') return;
    const p = this.players.get(id);
    if (!p) return;
    if (role !== ROLE.SEEKER && role !== ROLE.HIDER) return;
    if (role === ROLE.HIDER && p.role !== ROLE.HIDER && this.hiders.length >= CONFIG.MAX_HIDERS) return;
    p.role = role;
    p.ready = false; // 切换角色后重置准备
    this.broadcastLobby();
  }

  /** 房主设置对局时长（分钟，1~10）；变更后所有人需重新准备 */
  setMatchDuration(id, minutes) {
    if (this.state !== 'lobby' || id !== this.hostId) return;
    this.matchDurationMin = CONFIG.matchDurationSeconds(minutes) / 60;
    for (const p of this.players.values()) p.ready = false;
    this.broadcastLobby();
  }

  /** 切换准备状态（已准备再点则取消） */
  toggleReady(id) {
    const p = this.players.get(id);
    if (!p || this.state !== 'lobby') return;
    p.ready = !p.ready;
    this.broadcastLobby();
  }

  /**
   * 校验是否满足开局条件。
   * @returns {{ ok: boolean, reason: string }}
   */
  canStart() {
    const seekers = [...this.players.values()].filter(p => p.role === ROLE.SEEKER);
    const hiders = this.hiders;
    if (seekers.length !== 1) return { ok: false, reason: '需要恰好 1 名搜寻者' };
    if (hiders.length < 1) return { ok: false, reason: '至少需要 1 名隐藏者' };
    if (hiders.length > CONFIG.MAX_HIDERS) return { ok: false, reason: `隐藏者最多 ${CONFIG.MAX_HIDERS} 人` };
    const notReady = [...this.players.values()].filter(p => !p.ready);
    if (notReady.length > 0) return { ok: false, reason: '还有玩家未准备' };
    return { ok: true, reason: '' };
  }

  /**
   * 房主触发开局。
   * @param {string} id - 发起者 playerId，必须是 hostId
   */
  startGame(id) {
    if (id !== this.hostId) return;
    if (this.state !== 'lobby') return;
    const cs = this.canStart();
    if (!cs.ok) return;

    let hiders = this.hiders.map(p => ({ id: p.id, bot: false, name: p.name }));
    let botIdx = 0;
    while (hiders.length < CONFIG.MIN_HIDERS) hiders.push({ id: `bot_${botIdx++}`, bot: true });
    this._beginPlaying(hiders);
  }

  /** 单机调试：指定角色立即开局（仅自己一人） */
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
      while (hiders.length < Math.max(CONFIG.MIN_HIDERS, 2)) hiders.push({ id: `bot_${botIdx++}`, bot: true });
    } else {
      hiders = [{ id: p.id, bot: false, name: p.name }];
      while (hiders.length < CONFIG.MIN_HIDERS) hiders.push({ id: `bot_${botIdx++}`, bot: true });
    }
    this._beginPlaying(hiders, { debugMode: true });
  }

  _resetToLobby() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    this.game = null;
    this.state = 'lobby';
    for (const p of this.players.values()) p.ready = false;
  }

  /** 下发客户端工具配置，合并全局/运行时 devCfg 覆盖 */
  _toolsForClient(game) {
    const tools = JSON.parse(JSON.stringify(CONFIG.TOOLS));
    const cfg = game?.devCfg;
    if (cfg?.TOOL_CD) {
      for (const [k, cd] of Object.entries(cfg.TOOL_CD)) {
        if (tools[k]) tools[k].cd = cd;
      }
    }
    if (cfg?.BEAM_SPEED !== undefined) {
      if (tools.panic) tools.panic.beamSpeed = cfg.BEAM_SPEED;
      if (tools.sniff) tools.sniff.beamSpeed = cfg.BEAM_SPEED;
    }
    if (cfg?.SNIFF_RADIUS !== undefined && tools.sniff) {
      tools.sniff.radius = cfg.SNIFF_RADIUS;
    }
    return tools;
  }

  /** 全局调参热更新：进行中对局立即 setDevConfig，并同步客户端工具展示 */
  applyGlobalDevConfig(msg) {
    const params = stripDevConfigMsg(msg);
    if (this.game) {
      this.game.setDevConfig(params);
      this._broadcastDevTools();
    }
  }

  /** 调参变更后推送工具 CD / 光束速度等给本房间玩家（含 3000 联机） */
  _broadcastDevTools() {
    if (!this.game || this.state !== 'playing') return;
    const payload = {
      type: S2C.DEV_TOOLS,
      tools: this._toolsForClient(this.game),
      noToolCd: this.game.noToolCd,
    };
    for (const p of this.players.values()) this.send(p, payload);
  }

  _beginPlaying(hiders, opts = {}) {
    this.state = 'playing';
    const matchDuration = CONFIG.matchDurationSeconds(this.matchDurationMin);
    const globalCfg = getGlobalDevConfig();
    const noToolCd = globalCfg?.DEBUG_NO_CD !== undefined
      ? !!globalCfg.DEBUG_NO_CD
      : !!opts.noToolCd;
    this.game = new Game(hiders, { ...opts, matchDuration, noToolCd });
    if (globalCfg) this.game.setDevConfig(globalCfg);

    for (const p of this.players.values()) {
      const ant = p.role === ROLE.HIDER ? this.game.ants.find(a => a.playerId === p.id) : null;
      this.send(p, {
        type: S2C.START,
        role: p.role,
        world: {
          w: CONFIG.WORLD_W,
          h: CONFIG.WORLD_H,
          viewRatio: CONFIG.SEEKER_VIEW_RATIO,
          hiderViewWidth: CONFIG.HIDER_VIEW_WIDTH,
          hiderViewHeight: CONFIG.HIDER_VIEW_HEIGHT,
          tools: this._toolsForClient(this.game),
          debugMode: !!opts.debugMode,
          noToolCd: !!opts.noToolCd,
          matchDuration,
          hidingSpots: this.game.hidingSpots.map((s) => ({
            x: Math.round(s.x),
            y: Math.round(s.y),
            radius: s.radius,
          })),
        },
        antId: ant ? ant.id : null,
      });
    }

    const dt = 1 / CONFIG.TICK_RATE;
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(dt), 1000 / CONFIG.TICK_RATE);
    this.onChange?.();
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
    const seeker = this.seeker;
    this.broadcast({
      type: S2C.END,
      winner,
      reason,
      hiderScores: this.game ? this.game._hiderScoreList() : [],
      hiderQuota: this.game ? this.game.hiderQuota : 0,
      seeker: seeker && this.game ? {
        name: seeker.name,
        markHits: this.game.markHits,
        markMisses: this.game.markMisses,
      } : null,
    });
    this.onChange?.();
  }

  restart() {
    this._resetToLobby();
    this.broadcastLobby();
    this.onChange?.();
  }

  broadcastLobby() {
    const cs = this.canStart();
    const players = [...this.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      isHost: p.id === this.hostId,
    }));
    this.broadcast({
      type: S2C.LOBBY,
      roomId: this.id,
      roomName: this.name,
      hostId: this.hostId,
      players,
      state: this.state,
      canStart: cs.ok,
      canStartReason: cs.reason,
      matchDurationMin: this.matchDurationMin,
    });
  }

  // ---------- 输入路由 ----------
  handle(id, msg) {
    const p = this.players.get(id);
    if (!p) return;
    const g = this.game;
    switch (msg.type) {
      case 'ready': this.toggleReady(id); break;
      case 'switch_role': if (this.state === 'lobby') this.switchRole(id, msg.role); break;
      case 'start_game': this.startGame(id); break;
      case 'set_match_duration': this.setMatchDuration(id, msg.minutes); break;
      case 'solo_start':
        if (this.state === 'lobby' || this.state === 'ended') this.startSolo(id, msg.role);
        break;
      case 'restart': if (this.state === 'ended') this.restart(); break;
      case 'move': if (g && p.role === ROLE.HIDER) g.setHiderMove(id, msg.dx || 0, msg.dy || 0); break;
      case 'sprint': if (g && p.role === ROLE.HIDER) g.setHiderSprint(id, !!msg.active); break;
      case 'mark': if (g && p.role === ROLE.SEEKER) g.markAnt(msg.antId); break;
      case 'tool_beam': if (g && p.role === ROLE.SEEKER) g.setToolBeam(msg.tool, msg.x, msg.y, !!msg.active); break;
      case 'place_fake_food': if (g && p.role === ROLE.SEEKER) g.placeFakeFood(msg.x, msg.y); break;
      case 'cursor': if (g && p.role === ROLE.SEEKER) g.setSeekerCursor(msg.x, msg.y); break;
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
