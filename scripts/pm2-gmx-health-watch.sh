#!/usr/bin/env bash
# Проверка gmx-net: HTTP /health + статус PM2. При сбое — снимок логов в data/pm2-watch-alert.log и опционально reload ecosystem.
# Cron (каждые 3 мин): */3 * * * * /var/www/gmx-net.help-v2/scripts/pm2-gmx-health-watch.sh >>/var/www/gmx-net.help-v2/data/pm2-watch-cron.log 2>&1
# Установка cron: bash scripts/install-pm2-watch-cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${PM2_WATCH_APP_NAME:-gmx-net}"
ECOSYSTEM="${ROOT}/ecosystem.config.cjs"
STATE="${ROOT}/data/pm2-watch.state"
LOG="${ROOT}/data/pm2-watch.log"
ALERT="${ROOT}/data/pm2-watch-alert.log"
AUTO_RELOAD="${PM2_WATCH_AUTO_RELOAD:-1}"

PORT="3001"
if [[ -f "${ROOT}/.env" ]]; then
  line="$(grep -E '^[[:space:]]*PORT=' "${ROOT}/.env" | tail -1 || true)"
  if [[ -n "${line}" ]]; then
    v="${line#*=}"
    v="${v%\"}"
    v="${v#\"}"
    v="${v%\'}"
    v="${v#\'}"
    v="$(echo "$v" | tr -d '[:space:]')"
    [[ -n "$v" ]] && PORT="$v"
  fi
fi

mkdir -p "${ROOT}/data"
ts="$(date -Iseconds)"

health_code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 8 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "000")"

pm_status="missing"
if command -v pm2 >/dev/null 2>&1; then
  pm_status="$(node -e "
    try {
      const { execSync } = require('child_process');
      const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
      const p = j.find(function (x) { return x && x.name === '${APP_NAME}'; });
      process.stdout.write(p && p.pm2_env && p.pm2_env.status ? p.pm2_env.status : 'missing');
    } catch (e) { process.stdout.write('error'); }
  " 2>/dev/null || echo "error")"
fi

ok=1
[[ "$health_code" == "200" ]] || ok=0
[[ "$pm_status" == "online" ]] || ok=0

if [[ "$ok" -eq 1 ]]; then
  echo "${ts} OK health=${health_code} pm2=${pm_status}" >>"$LOG"
  echo "0" >"$STATE"
  exit 0
fi

echo "${ts} ALERT health=${health_code} pm2=${pm_status}" >>"$LOG"
{
  echo "======== ${ts} health=${health_code} pm2=${pm_status} ========"
  pm2 describe "$APP_NAME" 2>/dev/null || true
  echo "---- ${ROOT}/data/server-fatal.log (tail) ----"
  tail -n 30 "${ROOT}/data/server-fatal.log" 2>/dev/null || echo "(нет)"
  echo "---- pm2 error (tail) ----"
  tail -n 60 "${HOME}/.pm2/logs/${APP_NAME}-error-0.log" 2>/dev/null || true
  echo "---- pm2 out (tail) ----"
  tail -n 40 "${HOME}/.pm2/logs/${APP_NAME}-out-0.log" 2>/dev/null || true
  echo ""
} >>"$ALERT"

prev=0
[[ -f "$STATE" ]] && prev="$(cat "$STATE" 2>/dev/null || echo 0)"
echo "$((prev + 1))" >"$STATE"

if [[ "$AUTO_RELOAD" == "1" ]] && [[ -f "$ECOSYSTEM" ]] && command -v pm2 >/dev/null 2>&1; then
  echo "${ts} attempting pm2 reload via ecosystem..." >>"$LOG"
  pm2 reload "$ECOSYSTEM" --only "$APP_NAME" --update-env >>"$LOG" 2>&1 || true
  pm2 save >>"$LOG" 2>&1 || true
  sleep 6
  health2="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 8 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "000")"
  if [[ "$health2" == "200" ]]; then
    echo "${ts} recovered health=200 after reload" >>"$LOG"
    echo "0" >"$STATE"
    exit 0
  fi
fi

exit 1
