// AI 蚂蚁行为：极简个体规则 + 信息素媒介通信（stigmergy）+ 正负反馈 = 涌现群体智能。
// 每只蚂蚁只读局部信息素梯度（三触角传感器）并沿途沉积信息素，无全局调度。
//
// 两种状态：
//   searching  — 搜寻食物：嗅 toFood 梯度行走，沿途释放 toHome（强度随离巢时间衰减）
//   carrying   — 搬运回巢：朝巢穴方向走，沿途释放 toFood（强度随离食源时间衰减）
//
// 保留 flee / social 两个状态以兼容 GDD"铁律"，并维持原有导出接口不变。
import { CONFIG } from './config.js';

const { PHEROMONE: PHR } = CONFIG;

// GDD 仍用 STATES 做快照字段（前端不依赖枚举值，保持兼容）
export const STATES = ['searching', 'carrying', 'flee', 'social'];

function rand(a, b) { return a + Math.random() * (b - a); }
function clampAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/** 蚂蚁是否处于躲藏点内（免疫群体冻结） */
function _isInHidingSpot(ant, world) {
  const spots = world.hidingSpots;
  if (!spots?.length) return false;
  for (const s of spots) {
    const dx = ant.x - s.x, dy = ant.y - s.y;
    const r = s.radius ?? 45;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/** 初始化一只 AI 蚂蚁的行为字段 */
export function initAI(ant) {
  ant.state = 'searching';
  ant.carrying = false;
  ant.stateTimer = 0;        // flee / social 用
  ant.tripTime = rand(0, PHR.TAU); // 错开初始沉积强度，避免所有蚂蚁同时释放最强信息素
  ant.angle = rand(-Math.PI, Math.PI);
}

/**
 * 蚂蚁沿途沉积信息素：搜寻态释放 toHome，搬运态释放 toFood，强度随 tripTime 衰减。
 */
export function depositTrail(ant, dt, phero) {
  if (!ant.carrying) {
    const depositH = PHR.DEPOSIT_HOME * Math.exp(-ant.tripTime / PHR.TAU) * dt;
    if (depositH > 0.001) phero.deposit(ant.x, ant.y, 1, depositH);
  } else {
    const depositF = PHR.DEPOSIT_FOOD * Math.exp(-ant.tripTime / PHR.TAU) * dt;
    if (depositF > 0.001) phero.deposit(ant.x, ant.y, 0, depositF);
  }
}

/**
 * 触发逃跑（强光照射 / 环境威胁），兼容 Game.js 调用。
 * @param fleeFrom 威胁源坐标；提供时蚂蚁朝远离该点的方向逃离，否则随机乱窜
 */
export function triggerFlee(ant, duration, fleeFrom) {
  ant.state = 'flee';
  ant.stateTimer = duration;
  if (fleeFrom) {
    const dx = ant.x - fleeFrom.x;
    const dy = ant.y - fleeFrom.y;
    ant.targetAngle = Math.hypot(dx, dy) > 1
      ? Math.atan2(dy, dx)
      : rand(-Math.PI, Math.PI);
  } else {
    ant.targetAngle = rand(-Math.PI, Math.PI);
  }
}

/**
 * 单帧更新一只 AI 蚂蚁（dt 秒）。
 * world 需提供：nest / foodSources / phero(PheromoneField) / frozenUntil / now
 * world.cfg 可选：运行时覆盖 AI_SPEED_BASE / AI_TURN_SMOOTH / AI_SOCIAL_CHANCE / AI_SPEED
 */
export function updateAI(ant, dt, world) {
  // 群体冻结（躲藏点内免疫）
  if (world.frozenUntil > world.now && !_isInHidingSpot(ant, world)) return;

  // 合并运行时配置（开发者工具调参）
  const cfg = world.cfg || {};
  const sprintMul = cfg.AI_SPEED?.sprint ?? CONFIG.AI_SPEED.sprint;

  // --- flee：高速逃离威胁方向，绝不回巢，不沉积信息素（使用加速倍率）---
  if (ant.state === 'flee') {
    ant.stateTimer -= dt;
    _moveToward(ant, ant.targetAngle, sprintMul, dt, true, cfg);
    if (ant.stateTimer <= 0) {
      ant.state = ant.carrying ? 'carrying' : 'searching';
    }
    return;
  }

  // --- social：原地梳毛，小概率偶发 ---
  if (ant.state === 'social') {
    ant.stateTimer -= dt;
    if (ant.stateTimer <= 0) ant.state = ant.carrying ? 'carrying' : 'searching';
    return;
  }

  ant.tripTime += dt;

  if (!ant.carrying) {
    _updateSearching(ant, dt, world, cfg);
  } else {
    _updateCarrying(ant, dt, world, cfg);
  }
}

// ---------- 搜寻态 ----------
function _updateSearching(ant, dt, world, cfg) {
  const phero = world.phero;
  const sa = PHR.sensorAngle;
  const sd = PHR.sensorDist;

  // 三触角嗅探 toFood（channel 0）
  const sL = phero.sense(ant.x, ant.y, ant.angle, -sa, sd, 0);
  const sC = phero.sense(ant.x, ant.y, ant.angle,   0, sd, 0);
  const sR = phero.sense(ant.x, ant.y, ant.angle,  sa, sd, 0);

  let desired = ant.angle;
  if (sL > sC && sL > sR) {
    desired = ant.angle - sa;          // 转左
  } else if (sR > sC && sR > sL) {
    desired = ant.angle + sa;          // 转右
  } else if (sC > 0) {
    desired = ant.angle;               // 直行，轻微抖动由下面随机叠加
  } else {
    // 无信息素：随机游走（产生探索性扩散，形成新路径的种子）
    desired = ant.angle + rand(-PHR.wanderJitter, PHR.wanderJitter);
  }

  // 随机抖动叠加（保持探索性，防止全员走同一条路）
  desired += rand(-PHR.wanderJitter * 0.3, PHR.wanderJitter * 0.3);

  // 搜寻态：基准速度 × 1.0（无额外倍率）
  _moveToward(ant, desired, 1.0, dt, false, cfg);

  depositTrail(ant, dt, phero);

  // 取/放食物由 Game._processFoodAction 统一处理

  // 低概率进入社交（梳毛），不影响信息素场
  const socialChance = cfg.AI_SOCIAL_CHANCE ?? CONFIG.AI_SOCIAL_CHANCE;
  if (Math.random() < socialChance * dt) {
    ant.state = 'social';
    ant.stateTimer = rand(1.5, 3);
  }
}

// ---------- 搬运态 ----------
function _updateCarrying(ant, dt, world, cfg) {
  const phero = world.phero;
  // 回巢目标为巢内食物堆放点（非巢心）
  const dep = world.nest.deposit || world.nest;
  const desired = Math.atan2(dep.y - ant.y, dep.x - ant.x);
  const carryMul = _carryMulFor(ant, cfg);
  _moveToward(ant, desired, carryMul, dt, false, cfg);

  depositTrail(ant, dt, phero);

  // 放食物由 Game._processFoodAction 统一处理
}

/** 按搬运中的食物类型返回速度倍率（普通/珍稀分别可配） */
function _carryMulFor(ant, cfg) {
  const isRich = ant.carryingType === 'rich';
  if (isRich) {
    if (cfg.AI_SPEED?.carryRich !== undefined) return cfg.AI_SPEED.carryRich;
    return CONFIG.FOOD.RICH.carryMul ?? CONFIG.AI_SPEED.carry;
  }
  if (cfg.AI_SPEED?.carry !== undefined) return cfg.AI_SPEED.carry;
  return CONFIG.FOOD.carryMul ?? CONFIG.AI_SPEED.carry;
}

// ---------- 运动辅助 ----------

/** 朝 desired 角度平滑转向并前进（转弯限速，保持 GDD 铁律）
 * @param cfg 运行时配置（可覆盖 AI_SPEED_BASE / AI_TURN_SMOOTH）
 */
function _moveToward(ant, desired, speedMul, dt, instantTurn, cfg = {}) {
  const turnSmooth = cfg.AI_TURN_SMOOTH ?? CONFIG.AI_TURN_SMOOTH;
  const speedBase = cfg.AI_SPEED_BASE ?? CONFIG.AI_SPEED_BASE;
  let diff = clampAngle(desired - ant.angle);
  const maxTurn = (Math.PI / turnSmooth) * dt;
  if (!instantTurn && Math.abs(diff) > maxTurn) {
    diff = Math.sign(diff) * maxTurn;
  }
  ant.angle = clampAngle(ant.angle + diff);
  const spd = speedBase * speedMul;
  ant.x += Math.cos(ant.angle) * spd * dt;
  ant.y += Math.sin(ant.angle) * spd * dt;
  // 边界反弹：碰壁时随机转向（避免卡墙角）
  let bounced = false;
  if (ant.x < 20) { ant.x = 20; bounced = true; }
  if (ant.x > CONFIG.WORLD_W - 20) { ant.x = CONFIG.WORLD_W - 20; bounced = true; }
  if (ant.y < 20) { ant.y = 20; bounced = true; }
  if (ant.y > CONFIG.WORLD_H - 20) { ant.y = CONFIG.WORLD_H - 20; bounced = true; }
  if (bounced) ant.angle = clampAngle(ant.angle + Math.PI + rand(-0.5, 0.5));
}

