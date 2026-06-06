// AI 蚂蚁行为：极简个体规则 + 信息素媒介通信（stigmergy）+ 正负反馈 = 涌现群体智能。
// 每只蚂蚁只读局部信息素梯度（三触角传感器）并沿途沉积信息素，无全局调度。
//
// 两种状态：
//   searching  — 搜寻食物：嗅 toFood 梯度行走，沿途释放 toHome（强度随离巢时间衰减）
//   carrying   — 搬运回巢：朝巢穴方向走，沿途释放 toFood（强度随离食源时间衰减）
//
// 保留 flee / social 两个状态以兼容 GDD"铁律"，并维持原有导出接口不变。
import { CONFIG } from './config.js';

const { PHEROMONE: PHR, FOOD: FCFG } = CONFIG;

// GDD 仍用 STATES 做快照字段（前端不依赖枚举值，保持兼容）
export const STATES = ['searching', 'carrying', 'flee', 'social'];

function rand(a, b) { return a + Math.random() * (b - a); }
function clampAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

/** 初始化一只 AI 蚂蚁的行为字段 */
export function initAI(ant) {
  ant.state = 'searching';
  ant.carrying = false;
  ant.stateTimer = 0;        // flee / social 用
  ant.tripTime = rand(0, PHR.TAU); // 错开初始沉积强度，避免所有蚂蚁同时释放最强信息素
  ant.angle = rand(-Math.PI, Math.PI);
}

/** 触发逃跑（恐慌信息素 / 环境威胁），兼容 Game.js 调用 */
export function triggerFlee(ant, duration) {
  ant.state = 'flee';
  ant.stateTimer = duration;
  ant.targetAngle = rand(-Math.PI, Math.PI);
}

/**
 * 单帧更新一只 AI 蚂蚁（dt 秒）。
 * world 需提供：nest / foodSources / phero(PheromoneField) / frozenUntil / now
 * world.cfg 可选：运行时覆盖 AI_SPEED_BASE / AI_TURN_SMOOTH / AI_SOCIAL_CHANCE / AI_SPEED
 */
export function updateAI(ant, dt, world) {
  // 群体冻结
  if (world.frozenUntil > world.now) return;

  // 合并运行时配置（开发者工具调参）
  const cfg = world.cfg || {};
  const sprintMul = cfg.AI_SPEED?.sprint ?? CONFIG.AI_SPEED.sprint;

  // --- flee：高速随机，绝不回巢，不沉积信息素（使用加速倍率）---
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

  // 沉积 toHome（channel 1），强度随离巢时间指数衰减（越靠食源越弱）
  const depositH = PHR.DEPOSIT_HOME * Math.exp(-ant.tripTime / PHR.TAU) * dt;
  if (depositH > 0.001) phero.deposit(ant.x, ant.y, 1, depositH);

  // 检测食物堆
  const src = _nearestFoodSource(ant, world.foodSources);
  if (src) {
    src.amount--;
    ant.carrying = true;
    ant.state = 'carrying';
    ant.tripTime = 0;
    // 抵达食源瞬间，在食源处强沉积一次 toFood，给后来者一个强烈招募信号（正反馈）
    phero.deposit(src.x, src.y, 0, PHR.FIELD_MAX * 0.5);
    return;
  }

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
  const nest = world.nest;

  // 朝巢穴方向走（转弯限速）；搬运倍率 carry 使速度慢于空载
  const desired = Math.atan2(nest.y - ant.y, nest.x - ant.x);
  const carryMul = cfg.AI_SPEED?.carry ?? CONFIG.AI_SPEED.carry;
  _moveToward(ant, desired, carryMul, dt, false, cfg);

  // 沉积 toFood（channel 0），强度随离食源时间衰减（越靠巢越弱）
  const depositF = PHR.DEPOSIT_FOOD * Math.exp(-ant.tripTime / PHR.TAU) * dt;
  if (depositF > 0.001) phero.deposit(ant.x, ant.y, 0, depositF);

  // 到达巢穴
  if (dist2(ant, nest) < FCFG.nestRadius * FCFG.nestRadius) {
    ant.carrying = false;
    ant.state = 'searching';
    ant.tripTime = 0;
    // 抵达巢穴瞬间强沉积 toHome（给返程中的同伴更强的回巢信号）
    phero.deposit(nest.x, nest.y, 1, PHR.FIELD_MAX * 0.5);
  }
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

/** 找到进入拾取范围的最近食物堆（amount > 0），若无则返回 null */
function _nearestFoodSource(ant, sources) {
  const r2 = FCFG.pickupRadius * FCFG.pickupRadius;
  let best = null, bd = r2;
  for (const s of sources) {
    if (s.amount <= 0) continue;
    const d = dist2(ant, s);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
