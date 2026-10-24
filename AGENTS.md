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
- 局域网发布：`npm run start:lan`（即 `node scripts/publish-lan.mjs`）。正式服绑 `0.0.0.0` 并打印本机局域网 IP；调试服默认 `127.0.0.1`，用 `DEBUG_HOST=0.0.0.0` 才对外开放。
- 公网发布：`powershell -ExecutionPolicy Bypass -File .\scripts\publish-server.ps1`。目标是腾讯云轻量 `111.230.136.201`，线上入口 **`http://111.230.136.201`**（裸 IP，非域名）。远端代码 `/var/www/ants`，systemd 服务 `ants`，正式服 `127.0.0.1:3210` 经 Caddy 反代到 80，调试服 `127.0.0.1:3211` 不对外。
- 联机自检：`node scripts/smoke-lan.mjs <host> <port>`（需服务已启动），覆盖 WebSocket / 建房 / 加入 / 开局 / 快照。
- 本仓库**没有**配置 lint 或自动化测试脚本（`package.json` 仅有 `start` / `start:lan`）。
- 端口用 `PORT` / `DEBUG_PORT` 覆盖，绑定地址用 `HOST` / `DEBUG_HOST` 覆盖。

### 非显而易见的注意事项
- **服务器无热重载**：修改 `server/` 下任何 `.js` 后必须重启进程才能生效；`public/` 客户端资源刷新浏览器即可。
- 单机模式无需第二个玩家即可开局，适合做端到端验证：输入昵称 → 创建房间 → 选角色 → 准备 → 开始。
- DEV 默认值持久化在 `server/data/devDefaults.json`（运行时由调试面板写入）。
- 客户端 WebSocket 地址来自 `location.host`（`public/js/net.js`），因此局域网访问不需要改任何前端配置，用 IP 打开页面即自动连到该 IP。
- **线上只能用裸 IP 访问**：服务器在腾讯云境内且域名未备案，域名访问会被劫持到 `dnspod.qcloud.com/webblock.html`（HTTP 302 / HTTPS reset），连同机已有的 sthgame.top 从部分网络也一样。所以对外入口固定 `http://111.230.136.201`；Caddy 里有意只配 `http://` 站点、不申请证书。
- **不要用 `caddy validate` 检查配置**：它会以当前用户身份真的创建日志文件，root 跑过后 `/var/log/caddy/*.log` 变成 root 属主，caddy 进程（用户 `caddy`）写不进去，reload 一直返回 400。部署脚本用 `caddy adapt` 代替。

### 移动端 / 横屏适配
- **纯客户端改动**：移动端适配只涉及 `public/`（`view.js` 视口检测、`touch.js` 摇杆、`toolui.js` 轮盘、`style.css` 响应式），不改服务端、不改协议，因此**不需要重启 Node**。
- 桌面端验证触屏 UI：URL 加 `?input=touch` 强制触屏、`?input=pointer` 强制桌面；调试服（3001）DEV 面板也有「强制触屏操作」开关。
- 真机验收走 `npm run start:lan`，手机与电脑同网段后打开打印出的局域网地址。
- 隐藏者视野用 `public/js/const.js` 的 `HIDER_VIEW_MODE` 控制：`'area'`（默认，等面积缩放）或 `'box'`（旧 4:3 letterbox）。
- 输入模式是**运行时热切换**的（`viewport.notePointerType`），排查输入问题时先确认 `document.body.dataset.input` 是 `touch` 还是 `pointer`。
