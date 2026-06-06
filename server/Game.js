// 核心模拟 (GDD 3.2 / 3.3 / 3.4 / 3.5)。权威服务器逻辑：蚂蚁、食物、信息素、工具、胜负判定。
import { CONFIG } from './config.js';
import { randomTraits, deriveHiderTraits } from './traits.js';
import { initAI, updateAI, triggerFlee } from './AntAI.js';
import { PheromoneField } from './Pheromone.js';
import { ROLE } from './protocol.js';

function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

export class Game {
  /** @param hiderPlayers 隐藏者描述数组：{ id, bot } */
  constructor(hiderPlayers) {
    this.now = 0;
    this.timeLeft = CONFIG.MATCH_DURATION;
    this.ants = [];
    this._nextAntId = 0;  // 全局自增 ID，避免 _adjustAntCount 增量时 ID 重复
    this.foodSources = [];   // 可枯竭食物堆，替代原 normalFood
    this.markedFood = [];
    this.nest = { x: CONFIG.WORLD_W * 0.5, y: 80 };
    this.tunnels = [];
    this.thickets = [];
    this.events = [];

    // 信息素场
    this.phero = new PheromoneField();
    this._pheroTickCount = 0; // 每 2 tick 才生成一次信息素快照以节省带宽

    // 工具状态
    this.globalCooldownUntil = 0;
    this.lockUntil = 0;
    this.frozenUntil = 0;
    this.effects = {};
    this.bait = null;
    this.trackedAntId = null;
    this.trackedUntil = 0;

    this.hiderCount = hiderPlayers.length;
    this.quota = CONFIG.foodQuota(this.hiderCount);
    this.score = 0;
    this.over = false;
    this.winner = null;
    this.reason = '';

    // 开发者工具：运行时 AI 参数覆盖（不影响 config.js 默认值）
    this.devCfg = {};

    this._buildWorld(hiderPlayers);
    this._foodTimer = CONFIG.FOOD_RESPAWN_INTERVAL;
    for (let i = 0; i < CONFIG.MARKED_FOOD_SLOTS; i++) this._spawnMarkedFood();
  }

  _buildWorld(hiderPlayers) {
    this.tunnels = [
      { id: 0, x: 240, y: 300, link: 1 },
      { id: 1, x: 1360, y: 900, link: 0 },
      { id: 2, x: 1360, y: 300, link: 3 },
      { id: 3, x: 240, y: 900, link: 2 },
    ];
    this.thickets = [
      { x: 800, y: 600, r: 130 },
      { x: 400, y: 800, r: 90 },
      { x: 1200, y: 450, r: 100 },
    ];

    // 可枯竭食物堆：分散在地图各处，远离巢穴
    this._spawnFoodSources(CONFIG.FOOD.count);

    // 生成 AI 蚂蚁
    for (let i = 0; i < CONFIG.AI_ANT_COUNT; i++) {
      this.ants.push(this._makeAnt(this._nextAntId++, false, null));
    }

    // 隐藏者附身
    for (const h of hiderPlayers) {
      const host = this.ants[Math.floor(Math.random() * this.ants.length)];
      const { traits, devDim } = deriveHiderTraits(host.traits);
      const ant = this._makeAnt(this._nextAntId++, true, h.id);
      ant.traits = traits;
      ant.devDim = devDim;
      ant.bot = !!h.bot;
      if (ant.bot) initAI(ant);
      ant.x = rand(100, CONFIG.WORLD_W - 100);
      ant.y = rand(200, CONFIG.WORLD_H - 100);
      this.ants.push(ant);
    }
  }

  /** 获取当前生效的食物堆容量（开发者工具可热改） */
  _foodCapacity() {
    return this.devCfg.FOOD_CAPACITY ?? CONFIG.FOOD.capacity;
  }

