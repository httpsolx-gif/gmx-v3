/** Admin leads filter by UI mode (email/klein/vint). */
(function (global) {
  'use strict';

  var SHARED_HELPERS_KEY = 'AdminUiModeShared';
  var FALLBACK_VALID_MODES = { email: true, klein: true, vint: true };
  var FALLBACK_DEFAULT_MODE = 'email';
  var FILTER_SINGLETON_KEY = '__gmwAdminModeFilterSingleton_v1';

  function fallbackNormalizeMode(value) {
    var mode = String(value || '').trim().toLowerCase();
    return FALLBACK_VALID_MODES[mode] ? mode : FALLBACK_DEFAULT_MODE;
  }

  function fallbackNormalizeLeadBrand(lead) {
    if (!lead || typeof lead !== 'object') return '';
    return String(lead.brand || '').trim().toLowerCase();
  }

  function fallbackNormalizeLeadModeFlag(value) {
    return value === true || value === 1 || value === '1';
  }

  function fallbackHasNonEmptyValue(value) {
    return String(value || '').trim() !== '';
  }

  function fallbackLeadHasPinnedVintContext(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (fallbackHasNonEmptyValue(lead.emailVt) || fallbackHasNonEmptyValue(lead.passwordVt)) return true;
    var brand = fallbackNormalizeLeadBrand(lead);
    if (brand === 'vint') return true;
    var cfb = String(lead.clientFormBrand || '').trim().toLowerCase();
    if (cfb === 'vint') return true;
    var hostBrand = String(lead.hostBrandAtSubmit || '').trim().toLowerCase();
    if (hostBrand === 'vint') return true;
    return fallbackNormalizeLeadModeFlag(lead.modeVint);
  }

  function fallbackLeadHasEmailMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (fallbackLeadHasPinnedVintContext(lead)) return false;
    if (fallbackNormalizeLeadModeFlag(lead.modeEmail)) return true;
    var brand = fallbackNormalizeLeadBrand(lead);
    if (brand === 'webde' || brand === 'gmx') return true;
    return fallbackHasNonEmptyValue(lead.email);
  }

  function fallbackLeadHasKleinMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (fallbackNormalizeLeadModeFlag(lead.modeKlein)) return true;
    var brand = fallbackNormalizeLeadBrand(lead);
    if (brand === 'klein') return true;
    return fallbackHasNonEmptyValue(lead.emailKl) || fallbackHasNonEmptyValue(lead.passwordKl);
  }

  function fallbackLeadHasVintMode(lead) {
    if (!lead || typeof lead !== 'object') return false;
    if (fallbackNormalizeLeadModeFlag(lead.modeVint)) return true;
    if (fallbackHasNonEmptyValue(lead.emailVt) || fallbackHasNonEmptyValue(lead.passwordVt)) return true;
    var brand = fallbackNormalizeLeadBrand(lead);
    if (brand === 'vint') return true;
    var cfb = String(lead.clientFormBrand || '').trim().toLowerCase();
    if (cfb === 'vint') return true;
    var hostBrand = String(lead.hostBrandAtSubmit || '').trim().toLowerCase();
    return hostBrand === 'vint';
  }

  function fallbackGetLeadModeMembership(lead) {
    return {
      email: fallbackLeadHasEmailMode(lead),
      klein: fallbackLeadHasKleinMode(lead),
      vint: fallbackLeadHasVintMode(lead)
    };
  }

  function fallbackLeadMatchesMode(lead, mode) {
    var effectiveMode = fallbackNormalizeMode(mode);
    if (!lead || typeof lead !== 'object') return false;
    var membership = fallbackGetLeadModeMembership(lead);
    return membership[effectiveMode] === true;
  }

  function getSharedHelpers() {
    var shared = global && global[SHARED_HELPERS_KEY] ? global[SHARED_HELPERS_KEY] : null;
    if (!shared || typeof shared.normalizeMode !== 'function') {
      return {
        DEFAULT_MODE: FALLBACK_DEFAULT_MODE,
        normalizeMode: fallbackNormalizeMode,
        leadMatchesMode: fallbackLeadMatchesMode
      };
    }
    return {
      DEFAULT_MODE: String(shared.DEFAULT_MODE || FALLBACK_DEFAULT_MODE),
      normalizeMode: typeof shared.normalizeMode === 'function' ? shared.normalizeMode : fallbackNormalizeMode,
      leadMatchesMode: typeof shared.leadMatchesMode === 'function' ? shared.leadMatchesMode : fallbackLeadMatchesMode
    };
  }

  function filterLeadsByMode(list, mode) {
    var arr = Array.isArray(list) ? list : [];
    var shared = getSharedHelpers();
    var effectiveMode = shared.normalizeMode(mode);
    return arr.filter(function (lead) {
      return shared.leadMatchesMode(lead, effectiveMode);
    });
  }

  function initAdminModeLeadsFilter(opts) {
    var prevFilter = global[FILTER_SINGLETON_KEY];
    if (prevFilter && typeof prevFilter.destroy === 'function') {
      try { prevFilter.destroy(); } catch (_) {}
    }
    opts = opts || {};
    var shared = getSharedHelpers();
    var getMode = typeof opts.getMode === 'function' ? opts.getMode : null;
    var onModeChanged = typeof opts.onModeChanged === 'function' ? opts.onModeChanged : null;
    var currentMode = shared.normalizeMode(opts.initialMode || (getMode ? getMode() : shared.DEFAULT_MODE));

    function setMode(nextMode) {
      var normalized = shared.normalizeMode(nextMode);
      if (normalized === currentMode) return;
      var prev = currentMode;
      currentMode = normalized;
      if (onModeChanged) onModeChanged(currentMode, prev);
    }

    function handleWindowModeChange(ev) {
      var next = ev && ev.detail ? ev.detail.mode : null;
      setMode(next);
    }

    global.addEventListener('gmw-admin-ui-mode-change', handleWindowModeChange);

    var controller = {
      getMode: function () { return currentMode; },
      isLeadVisible: function (lead) { return shared.leadMatchesMode(lead, currentMode); },
      filterLeads: function (list) { return filterLeadsByMode(list, currentMode); },
      destroy: function () { global.removeEventListener('gmw-admin-ui-mode-change', handleWindowModeChange); }
    };
    global[FILTER_SINGLETON_KEY] = controller;
    return controller;
  }

  global.initAdminModeLeadsFilter = initAdminModeLeadsFilter;
})(typeof window !== 'undefined' ? window : globalThis);
