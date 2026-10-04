#!/usr/bin/env bash
# OTP Bot Server - management helper
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_APP="otp-bot-server"; PM2_TUNNEL="otp-bot-tunnel"
PORT="$(node -e "try{console.log(require('$APP_DIR/config.json').port||3000)}catch(e){console.log(3000)}" 2>/dev/null || echo 3000)"
tunnel_url() { pm2 logs "$PM2_TUNNEL" --lines 300 --nostream 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1; }

case "${1:-help}" in
  status)
    pm2 status
    echo ""; curl -s --max-time 4 "http://127.0.0.1:$PORT/health" || echo "Server is not answering"; echo ;;
  logs)    pm2 logs "$PM2_APP" --lines "${2:-40}" ;;
  code)
    echo "Press \"Request code\" on the Admin page. The code appears below (Ctrl+C to leave):"
    pm2 logs "$PM2_APP" --lines 0 ;;
  restart) pm2 restart "$PM2_APP" ;;
  stop)    pm2 stop "$PM2_APP" "$PM2_TUNNEL" ;;
  start)   pm2 start "$PM2_APP" 2>/dev/null || (cd "$APP_DIR" && pm2 start server.js --name "$PM2_APP"); pm2 start "$PM2_TUNNEL" 2>/dev/null; pm2 save ;;
  url)
    if [ -f "$APP_DIR/.public-url-fixed" ]; then u="$(cat "$APP_DIR/.public-url-fixed")"
    else u="$(tunnel_url)"; [ -n "$u" ] && echo "$u" > "$APP_DIR/.public-url"; fi
    echo "Local  : http://localhost:$PORT"
    echo "Public : ${u:-(no tunnel running: bash manage.sh tunnel)}"
    echo "Admin  : ${u:-http://localhost:$PORT}/admin.html" ;;
  tunnel)
    # New quick-tunnel link (the old quick link stops working)
    rm -f "$APP_DIR/.public-url-fixed"
    pm2 delete "$PM2_TUNNEL" >/dev/null 2>&1; rm -f "$HOME/.pm2/logs/$PM2_TUNNEL-"*.log
    pm2 start cloudflared --interpreter none --name "$PM2_TUNNEL" -- tunnel --protocol http2 --url "http://localhost:$PORT" >/dev/null
    echo "Creating link..."; for i in $(seq 1 45); do u="$(tunnel_url)"; [ -n "$u" ] && break; sleep 1; done
    if [ -n "$u" ]; then echo "$u" > "$APP_DIR/.public-url"; pm2 save >/dev/null; echo "Public: $u"; else echo "No link yet. See: pm2 logs $PM2_TUNNEL"; fi ;;
  fixed-link)
    # Permanent link with a Cloudflare named tunnel. Usage: bash manage.sh fixed-link <TOKEN> <hostname>
    TOKEN="$2"; HOST="$3"
    if [ -z "$TOKEN" ] || [ -z "$HOST" ]; then echo "Usage: bash manage.sh fixed-link <TUNNEL_TOKEN> <hostname, e.g. otp.example.com>"; exit 1; fi
    case "$HOST" in https://*) ;; *) HOST="https://$HOST" ;; esac
    pm2 delete "$PM2_TUNNEL" >/dev/null 2>&1
    TUNNEL_TOKEN="$TOKEN" pm2 start cloudflared --interpreter none --name "$PM2_TUNNEL" -- tunnel --no-autoupdate --protocol http2 run >/dev/null
    echo "$HOST" > "$APP_DIR/.public-url-fixed"; pm2 save >/dev/null
    echo "Fixed link set: $HOST"
    echo "Make sure the Cloudflare tunnel has a Public Hostname pointing to http://localhost:$PORT" ;;
  quick-link)
    rm -f "$APP_DIR/.public-url-fixed"; bash "$0" tunnel ;;
  reset-wa)
    # Remove the WhatsApp link (you will have to link again from Admin)
    pm2 stop "$PM2_APP" >/dev/null 2>&1; rm -rf "$APP_DIR/auth"; pm2 start "$PM2_APP" >/dev/null 2>&1
    echo "WhatsApp session removed. Open Admin and create a new pairing code." ;;
  update)
    ZIP="${2:-$HOME/storage/downloads/WhatsApp-OTP-Bot.zip}"
    [ -f "$ZIP" ] || { echo "Zip not found: $ZIP"; exit 1; }
    pm2 stop "$PM2_APP" >/dev/null 2>&1
    cd "$HOME" && unzip -o "$ZIP" >/dev/null && cd "$APP_DIR" || exit 1
    bash install.sh --no-tunnel ;;
  *)
    cat <<USAGE
Usage: bash manage.sh <command>
  status                 show processes and health
  logs [n]               server log (last n lines, live)
  code                   watch the log to read the admin verification code
  restart | stop | start restart / stop / start the server (and tunnel)
  url                    show local / public / admin links
  tunnel                 create a NEW quick-tunnel link
  fixed-link TOKEN HOST  permanent link via Cloudflare named tunnel
  quick-link             go back to a quick-tunnel link
  reset-wa               remove the WhatsApp link (link again from Admin)
  update [zip]           update from a new zip (keeps config + WhatsApp link)
USAGE
    ;;
esac
