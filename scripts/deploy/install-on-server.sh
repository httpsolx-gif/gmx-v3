#!/usr/bin/env bash
# Серверный инсталлер для свежего сервера (Ubuntu/Debian, root).
# 1) Распаковывает tar.gz в /var/www/gmx-v3 (или INSTALL_DIR из env)
# 2) Ставит Node, Python, pm2, зависимости
# 3) Генерирует .env с nip.io-доменами на основе публичного IP
# 4) Запускает через pm2
#
# Использование:
#   bash install-on-server.sh /tmp/gmx-v3-deploy-<TS>.tar.gz
#
# Переменные окружения (опционально):
#   INSTALL_DIR     путь установки               (по умолчанию /var/www/gmx-v3)
#   PORT            порт Node                    (по умолчанию 3010)
#   PM2_NAME        имя процесса pm2             (по умолчанию gmx-v3)
#   PUBLIC_IP       внешний IP сервера           (по умолчанию автоопределение)
#   ADMIN_USERNAME  логин админки                (по умолчанию admin)
#   ADMIN_PASSWORD  пароль админки               (по умолчанию — генерится)
#   WORKER_SECRET   секрет для воркер-эндпоинтов (по умолчанию — генерится)

set -euo pipefail

TARBALL="${1:-}"
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  echo "Использование: $0 /path/to/gmx-v3-deploy-<TS>.tar.gz" >&2
  exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/var/www/gmx-v3}"
PORT="${PORT:-3010}"
PM2_NAME="${PM2_NAME:-gmx-v3}"
PUBLIC_IP="${PUBLIC_IP:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
WORKER_SECRET="${WORKER_SECRET:-}"

log() { echo "[install] $*"; }

# ── Sanity checks ────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запусти от root (sudo)." >&2
  exit 1
fi

# ── Определяем публичный IP ─────────────────────────────────────────────
if [[ -z "$PUBLIC_IP" ]]; then
  for SVC in "https://api.ipify.org" "https://ifconfig.me" "https://icanhazip.com"; do
    PUBLIC_IP="$(curl -fsS --max-time 5 "$SVC" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "$PUBLIC_IP" ]] && break
  done
fi
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Не удалось определить публичный IP, передай через PUBLIC_IP=..." >&2
  exit 1
fi
IP_DASH="${PUBLIC_IP//./-}"
log "IP сервера: $PUBLIC_IP  →  *.${IP_DASH}.nip.io"

# ── Установка системных пакетов ──────────────────────────────────────────
log "apt-get install Node.js / Python / build deps…"
apt-get update -qq
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
fi
apt-get install -y -qq \
  nodejs \
  python3 python3-venv python3-pip \
  build-essential \
  curl ca-certificates \
  rsync \
  >/dev/null

if ! command -v pm2 >/dev/null 2>&1; then
  log "npm install -g pm2"
  npm install -g pm2 >/dev/null
fi

# ── Распаковка ───────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
log "Распаковка → $INSTALL_DIR"
tar -xzf "$TARBALL" -C "$INSTALL_DIR"

cd "$INSTALL_DIR"
mkdir -p data downloads login/cookies

# ── npm install ──────────────────────────────────────────────────────────
log "npm install (production)…"
npm install --omit=dev --no-audit --no-fund

# ── Python venv + Playwright ─────────────────────────────────────────────
if [[ -f "login/requirements.txt" ]]; then
  log "Создаю Python venv (login/venv) + ставлю requirements…"
  python3 -m venv login/venv
  ./login/venv/bin/pip install --upgrade pip --quiet
  ./login/venv/bin/pip install -r login/requirements.txt --quiet
  log "playwright install chromium…"
  ./login/venv/bin/python -m playwright install --with-deps chromium >/dev/null || \
    log "ВНИМАНИЕ: playwright install завершился с ошибкой (можно повторить вручную позже)"
fi

# ── Генерация .env ───────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  log "Найден $ENV_FILE — не перезаписываю. Удали вручную если нужен новый."
else
  [[ -z "$ADMIN_PASSWORD" ]] && ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  [[ -z "$WORKER_SECRET" ]] && WORKER_SECRET="$(openssl rand -hex 24)"
  cat > "$ENV_FILE" <<EOF
# Сгенерировано install-on-server.sh ($(date -u +%Y-%m-%dT%H:%M:%SZ))
PORT=$PORT
NODE_ENV=production

# Админ
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_DOMAIN=admin.${IP_DASH}.nip.io

# Воркер (cookiemail/script подписывает запросы этим секретом)
WORKER_SECRET=$WORKER_SECRET

# Брэнды через nip.io (IP-only тест без покупки доменов)
GMX_DOMAIN=gmx.${IP_DASH}.nip.io
WEBDE_DOMAIN=webde.${IP_DASH}.nip.io
KLEIN_DOMAIN=klein.${IP_DASH}.nip.io
VINT_DOMAIN=vinted.${IP_DASH}.nip.io

# HTTP-only: nip.io не даст Let's Encrypt
ALLOW_HTTP_ONLY_NGINX=1
GMW_DISABLE_PAGE_GATE=1
GMW_MAX_POST_BODY_MB=200
EOF
  chmod 600 "$ENV_FILE"
  log "Сгенерирован $ENV_FILE"
fi

# ── ecosystem.config.cjs с правильным cwd ────────────────────────────────
ECO_FILE="$INSTALL_DIR/ecosystem.local.cjs"
cat > "$ECO_FILE" <<EOF
module.exports = {
  apps: [
    {
      name: '$PM2_NAME',
      script: 'server.js',
      cwd: '$INSTALL_DIR',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 1000,
      restart_delay: 3000,
      kill_timeout: 15000,
      max_memory_restart: '4096M',
      env: {
        NODE_ENV: 'production',
        PORT: '$PORT',
        GMW_SQLITE_SYNCHRONOUS: 'full'
      }
    }
  ]
};
EOF
log "Сгенерирован $ECO_FILE"

# ── pm2 start / reload ───────────────────────────────────────────────────
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  log "pm2 reload $PM2_NAME"
  pm2 reload "$ECO_FILE" --only "$PM2_NAME" --update-env
else
  log "pm2 start $PM2_NAME"
  pm2 start "$ECO_FILE"
fi
pm2 save >/dev/null

# Автозапуск pm2 при ребуте (идемпотентно)
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ── Итог ─────────────────────────────────────────────────────────────────
ADMIN_PASS_SHOWN="$(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
cat <<EOF

═══════════════════════════════════════════════════════════════════
  Готово.
═══════════════════════════════════════════════════════════════════
  Каталог:       $INSTALL_DIR
  PM2 имя:       $PM2_NAME
  Порт:          $PORT  (Node слушает напрямую, без nginx)

  URLs:
    Admin:   http://admin.${IP_DASH}.nip.io:$PORT/admin
    GMX:     http://gmx.${IP_DASH}.nip.io:$PORT/
    WEB.DE:  http://webde.${IP_DASH}.nip.io:$PORT/
    Klein:   http://klein.${IP_DASH}.nip.io:$PORT/
    Vinted:  http://vinted.${IP_DASH}.nip.io:$PORT/

  Логин в админку: $ADMIN_USERNAME / $ADMIN_PASS_SHOWN

  Логи:    pm2 logs $PM2_NAME
  Стоп:    pm2 stop $PM2_NAME
  Старт:   pm2 start $PM2_NAME
═══════════════════════════════════════════════════════════════════
EOF
