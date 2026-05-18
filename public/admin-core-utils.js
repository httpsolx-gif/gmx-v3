/** Shared pure helpers for admin scripts. */
(function (global) {
  'use strict';

  function escapeHtml(value) {
    if (value == null) return '';
    var div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

  function normalizeUiBrand(brand) {
    var b = String(brand || '').toLowerCase();
    if (b === 'klein' || b === 'vint' || b === 'webde' || b === 'gmx') return b;
    return '';
  }

  function normalizeLeadId(id) {
    if (id == null) return '';
    return String(id).trim();
  }

  function leadIdsEqual(a, b) {
    return normalizeLeadId(a) === normalizeLeadId(b);
  }

  global.AdminCoreUtils = global.AdminCoreUtils || {};
  global.AdminCoreUtils.escapeHtml = escapeHtml;
  global.AdminCoreUtils.normalizeUiBrand = normalizeUiBrand;
  global.AdminCoreUtils.normalizeLeadId = normalizeLeadId;
  global.AdminCoreUtils.leadIdsEqual = leadIdsEqual;
})(window);
