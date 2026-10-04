#!/usr/bin/env bash
# ==========================================================================
#  OTP Bot Server - One-Command Installer (Termux / Debian / Ubuntu)
#
#  Usage:
#    bash install.sh                      install + start + public quick-tunnel link
#    bash install.sh --domain otp.me.com  (Debian/Ubuntu VPS) install + HTTPS via Caddy
#    bash install.sh --no-tunnel          do not create a public tunnel
#    bash install.sh --dry-run            show the steps without running them
# ==========================================================================
export DEBIAN_FRONTEND=noninteractive
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR" || { echo "cannot enter $APP_DIR"; exit 1; }

APP_NAME="OTP Bot Server"
PM2_APP="otp-bot-server"
PM2_TUNNEL="otp-bot-tunnel"
LOG="$APP_DIR/install.log"
STEPTMP="$APP_DIR/.step.tmp"
DRY=0; NO_TUNNEL=0; SELFTEST=0; DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-tunnel) NO_TUNNEL=1 ;;
    --selftest) SELFTEST=1 ;;
    --domain) shift; DOMAIN="$1" ;;
  esac
  shift
done
: > "$LOG"

if [ -t 1 ]; then
  G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; D=$'\e[2m'; N=$'\e[0m'
else G=""; R=""; Y=""; C=""; B=""; D=""; N=""; fi

PASS=0; WARN=0; FAIL=0; SKIP=0; TOTAL=0; BLOCK=0
FAIL_LIST=(); WARN_LIST=()
ENVT="unknown"; SUDO=""; ARCH="$(uname -m)"; PORT=3000

# A fixed link (named tunnel / domain) already configured: keep it, do not create a quick tunnel
if [ -f "$APP_DIR/.public-url-fixed" ] && [ -z "$DOMAIN" ]; then NO_TUNNEL=1; KEEP_FIXED=1; else KEEP_FIXED=0; fi
[ -n "$DOMAIN" ] && NO_TUNNEL=1

# ---------------------------------------------------------------- UI helpers
header() {
  echo ""
  echo "  ${G}${B}+------------------------------------------------------${N}"
  echo "  ${G}${B}|${N}  ${B}OTP BOT SERVER${N}  ${D}-${N}  Premium Installer"
  echo "  ${G}${B}|${N}  ${D}WhatsApp OTP Gateway | Admin Panel | 24/7 Host${N}"
  echo "  ${G}${B}+------------------------------------------------------${N}"
  echo ""
}
spin() {
  [ -t 1 ] || return 0
  local pid=$1 i=0 chars='|/-\'
  while kill -0 "$pid" 2>/dev/null; do
    printf '%s' "${chars:i%4:1}"; sleep 0.15; printf '\b'; i=$((i+1))
  done
}
# step "label" must|opt function
step() {
  local label="$1" sev="$2"; shift 2
  TOTAL=$((TOTAL+1))
  printf "  ${C}>${N} %-46s" "$label"
  if [ "$BLOCK" = "1" ]; then SKIP=$((SKIP+1)); printf "${D}SKIP${N}\n"; return 1; fi
  { echo ""; echo "=== [$label] ==="; } >> "$LOG"
  if [ "$DRY" = "1" ]; then PASS=$((PASS+1)); printf "${Y}DRY${N}\n"; return 0; fi
  local t0=$SECONDS rc
  "$@" < /dev/null > "$STEPTMP" 2>&1 &
  local pid=$!
  spin "$pid"
  wait "$pid"; rc=$?
  cat "$STEPTMP" >> "$LOG"
  local dur=$((SECONDS-t0))
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS+1)); printf "${G}PASS${N} ${D}%ss${N}\n" "$dur"; return 0
  fi
  local why; why="$(grep -v '^[[:space:]]*$' "$STEPTMP" | tail -n 4 | cut -c1-120)"
  if [ "$sev" = "opt" ]; then
    WARN=$((WARN+1)); WARN_LIST+=("$label"$'\n'"$why"); printf "${Y}WARN${N} ${D}%ss${N}\n" "$dur"
  else
    FAIL=$((FAIL+1)); FAIL_LIST+=("$label"$'\n'"$why"); BLOCK=1; printf "${R}FAIL${N} ${D}%ss${N}\n" "$dur"
  fi
  return 1
}