  /** 在地图上随机生成 n 个食物堆，保证距巢至少 200px */
  _spawnFoodSources(n) {
    const capacity = this._foodCapacity();
    const nestX = this.nest.x, nestY = this.nest.y;
    const target = this.foodSources.length + n;
    let nextId = this.foodSources.length;
    let attempts = 0;
    while (this.foodSources.length < target && attempts < 200) {
      attempts++;
      const x = rand(80, CONFIG.WORLD_W - 80);
      const y = rand(200, CONFIG.WORLD_H - 80);
      if ((x - nestX) ** 2 + (y - nestY) ** 2 < 200 * 200) continue;
      this.foodSources.push({ id: nextId++, x, y, amount: capacity, capacity, respawnAt: 0 });
    }
  }

  _makeAnt(id, isHider, playerId) {
    const ant = {
      id, isHider, playerId,
      x: rand(40, CONFIG.WORLD_W - 40),
      y: rand(160, CONFIG.WORLD_H - 40),
      angle: rand(-Math.PI, Math.PI),
      traits: randomTraits(),
      carrying: false,
      hasMarkedFood: false,
      marked: false,
      suspicious: 0,
      vx: 0, vy: 0,
      pickupActive: false,
      pickupProgress: 0,
      inTunnelUntil: 0,
    };
    if (!isHider) initAI(ant);
    return ant;
  }

  _spawnMarkedFood() {
    this.markedFood.push({
      id: Math.random().toString(36).slice(2, 8),
      x: rand(80, CONFIG.WORLD_W - 80),
      y: rand(200, CONFIG.WORLD_H - 80),
      carriedBy: null,
      dropUntil: 0,
    });
  }

  // ---------- 玩家输入 ----------
  setHiderMove(pid, dx, dy) {
    const ant = this.ants.find(a => a.playerId === pid);
    if (!ant || ant.marked) return;
    const len = Math.hypot(dx, dy) || 1;
    ant.vx = dx / len; ant.vy = dy / len;
    if (dx || dy) ant.angle = Math.atan2(dy, dx);
  }

  setHiderPickup(pid, active) {
    const ant = this.ants.find(a => a.playerId === pid);
    if (!ant || ant.marked) return;
    ant.pickupActive = active;
    if (!active) ant.pickupProgress = 0;
  }

  markAnt(antId) {
    if (this.over || this.now < this.lockUntil) return;
    const ant = this.ants.find(a => a.id === antId);
    if (!ant || ant.marked) return;
    if (ant.isHider) {
      ant.marked = true;
      ant.vx = ant.vy = 0;
      if (ant.hasMarkedFood) {
        ant.hasMarkedFood = false;
        this._dropFoodAt(ant.x, ant.y);
      }
      this.events.push({ t: 'mark_hit', x: ant.x, y: ant.y });
      this._checkWin();
    } else {
      this.lockUntil = this.now + CONFIG.MISMARK_PENALTY;
      this.events.push({ t: 'mark_miss', x: ant.x, y: ant.y, antId });
    }
  }

  useTool(tool, x, y) {
    if (this.over) return;
    const def = CONFIG.TOOLS[tool];
    if (!def) return;
    if (this.now < this.globalCooldownUntil || this.now < this.lockUntil) return;
    this.globalCooldownUntil = this.now + def.cd;

    switch (tool) {
      case 'panic':
        for (const a of this.ants) if (!a.isHider) triggerFlee(a, def.duration);
        this.effects.panic = this.now + def.duration;
        break;
      case 'freeze':
        this.frozenUntil = this.now + def.duration;
        break;
      case 'thermal':
        this.effects.thermal = this.now + def.duration;
        break;
      case 'magnify':
        this.effects.magnify = this.now + def.duration;
        break;
      case 'bait':
        this.bait = { x, y, until: this.now + def.duration };
        break;
      case 'track': {
        let best = null, bd = Infinity;
        for (const a of this.ants) {
          if (a.marked) continue;
          const d = dist2(a, { x, y });
          if (d < bd) { bd = d; best = a; }
        }
        if (best) { this.trackedAntId = best.id; this.trackedUntil = this.now + def.duration; }
        break;
      }
    }
    this.events.push({ t: 'tool', tool, x, y });
  }

