'use strict';

/**
 * Подставляет https:// если схемы нет (example.com/path → https://example.com/path).
 * Поддерживает уже полные http(s):// и protocol-relative //host/…
 * @returns {string|null}
 */
function normalizeOptionalSchemeHttpUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^\/\//.test(s)) s = 'https:' + s;
  else if (!/^https?:\/\//i.test(s)) {
    s = s.replace(/^\/+/, '');
    if (!s) return null;
    if (!/^[a-zA-Z0-9[(]/.test(s)) return null;
    s = 'https://' + s;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = (u.hostname || '').toLowerCase();
    if (!h) return null;
    if (/^(javascript|data|blob|vbscript)$/i.test(h)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

/** Уже HTTPS с точки зрения клиента (TLS на сокете или заголовки прокси / Cloudflare Flexible). */
function isEffectiveHttpsRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;
  const xf = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xf === 'https') return true;
  if (String(req.headers['x-forwarded-ssl'] || '').toLowerCase() === 'on') return true;
  const cfVis = req.headers['cf-visitor'];
  if (cfVis) {
    try {
      const j = JSON.parse(cfVis);
      if (j && String(j.scheme || '').toLowerCase() === 'https') return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/**
 * 301 на https:// + Host + url (path + query). Локальный доступ без прокси не трогаем.
 * @returns {boolean} true если ответ отправлен
 */
function trySendRedirectToHttps(req, res, safeEnd) {
  if (typeof safeEnd === 'function' && safeEnd(res)) return true;
  if (!req || !res) return false;
  if (isEffectiveHttpsRequest(req)) return false;
  const xf = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xf !== 'http') return false;
  const host = String(req.headers.host || '').trim();
  if (!host) return false;
  const { isLocalHost } = require('./localNetwork');
  if (isLocalHost(host.split(':')[0].toLowerCase())) return false;
  const loc = 'https://' + host + (req.url || '/');
  res.writeHead(301, { Location: loc, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

module.exports = {
  normalizeOptionalSchemeHttpUrl,
  isEffectiveHttpsRequest,
  trySendRedirectToHttps,
};
