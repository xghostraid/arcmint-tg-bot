#!/bin/bash
# Optional: prevent Mac sleep while the bot should stay online (AC power recommended).
# Run: nohup ./scripts/keep-awake.sh >/tmp/arctrade-caffeinate.log 2>&1 &
exec caffeinate -dims -w "$(pgrep -f 'tsx src/index' | head -1 || echo $$)"
