// 核心模拟 (GDD 3.2 / 3.3 / 3.4 / 3.5)。权威服务器逻辑：蚂蚁、食物、信息素、工具、胜负判定。
import { CONFIG } from './config.js';
import { randomTraits, deriveHiderTraits } from './traits.js';
import { initAI, updateAI, triggerFlee, depositTrail } from './AntAI.js';
import { PheromoneField } from './Pheromone.js';
import { ROLE } from './protocol.js';

function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

/** 将 pos 以 maxDist 为步长移向 target */
function moveToward(pos, target, maxDist) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxDist || dist === 0) {
    pos.x = target.x;
    pos.y = target.y;
    return;
  }
  pos.x += (dx / dist) * maxDist;
  pos.y += (dy / dist) * maxDist;
}

export class Game {
  /** @param hiderPlayers 隐藏者描述数组：{ id, bot } */
  /** @param opts.seekerIds 真人搜寻者 playerId 列表，每名搜寻者独立工具/冷却/光束 */
  /** @param opts.debugMode 单机调试对局 */
  /** @param opts.noToolCd 搜寻者工具无 CD（标记冷却仍生效） */
  /** @param opts.matchDuration 本局时长 (秒) */
  /** @param opts.hiderFoodQuota 每位隐藏者获胜所需食物数 */
  constructor(hiderPlayers, opts = {}) {
    this.now = 0;
    this.matchDuration = opts.matchDuration ?? CONFIG.MATCH_DURATION;
    this.timeLeft = this.matchDuration;
    this.ants = [];
    this._nextAntId = 0;  // 全局自增 ID，避免 _adjustAntCount 增量时 ID 重复
    this.foodSources = [];
    this.fakeFoods = [];       // 搜寻者放置的假食物，AI 不可见、不搬运、不释放信息素
    this._nextFakeFoodId = 0;
    this.nest = {
      x: CONFIG.WORLD_W * CONFIG.NEST.xRatio,
      y: CONFIG.WORLD_H * CONFIG.NEST.yRatio + (CONFIG.NEST.offsetY ?? 0),
    };
    this.hidingSpots = this._buildHidingSpots();
    this.events = [];

    // 信息素场
    this.phero = new PheromoneField();
    this._pheroTickCount = 0; // 每 2 tick 才生成一次信息素快照以节省带宽

    // 每名搜寻者独立的状态（工具 CD、标记 CD、光束、光标、统计）
    this.seekerStates = new Map();
    this.effects = {};

    this.hiderCount = hiderPlayers.length;
    this.hiderQuota = opts.hiderFoodQuota ?? CONFIG.HIDER_FOOD_QUOTA;
    this._botLabelSeq = 0;
    this.over = false;
    this.winner = null;
    this.reason = '';

    // 开发者工具：运行时 AI 参数覆盖（不影响 config.js 默认值）
    this.devCfg = {};
    this.debugMode = !!opts.debugMode;
    this.noToolCd = !!opts.noToolCd;

    this._buildWorld(hiderPlayers);
    for (const seekerId of opts.seekerIds ?? []) {
      const state = this._createSeekerState();
      this.seekerStates.set(seekerId, state);
      this._resetStartingToolCooldowns(state);
    }
  }

  /** 初始化单个搜寻者的运行时状态 */
  _createSeekerState() {
    return {
      toolCooldownUntil: {},
      _toolsUsed: false,
      markCooldownUntil: 0,
      markHits: 0,
      markMisses: 0,
      lightBeam: null,
      _lastLightBeamUntil: 0,
      sniffBeam: null,
      _lastSniffBeamUntil: 0,
      cursor: null,
    };
  }

  /** 读取某工具当前 CD 时长（秒），devCfg 可覆盖 config 默认值 */
  _toolCd(tool) {
    const override = this.devCfg.TOOL_CD?.[tool];
    if (override !== undefined) return override;
    return CONFIG.TOOLS[tool]?.cd ?? 0;
  }

  /** 开局或 dev 调参后、尚未使用任何工具时，将指定搜寻者所有工具置为统一开局 CD */
  _resetStartingToolCooldowns(state) {
    const startCd = CONFIG.TOOL_STARTING_CD ?? 5;
    for (const k of Object.keys(CONFIG.TOOLS)) {
      state.toolCooldownUntil[k] = this.noToolCd ? 0 : this.now + startCd;
    }
  }

  _buildWorld(hiderPlayers) {
    // 可枯竭食物堆：分散在地图各处，远离巢穴
    this._spawnFoodSources(CONFIG.FOOD.count, 'normal');
    this._spawnFoodSources(CONFIG.FOOD.RICH.count, 'rich');

    // 生成 AI 蚂蚁
    for (let i = 0; i < CONFIG.AI_ANT_COUNT; i++) {
      this.ants.push(this._makeAnt(this._nextAntId++, false, null));
    }

    // 隐藏者附身（每人分配不同标识色，仅隐藏者方可见）
    for (let i = 0; i < hiderPlayers.length; i++) {
      const h = hiderPlayers[i];
      const host = this.ants[Math.floor(Math.random() * this.ants.length)];
      const { traits, devDim } = deriveHiderTraits(host.traits);
      const ant = this._makeAnt(this._nextAntId++, true, h.id);
      ant.traits = traits;
      ant.hostTraits = { ...host.traits };
      ant.devDim = devDim;
      ant.bot = !!h.bot;
      ant.hiderColor = CONFIG.HIDER_COLORS[i % CONFIG.HIDER_COLORS.length];
      ant.hiderLabel = h.name || (h.bot ? `AI-${++this._botLabelSeq}` : '隐藏者');
      ant.foodScore = 0;
      ant.verified = false;
      ant.completeTime = null; // 达成食物配额时的对局用时（秒）
      if (ant.bot) initAI(ant);
      this.ants.push(ant);
    }
  }

