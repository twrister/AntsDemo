// 局域网联机冒烟测试：两个客户端经局域网 IP 建立 WebSocket，创建/加入房间并校验大厅同步。
// 用法：node scripts/smoke-lan.mjs [host] [port]
import WebSocket from 'ws';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3]) || 3000;
const url = `ws://${HOST}:${PORT}`;

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      // 先交给等待者，无人等待才入箱，避免同一条消息被消费两次
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
      inbox.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (type, ms = 3000) => {
        const idx = inbox.findIndex((m) => m.type === type);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`${name}: 等待 ${type} 超时`)), ms);
          waiters.push({ type, timer, resolve: res });
        });
      },
    }));
  });
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const a = await client('host');
await a.wait('room_list');
a.send({ type: 'create_room', name: '房主A', roomName: '局域网测试房' });
const lobbyA = await a.wait('lobby');
if (lobbyA.roomName !== '局域网测试房') fail(`房间名不符: ${lobbyA.roomName}`);
const roomId = lobbyA.roomId;

const b = await client('guest');
await b.wait('room_list');
b.send({ type: 'join_room', name: '玩家B', roomId });
const lobbyB = await b.wait('lobby');
if (lobbyB.roomId !== roomId) fail('B 未进入同一房间');

const lobbyA2 = await a.wait('lobby');
const names = lobbyA2.players.map((p) => p.name).sort();
if (!names.includes('房主A') || !names.includes('玩家B')) fail(`房主端未看到两人: ${names.join(',')}`);
if (lobbyA2.players.length !== 2) fail(`人数异常: ${lobbyA2.players.length}`);

b.send({ type: 'switch_role', role: 'hider' });
await new Promise((r) => setTimeout(r, 200));
a.send({ type: 'switch_role', role: 'seeker' });
await new Promise((r) => setTimeout(r, 200));

// 全员准备 -> 房主开局，两端都应收到 start（含各自角色）
b.send({ type: 'ready' });
await new Promise((r) => setTimeout(r, 150));
a.send({ type: 'ready' });
await new Promise((r) => setTimeout(r, 150));
a.send({ type: 'start_game' });

const [startA, startB] = await Promise.all([a.wait('start', 5000), b.wait('start', 5000)]);
if (!startA.world || !startA.world.hidingSpots) fail('房主端未收到完整开局数据');
if (!startB.world || !startB.world.hidingSpots) fail('玩家端未收到完整开局数据');
if (startA.role !== 'seeker') fail(`房主角色应为 seeker，实际 ${startA.role}`);
if (startB.role !== 'hider') fail(`玩家角色应为 hider，实际 ${startB.role}`);
if (!startB.antId) fail('隐藏者未分配到蚂蚁');

let snaps = 0;
b.ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'snapshot') snaps++; });
await new Promise((r) => setTimeout(r, 800));
if (snaps < 3) fail(`快照推送异常，800ms 内仅 ${snaps} 帧`);

console.log(`✓ WebSocket 经 ${url} 正常`);
console.log(`✓ 房间创建/加入成功 (roomId=${roomId})`);
console.log(`✓ 大厅同步正确: ${names.join(' / ')}`);
console.log(`✓ 双端开局成功: 隐藏者=${startB.antId}，隐藏点=${startB.world.hidingSpots.length}`);
console.log(`✓ 快照同步正常: 800ms 收到 ${snaps} 帧`);
a.ws.close();
b.ws.close();
process.exit(0);
