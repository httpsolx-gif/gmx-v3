'use strict';

const https = require('https');

/** URL проверки (как в админке Config → Прокси). */
const DEFAULT_WEBDE_AUTH_TEST_URL = 'https://auth.web.de/';

/**
 * @param {{ host: string, port: number, login?: string, password?: string }} parsed
 */
function buildHttpProxyUrl(parsed) {
  const enc = (s) => encodeURIComponent(String(s || ''));
  if (parsed.login || parsed.password) {
    return 'http://' + enc(parsed.login) + ':' + enc(parsed.password) + '@' + parsed.host + ':' + parsed.port;
  }
  return 'http://' + parsed.host + ':' + parsed.port;
}

/**
 * @param {'socks5'|'socks4'} variant
 * @param {{ host: string, port: number, login?: string, password?: string }} parsed
 */
function buildSocksProxyUri(parsed, variant) {
  const proto = variant === 'socks4' ? 'socks4' : 'socks5';
  const u = new URL(proto + '://' + parsed.host + ':' + parsed.port);
  if (parsed.login) u.username = parsed.login;
  if (parsed.password) u.password = parsed.password;
  return u.toString();
}

/**
 * HTTPS GET через agent; разбор statusCode целевого хоста.
 * 403 от auth.web.de при рабочем туннеле — не считаем «мёртвым прокси» (часто блок датацентра).
 */
function httpsGetStatusThroughAgent(agent, testUrl, timeoutMs) {
  return new Promise((resolve) => {
    const reqHttps = https.get(testUrl, { agent: agent, timeout: timeoutMs }, (resHttps) => {
      const code = resHttps.statusCode || 0;
      try {
        resHttps.resume();
      } catch (_) {}
      try {
        resHttps.destroy();
      } catch (_) {}
      if (code === 407) {
        resolve({ ok: false, error: 'Прокси не принял логин/пароль (407 Proxy Authentication Required)' });
        return;
      }
      if (code >= 200 && code < 400) {
        resolve({ ok: true });
        return;
      }
      if (code === 403) {
        resolve({
          ok: true,
          warn403: true,
          warn:
            'auth.web.de вернул 403 (часто для IP датацентров); HTTPS-туннель через прокси установлен',
        });
        return;
      }
      if (code >= 400) {
        resolve({
          ok: false,
          error: 'Через прокси получен HTTP ' + code + ' (страница auth.web.de недоступна или заблокирована)',
        });
        return;
      }
      resolve({ ok: false, error: 'Нет ответа по HTTPS через прокси' });
    });
    reqHttps.on('error', (err) => {
      resolve({ ok: false, error: (err && err.message) || 'Ошибка HTTPS через прокси' });
    });
    reqHttps.setTimeout(timeoutMs, () => {
      reqHttps.destroy();
      resolve({ ok: false, error: 'Таймаут HTTPS' });
    });
  });
}

module.exports = {
  DEFAULT_WEBDE_AUTH_TEST_URL,
  buildHttpProxyUrl,
  buildSocksProxyUri,
  httpsGetStatusThroughAgent,
};