  /** 获取指定类型食物堆的配置 */
  _foodTypeConfig(type = 'normal') {
    return type === 'rich' ? CONFIG.FOOD.RICH : CONFIG.FOOD;
  }

  /** 获取当前生效的每堆容量（两种食物共用，开发者工具可热改） */
  _foodCapacity() {
    return this.devCfg.FOOD_CAPACITY ?? CONFIG.FOOD.capacity;
  }

  /** 食物生成距巢最小距离（约 1/3 屏） */
  _foodMinDist() {
    const ratio = CONFIG.NEST.foodMinDistRatio ?? (1 / 3);
    return Math.min(CONFIG.WORLD_W, CONFIG.WORLD_H) * ratio;
  }

  /** 在地图上随机取一点，保证距巢足够远 */
  _randomFoodPos(maxAttempts = 200) {
    const nestX = this.nest.x, nestY = this.nest.y;
    const minDist2 = this._foodMinDist() ** 2;
    for (let i = 0; i < maxAttempts; i++) {
      const x = rand(80, CONFIG.WORLD_W - 80);
      const y = rand(200, CONFIG.WORLD_H - 80);
      if ((x - nestX) ** 2 + (y - nestY) ** 2 >= minDist2) return { x, y };
    }
    return null;
  }

  /** 根据当前搬运的食物类型返回速度倍率（普通/珍稀分别可配） */
  _carryMulFor(ant) {
    if (!ant.carrying) return 1.0;
    const isRich = ant.carryingType === 'rich';
    if (isRich) {
      if (this.devCfg.AI_SPEED?.carryRich !== undefined) return this.devCfg.AI_SPEED.carryRich;
      return CONFIG.FOOD.RICH.carryMul ?? CONFIG.AI_SPEED.carry;
    }
    if (this.devCfg.AI_SPEED?.carry !== undefined) return this.devCfg.AI_SPEED.carry;
    return CONFIG.FOOD.carryMul ?? CONFIG.AI_SPEED.carry;
  }

  /** 强光/嗅探光束跟随速度（像素/秒，开发者工具可热改） */
  _beamSpeed() {
    return this.devCfg.BEAM_SPEED ?? CONFIG.BEAM_SPEED ?? 280;
  }

  /** 误标后标记冷却 (秒)，开发者工具可热改 */
  _markCooldownSec() {
    if (this.devCfg.MARK_COOLDOWN !== undefined) {
      return Math.max(0, Math.min(5, +this.devCfg.MARK_COOLDOWN));
    }
    return CONFIG.MARK_COOLDOWN;
  }

  /** 误标 AI 后进入标记功能冷却 */
  _applyMarkCooldown(state) {
    state.markCooldownUntil = this.now + this._markCooldownSec();
  }

  /** 嗅探圈半径（像素，开发者工具可热改） */
  _sniffRadius() {
    return this.devCfg.SNIFF_RADIUS ?? CONFIG.TOOLS.sniff.radius ?? 100;
  }

  /** 巢穴区域半径（像素，遮蔽搜寻者视野） */
  _nestRadius() {
    return this.devCfg.NEST_RADIUS ?? CONFIG.NEST.radius;
  }

  /** 巢内食物堆放点坐标 */
  _depositPoint() {
    return {
      x: this.nest.x + CONFIG.NEST.depositOffsetX,
      y: this.nest.y + CONFIG.NEST.depositOffsetY,
    };
  }

  /** 食物堆放点交互半径 */
  _depositRadius() {
    return CONFIG.NEST.depositRadius;
  }

  /** 点是否在巢穴遮蔽区域内 */
  _isInsideNest(pos) {
    const r = this._nestRadius();
    return dist2(pos, this.nest) < r * r;
  }

  /** 随机生成躲藏点：数量、位置、半径每局略有不同 */
  _buildHidingSpots() {
    const cfg = CONFIG.HIDING_SPOTS;
    const count = cfg.count ?? 3;
    const rMin = cfg.radiusMin ?? 38;
    const rMax = cfg.radiusMax ?? 54;
    const [xMin, xMax] = cfg.xRatioRange ?? [0.15, 0.85];
    const [yMin, yMax] = cfg.yRatioRange ?? [0.45, 0.82];
    const minNestDist = cfg.minDistFromNest ?? 220;
    const minBetween = cfg.minDistBetween ?? 130;
    const margin = 90;

    const spots = [];
    for (let attempt = 0; attempt < 400 && spots.length < count; attempt++) {
      const radius = rand(rMin, rMax);
      const x = rand(CONFIG.WORLD_W * xMin, CONFIG.WORLD_W * xMax);
      const y = rand(CONFIG.WORLD_H * yMin, CONFIG.WORLD_H * yMax);
      if (x < margin || x > CONFIG.WORLD_W - margin || y < margin || y > CONFIG.WORLD_H - margin) {
        continue;
      }
      if (dist2({ x, y }, this.nest) < minNestDist * minNestDist) continue;

      let ok = true;
      for (const s of spots) {
        const gap = s.radius + radius + minBetween;
        if (dist2({ x, y }, s) < gap * gap) { ok = false; break; }
      }
      if (!ok) continue;

      spots.push({ id: spots.length, x, y, radius });
    }

    // 极端情况下凑不满时，用固定锚点 + 随机半径兜底
    const fallbacks = [
      { xRatio: 0.28, yRatio: 0.58 },
      { xRatio: 0.72, yRatio: 0.55 },
      { xRatio: 0.50, yRatio: 0.75 },
    ];
    while (spots.length < count) {
      const fb = fallbacks[spots.length];
      spots.push({
        id: spots.length,
        x: CONFIG.WORLD_W * fb.xRatio + rand(-40, 40),
        y: CONFIG.WORLD_H * fb.yRatio + rand(-35, 35),
        radius: rand(rMin, rMax),
      });
    }
    return spots;
  }