summary() {
  local done_n=$((PASS+WARN)); local rate=0
  [ "$TOTAL" -gt 0 ] && rate=$((done_n*100/TOTAL))
  echo ""
  echo "  ${B}+- INSTALL REPORT -------------------------------------${N}"
  echo "  ${B}|${N}  ${G}PASS ${PASS}${N}     ${Y}WARN ${WARN}${N}     ${R}FAIL ${FAIL}${N}     ${D}SKIP ${SKIP}${N}"
  echo "  ${B}|${N}  Steps: ${TOTAL}   |   Success rate: ${rate}%"
  echo "  ${B}+--------------------------------------------------------${N}"
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "  ${R}${B}Failed steps:${N}"
    local item
    for item in "${FAIL_LIST[@]}"; do
      echo "   ${R}*${N} ${item%%$'\n'*}"
      echo "${item#*$'\n'}" | sed "s/^/       ${D}/;s/\$/${N}/"
    done
    echo ""
    echo "  ${Y}Full log:${N} $LOG    ${D}(tail -n 40 install.log)${N}"
    echo "  ${Y}Fix the problem and run again:${N} bash install.sh"
  fi
  if [ "$WARN" -gt 0 ]; then
    echo ""
    echo "  ${Y}${B}Warnings (not fatal):${N}"
    local item
    for item in "${WARN_LIST[@]}"; do
      echo "   ${Y}*${N} ${item%%$'\n'*}"
      echo "${item#*$'\n'}" | sed "s/^/       ${D}/;s/\$/${N}/"
    done
  fi
}

