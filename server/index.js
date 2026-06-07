// 服务器入口：http 托管静态客户端 + WebSocket 权威服务器（多房间版）。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Room } from './Room.js';
import { S2C } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// 静态文件服务器
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- RoomManager ----------
let nextRoomId = 1;
let nextPlayerId = 1;

/** roomId -> Room */
const rooms = new Map();

/** playerId -> { ws, roomId | null } — 所有已连接会话 */
const connections = new Map();

/** 生成唯一房间 ID */
function genRoomId() { return `r${nextRoomId++}`; }

/** 构建公开房间列表快照 */
function roomList() {
  return [...rooms.values()]
    .filter(r => !r.isPrivate)
    .map(r => r.summary());
}

/** 向所有"大厅浏览者"（未进任何房间的连接）推送房间列表 */
function broadcastRoomList() {
  const msg = JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() });
  for (const [, conn] of connections) {
    if (conn.roomId === null && conn.ws.readyState === 1) {
      conn.ws.send(msg);
    }
  }
}

/** 如果房间为空则销毁 */
function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.count === 0) {
    rooms.delete(roomId);
  }
}

/**
 * 创建并加入一个新房间。
 * @returns {Room}
 */
function createAndJoinRoom(playerId, ws, playerName, roomName, isPrivate = false) {
  const id = genRoomId();
  const room = new Room({
    id,
    name: roomName,
    isPrivate,
    onChange: () => {
      cleanupRoom(id);
      broadcastRoomList();
    },
  });
  rooms.set(id, room);
  connections.get(playerId).roomId = id;
  room.addPlayer({ id: playerId, name: playerName, ws });
  return room;
}

/** 让玩家离开当前房间（不断开 WS） */
function leaveRoom(playerId) {
  const conn = connections.get(playerId);
  if (!conn || conn.roomId === null) return;
  const room = rooms.get(conn.roomId);
  conn.roomId = null;
  if (room) {
    room.removePlayer(playerId);
    cleanupRoom(room.id);
    broadcastRoomList();
  }
  // 重新推送列表给该玩家（现在变为浏览者）
  if (conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = `p${nextPlayerId++}`;
  connections.set(playerId, { ws, roomId: null });

  // 新连接立即推送当前房间列表
  ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const conn = connections.get(playerId);
    if (!conn) return;

    // ---- 房间管理消息（在任意状态下均可处理）----
    if (msg.type === 'list_rooms') {
      ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));
      return;
    }

    if (msg.type === 'create_room') {
      if (conn.roomId !== null) return; // 已在房间内
      const playerName = (msg.name || '玩家').slice(0, 16);
      const roomName = (msg.roomName || `${playerName}的房间`).slice(0, 24);
      createAndJoinRoom(playerId, ws, playerName, roomName);
      broadcastRoomList();
      return;
    }

    if (msg.type === 'join_room') {
      if (conn.roomId !== null) return; // 已在房间内
      const room = rooms.get(msg.roomId);
      if (!room || room.state === 'playing') return; // 不存在或正在对局
      const playerName = (msg.name || '玩家').slice(0, 16);
      conn.roomId = room.id;
      room.addPlayer({ id: playerId, name: playerName, ws });
      broadcastRoomList();
      return;
    }

    if (msg.type === 'leave_room') {
      leaveRoom(playerId);
      return;
    }

    if (msg.type === 'solo_start') {
      // 单机调试：若未在房间则先创建私有房间
      if (conn.roomId === null) {
        const playerName = (msg.name || '调试').slice(0, 16);
        const room = createAndJoinRoom(playerId, ws, playerName, `${playerName}的房间`, true);
        room.handle(playerId, msg);
      } else {
        const room = rooms.get(conn.roomId);
        if (room) room.handle(playerId, msg);
      }
      return;
    }

    // ---- 游戏内消息：转发给所在房间 ----
    if (conn.roomId !== null) {
      const room = rooms.get(conn.roomId);
      if (room) room.handle(playerId, msg);
    }
  });

  ws.on('close', () => {
    const conn = connections.get(playerId);
    if (conn && conn.roomId !== null) {
      const room = rooms.get(conn.roomId);
      if (room) {
        room.removePlayer(playerId);
        cleanupRoom(room.id);
        broadcastRoomList();
      }
    }
    connections.delete(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`蚁群迷踪服务器已启动: http://localhost:${PORT}`);
});
