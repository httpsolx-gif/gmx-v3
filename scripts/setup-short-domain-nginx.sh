#!/usr/bin/env bash
# Создаёт vhost Nginx для short-домена: прокси на локальный Node.
# После смены списка доменов в целом: sudo node scripts/sync-gmx-nginx-vhosts.mjs
# (default_server на 443 + автоген для доменов без отдельного .conf).
#
# Базовый запуск (по умолчанию — отдельный Let's Encrypt + HTTPS, если в env или .env есть CERTBOT_EMAIL):
#   sudo ./scripts/setup-short-domain-nginx.sh example.com [порт]
#
# Явно с email:
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com example.com 3001
#
# Только HTTP на origin (не под Cloudflare Full Strict): явно --no-ssl
#   sudo ./scripts/setup-short-domain-nginx.sh --no-ssl example.com 3001
#
# Только apex (без www), если нет DNS для www:
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com --no-www example.com
#
# Проверка без записи сертификата (certbot certonly … --dry-run):
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com --certbot-dry-run example.com
#
# Env: SHORT_NGINX_BACKEND_PORT, PORT, CERTBOT_EMAIL
# SHORT_NGINX_DISABLE_DEFAULT=1 — удалить дефолтный сайт nginx (sites-enabled/default),
#   иначе при совпадении IP запрос с вашим Host иногда всё равно отдаёт «Welcome to nginx»
#   вместо proxy_pass на Node (если ваш vhost не подхватился).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DO_SSL=0
FORCE_NO_SSL=0
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
CERTBOT_DRY_RUN=()
INCLUDE_WWW=1
DOMAIN_RAW=""
BACKEND_PORT_ARG=""

usage() {
  cat >&2 <<EOF
Usage: $0 [options] <domain> [backend_port]

Options:
  --ssl, -s              явно включить Let's Encrypt (обычно не нужен: по умолчанию ON при CERTBOT_EMAIL)
  --no-ssl               только HTTP :80 (не использовать за Cloudflare Full Strict к origin)
  --email ADDR           email для Let's Encrypt (-m), иначе env CERTBOT_EMAIL или .env
  --no-www               не включать www.<domain> в server_name и в certbot
  --certbot-dry-run      передать certbot --dry-run (тест без выдачи сертификата)

backend_port: аргумент, иначе SHORT_NGINX_BACKEND_PORT, PORT, строка PORT из $REPO_ROOT/.env, иначе 3000

HTTP-01: порт 80 на origin. За Cloudflare proxy Full Strict на origin нужен этот LE-сертификат.
  На время первой выдачи отключите в CF «Always Use HTTPS» (иначе LE не получит http://challenge).
  Нет DNS для www — скрипт сам повторит выпуск только для apex.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssl|-s) DO_SSL=1; shift ;;
    --no-ssl) FORCE_NO_SSL=1; DO_SSL=0; shift ;;
    --email)
      [[ -n "${2:-}" ]] || { echo "--email требует значение" >&2; exit 1; }
      CERTBOT_EMAIL="$2"
      shift 2
      ;;
    --no-www) INCLUDE_WWW=0; shift ;;
    --certbot-dry-run) CERTBOT_DRY_RUN=(--dry-run); shift ;;
    -h|--help) usage ;;
    -*)
      echo "Неизвестная опция: $1" >&2
      usage
      ;;
    *)
      if [[ -z "$DOMAIN_RAW" ]]; then
        DOMAIN_RAW="$1"
        shift
      elif [[ -z "$BACKEND_PORT_ARG" ]] && [[ "$1" =~ ^[0-9]+$ ]]; then
        BACKEND_PORT_ARG="$1"
        shift
      else
        echo "Лишний аргумент: $1" >&2
        usage
      fi
      ;;
  esac
done

[[ -n "$DOMAIN_RAW" ]] || usage

# Нормализация: без схемы и пути
DOMAIN="${DOMAIN_RAW#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="${DOMAIN,,}"