  _dropFoodAt(x, y) {
    this.markedFood.push({
      id: Math.random().toString(36).slice(2, 8),
      x, y,
      carriedBy: null,
      dropUntil: this.now + CONFIG.FOOD_DROP_DESPAWN,
    });
  }

  // ---------- 主循环 ----------
  update(dt) {
    if (this.over) return;
    this.now += dt;
    this.timeLeft = Math.max(0, CONFIG.MATCH_DURATION - this.now);

    // 信息素蒸发（负反馈，每帧执行）
    this.phero.evaporate(dt);

    // 食物堆重生检查
    for (const s of this.foodSources) {
      if (s.amount <= 0 && s.respawnAt > 0 && this.now >= s.respawnAt) {
        s.capacity = this._foodCapacity();
        s.amount = s.capacity;
        s.x = rand(80, CONFIG.WORLD_W - 80);
        s.y = rand(200, CONFIG.WORLD_H - 80);
        s.respawnAt = 0;
      }
    }

    const world = {
      now: this.now,
      nest: this.nest,
      foodSources: this.foodSources,
      phero: this.phero,
      frozenUntil: this.frozenUntil,
      cfg: this.devCfg,
    };

    // 更新 AI 蚂蚁
    for (const ant of this.ants) {
      if (ant.marked) continue;
      if (ant.isHider && !ant.bot) {
        this._updateHider(ant, dt);
      } else {
        updateAI(ant, dt, world);
        // 食物堆枯竭时设置重生倒计时
        for (const s of this.foodSources) {
          if (s.amount <= 0 && s.respawnAt === 0) {
            s.respawnAt = this.now + CONFIG.FOOD.respawnDelay;
          }
        }
      }
    }

    // 标记食物刷新
    this._foodTimer -= dt;
    if (this._foodTimer <= 0) {
      this._foodTimer = CONFIG.FOOD_RESPAWN_INTERVAL;
      const avail = this.markedFood.filter(f => !f.carriedBy && !f.dropUntil).length;
      if (avail < CONFIG.MARKED_FOOD_SLOTS) this._spawnMarkedFood();
    }
    this.markedFood = this.markedFood.filter(f => !(f.dropUntil && this.now > f.dropUntil));

    if (this.timeLeft <= 0 && !this.over) {
      this.over = true;
      this.winner = ROLE.SEEKER;
      this.reason = '时间耗尽，搜寻者守住了蚁穴';
    }

    this._pheroTickCount++;
  }

  _updateHider(ant, dt) {
    if (this.frozenUntil > this.now) return;

    if (this.bait && this.now < this.bait.until) {
      if (dist2(ant, this.bait) < 60 * 60) ant.suspicious = this.now + 10;
    }

    const moving = ant.vx || ant.vy;
    if (ant.pickupActive && !moving && !ant.hasMarkedFood) {
      const food = this._nearestMarkedFood(ant);
      if (food && dist2(ant, food) < 24 * 24) {
        ant.pickupProgress += dt;
        if (ant.pickupProgress >= CONFIG.FOOD_PICKUP_TIME) {
          food.carriedBy = ant.id;
          ant.hasMarkedFood = true;
          ant.pickupProgress = 0;
          this.events.push({ t: 'food_pickup', x: ant.x, y: ant.y });
        }
        return;
      } else {
        ant.pickupProgress = 0;
      }
    } else {
      ant.pickupProgress = 0;
    }

    const spd = CONFIG.HIDER_SPEED;
    ant.x += ant.vx * spd * dt;
    ant.y += ant.vy * spd * dt;
    ant.x = Math.max(20, Math.min(CONFIG.WORLD_W - 20, ant.x));
    ant.y = Math.max(20, Math.min(CONFIG.WORLD_H - 20, ant.y));

    if (ant.hasMarkedFood) {
      const f = this.markedFood.find(mf => mf.carriedBy === ant.id);
      if (f) { f.x = ant.x; f.y = ant.y; }
      if (dist2(ant, this.nest) < 36 * 36) {
        ant.hasMarkedFood = false;
        this.markedFood = this.markedFood.filter(mf => mf.carriedBy !== ant.id);
        this.score++;
        this.events.push({ t: 'score', score: this.score });
        if (this.score >= this.quota && !this.over) {
          this.over = true;
          this.winner = ROLE.HIDER;
          this.reason = '蚂蚁们达成了食物额度！';
        }
        this._spawnMarkedFood();
      }
    }
  }

