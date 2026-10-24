#!/usr/bin/env bash
# 远端部署脚本（由 scripts/publish-server.ps1 上传后在服务器上执行）
# 只依赖：/tmp/ants-deploy.tar.gz 已上传；ubuntu 用户有 NOPASSWD sudo。
set -euo pipefail

APP_DIR=${APP_DIR:-/var/www/ants}
APP_USER=${APP_USER:-ants}
SERVICE=${SERVICE:-ants}
MAIN_PORT=${MAIN_PORT:-3210}
DEBUG_PORT=${DEBUG_PORT:-3211}
DOMAIN=${DOMAIN:-111.230.136.201}
TARBALL=${TARBALL:-/tmp/ants-deploy.tar.gz}
STAMP=$(date +%Y%m%d-%H%M%S)

log() { printf '\n==> %s\n' "$*"; }

[ -f "$TARBALL" ] || { echo "missing tarball: $TARBALL" >&2; exit 1; }

# ---------- 1. 系统用户 ----------
log "ensure user $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- 2. 备份 + 解包 ----------
log "backup + unpack"
if [ -d "$APP_DIR/server" ]; then
  sudo mkdir -p /var/www/ants-backups
  sudo tar -czf "/var/www/ants-backups/app-$STAMP.tar.gz" \
    --exclude=node_modules -C "$APP_DIR" . 2>/dev/null || true
  echo "backup: /var/www/ants-backups/app-$STAMP.tar.gz"
fi

sudo mkdir -p "$APP_DIR"
# 只清理代码目录，保留 node_modules（deps 未变时不重装）
sudo rm -rf "$APP_DIR/public" "$APP_DIR/server" "$APP_DIR/scripts"
sudo rm -f "$APP_DIR"/*.md "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/.gitignore"
sudo tar -xzf "$TARBALL" -C "$APP_DIR"

# ---------- 3. 依赖 ----------
log "npm install (production only)"
sudo chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" env HOME="$APP_DIR" npm_config_cache=/tmp/npm-cache-ants \
  npm install --omit=dev --no-audit --no-fund \
  --registry=https://registry.npmmirror.com --prefix "$APP_DIR"

# ---------- 4. systemd ----------
log "write systemd unit $SERVICE.service"
sudo tee /etc/systemd/system/"$SERVICE".service >/dev/null <<UNIT
[Unit]
Description=Ant Hunt (antsdemo) game server
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$MAIN_PORT
Environment=DEBUG_PORT=$DEBUG_PORT
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/usr/bin/node $APP_DIR/server/index.js
Restart=always
RestartSec=3
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR/server/data

[Install]
WantedBy=multi-user.target
UNIT

sudo mkdir -p "$APP_DIR/server/data"
sudo chown -R "$APP_USER":"$APP_USER" "$APP_DIR/server"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE"
sleep 2
sudo systemctl is-active "$SERVICE"

# ---------- 5. Caddy ----------
# 为什么用裸 IP 而不是域名：
#   这台机器在腾讯云境内，没备案的域名访问会被运营商侧劫持到
#   https://dnspod.qcloud.com/static/webblock.html（连已备案的 sthgame.top
#   从部分网络访问也会被拦），但 **直接访问 IP 是通的**。
#   所以对外入口固定为 http://<公网IP>，游戏前端用 location.host 连 WS，天然同源。
log "ensure caddy site block for $DOMAIN"
CADDY=/etc/caddy/Caddyfile
sudo cp "$CADDY" "$CADDY.bak-$STAMP"

# 用标记段落反复覆盖，避免每次部署往 Caddyfile 里堆重复配置
sudo python3 - "$CADDY" "$DOMAIN" "$MAIN_PORT" <<'PY'
import sys
path, domain, port = sys.argv[1], sys.argv[2], sys.argv[3]
BEGIN, END = "# >>> ants-begin", "# <<< ants-end"
text = open(path, encoding="utf-8").read()
# 清掉早期版本追加的无标记段落（以注释行开头、直到文件末尾）
LEGACY = "# --- Ant Hunt (antsdemo) ---"
if LEGACY in text:
    text = text.split(LEGACY, 1)[0]
if BEGIN in text and END in text:
    head, rest = text.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    text = head.rstrip("\n") + "\n" + tail.lstrip("\n")
block = f"""{BEGIN}
# Ant Hunt (antsdemo) —— 只走 HTTP 80，不申请证书（域名未备案，会被劫持）
http://{domain} {{
\tencode gzip

\t# 正式服不提供调试页：debug.html 只在调试端口（3211）有意义，对外直接 404
\t@debugPage path /debug.html
\trespond @debugPage 404

\treverse_proxy 127.0.0.1:{port}
\tlog {{
\t\toutput file /var/log/caddy/ants.log {{
\t\t\troll_size 10mb
\t\t\troll_keep 5
\t\t}}
\t}}
}}
{END}
"""
text = text.rstrip("\n") + "\n\n" + block
open(path, "w", encoding="utf-8").write(text)
print("caddyfile updated")
PY

# 注意：不要用 `caddy validate` 做检查——它会真的去创建日志文件，
# 以 root 身份跑会留下 root:root 0600 的 /var/log/caddy/*.log，
# 之后 caddy 进程（用户 caddy）就再也写不进去，reload 一直 400。
# 用 `caddy adapt` 只做语法/结构适配，不碰文件系统。
if ! sudo caddy adapt --config "$CADDY" --adapter caddyfile >/tmp/caddy-adapt.json 2>/tmp/caddy-adapt.err; then
  echo "caddy adapt FAILED:" >&2
  sudo cat /tmp/caddy-adapt.err >&2
  exit 1
fi

# 上一版误用 root 跑 validate 留下的 root 属主日志，先纠正
sudo chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
sudo find /var/log/caddy -type f ! -user caddy -exec chown caddy:caddy {} + 2>/dev/null || true

if sudo systemctl reload caddy; then
  echo "caddy reloaded"
else
  echo "caddy reload FAILED，见 journalctl -u caddy" >&2
  sudo journalctl -u caddy -n 20 --no-pager >&2
  exit 1
fi

# ---------- 6. 本机健康检查 ----------
log "local health check"
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$MAIN_PORT/"; then break; fi
  sleep 1
done
curl -sS -o /dev/null -w "main  http://127.0.0.1:$MAIN_PORT/ -> %{http_code}\n" "http://127.0.0.1:$MAIN_PORT/"
curl -sS -o /dev/null -w "debug http://127.0.0.1:$DEBUG_PORT/ -> %{http_code}\n" "http://127.0.0.1:$DEBUG_PORT/"

log "ws smoke test"
( cd "$APP_DIR" && sudo -u "$APP_USER" env HOME="$APP_DIR" /usr/bin/node scripts/smoke-lan.mjs 127.0.0.1 "$MAIN_PORT" )

# 经 Caddy 走一遍公网入口，确认反代 + WebSocket 升级都正常（不只是本机 Node 好）
log "public entry health check (via Caddy)"
curl -sS -o /dev/null -w "http://$DOMAIN/        -> %{http_code}\n" --max-time 15 "http://$DOMAIN/"
curl -sS -o /dev/null -w "http://$DOMAIN/css/style.css -> %{http_code}\n" --max-time 15 "http://$DOMAIN/css/style.css"
curl -sS -o /dev/null -w "http://$DOMAIN/api/dev-defaults -> %{http_code}\n" --max-time 15 "http://$DOMAIN/api/dev-defaults"

log "done ($STAMP)"
