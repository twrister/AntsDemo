# ============================================================
# 蚁群迷踪（Ant Hunt）一键发布到腾讯云轻量应用服务器
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\publish-server.ps1
#
# 做的事：
#   1. 本地 tar 打包（排除 node_modules / .git / .history / .cursor）
#   2. scp 上传到服务器 /tmp
#   3. 远端执行 scripts/remote-deploy.sh：
#        备份旧版本 -> 解包 -> npm install --omit=dev -> 重写 systemd 服务
#        -> 更新 Caddyfile 站点块 -> reload Caddy -> 健康检查 + WS 冒烟
#   4. 本地再走公网 IP 验一次 HTTP + WebSocket
#
# 服务器上跑的进程（systemd 服务名 ants）：
#   正式服 127.0.0.1:3210（Caddy 反代到 http://111.230.136.201 的 80 端口）
#   调试服 127.0.0.1:3211（不对外，需要时自己开 SSH 隧道：
#                        ssh -i ~/.ssh/sthgame_deploy -L 3211:127.0.0.1:3211 ubuntu@111.230.136.201
#                        然后本地打开 http://localhost:3211）
#
# 为什么入口是裸 IP 而不是域名：
#   服务器在腾讯云境内且域名未备案，域名访问会被劫持到
#   dnspod.qcloud.com/static/webblock.html（HTTP 302）/ HTTPS 直接 reset，
#   连已有的 sthgame.top 从部分网络访问也一样。裸 IP 的 HTTP 访问则完全正常。
#   游戏前端用 location.host 拼 WebSocket 地址，所以 IP 入口无需改任何代码。
#
# 可选参数：
#   -Domain      对外入口，默认 111.230.136.201（裸 IP）
#   -MainPort    正式服端口，默认 3210
#   -DebugPort   调试服端口，默认 3211
# ============================================================
param(
  [string]$Server    = "111.230.136.201",
  [string]$User      = "ubuntu",
  [string]$KeyPath   = "$env:USERPROFILE\.ssh\sthgame_deploy",
  [string]$AppDir    = "/var/www/ants",
  [string]$Service   = "ants",
  [int]   $MainPort  = 3210,
  [int]   $DebugPort = 3211,
  [string]$Domain    = "111.230.136.201"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyPath)) { throw "找不到部署密钥：$KeyPath" }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RemoteScript = Join-Path $PSScriptRoot "remote-deploy.sh"
if (-not (Test-Path $RemoteScript)) { throw "缺少 scripts/remote-deploy.sh" }

$Target = "${User}@${Server}"
$SshOpts = @("-i", $KeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20")
$Tarball = Join-Path $env:TEMP "ants-deploy.tar.gz"
$BaseUrl = "http://$Domain"

# ---------- 1. 打包 ----------
Write-Host "==> [1/4] 打包" -ForegroundColor Cyan
Remove-Item $Tarball -Force -ErrorAction SilentlyContinue
# Git 自带的 GNU tar 会把 "C:\..." 里的盘符当成远程主机，需要 --force-local；系统 bsdtar 不支持该参数
$tarArgs = @("-czf", $Tarball, "--exclude=node_modules", "--exclude=.git", "--exclude=.history", "--exclude=.cursor", "-C", $ProjectRoot, ".")
if (((& tar --version 2>$null | Out-String) -match "GNU tar")) { $tarArgs = @("--force-local") + $tarArgs }
& tar @tarArgs
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败" }
Write-Host ("    包大小 {0:N2} MB" -f ((Get-Item $Tarball).Length / 1MB)) -ForegroundColor DarkGray

# ---------- 2. 上传 ----------
Write-Host "==> [2/4] 上传到 $Target" -ForegroundColor Cyan
& scp @SshOpts $Tarball "${Target}:/tmp/ants-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "上传 tarball 失败" }

# 远端脚本转 LF，避免 CRLF 让 bash 报 $'\r'
$shText = [System.IO.File]::ReadAllText($RemoteScript) -replace "`r`n", "`n"
$shTmp = Join-Path $env:TEMP "ants-remote-deploy.sh"
[System.IO.File]::WriteAllText($shTmp, $shText, (New-Object System.Text.UTF8Encoding($false)))
& scp @SshOpts $shTmp "${Target}:/tmp/ants-remote-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "上传部署脚本失败" }
Remove-Item $shTmp -Force -ErrorAction SilentlyContinue

# ---------- 3. 远端执行 ----------
Write-Host "==> [3/4] 远端部署中..." -ForegroundColor Cyan
$remoteCmd = "chmod +x /tmp/ants-remote-deploy.sh && " +
  "APP_DIR='$AppDir' SERVICE='$Service' MAIN_PORT='$MainPort' DEBUG_PORT='$DebugPort' DOMAIN='$Domain' " +
  "bash /tmp/ants-remote-deploy.sh"
& ssh @SshOpts $Target $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "远端部署失败（见上方日志）" }

# ---------- 4. 公网验证 ----------
Write-Host "==> [4/4] 公网验证 $BaseUrl" -ForegroundColor Cyan
$code = (& curl.exe -sS -o NUL -w "%{http_code}" --max-time 20 "$BaseUrl/").Trim()
Write-Host "    GET /            -> $code" -ForegroundColor DarkGray
$wsCode = (& curl.exe -sS -o NUL -w "%{http_code}" --max-time 20 "$BaseUrl/css/style.css").Trim()
Write-Host "    GET /css/style.css -> $wsCode" -ForegroundColor DarkGray
& node scripts/smoke-lan.mjs $Domain 80
if ($LASTEXITCODE -ne 0) { throw "公网 WebSocket 冒烟失败" }

Write-Host "`n发布完成：$BaseUrl" -ForegroundColor Green
