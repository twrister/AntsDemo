// 服务器入口：3000 正式服 + 3001 本地调试服（单机调试 / DEV 工具）。
import { createServer } from './createServer.js';
import { setGlobalDevConfig } from './globalDevConfig.js';
import { loadDevDefaultsFromDisk, getDevDefaults } from './devDefaultsStore.js';

loadDevDefaultsFromDisk();
const savedDefaults = getDevDefaults();
if (savedDefaults) setGlobalDevConfig(savedDefaults);

const MAIN_PORT = Number(process.env.PORT) || 3000;
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 3001;

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

createServer({
  port: MAIN_PORT,
  allowDebug: false,
  allowSolo: true,
  defaultPage: 'index.html',
  label: '正式',
  registerRooms: (rooms) => allRoomMaps.push(rooms),
  onDevConfig: onGlobalDevConfig,
});
createServer({
  port: DEBUG_PORT,
  allowDebug: true,
  allowSolo: true,
  defaultPage: 'debug.html',
  label: '调试',
  registerRooms: (rooms) => allRoomMaps.push(rooms),
  onDevConfig: onGlobalDevConfig,
});

console.log('蚁群迷踪已启动');
console.log(`  玩家入口: http://localhost:${MAIN_PORT}`);
console.log(`  调试入口: http://localhost:${DEBUG_PORT}`);
