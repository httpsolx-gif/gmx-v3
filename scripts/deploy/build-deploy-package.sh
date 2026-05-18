#!/usr/bin/env bash
# Собирает чистый tar.gz пакет для деплоя текущего worktree на новый сервер.
# Использование (из корня репозитория):
#   bash scripts/deploy/build-deploy-package.sh
# Результат: dist/gmx-v3-deploy-<timestamp>.tar.gz + dist/install-on-server.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/dist"
TS="$(date +%Y-%m-%d_%H-%M-%S)"
TARBALL="$OUT_DIR/gmx-v3-deploy-$TS.tar.gz"

mkdir -p "$OUT_DIR"

echo "[build] root: $ROOT"
echo "[build] target: $TARBALL"

# Список исключений: всё локальное / секретное / большое / билд-артефакты.
# data/ исключаем целиком — на сервере у этой инстанции будет свой data/.
# .env — секреты, должен генериться install.sh-ом на сервере.
tar \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.claude' \
  --exclude='./.cursorrules' \
  --exclude='./.vscode' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./data' \
  --exclude='./dist' \
  --exclude='./downloads' \
  --exclude='./login/venv' \
  --exclude='./login/.venv' \
  --exclude='./login/__pycache__' \
  --exclude='./login/chrome-profiles' \
  --exclude='./login/klein_reset_debug' \
  --exclude='./login/cookies.json' \
  --exclude='./login/cookies' \
  --exclude='./login/proxy_klein.txt' \
  --exclude='./login/webde_fp_rr_counter.txt' \
  --exclude='./login/webde_replace_fp_all_done.flag' \
  --exclude='./scripts/__pycache__' \
  --exclude='./**/*.pyc' \
  --exclude='./**/__pycache__' \
  --exclude='./**/.DS_Store' \
  --exclude='./*.log' \
  --exclude='./server.pid' \
  --exclude='*.swp' \
  -czf "$TARBALL" \
  .

# Копируем install.sh рядом с тарболлом — удобно скачивать на сервер.
cp "$ROOT/scripts/deploy/install-on-server.sh" "$OUT_DIR/install-on-server.sh"
chmod +x "$OUT_DIR/install-on-server.sh"

SIZE=$(du -h "$TARBALL" | awk '{print $1}')
echo
echo "[build] Готово."
echo "  Пакет:      $TARBALL ($SIZE)"
echo "  Инсталлер:  $OUT_DIR/install-on-server.sh"
echo
echo "Как залить на сервер:"
echo "  scp $TARBALL $OUT_DIR/install-on-server.sh root@<IP>:/tmp/"
echo "  ssh root@<IP> 'bash /tmp/install-on-server.sh /tmp/$(basename "$TARBALL")'"
