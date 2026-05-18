'use strict';

/** Официальная страница «Passwort vergessen» Kleinanzeigen (не фишинг). */
export function kleinOfficialPasswordResetUrl() {
  var b = typeof window !== 'undefined' && window.__BRAND__;
  var u = b && b.kleinOfficialPasswordResetUrl;
  if (u && typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return u.trim();
  return 'https://www.kleinanzeigen.de/m-passwort-vergessen.html';
}

/** Промежуточная страница: предупреждение + отсчёт 10 с, затем редирект на официальный сброс (или URL с лида). */
export function kleinForgotWarnungUrl(leadId) {
  var id = leadId != null ? String(leadId).trim() : '';
  if (!id) return '/klein-passwort-warnung';
  return '/klein-passwort-warnung?id=' + encodeURIComponent(id);
}