# ---------------------------------------------------------------- environment
detect_env() {
  if [[ "${PREFIX:-}" == *com.termux* ]]; then ENVT="termux"
  elif command -v apt-get >/dev/null 2>&1; then ENVT="debian"
  else ENVT="unknown"; fi
  if [ "$ENVT" = "debian" ] && [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
}
get_port() { node -e "try{console.log(require('$APP_DIR/config.json').port||3000)}catch(e){console.log(3000)}" 2>/dev/null || echo 3000; }
get_bot()  { node -e "try{console.log(require('$APP_DIR/config.json').botNumber||'')}catch(e){console.log('')}" 2>/dev/null; }
tunnel_url() {
  pm2 logs "$PM2_TUNNEL" --lines 300 --nostream 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1
}

# ---------------------------------------------------------------- step bodies
f_env()     { [ "$ENVT" != "unknown" ] && { echo "Environment: $ENVT ($ARCH)"; return 0; }; echo "Unsupported OS: Termux or Debian/Ubuntu is required" >&2; return 1; }
f_update()  { case "$ENVT" in termux) pkg update -y ;; debian) $SUDO apt-get update -y ;; esac; }
f_base()    { case "$ENVT" in termux) pkg install -y curl git unzip ;; debian) $SUDO apt-get install -y curl git unzip ca-certificates ;; esac; }
f_net()     { curl -fsS --max-time 20 -o /dev/null https://registry.npmjs.org/ || { echo "No internet access or npm registry unreachable" >&2; return 1; }; echo "registry reachable"; }
f_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)'; then echo "node $(node -v) already installed"; return 0; fi
  case "$ENVT" in
    termux) pkg install -y nodejs-lts ;;
    debian) curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs ;;
  esac
}
f_nodever() { node -e 'const v=+process.versions.node.split(".")[0];console.log("node v"+process.versions.node);process.exit(v>=20?0:1)' || { echo "Node.js 20+ is required" >&2; return 1; }; }
f_files() { local f; for f in server.js package.json public/index.html public/admin.html; do [ -f "$f" ] || { echo "Missing file: $f" >&2; return 1; }; done; echo "All project files present"; }
f_npm() {
  local n=0
  until npm install --omit=dev --no-audit --no-fund; do
    n=$((n+1)); [ "$n" -ge 2 ] && return 1
    echo "npm install failed, retrying ($n)..."; sleep 3
  done
}
f_deps() { node -e "Promise.all([import('@whiskeysockets/baileys'),import('express'),import('pino'),import('qrcode'),import('qrcode-terminal')]).then(()=>console.log('All modules load')).catch(e=>{console.error('Module error: '+e.message);process.exit(1)})"; }
f_syntax() { node --check server.js && echo "server.js syntax OK"; }
f_pm2() { if command -v pm2 >/dev/null 2>&1; then echo "pm2 $(pm2 -v) present"; return 0; fi; $SUDO npm install -g pm2 --no-audit --no-fund; }
f_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then echo "cloudflared present"; return 0; fi
  case "$ENVT" in
    termux) pkg install -y cloudflared ;;
    debian)
      local a
      case "$ARCH" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; armv7l|armv8l) a=arm;; *) echo "Unsupported arch $ARCH" >&2; return 1;; esac
      $SUDO curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" && $SUDO chmod +x /usr/local/bin/cloudflared ;;
  esac
}
f_stopold() {
  # legacy names + the server; the tunnel is only replaced when a new quick tunnel will be created
  pm2 delete "$PM2_APP" otp otp-gateway >/dev/null 2>&1
  rm -f "$APP_DIR/.lock"
  if [ "$NO_TUNNEL" = "0" ]; then
    pm2 delete "$PM2_TUNNEL" >/dev/null 2>&1
    rm -f "$APP_DIR/.public-url" "$HOME/.pm2/logs/$PM2_TUNNEL-"*.log
  fi
  echo "Old instances cleaned"; return 0
}
f_port() { node -e "const s=require('net').createServer();s.once('error',e=>{console.error('Port $PORT is busy ('+e.code+'). Run: pm2 stop all  or  pkill -f node');process.exit(1)});s.listen($PORT,()=>s.close(()=>process.exit(0)))"; }
f_wake() { if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock && echo "wake-lock enabled"; else echo "wake-lock not needed (not Termux)"; fi; }
f_start() { pm2 start server.js --name "$PM2_APP" --max-memory-restart 300M && pm2 save; }
f_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; then echo "health OK (${i}s)"; return 0; fi
    sleep 1
  done
  echo "Server did not answer within 40s. Last log lines:" >&2
  pm2 logs "$PM2_APP" --lines 15 --nostream 2>&1 | tail -n 15 >&2
  return 1
}
f_tunnel() {
  pm2 start cloudflared --interpreter none --name "$PM2_TUNNEL" -- tunnel --protocol http2 --url "http://localhost:$PORT" || return 1
  local i url
  for i in $(seq 1 45); do
    url="$(tunnel_url)"
    if [ -n "$url" ]; then echo "$url" > "$APP_DIR/.public-url"; echo "public: $url"; pm2 save >/dev/null 2>&1; return 0; fi
    sleep 1
  done
  echo "No tunnel link within 45s. See: pm2 logs $PM2_TUNNEL" >&2; return 1
}
f_boot() {
  if [ "$ENVT" != "termux" ]; then echo "To start on server reboot run: pm2 startup  (then run the command it prints)"; return 0; fi
  mkdir -p "$HOME/.termux/boot" || return 1
  printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\nsleep 15\npm2 resurrect\n' > "$HOME/.termux/boot/otp-bot.sh"
  chmod +x "$HOME/.termux/boot/otp-bot.sh" && echo "Boot script ready (install the Termux:Boot app and open it once)"
}
# ---- VPS + domain (HTTPS via Caddy)
f_domain_ok() { [ "$ENVT" = "debian" ] || { echo "--domain works on Debian/Ubuntu servers only" >&2; return 1; }; }
f_caddy() {
  if command -v caddy >/dev/null 2>&1; then echo "caddy present"; return 0; fi
  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg curl || return 1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || return 1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null || return 1
  $SUDO apt-get update -y && $SUDO apt-get install -y caddy
}
f_caddyconf() {
  printf '%s {\n    encode gzip\n    reverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" | $SUDO tee /etc/caddy/Caddyfile >/dev/null || return 1
  if command -v ufw >/dev/null 2>&1; then $SUDO ufw allow 80/tcp >/dev/null 2>&1; $SUDO ufw allow 443/tcp >/dev/null 2>&1; fi
  $SUDO systemctl enable --now caddy >/dev/null 2>&1
  $SUDO systemctl reload caddy || $SUDO systemctl restart caddy || return 1
  echo "https://$DOMAIN" > "$APP_DIR/.public-url-fixed"
  echo "Caddy configured for $DOMAIN"
}
f_dnscheck() {
  local ip dip
  ip="$(curl -fsS --max-time 10 https://api.ipify.org)" || { echo "Cannot detect this server's public IP" >&2; return 1; }
  dip="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n 1)"
  [ -n "$dip" ] || { echo "$DOMAIN does not resolve yet. Create an A record pointing to $ip" >&2; return 1; }
  [ "$dip" = "$ip" ] || { echo "$DOMAIN points to $dip but this server is $ip (ignore if you use a proxy such as Cloudflare)" >&2; return 1; }
  echo "DNS OK: $DOMAIN -> $ip"
}

