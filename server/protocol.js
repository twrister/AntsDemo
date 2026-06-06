// WebSocket 消息类型常量，客户端与服务器共享语义。

// 客户端 -> 服务器
export const C2S = {
  JOIN: 'join',           // { name }
  READY: 'ready',         // 玩家准备
  MOVE: 'move',           // 隐藏者移动 { dx, dy }
  PICKUP: 'pickup',       // 隐藏者开始/停止引导拾取 { active }
  MARK: 'mark',           // 搜寻者标记蚂蚁 { antId }
  USE_TOOL: 'use_tool',   // 搜寻者使用工具 { tool, x, y }
  RESTART: 'restart',     // 结算后重开
  SOLO_START: 'solo_start', // 单机调试 { role: 'seeker' | 'hider' }
};

// 服务器 -> 客户端
export const S2C = {
  WELCOME: 'welcome',     // { playerId, role }
  LOBBY: 'lobby',         // { players, canStart }
  START: 'start',         // { role, world, antId? } 对局开始
  SNAPSHOT: 'snapshot',   // 10Hz 世界快照
  EVENT: 'event',         // 一次性事件(标记成功/误标记/拾取等)
  END: 'end',             // { winner, reason }
};

export const ROLE = { SEEKER: 'seeker', HIDER: 'hider' };