  /** 点是否处于任一躲藏点内（免疫工具与标记） */
  _isInsideHidingSpot(pos) {
    for (const spot of this.hidingSpots) {
      const r = spot.radius ?? 45;
      if (dist2(pos, spot) < r * r) return true;
    }
    return false;
  }

  /** 在巢穴区域内随机取一点（用于出生/复活） */
  _randomPosInNest() {
    const spawnR = this._nestRadius() * 0.55;
    const ang = rand(0, Math.PI * 2);
    const dist = rand(0, spawnR);
    return {
      x: this.nest.x + Math.cos(ang) * dist,
      y: this.nest.y + Math.sin(ang) * dist,
    };
  }

  /** 在地图上随机生成 n 个指定类型的食物堆，保证距巢足够远 */
  _spawnFoodSources(n, type = 'normal') {
    const capacity = this._foodCapacity();
    const target = this.foodSources.length + n;
    let nextId = this.foodSources.length;
    let attempts = 0;
    while (this.foodSources.length < target && attempts < 200) {
      attempts++;
      const pos = this._randomFoodPos();
      if (!pos) continue;
      this.foodSources.push({
        id: nextId++, type, x: pos.x, y: pos.y,
        amount: capacity, capacity, respawnAt: 0,
      });
    }
  }

  _makeAnt(id, isHider, playerId) {
    const spawn = this._randomPosInNest();
    const ant = {
      id, isHider, playerId,
      x: spawn.x,
      y: spawn.y,
      angle: rand(-Math.PI, Math.PI),
      traits: randomTraits(),
      carrying: false,
      carryingType: null,
      markedUntil: 0,   // 被标中冻结截止时刻；0 表示正常
      stunnedUntil: 0,  // 吃到假食物后的定身截止时刻；0 表示正常
      lives: isHider ? CONFIG.HIDER_LIVES : 0,
      eliminated: false, // 生命归零或玩家离场等永久出局
      vx: 0, vy: 0,
      sprinting: false,
      pickupProgress: 0,
      depositProgress: 0,
      tripTime: isHider ? rand(0, CONFIG.PHEROMONE.TAU) : 0,
    };
    if (!isHider) initAI(ant);
    return ant;
  }

  /** 隐藏者是否处于被标中冻结期（不可移动） */
  _isMarked(ant) {
    return ant.markedUntil > this.now;
  }

  /** 蚂蚁是否处于假食物定身期（不可移动、不可取食） */
  _isStunned(ant) {
    return ant.stunnedUntil > this.now;
  }

  /** 隐藏者是否仍在对局中（未永久出局） */
  _isActiveHider(ant) {
    return ant.isHider && !ant.eliminated;
  }

  // ---------- 玩家输入 ----------
  setHiderMove(pid, dx, dy) {
    const ant = this.ants.find(a => a.playerId === pid);
    if (!ant || this._isMarked(ant) || this._isStunned(ant) || ant.eliminated) return;
    const len = Math.hypot(dx, dy) || 1;
    ant.vx = dx / len; ant.vy = dy / len;
    if (dx || dy) ant.angle = Math.atan2(dy, dx);
  }

  /** 隐藏者冲刺开关：按住空格时叠加加速倍率 */
  setHiderSprint(pid, active) {
    const ant = this.ants.find(a => a.playerId === pid);
    if (!ant || this._isMarked(ant) || this._isStunned(ant) || ant.eliminated) return;
    ant.sprinting = active;
  }

  /** 记录搜寻者鼠标世界坐标，供隐藏者方显示 */
  setSeekerCursor(seekerId, x, y) {
    const state = this.seekerStates.get(seekerId);
    if (!state) return;
    state.cursor = {
      x: Math.max(0, Math.min(CONFIG.WORLD_W, x)),
      y: Math.max(0, Math.min(CONFIG.WORLD_H, y)),
    };
  }

