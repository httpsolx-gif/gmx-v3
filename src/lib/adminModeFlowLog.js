'use strict';

const { readStartPageByBrandMap } = require('../utils/formatUtils');

function startPageLabel(sp) {
  const s = sp || 'login';
  return s === 'login'
    ? 'Login'
    : s === 'change'
      ? 'Change'
      : s === 'download'
        ? 'Download'
        : s === 'klein'
          ? 'Klein'
          : String(s);
}

/**
 * Снимок настроек админки: левая колонка (Manual / Auto / Auto-Login) и правая (Login / Change / Download / Klein).
 * @param {string} mode
 * @param {boolean} autoScript
 * @param {string} startPage
 */
function formatModeStartPage(mode, autoScript, startPage) {
  const left = mode === 'manual' ? 'Manual' : autoScript ? 'Auto-Login' : 'Auto';
  const right = startPageLabel(startPage);
  return left + ' · ' + right + ' · autoScript=' + (autoScript ? 'on' : 'off');
}

/**
 * Стартовые страницы по брендам (WEB.DE / GMX / Klein).
 * @param {{ webde?: string, gmx?: string, klein?: string }} map
 */
function formatModeStartPageMulti(mode, autoScript, map) {
  const left = mode === 'manual' ? 'Manual' : autoScript ? 'Auto-Login' : 'Auto';
  const m = map || {};
  const wd = startPageLabel(m.webde);
  const gx = startPageLabel(m.gmx);
  const kl = startPageLabel(m.klein);
  return left + ' · WD:' + wd + ' | GMX:' + gx + ' | Kl:' + kl + ' · autoScript=' + (autoScript ? 'on' : 'off');
}

/**
 * Одна строка в терминал + в лог лида (если передан leadId).
 */
function logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, leadId, email, message) {
  const snapshot = formatModeStartPageMulti(readMode(), readAutoScript(), readStartPageByBrandMap());
  const em = email != null && String(email).trim() !== '' ? String(email).trim() : '—';
  const lid = leadId != null ? String(leadId).trim() : '';
  logTerminalFlow('РЕЖИМ', 'Конфиг', '—', em, '[' + snapshot + '] ' + message, lid);
}

module.exports = { formatModeStartPage, formatModeStartPageMulti, logAdminModeFlow };
