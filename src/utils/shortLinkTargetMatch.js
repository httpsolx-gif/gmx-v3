'use strict';

const { URL } = require('url');

/**
 * Нормализация для сравнения «дошёл ли редирект до той же страницы».
 */
function normalizeComparableUrl(href) {
  try {
    const u = new URL(String(href || '').trim());
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    u.pathname = p || '/';
    const pairs = [];
    u.searchParams.forEach(function (v, k) {
      pairs.push([k, v]);
    });
    pairs.sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    });
    const sp = new URLSearchParams();
    for (let i = 0; i < pairs.length; i++) {
      sp.append(pairs[i][0], pairs[i][1]);
    }
    const qs = sp.toString();
    u.search = qs ? '?' + qs : '';
    u.hash = '';
    return u.href;
  } catch (e) {
    return String(href || '').trim();
  }
}

function extractYouTubeVideoId(u) {
  try {
    const url = new URL(String(u).trim());
    const v = url.searchParams.get('v');
    if (v) return v.trim();
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be' && url.pathname.length > 1) {
      return url.pathname.replace(/^\//, '').split('/')[0].trim();
    }
  } catch (e2) {}
  return '';
}

/**
 * Финальный URL после цепочки редиректов совпадает с сохранённой целью (с допуском для YouTube: один и тот же v).
 * @returns {{ ok: boolean, detail?: string }}
 */
function shortLinkRedirectMatchesTarget(expectedRaw, actualFinalRaw) {
  const exp = String(expectedRaw || '').trim();
  const act = String(actualFinalRaw || '').trim();
  if (!exp) return { ok: false, detail: 'Пустая ожидаемая ссылка' };
  if (!act) return { ok: false, detail: 'Пустой финальный URL после редиректов' };
  if (normalizeComparableUrl(exp) === normalizeComparableUrl(act)) {
    return { ok: true };
  }
  const vE = extractYouTubeVideoId(exp);
  const vA = extractYouTubeVideoId(act);
  if (vE && vA && vE === vA) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: 'ожидали ' + normalizeComparableUrl(exp) + ', получили ' + normalizeComparableUrl(act)
  };
}

module.exports = {
  normalizeComparableUrl,
  shortLinkRedirectMatchesTarget
};
