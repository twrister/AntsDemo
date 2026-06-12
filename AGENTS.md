# AGENTS.md

## Cursor Cloud specific instructions

### 项目概览
蚁群迷踪（Ant Hunt）是一个非对称多人社交推理网页游戏 Demo。技术栈为 Node.js（ES Module）+ 原生 `ws` WebSocket + 原生 Canvas 2D 客户端，无前端框架、无构建步骤。

### 服务说明
单进程同时监听两个端口（见 `server/index.js`）：
- `http://localhost:3000` 正式服（玩家入口，含单机模式）
- `http://localhost:3001` 调试服（单机调试 + 开发者面板）

### 运行 / 构建 / 测试
- 启动：`npm start`（即 `node server/index.js`）。无独立 build 步骤；`public/` 为静态资源。
- 本仓库**没有**配置 lint 或自动化测试脚本（`package.json` 仅有 `start`）。
- 端口可用环境变量 `PORT` / `DEBUG_PORT` 覆盖。

### 非显而易见的注意事项
- **服务器无热重载**：修改 `server/` 下任何 `.js` 后必须重启进程才能生效；`public/` 客户端资源刷新浏览器即可。
- 单机模式无需第二个玩家即可开局，适合做端到端验证：输入昵称 → 创建房间 → 选角色 → 准备 → 开始。
- DEV 默认值持久化在 `server/data/devDefaults.json`（运行时由调试面板写入）。