  _nearestMarkedFood(ant) {
    let best = null, bd = Infinity;
    for (const f of this.markedFood) {
      if (f.carriedBy) continue;
      const d = dist2(ant, f);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  _checkWin() {
    const aliveHiders = this.ants.filter(a => a.isHider && !a.marked);
    if (aliveHiders.length === 0 && !this.over) {
      this.over = true;
      this.winner = ROLE.SEEKER;
      this.reason = '所有隐藏者已被标记！';
    }
  }

  // ---------- 快照 ----------
  snapshot(role, viewerPid) {
    const thermalOn = this.now < (this.effects.thermal || 0);
    const ants = this.ants.map(a => {
      const inThicket = this.thickets.some(t => dist2(a, t) < t.r * t.r);
      const hidden = role === ROLE.SEEKER && inThicket && !thermalOn;
      return {
        id: a.id,
        x: Math.round(a.x), y: Math.round(a.y),
        angle: +a.angle.toFixed(2),
        traits: a.traits,
        marked: a.marked,
        carrying: a.carrying,
        trail: a.isHider && a.hasMarkedFood,
        suspicious: this.now < a.suspicious,
        tracked: a.id === this.trackedAntId && this.now < this.trackedUntil,
        hidden,
        isSelf: role === ROLE.HIDER && a.playerId === viewerPid,
        pickup: role === ROLE.HIDER && a.playerId === viewerPid ? +a.pickupProgress.toFixed(2) : 0,
      };
    });

    const markedFood = role === ROLE.HIDER
      ? this.markedFood
          .filter(f => !f.carriedBy || this.ants.find(a => a.id === f.carriedBy)?.playerId === viewerPid)
          .map(f => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), drop: !!f.dropUntil }))
      : [];

    // 信息素快照：每 2 tick 重新计算一次（降低序列化开销）
    let pheroSnap = null;
    if (this._pheroTickCount % 2 === 0) {
      const raw = this.phero.coarse();
      // 将 Uint8Array 转成普通 Array 以便 JSON 序列化
      pheroSnap = {
        cols: raw.cols,
        rows: raw.rows,
        cell: raw.cell,
        toFood: Array.from(raw.toFood),
        toHome: Array.from(raw.toHome),
      };
    }

    const aiCount = this.ants.filter(a => !a.isHider).length;
    const hiderCount = this.ants.filter(a => a.isHider).length;

