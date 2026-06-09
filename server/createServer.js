// 创建 HTTP + WebSocket 游戏服务实例（可配置是否开放调试能力）。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Room } from './Room.js';
import { S2C } from './protocol.js';
import { getDevDefaults, setDevDefaults } from './devDefaultsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * @param {{
 *   port: number,
 *   allowDebug?: boolean,
 *   allowSolo?: boolean,
 *   defaultPage?: string,
 *   label?: string,
 *   registerRooms?: (rooms: Map<string, import('./Room.js').Room>) => void,
 *   onDevConfig?: (msg: object) => void,
 * }} opts
 * @returns {import('http').Server}
 */
export function createServer(opts) {
  const {
    port,
    allowDebug = false,
    allowSolo = false,
    defaultPage = 'index.html',
    label = '',
    registerRooms = null,
    onDevConfig = null,
  } = opts;

  let nextRoomId = 1;
  let nextPlayerId = 1;

  /** roomId -> Room */
  const rooms = new Map();
  registerRooms?.(rooms);

  /** playerId -> { ws, roomId | null } */
  const connections = new Map();

  function genRoomId() { return `r${nextRoomId++}`; }

  function roomList() {
    return [...rooms.values()]
      .filter(r => !r.isPrivate)
      .map(r => r.summary());
  }

  function broadcastRoomList() {
    const msg = JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() });
    for (const [, conn] of connections) {
      if (conn.roomId === null && conn.ws.readyState === 1) {
        conn.ws.send(msg);
      }
    }
  }

  function cleanupRoom(roomId) {
    const room = rooms.get(roomId);
    if (room && room.count === 0) {
      rooms.delete(roomId);
    }
  }

  function createAndJoinRoom(playerId, ws, playerName, roomName, isPrivate = false, soloDebugMode = false) {
    const id = genRoomId();
    const room = new Room({
      id,
      name: roomName,
      isPrivate,
      soloDebugMode,
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
    if (conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));
    }
  }

  /** 读取 POST 请求体 */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = `/${defaultPage}`;

    // 开发者工具自定义默认值 API（GET 双端口可读，POST 仅调试端口）
    if (urlPath === '/api/dev-defaults') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(getDevDefaults() || {}));
        return;
      }
      if (req.method === 'POST') {
        if (!allowDebug) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const raw = await readBody(req);
          const cfg = JSON.parse(raw || '{}');
          const saved = setDevDefaults(cfg);
          onDevConfig?.(saved);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(saved));
        } catch {
          res.writeHead(400);
          res.end('Bad Request');
        }
        return;
      }
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const filePath = path.join(PUBLIC, path.normalize(urlPath.slice(1)));
    if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    const playerId = `p${nextPlayerId++}`;
    connections.set(playerId, { ws, roomId: null });

    ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const conn = connections.get(playerId);
      if (!conn) return;

      if (msg.type === 'list_rooms') {
        ws.send(JSON.stringify({ type: S2C.ROOM_LIST, rooms: roomList() }));
        return;
      }

      if (msg.type === 'create_room') {
        if (conn.roomId !== null) return;
        const playerName = (msg.name || '玩家').slice(0, 16);
        const roomName = (msg.roomName || `${playerName}的房间`).slice(0, 24);
        createAndJoinRoom(playerId, ws, playerName, roomName);
        broadcastRoomList();
        return;
      }

      if (msg.type === 'join_room') {
        if (conn.roomId !== null) return;
        const room = rooms.get(msg.roomId);
        if (!room || room.state === 'playing') return;
        const playerName = (msg.name || '玩家').slice(0, 16);
        conn.roomId = room.id;
        if (!room.addPlayer({ id: playerId, name: playerName, ws })) return;
        broadcastRoomList();
        return;
      }

      if (msg.type === 'leave_room') {
        leaveRoom(playerId);
        return;
      }

      if (msg.type === 'solo_start') {
        if (!allowSolo) return;
        if (conn.roomId === null) {
          const playerName = (msg.name || (allowDebug ? '调试' : '玩家')).slice(0, 16);
          const room = createAndJoinRoom(
            playerId, ws, playerName, `${playerName}的房间`, true, allowDebug,
          );
          room.handle(playerId, msg);
        } else {
          const room = rooms.get(conn.roomId);
          if (room) room.handle(playerId, msg);
        }
        return;
      }

      if (msg.type === 'dev_config') {
        if (!allowDebug) return;
        onDevConfig?.(msg);
        return;
      }

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

  server.listen(port, () => {
    const suffix = label ? ` (${label})` : '';
    console.log(`监听 http://localhost:${port}${suffix}`);
  });

  return server;
}
