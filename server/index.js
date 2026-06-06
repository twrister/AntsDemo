// 服务器入口：http 托管静态客户端 + WebSocket 权威服务器。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Room } from './Room.js';
import { C2S } from './protocol.js';

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

// 单一全局房间 (Demo)。多人通过同一地址进入。
const room = new Room();
let nextId = 1;

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const playerId = `p${nextId++}`;
  let joined = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === C2S.JOIN && !joined) {
      joined = true;
      room.addPlayer({ id: playerId, name: (msg.name || '玩家').slice(0, 16), ws });
      return;
    }
    if (joined) room.handle(playerId, msg);
  });

  ws.on('close', () => { if (joined) room.removePlayer(playerId); });
});

server.listen(PORT, () => {
  console.log(`蚁群迷踪服务器已启动: http://localhost:${PORT}`);
});
