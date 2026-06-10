// 调参表：移植自 GDD 第 4 节「经济与平衡」。所有数值集中于此便于平衡测试。

export const CONFIG = {
  // 网络与世界
  TICK_RATE: 10,            // 服务器逻辑帧率 (Hz)，GDD 7 节：10Hz tick
  WORLD_W: 1600,            // 世界宽 (像素)
  WORLD_H: 1200,            // 世界高 (像素)

  // 对局
  MATCH_DURATION: 300,              // 单局默认时长 (秒)，默认 5 分钟
  MATCH_DURATION_MIN_MINUTES: 1,    // 可配置最短对局 (分钟)
  MATCH_DURATION_MAX_MINUTES: 10,   // 可配置最长对局 (分钟)
  /** 将分钟数限制在合法范围并转为秒 */
  matchDurationSeconds(minutes) {
    const m = Math.round(Number(minutes) || 0);
    const clamped = Math.max(this.MATCH_DURATION_MIN_MINUTES, Math.min(this.MATCH_DURATION_MAX_MINUTES, m));
    return clamped * 60;
  },
  AI_ANT_COUNT: 30,         // 地图 AI 蚂蚁数量（默认；房主可在房间中配置）
  AI_ANT_COUNT_MIN: 5,
  AI_ANT_COUNT_MAX: 100,
  AI_ANT_COUNT_STEP: 5,
  /** 将 AI 蚂蚁数量限制在合法范围并按步长取整 */
  aiAntCount(count) {
    const n = Math.round(Number(count) || 0);
    const clamped = Math.max(this.AI_ANT_COUNT_MIN, Math.min(this.AI_ANT_COUNT_MAX, n));
    return Math.round(clamped / this.AI_ANT_COUNT_STEP) * this.AI_ANT_COUNT_STEP;
  },
  MAX_PLAYERS: 10,          // 单房间最多联机人数
  MIN_HIDERS: 1,            // 最少隐藏者(不足用 AI 占位)
  MAX_HIDERS: 9,            // 单局最多隐藏者人数
  MAX_SEEKERS: 9,           // 单局最多搜寻者人数（受总人数约束）
  /** 隐藏者阵营标识色（按加入顺序分配，仅隐藏者方可见） */
  HIDER_COLORS: [
    '#6fc36f', '#5eb8e8', '#e8a05e', '#c36fd4',
    '#e85e7a', '#5ee8c8', '#b8e85e', '#8e5ee8', '#e8d45e',
  ],
  /** 每位隐藏者获胜所需食物份数（固定值，与人数无关；房主可在房间中配置） */
  HIDER_FOOD_QUOTA: 10,
  HIDER_FOOD_QUOTA_MIN: 1,
  HIDER_FOOD_QUOTA_MAX: 30,
  /** 将食物目标限制在合法范围 */
  hiderFoodQuota(quota) {
    const n = Math.round(Number(quota) || 0);
    return Math.max(this.HIDER_FOOD_QUOTA_MIN, Math.min(this.HIDER_FOOD_QUOTA_MAX, n));
  },

  FOOD_ACTION_TIME: 1,          // 取食物 / 放食物等待时间 (秒)

  // 外观破绽
  TRAIT_DEVIANCE_VISIBILITY: 0.15, // 特征偏差可见度 15%

  // 工具 (各工具独立冷却，单位秒；开局统一进入 TOOL_STARTING_CD 冷却)
  TOOL_STARTING_CD: 5, // 开局所有工具共用冷却 (秒)，使用后仍走各工具 cd
  /** 强光/嗅探光束跟随速度 (px/s)，开发者工具可热改 */
  BEAM_SPEED: 280,
  BEAM_SPEED_MIN: 100,
  BEAM_SPEED_MAX: 1200,
  TOOLS: {
    panic:    { name: '强光照射', cd: 30, duration: 4, radius: 120, desc: '在鼠标位置投射强光，范围内 AI 蚂蚁逃离光源，隐藏者不受影响。选中后点击地图开始照射，自动持续 4 秒。' },
    sniff:    { name: '气息嗅探', cd: 20, duration: 5, warnDuration: 1, radius: 100, desc: '释放气息探测圈跟随鼠标，嗅探到隐藏者后圈持续变红警告 1 秒后结束；未嗅探到则持续 5 秒。选中后点击地图开始嗅探。' },
    fakeFood: { name: '假食物', cd: 25, warnDuration: 1.5, stunDuration: 0.5, maxCount: 8, lifetime: 40, desc: '在点击位置放置假食物堆，40 秒后消失；外观与真食物相同。AI 蚂蚁不可见且不搬运；真人蚂蚁完成取食交互后定身 0.5 秒并触发短暂高亮警告，不会得分。' },
    pathEcho: { name: '轨迹残影', cd: 30, duration: 6, trailDuration: 6, desc: '点击后立即显示所有蚂蚁过去 6 秒的移动残影轨迹，轨迹颜色反映移动速度，便于判断步态是否异常。按 [4] 或点击工具栏使用。' },
  },
  /** 调试模式下搜寻者工具是否无 CD（标记冷却不受影响）；默认关闭 */
  DEBUG_NO_CD: false,

  // 隐藏者工具（每名真人隐藏者独立冷却）
  HIDER_TOOLS: {
    dash: {
      name: '突进',
      cd: 10,
      distance: 120,   // 位移距离 (像素)，开发者工具可热改
      duration: 0.15,  // 位移耗时 (秒)，快速冲刺感
      desc: '朝当前移动方向（静止时朝面向）快速位移一段距离，冷却 10 秒。按 [1] 或点击工具栏使用。',
    },
  },

  MARK_COOLDOWN: 3, // 误标记后标记功能冷却 (秒)，开发者工具可热改 0–5
  MISMARK_FLEE_DURATION: 1.2,          // 误标 AI 逃窜时长 (秒)
  HIDER_LIVES: 3,                      // 每位隐藏者默认生命数，被标中一次减 1，归零淘汰
  HIDER_MARK_DURATION: 10,             // 隐藏者被标中后冻结时长 (秒)，有剩余生命则在巢穴复活

  // 搜寻者视野
  SEEKER_VIEW_RATIO: 0.6,   // 屏幕 60%

  // 隐藏者视野：4:3 视口 (世界像素)，客户端自适应 zoom 保持各端可见范围一致
  HIDER_VIEW_WIDTH: 960,
  HIDER_VIEW_HEIGHT: 720,

  // AI 行为铁律
  AI_PAUSE_MAX: 0.8,        // 非待机状态最长停顿 (秒)
  AI_TURN_SMOOTH: 0.3,      // 转弯减速曲线 (秒)
  AI_SOCIAL_CHANCE: 0.05,   // 空闲触发待机概率
  AI_SPEED_BASE: 60,        // 基准速度 (像素/秒)
  /** 速度叠加倍率：最终速度 = base × (加速中 ? sprint : 1.0) × (搬运中 ? carry/carryRich : 1.0) */
  AI_SPEED: { sprint: 1.5, carry: 0.8 }, // carry 普通食物默认；珍稀见 FOOD.RICH.carryMul，调试端口可热改 carryRich

  // 玩家移动基准速度与 AI_SPEED_BASE 共用，见 Game._updateHider / AntAI._moveToward

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

  // ---------- 躲藏点（蚂蚁在内免疫工具与标记，搜寻者只见影子）----------
  HIDING_SPOTS: {
    count: 3,
    radiusMin: 38,
    radiusMax: 54,
    /** 生成区域（世界坐标比例），地图中下部 */
    xRatioRange: [0.15, 0.85],
    yRatioRange: [0.45, 0.82],
    minDistFromNest: 220,   // 距巢穴中心最小距离 (px)
    minDistBetween: 130,    // 两躲藏点边缘最小间距 (px)
  },

  // ---------- 巢穴 ----------
  NEST: {
    xRatio: 0.5,            // 巢心 X = WORLD_W * xRatio（地图水平居中）
    yRatio: 0.12,           // 巢心 Y = WORLD_H * yRatio（地图中上方）
    offsetY: 50,            // 巢心额外 Y 偏移（像素，正值向下）
    radius: 80,             // 巢穴区域半径：遮蔽搜寻者视野
    depositRadius: 30,      // 巢内食物堆放点交互半径
    depositOffsetX: 0,      // 堆放点相对巢心的偏移
    depositOffsetY: 18,
    /** 食物堆距巢最小距离 = min(WORLD_W, WORLD_H) × 比例（约 1/3 屏，fit 缩放下） */
    foodMinDistRatio: 1 / 3,
  },

  // ---------- 可枯竭食物堆 ----------
  FOOD: {
    count: 5,               // 普通食物堆数量
    capacity: 60,           // 每堆容量（两种食物共用，可搬运次数）
    respawnDelay: 30,       // 普通食物堆枯竭后延时重生（秒）
    score: 1,               // 普通食物单次得分
    carryMul: 0.8,          // 搬运普通食物时的速度倍率
    pickupRadius: 18,       // 蚂蚁进入此范围触发拾取
    /** 珍稀食物：单次 3 分、搬运更慢、堆数更少（容量与普通食物共用 FOOD.capacity） */
    RICH: {
      count: 2,
      respawnDelay: 45,
      score: 3,
      carryMul: 0.5,
    },
  },
};