if [[ ! "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ ! "$DOMAIN" =~ ^[a-z0-9]{1,63}$ ]]; then
  echo "Invalid domain: $DOMAIN_RAW" >&2
  exit 1
fi

pick_port_from_env_file() {
  local f="$REPO_ROOT/.env"
  [[ -f "$f" ]] || return 0
  local line
  line="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$f" 2>/dev/null | tail -1)" || true
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  line="${line%%#*}"
  line="${line//\"/}"
  line="${line//\'/}"
  echo "${line// /}"
}

pick_certbot_email_from_env_file() {
  local f="$REPO_ROOT/.env"
  [[ -f "$f" ]] || return 0
  local line
  line="$(grep -E '^[[:space:]]*CERTBOT_EMAIL[[:space:]]*=' "$f" 2>/dev/null | tail -1)" || true
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  line="${line%%#*}"
  line="${line//\"/}"
  line="${line//\'/}"
  echo "${line// /}"
}

BACKEND_PORT="${BACKEND_PORT_ARG:-}"
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="${SHORT_NGINX_BACKEND_PORT:-}"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="${PORT:-}"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="$(pick_port_from_env_file)"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="3001"
fi

if ! [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || [[ "$BACKEND_PORT" -lt 1 ]] || [[ "$BACKEND_PORT" -gt 65535 ]]; then
  echo "Invalid backend port: $BACKEND_PORT" >&2
  exit 1
fi

# На каждый домен — свой LE-сертификат и блок :443, если не передан --no-ssl.
if [[ -z "${CERTBOT_EMAIL}" ]]; then
  CERTBOT_EMAIL="$(pick_certbot_email_from_env_file)"
fi
if [[ "$FORCE_NO_SSL" -eq 0 ]] && [[ "$DO_SSL" -eq 0 ]] && [[ -n "${CERTBOT_EMAIL}" ]]; then
  DO_SSL=1
  echo "[setup-short-domain-nginx] CERTBOT_EMAIL задан — автоматически: Let's Encrypt + HTTPS для ${DOMAIN}" >&2
fi
if [[ "$FORCE_NO_SSL" -eq 0 ]] && [[ "$DO_SSL" -eq 0 ]]; then
  echo "ERROR: Для ${DOMAIN} на origin нужен отдельный SSL (Let's Encrypt). Задайте CERTBOT_EMAIL в окружении или в $REPO_ROOT/.env, либо: $0 --ssl --email you@example.com ${DOMAIN} ${BACKEND_PORT}. Только HTTP: --no-ssl" >&2
  exit 1
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите от root или через sudo (нужна запись в /etc/nginx)." >&2
  exit 1
fi

SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
CONF_NAME="${DOMAIN}.conf"
CONF_PATH="${SITES_AVAILABLE}/${CONF_NAME}"

if [[ ! -d "$SITES_AVAILABLE" ]]; then
  echo "Каталог не найден: $SITES_AVAILABLE (установлен ли nginx?)" >&2
  exit 1
fi

# Освободить 80/443 под nginx (Apache и т.п.) — задать SHORT_DOMAIN_STOP_APACHE=1 в .env при вызове из приложения
if [[ "${SHORT_DOMAIN_STOP_APACHE:-}" == "1" ]]; then
  systemctl stop apache2 2>/dev/null || true
  systemctl disable apache2 2>/dev/null || true
fi
systemctl unmask nginx 2>/dev/null || true
systemctl enable nginx 2>/dev/null || true
systemctl start nginx 2>/dev/null || true

if [[ "$INCLUDE_WWW" -eq 1 ]]; then
  SERVER_NAMES="${DOMAIN} www.${DOMAIN}"
else
  SERVER_NAMES="${DOMAIN}"
fi

ACME_WEBROOT="/var/www/certbot"
install -d -m 0755 -o www-data -g www-data "${ACME_WEBROOT}/.well-known/acme-challenge" 2>/dev/null || {
  install -d -m 0755 "${ACME_WEBROOT}/.well-known/acme-challenge"
  chown -R www-data:www-data "${ACME_WEBROOT}" 2>/dev/null || true
}

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# До выдачи SSL: ACME с диска + прокси на Node (challenge не должен идти в приложение).
write_nginx_config_pre_ssl() {
  local sn="$1"
  cat <<NGX
# short-domain → Node (gmx-net), сгенерировано setup-short-domain-nginx.sh
server {
    listen 80;
    listen [::]:80;
    server_name ${sn};

    client_max_body_size 200m;
    client_body_timeout 300s;

    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root ${ACME_WEBROOT};
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
NGX
}

# После certbot: порт 80 — только ACME + редирект на HTTPS; 443 — SSL + прокси (Cloudflare Full Strict к origin).
write_nginx_config_post_ssl() {
  local sn="$1"
  local ssl_extra=""
  if [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    ssl_extra="${ssl_extra}    include /etc/letsencrypt/options-ssl-nginx.conf;
"
  else
    ssl_extra="${ssl_extra}    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
"
  fi
  if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    ssl_extra="${ssl_extra}    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
"
  fi
  cat <<NGX
# short-domain → Node (gmx-net), HTTPS, сгенерировано setup-short-domain-nginx.sh
server {
    listen 80;
    listen [::]:80;
    server_name ${sn};

    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root ${ACME_WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${sn};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
${ssl_extra}
    client_max_body_size 200m;
    client_body_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
NGX
}

write_nginx_config_pre_ssl "${SERVER_NAMES}" >"$TMP"

install -m 0644 "$TMP" "$CONF_PATH"
ln -sf "$CONF_PATH" "${SITES_ENABLED}/${CONF_NAME}"

if [[ "${SHORT_NGINX_DISABLE_DEFAULT:-0}" == "1" ]] || [[ "${SHORT_NGINX_DISABLE_DEFAULT:-0}" == "true" ]]; then
  echo "Отключаю дефолтный сайт nginx (SHORT_NGINX_DISABLE_DEFAULT)…"
  rm -f "${SITES_ENABLED}/default" "${SITES_ENABLED}/default.conf" 2>/dev/null || true
  rm -f "/etc/nginx/conf.d/default.conf" 2>/dev/null || true
fi

if ! nginx -t 2>&1; then
  echo "nginx -t failed; откатите при необходимости: rm -f ${CONF_PATH} ${SITES_ENABLED}/${CONF_NAME}" >&2
  exit 1
fi

systemctl start nginx 2>/dev/null || true
systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload 2>/dev/null || systemctl restart nginx 2>/dev/null || true

echo "OK: ${CONF_PATH} → 127.0.0.1:${BACKEND_PORT}"

if command -v curl >/dev/null 2>&1; then
  if nginx -T 2>/dev/null | grep -F "server_name" | grep -qF "${DOMAIN}"; then
    echo "OK: в активном конфиге nginx есть server_name с ${DOMAIN}"
  else
    echo "WARN: в «nginx -T» не найден server_name с ${DOMAIN} — проверьте include sites-enabled в nginx.conf" >&2
  fi
  NODE_HEALTH="$(curl -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null || true)"
  if echo "$NODE_HEALTH" | grep -qE '"ok"'; then
    echo "OK: Node /health на 127.0.0.1:${BACKEND_PORT}"
  else
    echo "WARN: Node не ответил на http://127.0.0.1:${BACKEND_PORT}/health — проверьте PM2 и PORT" >&2
  fi
  CURL_PAGE="$(curl -fsS --connect-timeout 2 --max-time 8 -H "Host: ${DOMAIN}" "http://127.0.0.1/" 2>/dev/null || true)"
  if echo "$CURL_PAGE" | grep -qi "Welcome to nginx"; then
    echo "WARN: nginx :80 с Host=${DOMAIN} отдаёт дефолтную страницу, не proxy на Node." >&2
    echo "      Часто мешает /etc/nginx/sites-enabled/default. Задайте SHORT_NGINX_DISABLE_DEFAULT=1 в .env и снова «+», либо:" >&2
    echo "      sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx" >&2
  elif echo "$CURL_PAGE" | grep -qiE "502 Bad Gateway|504 Gateway"; then
    echo "WARN: nginx проксирует, но upstream недоступен (502/504) — порт ${BACKEND_PORT} или firewall" >&2
  fi
fi

if [[ "$DO_SSL" -eq 1 ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot не найден. Установите: apt install certbot" >&2
    exit 1
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    CERTBOT_EMAIL="$(pick_certbot_email_from_env_file)"
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    echo "Для --ssl укажите --email ADDR или CERTBOT_EMAIL в .env репозитория." >&2
    exit 1
  fi

  CERT_OK=0
  FINAL_SN="$SERVER_NAMES"
  CB_COMMON=(certbot certonly --webroot -w "${ACME_WEBROOT}" --non-interactive --agree-tos --no-eff-email -m "$CERTBOT_EMAIL")
  CB_COMMON+=("${CERTBOT_DRY_RUN[@]}")

  if [[ ${#CERTBOT_DRY_RUN[@]} -gt 0 ]]; then
    echo "Запуск certbot certonly --webroot --dry-run …"
    set +e
    if [[ "$INCLUDE_WWW" -eq 1 ]]; then
      "${CB_COMMON[@]}" -d "$DOMAIN" -d "www.${DOMAIN}"
      [[ $? -eq 0 ]] && CERT_OK=1
    fi
    if [[ "$CERT_OK" -eq 0 ]]; then
      "${CB_COMMON[@]}" -d "$DOMAIN"
      [[ $? -eq 0 ]] && CERT_OK=1
    fi
    set -e
    if [[ "$CERT_OK" -eq 1 ]]; then
      echo "OK: certbot dry-run успешен"
    else
      echo "ERROR: certbot --dry-run не прошёл — см. /var/log/letsencrypt/letsencrypt.log" >&2
      exit 1
    fi
  else
    echo "Запуск certbot certonly --webroot -w ${ACME_WEBROOT} (challenge не через Node)…"
    set +e
    if [[ "$INCLUDE_WWW" -eq 1 ]]; then
      "${CB_COMMON[@]}" -d "$DOMAIN" -d "www.${DOMAIN}"
      rc=$?
      if [[ $rc -eq 0 ]]; then
        CERT_OK=1
      else
        echo "WARN: выпуск с www.${DOMAIN} не удался (нет DNS www?) — повтор только apex ${DOMAIN}" >&2
      fi
    fi
    if [[ "$CERT_OK" -eq 0 ]]; then
      "${CB_COMMON[@]}" -d "$DOMAIN"
      rc=$?
      if [[ $rc -eq 0 ]]; then
        CERT_OK=1
        FINAL_SN="${DOMAIN}"
      fi
    fi
    set -e

    if [[ "$CERT_OK" -eq 0 ]]; then
      echo "ERROR: Let's Encrypt не выдал сертификат. Проверьте DNS A@${DOMAIN}→этот сервер, порт 80 снаружи." >&2
      echo "  Cloudflare + proxy: на время первой выдачи отключите «Always Use HTTPS» и правила редиректа HTTP→HTTPS на edge." >&2
      echo "  Лог: /var/log/letsencrypt/letsencrypt.log" >&2
      exit 1
    fi

    SERVER_NAMES="$FINAL_SN"
    write_nginx_config_post_ssl "${SERVER_NAMES}" >"$TMP"
    install -m 0644 "$TMP" "$CONF_PATH"
    if ! nginx -t 2>&1; then
      echo "nginx -t failed после добавления SSL" >&2
      exit 1
    fi
    systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload 2>/dev/null || systemctl restart nginx 2>/dev/null || true
    echo "OK: SSL для ${DOMAIN} (server_name: ${SERVER_NAMES})"
  fi
else
  echo "WARN: vhost только HTTP :80 (--no-ssl). Для Cloudflare «Full (strict)» к origin нужен свой сертификат на :443." >&2
fi