  markAnt(seekerId, antId) {
    const state = this.seekerStates.get(seekerId);
    if (!state || this.over || this.now < state.markCooldownUntil) return;
    const ant = this.ants.find(a => a.id === antId);
    if (!ant || this._isMarked(ant)) return;
    // 躲藏点内免疫标记
    if (this._isInsideHidingSpot(ant)) return;
    // 已获胜或已淘汰的隐藏者不可再被标记
    if (ant.isHider && (ant.verified || ant.eliminated)) return;
    if (ant.isHider) {
      ant.lives = Math.max(0, ant.lives - 1);
      ant.markedUntil = this.now + CONFIG.HIDER_MARK_DURATION;
      ant.vx = ant.vy = 0;
      ant.sprinting = false;
      if (ant.carrying) {
        ant.carrying = false;
        ant.carryingType = null;
        ant.pickupProgress = 0;
        ant.depositProgress = 0;
      }
      state.markHits++;
      this.events.push({
        t: 'mark_hit', x: ant.x, y: ant.y, lives: ant.lives,
        antId: ant.id, playerId: ant.playerId, label: ant.hiderLabel,
      });
      if (ant.lives <= 0) {
        ant.eliminated = true;
        this.events.push({ t: 'hider_eliminated', antId: ant.id, label: ant.hiderLabel });
        this._checkWin();
      }
    } else {
      // 误标 AI：触发逃窜态短暂打乱画面，并进入标记冷却
      triggerFlee(ant, CONFIG.MISMARK_FLEE_DURATION, { x: ant.x, y: ant.y });
      this._applyMarkCooldown(state);
      state.markMisses++;
      this.events.push({ t: 'mark_miss', x: ant.x, y: ant.y, antId });
    }
  }

  /** 标记功能剩余冷却 (秒) */
  _markCdLeft(state) {
    return Math.max(0, +(state.markCooldownUntil - this.now).toFixed(1));
  }

  /** 某工具剩余冷却 (秒) */
  _toolCdLeft(state, tool) {
    if (this.noToolCd) return 0;
    return Math.max(0, +(state.toolCooldownUntil[tool] - this.now).toFixed(1));
  }

  /** 工具是否可用（未在独立 CD 中） */
  _canUseTool(state, tool) {
    if (this.noToolCd) return true;
    return this.now >= (state.toolCooldownUntil[tool] ?? 0);
  }

  /** 持续照射类工具配置：强光照射 / 气息嗅探 */
  static BEAM_TOOLS = {
    panic: { field: 'lightBeam', lastUntil: '_lastLightBeamUntil' },
    sniff: { field: 'sniffBeam', lastUntil: '_lastSniffBeamUntil' },
  };

  /** 点击放置类工具（非光束） */
  static PLACE_TOOLS = new Set(['fakeFood']);

  /**
   * 搜寻者放置假食物：不释放信息素，AI 不可见，真人尝试搬运时触发警告高亮。
   */
  placeFakeFood(seekerId, x, y) {
    const state = this.seekerStates.get(seekerId);
    const tool = 'fakeFood';
    if (!state || this.over || !Game.PLACE_TOOLS.has(tool)) return;
    if (!this._canUseTool(state, tool)) return;

    const def = CONFIG.TOOLS.fakeFood;
    const maxCount = def.maxCount ?? 8;
    if (this.fakeFoods.length >= maxCount) return;

    const margin = 24;
    const px = Math.max(margin, Math.min(CONFIG.WORLD_W - margin, x));
    const py = Math.max(margin, Math.min(CONFIG.WORLD_H - margin, y));

    const capacity = this._foodCapacity();
    const lifetime = def.lifetime ?? 40;
    this.fakeFoods.push({
      id: this._nextFakeFoodId++,
      x: px,
      y: py,
      amount: capacity,
      capacity,
      warnUntil: 0,
      expiresAt: this.now + lifetime,
    });

    state._toolsUsed = true;
    if (!this.noToolCd) state.toolCooldownUntil[tool] = this.now + this._toolCd(tool);
    this.events.push({ t: 'tool', tool, x: px, y: py });
  }

  /**
   * 持续照射类工具：点击开始后更新光束位置，自动持续至时长结束。
   */
  setToolBeam(seekerId, tool, x, y, active) {
    const state = this.seekerStates.get(seekerId);
    const cfg = Game.BEAM_TOOLS[tool];
    if (!state || this.over || !cfg) return;
    const def = CONFIG.TOOLS[tool];
    const field = cfg.field;

    if (active) {
      if (!state[field]) {
        // 光束刚结束后的残留 active:true 不应重启（无 CD 时尤甚）
        const lastUntil = state[cfg.lastUntil];
        if (lastUntil > 0 && this.now < lastUntil + 0.3) return;
        if (!this._canUseTool(state, tool)) return;
        state._toolsUsed = true;
        if (!this.noToolCd) state.toolCooldownUntil[tool] = this.now + this._toolCd(tool);
        state[field] = { x, y, targetX: x, targetY: y, until: this.now + def.duration };
        this.events.push({ t: 'tool', tool, x, y });
      } else {
        state[field].targetX = x;
        state[field].targetY = y;
      }
    } else {
      state[field] = null;
    }
  }

  /** 光束限速移向客户端上报的目标点 */
  _updateSeekerBeam(state, beamKey, lastUntilKey, dt) {
    const beam = state[beamKey];
    if (!beam || this.now >= beam.until) {
      if (beam) state[lastUntilKey] = beam.until;
      state[beamKey] = null;
      return;
    }
    moveToward(
      beam,
      { x: beam.targetX, y: beam.targetY },
      this._beamSpeed() * dt,
    );
  }

