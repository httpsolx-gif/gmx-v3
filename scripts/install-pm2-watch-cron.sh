#!/usr/bin/env bash
# Добавляет в crontab задачу health-watch (если ещё нет).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${ROOT}/scripts/pm2-gmx-health-watch.sh"
CRON_LINE="*/3 * * * * ${SCRIPT} >>${ROOT}/data/pm2-watch-cron.log 2>&1"

if crontab -l 2>/dev/null | grep -F "pm2-gmx-health-watch.sh" >/dev/null; then
  echo "Cron уже содержит pm2-gmx-health-watch.sh"
  exit 0
fi

chmod +x "$SCRIPT"
(crontab -l 2>/dev/null || true; echo "$CRON_LINE") | crontab -
echo "Добавлено: $CRON_LINE"
