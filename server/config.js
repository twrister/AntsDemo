// 调参表：移植自 GDD 第 4 节「经济与平衡」。所有数值集中于此便于平衡测试。

export const CONFIG = {
  // 网络与世界
  TICK_RATE: 10,            // 服务器逻辑帧率 (Hz)，GDD 7 节：10Hz tick
  WORLD_W: 1600,            // 世界宽 (像素)
  WORLD_H: 1200,            // 世界高 (像素)

  // 对局
  MATCH_DURATION: 600,      // 单局时长 (秒)，基准 600
  AI_ANT_COUNT: 30,         // 地图 AI 蚂蚁数量
  MIN_HIDERS: 1,            // 最少隐藏者(不足用 AI 占位)
  // 标记食物目标公式：目标 = 2 + 隐藏者人数
  foodQuota: (hiderCount) => 2 + hiderCount,

  // 标记食物
  MARKED_FOOD_SLOTS: 3,         // 同时存在的标记食物数
  FOOD_RESPAWN_INTERVAL: 90,    // 刷新间隔 (秒)
  FOOD_PICKUP_TIME: 2.5,        // 原地引导拾取时间 (秒)
  FOOD_DROP_DESPAWN: 15,        // 掉落食物消失时间 (秒)

  // 外观破绽
  TRAIT_DEVIANCE_VISIBILITY: 0.15, // 特征偏差可见度 15%

  // 盲区
  TUNNEL_TRANSIT: 6,        // 隧道通行时间 (秒)

  // 工具 (全局冷却，单位秒)
  TOOLS: {
    panic:    { name: '恐慌信息素', cd: 30, duration: 4 },
    thermal:  { name: '热能扫描',   cd: 45, duration: 3 },
    bait:     { name: '诱饵食屑',   cd: 25, duration: 10 },
    freeze:   { name: '群体冻结',   cd: 60, duration: 2 },
    track:    { name: '追踪粉尘',   cd: 35, duration: 15 },
    magnify:  { name: '放大镜',     cd: 20, duration: 8 },
  },
  MISMARK_PENALTY: 10,      // 误标记全工具锁死 (秒)

  // 搜寻者视野
  SEEKER_VIEW_RATIO: 0.6,   // 屏幕 60%

  // AI 行为铁律
  AI_PAUSE_MAX: 0.8,        // 非社交状态最长停顿 (秒)
  AI_TURN_SMOOTH: 0.3,      // 转弯减速曲线 (秒)
  AI_SOCIAL_CHANCE: 0.05,   // 空闲触发社交概率
  AI_SPEED_BASE: 60,        // 基准速度 (像素/秒)
  AI_SPEED: { wander: 0.6, forage: 1.0, carry: 0.8, flee: 1.4, social: 0 },

  // 玩家移动
  HIDER_SPEED: 60,          // 隐藏者基准移动速度，与 AI 基准一致以便伪装

  // ---------- 信息素场（stigmergy）----------
  PHEROMONE: {
    cell: 20,               // 网格格元边长（像素），20px → 80×60 格
    worldW: 1600,           // 与 WORLD_W 保持一致
    worldH: 1200,           // 与 WORLD_H 保持一致
    evapToFood: 0.08,       // toFood 蒸发率（/秒）：旧食源路径消散较快
    evapToHome: 0.04,       // toHome 蒸发率（/秒）：回巢路径保留稍久
    EVAP_MIN: 0.02,         // 低于此值归零（避免极小浮点积累）
    FIELD_MAX: 10,          // 场强封顶（正反馈饱和点）
    DEPOSIT_HOME: 3,        // 搜寻途中单帧最大 toHome 沉积量（离巢衰减前）
    DEPOSIT_FOOD: 3,        // 搬运途中单帧最大 toFood 沉积量（离食源衰减前）
    TAU: 25,                // 沉积指数衰减时间常数（秒），越大路径越均匀
    sensorDist: 22,         // 三触角传感器探测距离（像素）
    sensorAngle: 0.6,       // 左/右触角偏转角度（弧度，约 34°）
    wanderJitter: 0.35,     // 无信息素时随机游走抖动幅度（弧度）
    coarseFactor: 2,        // 快照降采样倍数（降带宽），输出 40×30
  },

  // ---------- 可枯竭食物堆 ----------
  FOOD: {
    count: 5,               // 地图同时存在的食物堆数量
    capacity: 60,           // 每堆初始容量（可搬运次数）
    respawnDelay: 30,       // 食物堆枯竭后延时重生（秒）
    pickupRadius: 18,       // 蚂蚁进入此范围触发拾取
    nestRadius: 30,         // 到达巢穴的判定半径
  },
};
