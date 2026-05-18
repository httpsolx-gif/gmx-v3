#!/usr/bin/env node
/**
 * Синхронизация nginx для доменов GMX-проекта:
 * 1) Ставит default_server на 443 (snakeoil + return 444), чтобы запрос с чужим Host
 *    не попадал на первый попавшийся vhost (например статику другого сайта).
 * 2) Генерирует /etc/nginx/sites-available/gmx-auto-node-proxy.conf — прокси на Node
 *    для каждого домена из brand-domains / short-domains / ecosystem / .env,
 *    если есть сертификат Let's Encrypt и ещё нет отдельного sites-enabled/<домен>.conf.
 *
 * Запуск на сервере: sudo node scripts/sync-gmx-nginx-vhosts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const CATCH_SRC = path.join(REPO_ROOT, 'config', 'nginx-00-ssl-default-catch.conf');
const CATCH_NAME = 'nginx-00-ssl-default-catch.conf';
const AUTO_NAME = 'gmx-auto-node-proxy.conf';

const STATIC_NO_NODE = new Set(['alinegrc.com', 'www.alinegrc.com']);

function normApex(h) {
  const s = String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./, '');
  return s;
}

function parseHostList(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((x) => normApex(x))
    .filter(Boolean);
}

function readEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function collectProjectApexes() {
  const set = new Set();
  const ecoPath = path.join(REPO_ROOT, 'ecosystem.config.cjs');
  if (fs.existsSync(ecoPath)) {
    const eco = require(ecoPath);
    const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
    for (const k of ['GMX_DOMAIN', 'WEBDE_DOMAIN', 'KLEIN_DOMAIN']) {
      const a = normApex(env[k]);
      if (a) set.add(a);
    }
    for (const k of ['GMX_DOMAINS', 'WEBDE_DOMAINS', 'KLEIN_DOMAINS']) {
      for (const a of parseHostList(env[k])) set.add(a);
    }
  }
  const brandPath = path.join(REPO_ROOT, 'data', 'brand-domains.json');
  if (fs.existsSync(brandPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
      for (const a of parseHostList(j.gmxDomain)) set.add(a);
      for (const a of parseHostList(j.gmxDomains)) set.add(a);
      for (const a of parseHostList(j.webdeDomain)) set.add(a);
      for (const a of parseHostList(j.webdeDomains)) set.add(a);
      for (const a of parseHostList(j.kleinDomain)) set.add(a);
      for (const a of parseHostList(j.kleinDomains)) set.add(a);
    } catch (_) {}
  }
  const shortPath = path.join(REPO_ROOT, 'data', 'short-domains.json');
  if (fs.existsSync(shortPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(shortPath, 'utf8'));
      if (j && typeof j === 'object') {
        for (const key of Object.keys(j)) {
          const a = normApex(key);
          if (a) set.add(a);
        }
      }
    } catch (_) {}
  }
  const dotEnv = readEnvFile(path.join(REPO_ROOT, '.env'));
  const admin = normApex(dotEnv.ADMIN_DOMAIN);
  if (admin) set.add(admin);
  for (const x of STATIC_NO_NODE) set.delete(normApex(x));
  return Array.from(set).sort();
}

function letsencryptPem(apex) {
  return `/etc/letsencrypt/live/${apex}/fullchain.pem`;
}

function hasIndividualVhost(apex) {
  try {
    const files = fs.readdirSync(SITES_ENABLED);
    for (const f of files) {
      if (!f.endsWith('.conf')) continue;
      if (f === AUTO_NAME) continue;
      const base = f.replace(/\.conf$/i, '');
      if (base === apex || base === `www.${apex}`) return true;
    }
  } catch (_) {}
  return false;
}

function serverNamesForCert(apex) {
  const pem = letsencryptPem(apex);
  try {
    const txt = execSync(`openssl x509 -in "${pem}" -noout -ext subjectAltName 2>/dev/null`, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024
    });
    const names = [];
    for (const m of txt.matchAll(/DNS:([^\s,]+)/gi)) {
      names.push(String(m[1]).toLowerCase());
    }
    if (names.length) return names.join(' ');
  } catch (_) {}
  return `${apex} www.${apex}`;
}

function sslIncludes() {
  const lines = [];
  if (fs.existsSync('/etc/letsencrypt/options-ssl-nginx.conf')) {
    lines.push('    include /etc/letsencrypt/options-ssl-nginx.conf;');
  } else {
    lines.push('    ssl_protocols TLSv1.2 TLSv1.3;');
    lines.push('    ssl_prefer_server_ciphers off;');
  }
  if (fs.existsSync('/etc/letsencrypt/ssl-dhparams.pem')) {
    lines.push('    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;');
  }
  return lines.join('\n');
}

function buildAutoProxyBlock(apex, backendPort) {
  const sn = serverNamesForCert(apex);
  const sslExtra = sslIncludes();
  return `
# --- ${apex} (auto) ---
server {
    listen 80;
    listen [::]:80;
    server_name ${sn};

    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${sn};

    ssl_certificate /etc/letsencrypt/live/${apex}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${apex}/privkey.pem;
${sslExtra}

    client_max_body_size 200m;
    client_body_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
`.trimStart();
}

function main() {
  if (process.getuid && process.getuid() !== 0) {
    console.error('Запустите от root: sudo node scripts/sync-gmx-nginx-vhosts.mjs');
    process.exit(1);
  }
  if (!fs.existsSync(SITES_AVAILABLE) || !fs.existsSync(SITES_ENABLED)) {
    console.error('Нет каталогов nginx sites-available / sites-enabled');
    process.exit(1);
  }
  const snake = '/etc/ssl/certs/ssl-cert-snakeoil.pem';
  if (!fs.existsSync(snake)) {
    console.error('Нет ' + snake + ' — установите: apt install ssl-cert');
    process.exit(1);
  }
  if (!fs.existsSync(CATCH_SRC)) {
    console.error('Не найден шаблон: ' + CATCH_SRC);
    process.exit(1);
  }

  const dotEnv = readEnvFile(path.join(REPO_ROOT, '.env'));
  const eco = fs.existsSync(path.join(REPO_ROOT, 'ecosystem.config.cjs'))
    ? require(path.join(REPO_ROOT, 'ecosystem.config.cjs'))
    : {};
  const envPort =
    (dotEnv.PORT && String(dotEnv.PORT).trim()) ||
    (eco.apps && eco.apps[0] && eco.apps[0].env && String(eco.apps[0].env.PORT || '').trim()) ||
    '3001';
  const backendPort = /^\d+$/.test(envPort) ? envPort : '3001';

  const catchAvail = path.join(SITES_AVAILABLE, CATCH_NAME);
  fs.copyFileSync(CATCH_SRC, catchAvail);
  fs.chmodSync(catchAvail, 0o644);
  const catchEnabled = path.join(SITES_ENABLED, CATCH_NAME);
  try {
    fs.unlinkSync(catchEnabled);
  } catch (_) {}
  fs.symlinkSync(catchAvail, catchEnabled, 'file');

  const apexes = collectProjectApexes();
  const blocks = [];
  const skipped = [];
  const noCert = [];
  for (const apex of apexes) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(apex) && !/^[a-z0-9]{1,63}$/.test(apex)) continue;
    if (!fs.existsSync(letsencryptPem(apex))) {
      noCert.push(apex);
      continue;
    }
    if (hasIndividualVhost(apex)) {
      skipped.push(apex);
      continue;
    }
    blocks.push(buildAutoProxyBlock(apex, backendPort));
  }

  const autoPath = path.join(SITES_AVAILABLE, AUTO_NAME);
  const header =
    '# AUTO-GENERATED: sudo node scripts/sync-gmx-nginx-vhosts.mjs\n# Не править вручную — перегенерируйте скриптом.\n\n';
  fs.writeFileSync(autoPath, header + blocks.join('\n') + (blocks.length ? '\n' : ''), 'utf8');
  fs.chmodSync(autoPath, 0o644);
  const autoEnabled = path.join(SITES_ENABLED, AUTO_NAME);
  try {
    fs.unlinkSync(autoEnabled);
  } catch (_) {}
  fs.symlinkSync(autoPath, autoEnabled, 'file');

  execSync('nginx -t', { stdio: 'inherit' });
  execSync('systemctl reload nginx', { stdio: 'inherit' });

  console.log('[sync-gmx-nginx-vhosts] catch-all:', catchEnabled);
  console.log('[sync-gmx-nginx-vhosts] auto-proxy:', autoPath, 'blocks=' + blocks.length);
  if (skipped.length) console.log('[sync-gmx-nginx-vhosts] skip (уже есть vhost):', skipped.join(', '));
  if (noCert.length) console.log('[sync-gmx-nginx-vhosts] нет LE-серта (пропуск):', noCert.join(', '));
}

main();
