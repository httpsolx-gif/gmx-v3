#!/usr/bin/env bash
set -euo pipefail

APP_NAME="gmx-net"
ECOSYSTEM_FILE="ecosystem.config.cjs"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 не найден. Установите: npm i -g pm2"
  exit 1
fi

# Важно: `pm2 restart ИМЯ` не перечитывает ecosystem — max_memory_restart и др. остаются
# старыми из `pm2 save` (частый случай: лимит ~700M → рестарты при ~880M RSS).
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$ECOSYSTEM_FILE" --only "$APP_NAME" --update-env
else
  pm2 start "$ECOSYSTEM_FILE" --only "$APP_NAME" --update-env
fi

pm2 save
echo "OK: $APP_NAME запущен как daemon через PM2."
