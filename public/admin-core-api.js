/** Shared API helpers for admin scripts. */
(function (global) {
  'use strict';

  function authFetch(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (!options.credentials) options.credentials = 'same-origin';
    return fetch(url, options).then(function (response) {
      if (response && (response.status === 401 || response.status === 403)) {
        global.location.href = '/admin-login';
      }
      return response;
    });
  }

  function postJson(path, body) {
    body = body || {};
    var payload = {};
    for (var k in body) {
      if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k];
    }
    if (payload.id != null) payload.id = String(payload.id).trim();
    return authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  function parseJsonResponseThrowIfNotOk(response) {
    return response.json().then(function (data) {
      if (!response.ok) {
        var msg = (data && (data.error || data.message)) || ('HTTP ' + response.status);
        throw new Error(msg);
      }
      return data;
    });
  }

  function adminNonJsonHint(label, status) {
    var s = Number(status) || 0;
    var tail = '';
    if (s === 401 || s === 403) {
      tail = ' Часто: сессия админки истекла — обновите страницу и войдите снова.';
    } else if (s === 502 || s === 503 || s === 504) {
      tail = ' Ответ дал nginx/шлюз: upstream (Node) не ответил вовремя, упал или недоступен. Сессия админки при этом может быть рабочей — смотрите лог процесса (PM2, data/dev-server.log) и proxy_read_timeout / upstream в nginx.';
    } else {
      tail = ' Часто: HTML-страница ошибки или запрос не проксируется на Node.';
    }
    return String(label || 'Ответ') + ' не JSON (HTTP ' + s + ').' + tail;
  }

  global.AdminCoreApi = global.AdminCoreApi || {};
  global.AdminCoreApi.authFetch = authFetch;
  global.AdminCoreApi.postJson = postJson;
  global.AdminCoreApi.parseJsonResponseThrowIfNotOk = parseJsonResponseThrowIfNotOk;
  global.AdminCoreApi.adminNonJsonHint = adminNonJsonHint;
})(window);