  /** 嗅探圈内检测未标记隐藏者；发现后持续警告 warnDuration 秒并结束嗅探 */
  _applySniffDetect(state) {
    const beam = state.sniffBeam;
    if (!beam || beam.hiderDetected) return;

    const r2 = this._sniffRadius() ** 2;
    const src = { x: beam.x, y: beam.y };
    for (const a of this.ants) {
      if (this._isInsideNest(a) || this._isInsideHidingSpot(a)) continue;
      if (a.isHider && !a.eliminated && !this._isMarked(a) && dist2(a, src) < r2) {
        beam.hiderDetected = true;
        const warn = CONFIG.TOOLS.sniff.warnDuration ?? 1;
        beam.until = this.now + warn;
        return;
      }
    }
  }

  /** 强光范围内触发 AI 蚂蚁逃离光源（聚合所有搜寻者光束） */
  _applyLightPanic() {
    const def = CONFIG.TOOLS.panic;
    const r2 = def.radius * def.radius;
    for (const state of this.seekerStates.values()) {
      const beam = state.lightBeam;
      if (!beam) continue;
      const src = { x: beam.x, y: beam.y };
      for (const a of this.ants) {
        if (!a.isHider && !this._isInsideHidingSpot(a) && dist2(a, src) < r2) {
          triggerFlee(a, 0.4, src);
        }
      }
    }
  }

  /**
   * 统一处理取/放食物：进入范围后原地等待 FOOD_ACTION_TIME 秒完成动作。
   * @returns {boolean} 是否处于取/放等待中（此时不应移动）
   */
  _processFoodAction(ant, dt) {
    const actionTime = CONFIG.FOOD_ACTION_TIME;
    const pickupR2 = CONFIG.FOOD.pickupRadius * CONFIG.FOOD.pickupRadius;
    const deposit = this._depositPoint();
    const depositR2 = this._depositRadius() ** 2;

    if (!ant.carrying) {
      const src = this._nearestFoodSource(ant);
      if (!src || dist2(ant, src) >= pickupR2) {
        ant.pickupProgress = 0;
        return false;
      }
      // 玩家隐藏者需静止才能拾取
      if (ant.isHider && !ant.bot && (ant.vx || ant.vy)) {
        ant.pickupProgress = 0;
        return false;
      }
      ant.pickupProgress += dt;
      if (ant.pickupProgress < actionTime) return true;

      src.amount--;
      if (src.amount <= 0 && src.respawnAt === 0) {
        const delay = this._foodTypeConfig(src.type).respawnDelay ?? CONFIG.FOOD.respawnDelay;
        src.respawnAt = this.now + delay;
      }
      ant.carrying = true;
      ant.carryingType = src.type || 'normal';
      ant.pickupProgress = 0;
      ant.depositProgress = 0;
      ant.tripTime = 0;
      if (ant.state !== undefined) ant.state = 'carrying';
      this.phero.deposit(src.x, src.y, 0, CONFIG.PHEROMONE.FIELD_MAX * 0.5);
      if (ant.isHider) this.events.push({ t: 'food_pickup', x: ant.x, y: ant.y });
      return false;
    }

    if (dist2(ant, deposit) >= depositR2) {
      ant.depositProgress = 0;
      return false;
    }
    ant.depositProgress += dt;
    if (ant.depositProgress < actionTime) return true;

    const depositedType = ant.carryingType ?? 'normal';
    ant.carrying = false;
    ant.carryingType = null;
    ant.depositProgress = 0;
    ant.tripTime = 0;
    if (ant.state !== undefined) ant.state = 'searching';
    this.phero.deposit(deposit.x, deposit.y, 1, CONFIG.PHEROMONE.FIELD_MAX * 0.5);
    if (ant.isHider) {
      const scoreGain = this._foodTypeConfig(depositedType).score ?? 1;
      ant.foodScore += scoreGain;
      this.events.push({ t: 'score', antId: ant.id, playerId: ant.playerId, score: ant.foodScore, label: ant.hiderLabel });
      if (!ant.verified && ant.foodScore >= this.hiderQuota) {
        ant.verified = true;
        ant.completeTime = +this.now.toFixed(2);
        this.events.push({ t: 'hider_verified', antId: ant.id, label: ant.hiderLabel });
        this._checkHiderWin();
      }
    }
    return false;
  }

