// WebSocket 消息类型常量，客户端与服务器共享语义。

// 客户端 -> 服务器
export const C2S = {
  // 大厅 / 房间管理
  LIST_ROOMS:   'list_rooms',   // {} 请求当前房间列表
  CREATE_ROOM:  'create_room',  // { name, roomName }
  JOIN_ROOM:    'join_room',    // { name, roomId }
  LEAVE_ROOM:   'leave_room',   // {}
  SWITCH_ROLE:  'switch_role',  // { role: 'seeker'|'hider' }
  START_GAME:   'start_game',   // {} 房主开局

  // 旧接口保留
  JOIN:         'join',         // 旧版兼容，已替换为 CREATE_ROOM/JOIN_ROOM
  READY:        'ready',        // 切换准备状态
  MOVE:         'move',         // 隐藏者移动 { dx, dy }
  PICKUP:       'pickup',
  MARK:         'mark',         // 搜寻者标记蚂蚁 { antId }
  USE_TOOL:     'use_tool',     // 搜寻者使用工具 { tool, x, y }
  TOOL_BEAM:    'tool_beam',    // 搜寻者持续照射 { tool, x, y, active }
  RESTART:      'restart',      // 结算后重开（返回大厅）
  SOLO_START:   'solo_start',   // 单机调试 { role }
};

// 服务器 -> 客户端
export const S2C = {
  ROOM_LIST:  'room_list',  // { rooms:[{id,name,count,state,hostName}] }
  WELCOME:    'welcome',    // { playerId, role, roomId, roomName, hostId }
  LOBBY:      'lobby',      // { roomId, roomName, hostId, players, state, canStart, canStartReason }
  START:      'start',      // { role, world, antId? }
  SNAPSHOT:   'snapshot',   // 10Hz 世界快照
  EVENT:      'event',
  END:        'end',        // { winner, reason }
};

export const ROLE = { SEEKER: 'seeker', HIDER: 'hider' };
