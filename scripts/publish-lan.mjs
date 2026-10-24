// 局域网发布入口：正式服对所有网卡开放，打印可直接分享的局域网地址。
// 调试服默认只绑本机（开发者面板可改全局调参，不宜暴露给同网段），
// 需要时用 DEBUG_HOST=0.0.0.0 显式开放。
// 用法：
//   node scripts/publish-lan.mjs          （默认 3000 / 3001）
//   PORT=8080 DEBUG_PORT=8081 node scripts/publish-lan.mjs
//   HOST=127.0.0.1 node scripts/publish-lan.mjs   （只允许本机玩）
import os from 'os';
import { createServer } from '../server/createServer.js';
import { setGlobalDevConfig } from '../server/globalDevConfig.js';
import { loadDevDefaultsFromDisk, getDevDefaults } from '../server/devDefaultsStore.js';

loadDevDefaultsFromDisk();
const savedDefaults = getDevDefaults();
if (savedDefaults) setGlobalDevConfig(savedDefaults);

const MAIN_PORT = Number(process.env.PORT) || 3000;
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 3001;
// 正式服默认对局域网开放；调试服默认仅本机。
const MAIN_HOST = process.env.HOST || '0.0.0.0';
const DEBUG_HOST = process.env.DEBUG_HOST || '127.0.0.1';

/** 取本机所有非回环、非链路本地的 IPv4 地址（局域网可达） */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // 自动私有地址，通常不可达
      out.push({ name, address: net.address });
    }
  }
  return out;
}

/** 各端口房间表，用于 3001 调参时同步到 3000 进行中对局 */
const allRoomMaps = [];

/** 3001 调试面板写入全局调参，并热更新所有端口上的对局 */
function onGlobalDevConfig(msg) {
  setGlobalDevConfig(msg);
  for (const rooms of allRoomMaps) {
    for (const room of rooms.values()) {
      room.applyGlobalDevConfig(msg);
    }
  }
}

const mainServer = createServer({
  port: MAIN_PORT,
  host: MAIN_HOST,
  allowDebug: false,
  allowSolo: true,
  defaultPage: 'index.html',
  label: '正式',
  registerRooms: (rooms) => allRoomMaps.push(rooms),
  onDevConfig: onGlobalDevConfig,
});
const debugServer = createServer({
  port: DEBUG_PORT,
  host: DEBUG_HOST,
  allowDebug: true,
  allowSolo: true,
  defaultPage: 'debug.html',
  label: '调试',
  registerRooms: (rooms) => allRoomMaps.push(rooms),
  onDevConfig: onGlobalDevConfig,
});
const servers = [
  { server: mainServer, name: '正式', port: MAIN_PORT },
  { server: debugServer, name: '调试', port: DEBUG_PORT },
];

const addrs = lanAddresses();
console.log('蚁群迷踪已启动（局域网模式）');
for (const { name, address } of addrs) {
  console.log(`  玩家入口 [${name}]: http://${address}:${MAIN_PORT}`);
}
if (addrs.length === 0) {
  console.log('  ⚠ 未发现局域网 IPv4 地址，请检查网络连接');
}
console.log(`  调试入口（仅本机）: http://localhost:${DEBUG_PORT}`);
console.log(
  DEBUG_HOST === '127.0.0.1' || DEBUG_HOST === 'localhost'
    ? '  调试面板未对外开放（如需开放：DEBUG_HOST=0.0.0.0 npm run start:lan）'
    : `  ⚠ 调试面板已对外开放（${DEBUG_HOST}），同网段设备可修改全局调参`,
);

for (const { server, name, port } of servers) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`✗ ${name}端口 ${port} 已被占用，请换端口后重试（PORT / DEBUG_PORT）`);
    } else {
      console.error(`✗ ${name}服务启动失败:`, err.message);
    }
    process.exit(1);
  });
}

const shutdown = () => {
  for (const { server } of servers) server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