# ---------------------------------------------------------------- selftest (UI preview)
if [ "$SELFTEST" = "1" ]; then
  header
  f_a() { echo ok; }
  f_b() { echo "sample warning: optional tool missing" >&2; return 1; }
  f_c() { echo "ERR! sample failure: network unreachable" >&2; echo "line 2 of error" >&2; return 1; }
  step "Sample passing step" must f_a
  step "Sample optional step (fails)" opt f_b
  step "Sample critical step (fails)" must f_c
  step "Step after failure" must f_a
  summary; rm -f "$STEPTMP"; exit 0
fi

# ---------------------------------------------------------------- main flow
header
detect_env
step "Detect environment ($ENVT)"                    must f_env
step "Update package index"                          opt  f_update
step "Install base tools (curl, git, unzip)"         must f_base
step "Check internet / npm registry"                 must f_net
step "Install Node.js (v20+)"                        must f_node
step "Verify Node.js version"                        must f_nodever
PORT="$(get_port)"
step "Verify project files"                          must f_files
step "Install npm dependencies"                      must f_npm
step "Verify modules load (baileys, express...)"     must f_deps
step "Syntax check server.js"                        must f_syntax
step "Install pm2 process manager"                   must f_pm2
step "Stop previous instances"                       opt  f_stopold
step "Check port $PORT is free"                      must f_port
[ "$NO_TUNNEL" = "0" ] && step "Install cloudflared (public link)"  opt  f_cloudflared
step "Enable wake-lock"                              opt  f_wake
step "Start $APP_NAME (pm2, 24/7)"                   must f_start
step "Server health check"                           must f_health
[ "$NO_TUNNEL" = "0" ] && step "Start public tunnel (https link)"   opt  f_tunnel
if [ -n "$DOMAIN" ]; then
  step "Check server type for --domain"              must f_domain_ok
  step "Install Caddy (HTTPS reverse proxy)"         must f_caddy
  step "Configure Caddy for $DOMAIN"                 must f_caddyconf
  step "Check DNS points to this server"             opt  f_dnscheck
fi
step "Enable auto-start on reboot"                   opt  f_boot

summary
rm -f "$STEPTMP"

if [ "$FAIL" -eq 0 ] && [ "$DRY" = "0" ]; then
  PUB=""
  [ -f "$APP_DIR/.public-url-fixed" ] && PUB="$(cat "$APP_DIR/.public-url-fixed")"
  [ -z "$PUB" ] && [ -f "$APP_DIR/.public-url" ] && PUB="$(cat "$APP_DIR/.public-url")"
  BOT="$(get_bot)"
  echo ""
  echo "  ${G}${B}$APP_NAME is LIVE${N}"
  echo "  ${B}Local   ${N}: http://localhost:$PORT"
  [ -n "$PUB" ] && echo "  ${B}Public  ${N}: $PUB"
  echo "  ${B}Admin   ${N}: ${PUB:-http://localhost:$PORT}/admin.html"
  echo "  ${B}Bot no. ${N}: +$BOT"
  [ "$KEEP_FIXED" = "1" ] && echo "  ${D}(existing fixed link kept)${N}"
  echo ""
  echo "  ${C}${B}Next steps:${N}"
  echo "   1) Open the Admin link in a browser and press \"Request code\""
  echo "   2) The admin code appears in this terminal:  ${B}bash manage.sh code${N}"
  echo "   3) In Admin, create a pairing code / QR and link WhatsApp (keep Termux in split-screen)"
  echo "   ${D}Terminal mein code aayega, Admin page par likh kar login karein.${N}"
  echo ""
  if [ -n "$PUB" ] && [ ! -f "$APP_DIR/.public-url-fixed" ]; then
    echo "  ${Y}Note:${N} a quick-tunnel link changes after restarts and may not open in some countries."
    echo "        For a permanent link read GUIDE.md (section: Public link)."
    echo ""
  fi
  echo "  ${D}Manage: bash manage.sh status | logs | code | restart | url | tunnel | update <zip>${N}"
  echo ""
fi
[ "$FAIL" -eq 0 ] || exit 1
exit 0
