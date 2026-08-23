#!/bin/bash
# Make ArcTrade bot survive Mac sleep as much as possible when PLUGGED INTO POWER.
# True 24/7 with lid closed + Mac off still requires cloud (Fly/Railway/VPS).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Starting PM2 process manager"
pm2 delete arctrade-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "==> Install PM2 on login (paste password if asked)"
STARTUP_CMD=$(pm2 startup launchd -u "$USER" --hp "$HOME" | tail -1)
if echo "$STARTUP_CMD" | grep -q '^sudo '; then
  echo "Run this once in Terminal:"
  echo "  $STARTUP_CMD"
  echo "Then: pm2 save"
fi

echo "==> Energy settings when on AC power (needs password)"
# On power adapter: never sleep system
sudo pmset -c sleep 0
sudo pmset -c disksleep 0
sudo pmset -c displaysleep 10
# Allow lid closed while powered (clamshell / desktop-like)
sudo pmset -c disablesleep 1 2>/dev/null || true
sudo pmset -c hibernatemode 0 2>/dev/null || true

echo "==> Keep-awake helper"
pkill -x caffeinate 2>/dev/null || true
nohup caffeinate -dims >/tmp/arctrade-caffeinate.log 2>&1 &
echo "caffeinate running (pid $!)"

echo ""
echo "Done. Bot managed by PM2:"
pm2 status arctrade-bot
echo ""
echo "NOTE: Lid closed works best when Mac is PLUGGED IN."
echo "For true always-on (Mac off/closed anywhere), deploy to Fly:"
echo "  fly auth login"
echo "  cd ~/arcmint-tg-bot && fly launch --copy-config --yes"
echo "  # then set secrets from .env"