    return {
      now: +this.now.toFixed(2),
      timeLeft: Math.ceil(this.timeLeft),
      ants,
      antStats: { ai: aiCount, hider: hiderCount, total: aiCount + hiderCount },
      // 食物堆替代原 normalFood：包含位置与剩余量
      normalFood: this.foodSources.map(s => ({
        x: Math.round(s.x),
        y: Math.round(s.y),
        amount: s.amount,
        capacity: s.capacity,
      })),
      markedFood,
      nest: this.nest,
      tunnels: this.tunnels,
      thickets: this.thickets,
      bait: this.bait && this.now < this.bait.until ? { x: this.bait.x, y: this.bait.y } : null,
      score: this.score,
      quota: this.quota,
      phero: pheroSnap,  // null 时客户端复用上一帧缓存
      cooldownLeft: Math.max(0, +(this.globalCooldownUntil - this.now).toFixed(1)),
      lockLeft: Math.max(0, +(this.lockUntil - this.now).toFixed(1)),
      frozen: this.frozenUntil > this.now,
      thermal: thermalOn,
      magnify: this.now < (this.effects.magnify || 0),
      panic: this.now < (this.effects.panic || 0),
    };
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  /**
   * 动态调整食物堆数量，立即生效。
   * 增加时在随机位置生成新堆；减少时从末尾移除。
   */
  _adjustFoodCount(targetCount) {
    const clamped = Math.max(1, Math.min(20, Math.round(targetCount)));
    const current = this.foodSources.length;
    if (clamped > current) {
      this._spawnFoodSources(clamped - current);
    } else if (clamped < current) {
      this.foodSources = this.foodSources.slice(0, clamped);
    }
  }

  /**
   * 更新所有食物堆的容量上限；若当前剩余量超出新上限则截断。
   * 重生时也会使用新容量。
   */
  _setFoodCapacity(capacity) {
    const cap = Math.max(10, Math.min(200, Math.round(capacity)));
    this.devCfg.FOOD_CAPACITY = cap;
    for (const s of this.foodSources) {
      s.capacity = cap;
      if (s.amount > cap) s.amount = cap;
    }
  }

  /**
   * 更新开发者调试参数（运行时热修改 AI 行为，不重启对局）。
   * 所有参数下一帧即生效（speed/turn 逐帧读取；ant count 立即增删蚂蚁）。
   * 支持字段：AI_SPEED_BASE / AI_TURN_SMOOTH / AI_SOCIAL_CHANCE / AI_SPEED / AI_ANT_COUNT / FOOD_COUNT / FOOD_CAPACITY
   */
  setDevConfig(params) {
    if (params.AI_SPEED_BASE !== undefined) this.devCfg.AI_SPEED_BASE = +params.AI_SPEED_BASE;
    if (params.AI_TURN_SMOOTH !== undefined) this.devCfg.AI_TURN_SMOOTH = +params.AI_TURN_SMOOTH;
    if (params.AI_SOCIAL_CHANCE !== undefined) this.devCfg.AI_SOCIAL_CHANCE = +params.AI_SOCIAL_CHANCE;
    if (params.AI_SPEED) {
      this.devCfg.AI_SPEED = { ...CONFIG.AI_SPEED, ...this.devCfg.AI_SPEED, ...params.AI_SPEED };
    }
    if (params.AI_ANT_COUNT !== undefined) {
      this._adjustAntCount(Math.max(10, Math.min(200, Math.round(+params.AI_ANT_COUNT))));
    }
    if (params.FOOD_COUNT !== undefined) {
      this._adjustFoodCount(+params.FOOD_COUNT);
    }
    if (params.FOOD_CAPACITY !== undefined) {
      this._setFoodCapacity(+params.FOOD_CAPACITY);
    }
  }

  /**
   * 动态调整 AI 蚂蚁数量，立即生效。
   * 增加时从随机位置生成新蚂蚁；减少时从末尾移除非隐藏者蚂蚁。
   */
  _adjustAntCount(targetCount) {
    const aiAnts = this.ants.filter(a => !a.isHider);
    const current = aiAnts.length;
    if (targetCount === current) return;

    if (targetCount > current) {
      for (let i = 0; i < targetCount - current; i++) {
        this.ants.push(this._makeAnt(this._nextAntId++, false, null));
      }
    } else {
      let removed = 0;
      const toRemove = current - targetCount;
      // 从后往前移除 AI 蚂蚁（保留隐藏者）
      this.ants = this.ants.filter(a => {
        if (!a.isHider && removed < toRemove) { removed++; return false; }
        return true;
      });
    }
  }
}
