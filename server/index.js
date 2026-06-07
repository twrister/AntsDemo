// 服务器入口：3000 正式服 + 3001 本地调试服（单机调试 / DEV 工具）。
import { createServer } from './createServer.js';

const MAIN_PORT = Number(process.env.PORT) || 3000;
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 3001;

createServer({ port: MAIN_PORT, allowDebug: false, defaultPage: 'index.html', label: '正式' });
createServer({ port: DEBUG_PORT, allowDebug: true, defaultPage: 'debug.html', label: '调试' });

console.log('蚁群迷踪已启动');
console.log(`  玩家入口: http://localhost:${MAIN_PORT}`);
console.log(`  调试入口: http://localhost:${DEBUG_PORT}`);