  /** 找到进入拾取范围的最近食物堆（amount > 0） */
  _nearestFoodSource(ant) {
    const r2 = CONFIG.FOOD.pickupRadius * CONFIG.FOOD.pickupRadius;
    let best = null, bd = r2;
    for (const s of this.foodSources) {
      if (s.amount <= 0) continue;
      const d = dist2(ant, s);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** 找到进入拾取范围的最近假食物（仅真人隐藏者交互） */
  _nearestFakeFood(ant) {
    const r2 = CONFIG.FOOD.pickupRadius * CONFIG.FOOD.pickupRadius;
    let best = null, bd = r2;
    for (const s of this.fakeFoods) {
      const d = dist2(ant, s);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /**
   * 真人隐藏者尝试搬运假食物：完成取食动作后不搬运，触发短暂警告高亮。
   * @returns {boolean} 是否处于取食等待中
   */
  _processFakeFoodAction(ant, dt) {
    if (!ant.isHider || ant.bot || ant.carrying) return false;

    const src = this._nearestFakeFood(ant);
    const pickupR2 = CONFIG.FOOD.pickupRadius * CONFIG.FOOD.pickupRadius;
    if (!src || dist2(ant, src) >= pickupR2) {
      ant.pickupProgress = 0;
      return false;
    }
    if (ant.vx || ant.vy) {
      ant.pickupProgress = 0;
      return false;
    }

    const actionTime = CONFIG.FOOD_ACTION_TIME;
    const warnDur = CONFIG.TOOLS.fakeFood.warnDuration ?? 1.5;
    ant.pickupProgress += dt;
    if (ant.pickupProgress < actionTime) return true;

    ant.pickupProgress = 0;
    // 交互完成后定身并触发警告高亮，取食过程中搜寻者不可见
    const stunDur = CONFIG.TOOLS.fakeFood.stunDuration ?? 0.5;
    ant.stunnedUntil = this.now + stunDur;
    ant.vx = ant.vy = 0;
    ant.sprinting = false;
    src.warnUntil = this.now + warnDur;
    this.events.push({ t: 'fake_food_warn', x: src.x, y: src.y, antId: ant.id });
    return true;
  }

  // ---------- 主循环 ----------
  update(dt) {
    if (this.over) return;
    this.now += dt;
    this.timeLeft = Math.max(0, this.matchDuration - this.now);

    // 信息素蒸发（负反馈，每帧执行）
    this.phero.evaporate(dt);
    for (const state of this.seekerStates.values()) {
      this._updateSeekerBeam(state, 'lightBeam', '_lastLightBeamUntil', dt);
      this._updateSeekerBeam(state, 'sniffBeam', '_lastSniffBeamUntil', dt);
      this._applySniffDetect(state);
    }
    this._applyLightPanic();

    // 假食物到期移除
    this.fakeFoods = this.fakeFoods.filter(f => this.now < f.expiresAt);

    // 食物堆重生检查
    for (const s of this.foodSources) {
      if (s.amount <= 0 && s.respawnAt > 0 && this.now >= s.respawnAt) {
        s.capacity = this._foodCapacity();
        s.amount = s.capacity;
        const pos = this._randomFoodPos();
        if (pos) { s.x = pos.x; s.y = pos.y; }
        s.respawnAt = 0;
      }
    }

    const deposit = this._depositPoint();
    const world = {
      now: this.now,
      nest: {
        x: this.nest.x,
        y: this.nest.y,
        radius: this._nestRadius(),
        deposit,
      },
      foodSources: this.foodSources,
      phero: this.phero,
      hidingSpots: this.hidingSpots,
      cfg: this.devCfg,
    };

    // 被标中冻结期满 → 有剩余生命则巢穴复活，否则解除冻结状态
    for (const ant of this.ants) {
      if (!ant.isHider || ant.markedUntil <= 0 || this.now < ant.markedUntil) continue;
      if (ant.eliminated) ant.markedUntil = 0;
      else this._respawnHider(ant);
    }

    // 更新蚂蚁
    for (const ant of this.ants) {
      if (this._isMarked(ant)) continue;
      if (ant.isHider && ant.eliminated) continue;
      if (this._isStunned(ant)) {
        ant.vx = ant.vy = 0;
        ant.sprinting = false;
        continue;
      }
      // 真人隐藏者取食：真/假食物互斥处理，避免 _processFoodAction 每帧清零 pickupProgress
      let foodBusy;
      if (ant.isHider && !ant.bot && !ant.carrying) {
        const fake = this._nearestFakeFood(ant);
        const real = this._nearestFoodSource(ant);
        const useFake = fake && (!real || dist2(ant, fake) <= dist2(ant, real));
        foodBusy = useFake
          ? this._processFakeFoodAction(ant, dt)
          : this._processFoodAction(ant, dt);
      } else {
        foodBusy = this._processFoodAction(ant, dt);
      }
      if (ant.isHider && !ant.bot) {
        if (!foodBusy) this._updateHider(ant, dt);
      } else if (!foodBusy) {
        updateAI(ant, dt, world);
      }
    }

    if (this.timeLeft <= 0 && !this.over) {
      this.over = true;
      this.winner = ROLE.SEEKER;
      this.reason = '时间耗尽，搜寻者守住了蚁穴';
    }

    this._pheroTickCount++;
  }

  _updateHider(ant, dt) {
    const speedBase = this.devCfg.AI_SPEED_BASE ?? CONFIG.AI_SPEED_BASE;
    const sprintMul = ant.sprinting ? (this.devCfg.AI_SPEED?.sprint ?? CONFIG.AI_SPEED.sprint) : 1.0;
    const carryMul = this._carryMulFor(ant);
    const spd = speedBase * sprintMul * carryMul;
    if (!ant.vx && !ant.vy) return;

    ant.tripTime += dt;
    ant.x += ant.vx * spd * dt;
    ant.y += ant.vy * spd * dt;
    ant.x = Math.max(20, Math.min(CONFIG.WORLD_W - 20, ant.x));
    ant.y = Math.max(20, Math.min(CONFIG.WORLD_H - 20, ant.y));
    depositTrail(ant, dt, this.phero);
  }

  /** 隐藏者被标中冻结结束后，在巢穴复活并恢复行动 */
  _respawnHider(ant) {
    ant.markedUntil = 0;
    const spawn = this._randomPosInNest();
    ant.x = spawn.x;
    ant.y = spawn.y;
    ant.vx = ant.vy = 0;
    ant.sprinting = false;
    ant.carrying = false;
    ant.carryingType = null;
    ant.pickupProgress = 0;
    ant.depositProgress = 0;
    ant.stunnedUntil = 0;
    ant.tripTime = rand(0, CONFIG.PHEROMONE.TAU);
    if (ant.bot) initAI(ant);
    this.events.push({ t: 'hider_respawn', x: ant.x, y: ant.y });
  }

  _checkWin() {
    const aliveHiders = this.ants.filter(a => this._isActiveHider(a));
    if (aliveHiders.length === 0 && !this.over) {
      this.over = true;
      this.winner = ROLE.SEEKER;
      this.reason = '所有隐藏者已出局！';
    }
  }

  /** 所有在场隐藏者均已获胜 → 隐藏者阵营胜利 */
  _checkHiderWin() {
    if (this.over) return;
    const active = this.ants.filter(a => this._isActiveHider(a));
    if (active.length > 0 && active.every(a => a.verified)) {
      this.over = true;
      this.winner = ROLE.HIDER;
      this.reason = '所有隐藏者均已获胜！';
    }
  }

  /** 已完成获证的排前，按胜利用时从快到慢；未完成者排后 */
  _sortHiderScores(list) {
    return list.sort((a, b) => {
      const aDone = a.completeTime != null;
      const bDone = b.completeTime != null;
      if (aDone && bDone) return a.completeTime - b.completeTime;
      if (aDone) return -1;
      if (bDone) return 1;
      return b.score - a.score;
    });
  }

  /** 每位隐藏者的获证进度（供 HUD 展示） */
  _hiderScoreList() {
    const list = this.ants
      .filter(a => a.isHider)
      .map(a => ({
        antId: a.id,
        label: a.hiderLabel,
        color: a.hiderColor,
        score: a.foodScore,
        quota: this.hiderQuota,
        verified: a.verified,
        completeTime: a.completeTime,
        lives: a.lives,
        eliminated: a.eliminated,
      }));
    return this._sortHiderScores(list);
  }

  // ---------- 快照 ----------
  snapshot(role, viewerPid) {
    const deposit = this._depositPoint();
    const viewerAnt = role === ROLE.HIDER
      ? this.ants.find(a => a.isHider && a.playerId === viewerPid)
      : null;
    const visibleAnts = (role === ROLE.SEEKER
      ? this.ants.filter(a => !this._isInsideNest(a))
      : this.ants
    ).filter(a => !(a.isHider && a.eliminated));
    const ants = visibleAnts.map((a) => {
        const base = {
          id: a.id,
          x: Math.round(a.x),
          y: Math.round(a.y),
          angle: +a.angle.toFixed(2),
        };
        // 搜寻者视角：躲藏点内且未获证 → 仅下发影子所需字段
        if (role === ROLE.SEEKER && this._isInsideHidingSpot(a) && !a.verified) {
          return { ...base, hiding: true };
        }
        return {
          ...base,
          traits: a.traits,
          marked: this._isMarked(a),
          ...(this._isMarked(a) && {
            markedLeft: Math.ceil(a.markedUntil - this.now),
          }),
          stunned: this._isStunned(a),
          ...(this._isStunned(a) && {
            stunnedLeft: +(a.stunnedUntil - this.now).toFixed(2),
          }),
          ...(a.isHider && {
            lives: a.lives,
            eliminated: a.eliminated,
          }),
          verified: !!a.verified,
          carrying: a.carrying,
          carryingType: a.carrying ? (a.carryingType || 'normal') : null,
          isSelf: role === ROLE.HIDER && a.playerId === viewerPid,
          // 隐藏者方始终可见队友色；搜寻者仅对已获胜的隐藏者下发真色
          ...(a.isHider && a.hiderColor && (role === ROLE.HIDER || a.verified) && { hiderColor: a.hiderColor }),
          pickup: role === ROLE.HIDER && a.playerId === viewerPid ? +a.pickupProgress.toFixed(2) : 0,
          deposit: role === ROLE.HIDER && a.playerId === viewerPid ? +a.depositProgress.toFixed(2) : 0,
        };
      });

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
      ...(role === ROLE.HIDER && { selfEliminated: !!viewerAnt?.eliminated }),
      ants,
      antStats: { ai: aiCount, hider: hiderCount, total: aiCount + hiderCount },
      // 食物堆替代原 normalFood：包含位置与剩余量
      normalFood: this.foodSources.map(s => ({
        x: Math.round(s.x),
        y: Math.round(s.y),
        amount: s.amount,
        capacity: s.capacity,
        type: s.type || 'normal',
        score: this._foodTypeConfig(s.type).score ?? 1,
      })),
      fakeFood: this.fakeFoods.map(f => ({
        x: Math.round(f.x),
        y: Math.round(f.y),
        amount: f.amount,
        capacity: f.capacity,
        warnLeft: +Math.max(0, f.warnUntil - this.now).toFixed(2),
        lifeLeft: +Math.max(0, f.expiresAt - this.now).toFixed(2),
      })),
      foodActionTime: CONFIG.FOOD_ACTION_TIME,
      hidingSpots: this.hidingSpots.map((s) => ({
        x: Math.round(s.x),
        y: Math.round(s.y),
        radius: s.radius,
      })),
      nest: {
        x: Math.round(this.nest.x),
        y: Math.round(this.nest.y),
        radius: this._nestRadius(),
        ...(role !== ROLE.SEEKER && {
          deposit: {
            x: Math.round(deposit.x),
            y: Math.round(deposit.y),
            radius: this._depositRadius(),
          },
        }),
      },
      hiderScores: role === ROLE.HIDER
        ? this._hiderScoreList()
        : this._hiderScoreList().map(({ color, ...rest }) => rest),
      hiderQuota: this.hiderQuota,
      phero: pheroSnap,  // null 时客户端复用上一帧缓存
      ...(role === ROLE.SEEKER && (() => {
        const myState = this.seekerStates.get(viewerPid);
        return {
          toolCooldownLeft: myState
            ? Object.fromEntries(Object.keys(CONFIG.TOOLS).map((k) => [k, this._toolCdLeft(myState, k)]))
            : {},
          markCdLeft: myState ? this._markCdLeft(myState) : 0,
        };
      })()),
      debugMode: this.debugMode,
      noToolCd: this.noToolCd,
      lightBeams: this._serializeLightBeams(role, viewerPid),
      sniffBeams: this._serializeSniffBeams(role, viewerPid),
      seekerCursors: role === ROLE.HIDER ? this._serializeSeekerCursors() : [],
    };
  }

  /** 汇总所有搜寻者的强光束，搜寻者视角标记 self */
  _serializeLightBeams(role, viewerPid) {
    const beams = [];
    for (const [seekerId, state] of this.seekerStates) {
      const beam = state.lightBeam;
      if (!beam || this.now >= beam.until) continue;
      beams.push({
        seekerId,
        x: beam.x,
        y: beam.y,
        targetX: beam.targetX,
        targetY: beam.targetY,
        radius: CONFIG.TOOLS.panic.radius,
        ...(role === ROLE.SEEKER && { self: seekerId === viewerPid }),
      });
    }
    return beams;
  }

  /** 汇总所有搜寻者的嗅探圈，搜寻者视角标记 self */
  _serializeSniffBeams(role, viewerPid) {
    const beams = [];
    for (const [seekerId, state] of this.seekerStates) {
      const beam = state.sniffBeam;
      if (!beam || this.now >= beam.until) continue;
      beams.push({
        seekerId,
        x: beam.x,
        y: beam.y,
        targetX: beam.targetX,
        targetY: beam.targetY,
        radius: this._sniffRadius(),
        hiderDetected: !!beam.hiderDetected,
        ...(role === ROLE.SEEKER && { self: seekerId === viewerPid }),
      });
    }
    return beams;
  }

  /** 隐藏者视角：所有搜寻者鼠标位置 */
  _serializeSeekerCursors() {
    const cursors = [];
    for (const [seekerId, state] of this.seekerStates) {
      if (!state.cursor) continue;
      cursors.push({
        seekerId,
        x: Math.round(state.cursor.x),
        y: Math.round(state.cursor.y),
      });
    }
    return cursors;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  /**
   * 动态调整普通食物堆数量，珍稀食物不受影响。
   * 增加时在随机位置生成新堆；减少时从普通食物末尾移除。
   */
  _adjustFoodCount(targetCount) {
    const clamped = Math.max(1, Math.min(20, Math.round(targetCount)));
    const rich = this.foodSources.filter(s => s.type === 'rich');
    let normal = this.foodSources.filter(s => s.type !== 'rich');
    const current = normal.length;
    if (clamped > current) {
      this._spawnFoodSources(clamped - current, 'normal');
    } else if (clamped < current) {
      normal = normal.slice(0, clamped);
      this.foodSources = [...normal, ...rich];
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
   * 支持字段：AI_SPEED_BASE / AI_TURN_SMOOTH / AI_SOCIAL_CHANCE / AI_SPEED（含 carry / carryRich）/ AI_ANT_COUNT / FOOD_COUNT / FOOD_CAPACITY / BEAM_SPEED / SNIFF_RADIUS / TOOL_CD / MARK_COOLDOWN / DEBUG_NO_CD
   */
  setDevConfig(params) {
    let toolCdChanged = false;
    if (params.DEBUG_NO_CD !== undefined) this.noToolCd = !!params.DEBUG_NO_CD;
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
    if (params.BEAM_SPEED !== undefined) {
      this.devCfg.BEAM_SPEED = Math.max(
        CONFIG.BEAM_SPEED_MIN,
        Math.min(CONFIG.BEAM_SPEED_MAX, +params.BEAM_SPEED),
      );
    }
    if (params.SNIFF_RADIUS !== undefined) {
      this.devCfg.SNIFF_RADIUS = Math.max(50, Math.min(300, +params.SNIFF_RADIUS));
    }
    if (params.TOOL_CD) {
      this.devCfg.TOOL_CD = { ...this.devCfg.TOOL_CD };
      for (const [tool, cd] of Object.entries(params.TOOL_CD)) {
        if (!CONFIG.TOOLS[tool] || cd === undefined) continue;
        this.devCfg.TOOL_CD[tool] = Math.max(0, Math.min(30, +cd));
      }
      toolCdChanged = true;
    }
    if (params.MARK_COOLDOWN !== undefined) {
      const raw = typeof params.MARK_COOLDOWN === 'number'
        ? params.MARK_COOLDOWN
        : (params.MARK_COOLDOWN?.min ?? params.MARK_COOLDOWN?.max ?? this.devCfg.MARK_COOLDOWN ?? CONFIG.MARK_COOLDOWN);
      this.devCfg.MARK_COOLDOWN = Math.max(0, Math.min(5, +raw));
    }
    if (toolCdChanged || params.DEBUG_NO_CD !== undefined) {
      for (const state of this.seekerStates.values()) {
        if (!state._toolsUsed) this._resetStartingToolCooldowns(state);
      }
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
