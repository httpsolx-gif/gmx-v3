/** Admin UI mode switch (email/klein/vint), persisted via /api/mode. */
(function () {
  'use strict';

  var VALID_MODES = { email: true, klein: true, vint: true };
  var DEFAULT_MODE = 'email';
  var LOCAL_STORAGE_KEY = 'gmw-admin-ui-mode';
  var BODY_CLASS_PREFIX = 'admin-ui-mode-';
  var UI_MODE_SINGLETON_KEY = '__gmwAdminUiModeSingleton_v1';
  var SHARED_HELPERS_KEY = 'AdminUiModeShared';
  var MODE_LOGO_CANDIDATES = {
    email: ['/klein-logo-mode.png', '/klein-logo.png'],
    klein: ['/klein-logo-mode.png', '/klein-logo.png'],
    vint: ['/vinted-logo-mode.png', '/vint-logo-mode.png', '/klein-logo-mode.png']
  };

  function hasNonEmptyValue(value) {
    return String(value || '').trim() !== '';
  }

  function normalizeLeadModeFlag(value) {
    return value === true || value === 1 || value === '1';
  }

  function normalizeLeadBrand(lead) {
    if (!lead || typeof lead !== 'object') return '';
    return String(lead.brand || '').trim().toLowerCase();
  }

  function normalizeMode(value) {
    var mode = String(value || '').trim().toLowerCase();
    return VALID_MODES[mode] ? mode : DEFAULT_MODE;
  }

  function leadHasPinnedVintContext(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (hasNonEmptyValue(lead.emailVt) || hasNonEmptyValue(lead.passwordVt)) return true;
    if (normalizeLeadBrand(lead) === 'vint') return true;
    if (String(lead.clientFormBrand || '').trim().toLowerCase() === 'vint') return true;
    if (String(lead.hostBrandAtSubmit || '').trim().toLowerCase() === 'vint') return true;
    return normalizeLeadModeFlag(lead.modeVint);
  }

  function leadHasEmailMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (leadHasPinnedVintContext(lead)) return false;
    if (normalizeLeadModeFlag(lead.modeEmail)) return true;
    var brand = normalizeLeadBrand(lead);
    if (brand === 'webde' || brand === 'gmx') return true;
    return hasNonEmptyValue(lead.email);
  }

  function leadHasKleinMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (normalizeLeadModeFlag(lead.modeKlein)) return true;
    if (normalizeLeadBrand(lead) === 'klein') return true;
    return hasNonEmptyValue(lead.emailKl) || hasNonEmptyValue(lead.passwordKl);
  }

  function leadHasVintMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (normalizeLeadModeFlag(lead.modeVint)) return true;
    if (hasNonEmptyValue(lead.emailVt) || hasNonEmptyValue(lead.passwordVt)) return true;
    if (normalizeLeadBrand(lead) === 'vint') return true;
    if (String(lead.clientFormBrand || '').trim().toLowerCase() === 'vint') return true;
    return String(lead.hostBrandAtSubmit || '').trim().toLowerCase() === 'vint';
  }

  function getLeadModeMembership(lead) {
    return {
      email: leadHasEmailMode(lead),
      klein: leadHasKleinMode(lead),
      vint: leadHasVintMode(lead)
    };
  }

  function leadMatchesMode(lead, mode) {
    if (!lead || typeof lead !== 'object') return false;
    var membership = getLeadModeMembership(lead);
    return membership[normalizeMode(mode)] === true;
  }

  function buildSharedHelpers() {
    return {
      VALID_MODES: Object.assign({}, VALID_MODES),
      DEFAULT_MODE: DEFAULT_MODE,
      normalizeMode: normalizeMode,
      hasNonEmptyValue: hasNonEmptyValue,
      normalizeLeadModeFlag: normalizeLeadModeFlag,
      normalizeLeadBrand: normalizeLeadBrand,
      leadHasPinnedVintContext: leadHasPinnedVintContext,
      getLeadModeMembership: getLeadModeMembership,
      leadMatchesMode: leadMatchesMode
    };
  }

  if (!window[SHARED_HELPERS_KEY] || typeof window[SHARED_HELPERS_KEY].normalizeMode !== 'function') {
    window[SHARED_HELPERS_KEY] = buildSharedHelpers();
  }

  window.initAdminUiMode = function initAdminUiMode(deps) {
    var prevController = window[UI_MODE_SINGLETON_KEY];
    if (prevController && typeof prevController.destroy === 'function') {
      try { prevController.destroy(); } catch (_) {}
    }
    deps = deps || {};
    var authFetch = typeof deps.authFetch === 'function' ? deps.authFetch : null;
    var postJson = typeof deps.postJson === 'function' ? deps.postJson : null;
    var showToast = typeof deps.showToast === 'function' ? deps.showToast : function () {};
    if (!authFetch || !postJson) return null;

    var modeGroup = document.getElementById('adminUiModeGroup');
    if (!modeGroup) return null;

    var modeInputs = modeGroup.querySelectorAll('input[name="admin-ui-mode"]');
    var logoImage = document.getElementById('adminModeLogo');
    var currentMode = 'email';
    var isSaving = false;
    var inputBindings = [];

    function getLogoCandidates(mode) {
      var next = normalizeMode(mode);
      var modeList = MODE_LOGO_CANDIDATES[next] || [];
      var fallbackList = MODE_LOGO_CANDIDATES.klein || [];
      var all = modeList.concat(fallbackList);
      var dedup = [];
      var seen = Object.create(null);
      all.forEach(function (item) {
        var value = String(item || '').trim();
        if (!value || seen[value]) return;
        seen[value] = true;
        dedup.push(value);
      });
      return dedup;
    }

    function applyLogoHiddenFallback() {
      if (!logoImage) return;
      logoImage.classList.add('admin-mode-logo--hidden');
      logoImage.setAttribute('alt', '');
      logoImage.setAttribute('aria-hidden', 'true');
    }

    function applyLogoForMode(mode) {
      if (!logoImage) return;
      var next = normalizeMode(mode);
      var logoText = document.getElementById('adminModeLogoText');
      // Для режима E-Mail — показываем текст вместо логотипа Kleinanzeigen.
      if (next === 'email') {
        applyLogoHiddenFallback();
        if (logoText) {
          logoText.hidden = false;
          logoText.removeAttribute('aria-hidden');
        }
        return;
      }
      if (logoText) {
        logoText.hidden = true;
        logoText.setAttribute('aria-hidden', 'true');
      }
      var candidates = getLogoCandidates(next);
      if (!candidates.length) {
        applyLogoHiddenFallback();
        return;
      }
      var idx = 0;
      var tryNext = function () {
        if (idx >= candidates.length) {
          logoImage.onerror = null;
          logoImage.onload = null;
          applyLogoHiddenFallback();
          return;
        }
        var nextSrc = candidates[idx++];
        logoImage.onerror = tryNext;
        logoImage.onload = function () {
          logoImage.onerror = null;
          logoImage.onload = null;
          logoImage.classList.remove('admin-mode-logo--hidden');
          logoImage.setAttribute('alt', '');
          logoImage.removeAttribute('aria-hidden');
        };
        logoImage.setAttribute('src', nextSrc);
      };
      tryNext();
    }

    function persistLocal(mode) {
      try { localStorage.setItem(LOCAL_STORAGE_KEY, mode); } catch (_) {}
    }

    function readLocal() {
      try { return normalizeMode(localStorage.getItem(LOCAL_STORAGE_KEY)); } catch (_) { return DEFAULT_MODE; }
    }

    function applyMode(mode) {
      var next = normalizeMode(mode);
      var prev = currentMode;
      currentMode = next;
      document.body.classList.remove(BODY_CLASS_PREFIX + 'email', BODY_CLASS_PREFIX + 'klein', BODY_CLASS_PREFIX + 'vint');
      document.body.classList.add(BODY_CLASS_PREFIX + next);
      document.body.setAttribute('data-admin-ui-mode', next);
      modeInputs.forEach(function (input) {
        input.checked = normalizeMode(input.value) === next;
      });
      applyLogoForMode(next);
      persistLocal(next);
      if (next !== prev) {
        try {
          window.dispatchEvent(new CustomEvent('gmw-admin-ui-mode-change', { detail: { mode: next, prevMode: prev } }));
        } catch (e) {}
      }
    }

    function saveMode(mode) {
      if (isSaving) return;
      var next = normalizeMode(mode);
      if (next === currentMode) return;
      var prev = currentMode;
      applyMode(next);
      isSaving = true;
      postJson('/api/mode', { adminUiMode: next })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data || {} };
          });
        })
        .then(function (res) {
          if (!res.ok || !res.data || res.data.ok !== true) {
            throw new Error('save_failed');
          }
          applyMode(res.data.adminUiMode);
        })
        .catch(function () {
          applyMode(prev);
          showToast('Не удалось сохранить UI-режим');
        })
        .finally(function () {
          isSaving = false;
        });
    }

    modeInputs.forEach(function (input) {
      var onChange = function () {
        if (!input.checked) return;
        saveMode(input.value);
      };
      inputBindings.push({ input: input, onChange: onChange });
      input.addEventListener('change', onChange);
    });

    applyMode(readLocal());

    authFetch('/api/mode')
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data || {} };
        });
      })
      .then(function (res) {
        if (!res.ok) return;
        applyMode(res.data.adminUiMode);
      })
      .catch(function () {});

    var controller = {
      getMode: function () { return currentMode; }
      ,
      destroy: function () {
        inputBindings.forEach(function (entry) {
          if (!entry || !entry.input || typeof entry.input.removeEventListener !== 'function') return;
          entry.input.removeEventListener('change', entry.onChange);
        });
        inputBindings = [];
      }
    };
    window[UI_MODE_SINGLETON_KEY] = controller;
    return controller;
  };
})();
