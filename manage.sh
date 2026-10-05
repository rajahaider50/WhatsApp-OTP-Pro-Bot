#!/usr/bin/env bash
# OTP Bot Pro v2.0 - Management Script
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_APP="otp-bot-pro"
PM2_TUNNEL="otp-bot-tunnel"
PORT="$(node -e "try{console.log(require('$APP_DIR/config.json').port||3000)}catch(e){console.log(3000)}" 2>/dev/null || echo 3000)"

tunnel_url() {
  pm2 logs "$PM2_TUNNEL" --lines 300 --nostream 2>&1 | \
    sed 's/\x1b\[[0-9;]*m//g' | \
    grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1
}

case "${1:-help}" in
  status)
    pm2 status
    echo ""
    curl -s --max-time 4 "http://127.0.0.1:$PORT/health" | \
      node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log('Server: '+j.name+' v'+j.version+' | status='+j.status+' ready='+j.ready)}catch{console.log('Server not responding')}})" 2>/dev/null || echo "Server not responding"
    echo ""
    ;;
  logs)
    pm2 logs "$PM2_APP" --lines "${2:-50}"
    ;;
  code)
    echo "Press 'Request code' on Admin page. Code appears below (Ctrl+C to exit):"
    pm2 logs "$PM2_APP" --lines 0
    ;;
  restart)
    pm2 restart "$PM2_APP"
    echo "Restarting..."
    ;;
  stop)
    pm2 stop "$PM2_APP" "$PM2_TUNNEL" 2>/dev/null
    echo "Stopped."
    ;;
  start)
    pm2 start "$PM2_APP" 2>/dev/null || \
      (cd "$APP_DIR" && pm2 start server.js --name "$PM2_APP" --max-memory-restart 300M)
    pm2 start "$PM2_TUNNEL" 2>/dev/null
    pm2 save
    echo "Started."
    ;;
  url)
    if [ -f "$APP_DIR/.public-url-fixed" ]; then
      PUB="$(cat "$APP_DIR/.public-url-fixed")"
    else
      PUB="$(tunnel_url)"
      [ -n "$PUB" ] && echo "$PUB" > "$APP_DIR/.public-url"
    fi
    echo "Local  : http://localhost:$PORT"
    echo "Public : ${PUB:-(no tunnel - run: bash manage.sh tunnel)}"
    echo "Admin  : ${PUB:-http://localhost:$PORT}/admin.html"
    echo "Signup : ${PUB:-http://localhost:$PORT}/"
    ;;
  tunnel)
    rm -f "$APP_DIR/.public-url-fixed"
    pm2 delete "$PM2_TUNNEL" >/dev/null 2>&1
    rm -f "$HOME/.pm2/logs/$PM2_TUNNEL-"*.log
    pm2 start cloudflared --interpreter none --name "$PM2_TUNNEL" \
      -- tunnel --protocol http2 --url "http://localhost:$PORT" >/dev/null
    echo "Creating public link..."
    for i in $(seq 1 45); do
      PUB="$(tunnel_url)"
      [ -n "$PUB" ] && break
      sleep 1
    done
    if [ -n "$PUB" ]; then
      echo "$PUB" > "$APP_DIR/.public-url"
      pm2 save >/dev/null
      echo ""
      echo "Public : $PUB"
      echo "Admin  : $PUB/admin.html"
    else
      echo "No link yet. See: pm2 logs $PM2_TUNNEL"
    fi
    ;;
  fixed-link)
    TOKEN="$2"; FHOST="$3"
    if [ -z "$TOKEN" ] || [ -z "$FHOST" ]; then
      echo "Usage: bash manage.sh fixed-link <TUNNEL_TOKEN> <hostname>"
      echo "Example: bash manage.sh fixed-link eyJhbG... otp.mysite.com"
      exit 1
    fi
    case "$FHOST" in https://*) ;; *) FHOST="https://$FHOST" ;; esac
    pm2 delete "$PM2_TUNNEL" >/dev/null 2>&1
    TUNNEL_TOKEN="$TOKEN" pm2 start cloudflared --interpreter none \
      --name "$PM2_TUNNEL" -- tunnel --no-autoupdate --protocol http2 run >/dev/null
    echo "$FHOST" > "$APP_DIR/.public-url-fixed"
    pm2 save >/dev/null
    echo "Fixed link set: $FHOST"
    ;;
  quick-link)
    rm -f "$APP_DIR/.public-url-fixed"
    bash "$0" tunnel
    ;;
  reset-wa)
    echo "Removing ALL WhatsApp sessions (all bots)..."
    pm2 stop "$PM2_APP" >/dev/null 2>&1
    rm -rf "$APP_DIR/auth"
    pm2 start "$PM2_APP" >/dev/null 2>&1
    echo "Done. Open Admin and create new pairing codes."
    ;;
  reset-bot)
    BOT_ID="${2:-bot0}"
    echo "Removing WhatsApp session for bot: $BOT_ID"
    pm2 stop "$PM2_APP" >/dev/null 2>&1
    rm -rf "$APP_DIR/auth/$BOT_ID"
    pm2 start "$PM2_APP" >/dev/null 2>&1
    echo "Done. Open Admin > Bots > New Pairing Code for $BOT_ID"
    ;;
  update)
    ZIP="${2:-$HOME/storage/downloads/WhatsApp-OTP-Bot.zip}"
    [ -f "$ZIP" ] || { echo "Zip not found: $ZIP"; exit 1; }
    echo "Stopping server..."
    pm2 stop "$PM2_APP" >/dev/null 2>&1
    echo "Extracting..."
    cd "$HOME" && unzip -o "$ZIP" >/dev/null && cd "$APP_DIR" || exit 1
    echo "Installing dependencies..."
    npm install --omit=dev --no-audit --no-fund
    echo "Starting..."
    pm2 start "$PM2_APP" >/dev/null 2>&1
    echo "Update complete!"
    bash "$0" url
    ;;
  pull)
    echo "Pulling latest code from GitHub..."
    git pull origin main
    echo "Installing any new dependencies..."
    npm install --omit=dev --no-audit --no-fund
    echo "Restarting server..."
    pm2 restart "$PM2_APP" 2>/dev/null || pm2 start server.js --name "$PM2_APP"
    echo "Server successfully updated with latest GitHub code!"
    ;;
  health)
    curl -s "http://127.0.0.1:$PORT/health" | python3 -m json.tool 2>/dev/null || \
      curl -s "http://127.0.0.1:$PORT/health"
    echo ""
    ;;
  *)
    cat <<USAGE
OTP Bot Pro v2.0 - Management Script
=====================================
Usage: bash manage.sh <command>

BASIC:
  status               Show pm2 processes and server health
  logs [n]             Live server log (last n lines)
  code                 Watch log for admin verification code
  health               Show /health endpoint JSON

CONTROL:
  restart              Restart the server
  pull                 Pull latest code from GitHub and restart
  stop                 Stop server and tunnel
  start                Start server and tunnel

LINKS:
  url                  Show Local / Public / Admin links
  tunnel               Create a NEW quick Cloudflare tunnel link
  fixed-link TOKEN HOST  Set a permanent Cloudflare named tunnel
  quick-link           Switch back to a quick tunnel link

WHATSAPP:
  reset-wa             Remove ALL WhatsApp sessions (re-link all bots)
  reset-bot [id]       Remove session for one bot (default: bot0)

MAINTENANCE:
  update [zip]         Update from a new zip file
USAGE
    ;;
esac
