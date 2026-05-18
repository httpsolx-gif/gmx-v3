(function () {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var moduleApi = {};

    function d(name, fallback) {
      return typeof deps[name] === 'function' ? deps[name] : fallback;
    }
    var getEl = d('getEl', function () { return {}; });
    var getLeads = d('getLeads', function () { return []; });
    var getSelectedId = d('getSelectedId', function () { return null; });
    var setSelectedId = d('setSelectedId', function () {});
    var getSelectedIds = d('getSelectedIds', function () { return {}; });
    var getLeadsTotal = d('getLeadsTotal', function () { return 0; });
    var getLeadsLimit = d('getLeadsLimit', function () { return 50; });
    var getLeadsPage = d('getLeadsPage', function () { return 1; });
    var getSearchQ = d('getSearchQ', function () { return ''; });
    var getSearchDraft = d('getSearchDraft', function () { return ''; });
    var getSearchTimer = d('getSearchTimer', function () { return null; });
    var setSearchQ = d('setSearchQ', function () {});
    var setSearchDraft = d('setSearchDraft', function () {});
    var setSearchTimer = d('setSearchTimer', function () {});
    var sortLeadsNewFirst = d('sortLeadsNewFirst', function (arr) { return arr; });
    var leadIdsEqual = d('leadIdsEqual', function (a, b) { return String(a) === String(b); });
    var normalizeLeadId = d('normalizeLeadId', function (id) { return id == null ? null : String(id); });
    var leadIsSidebarWorked = d('leadIsSidebarWorked', function () { return false; });
    var getBadgeClassAndLabel = d('getBadgeClassAndLabel', function () { return { cls: '', label: '' }; });
    var getLeadDisplayEmail = d('getLeadDisplayEmail', function () { return ''; });
    var getPlatformIcon = d('getPlatformIcon', function () { return ''; });
    var statusClass = d('statusClass', function () { return 'session-status danger'; });
    var getLeadUnreadChatCount = d('getLeadUnreadChatCount', function () { return 0; });
    var formatUnreadBadgeCount = d('formatUnreadBadgeCount', function () { return ''; });
    var escapeHtml = d('escapeHtml', function (s) { return String(s == null ? '' : s); });
    var authFetch = d('authFetch', function () { return Promise.reject(new Error('authFetch missing')); });
    var showToast = d('showToast', function () {});
    var buildAntiFraudModalText = d('buildAntiFraudModalText', function () { return ''; });
    var flushAdminDetailDebounce = d('flushAdminDetailDebounce', function () {});
    var renderDetail = d('renderDetail', function () {});
    var loadLeads = d('loadLeads', function () {});
    var adminShowArchivedInList = d('adminShowArchivedInList', function () { return false; });
    var getSelectedLeadIds = d('getSelectedLeadIds', function () { return []; });
    var clearSelectionAfterBulk = d('clearSelectionAfterBulk', function () {});
    var postBulkAction = d('postBulkAction', function () { return Promise.reject(new Error('bulk action unavailable')); });
    var bulkSendEmail = d('bulkSendEmail', function () { return Promise.reject(new Error('bulk email unavailable')); });
    var toggleAllOnCurrentPage = d('toggleAllOnCurrentPage', function () {});
    var log = d('log', function () {});

    function setItemStateClasses(item, lead) {
      if (!item || !lead) return;
      item.classList.toggle('active', leadIdsEqual(lead.id, getSelectedId()));
      item.classList.toggle('session-item--kl-archived', lead.klLogArchived === true);
      item.classList.toggle('session-item--admin-archived', lead.adminLogArchived === true);
      item.classList.toggle('session-item--worked', leadIsSidebarWorked(lead));
    }

    function renderList() {
      var el = getEl();
      var leads = getLeads();
      var wrap = el.sessionsListWrap;
      var list = el.leadsList;
      var empty = el.leadEmpty;
      var selectedIds = getSelectedIds();
      if (!list) return;
      list.innerHTML = '';
      if (leads.length === 0) {
        if (wrap) wrap.style.display = 'none';
        if (empty) { empty.style.display = 'block'; empty.classList.remove('hidden'); }
        if (el.countBadge) el.countBadge.textContent = '0';
        return;
      }
      if (wrap) wrap.style.display = 'block';
      if (empty) { empty.style.display = 'none'; empty.classList.add('hidden'); }
      if (el.countBadge) {
        var leadsTotal = getLeadsTotal();
        var leadsLimit = getLeadsLimit();
        el.countBadge.textContent = leadsTotal > leadsLimit ? (leads.length + ' / ' + leadsTotal) : String(leads.length);
      }
      var ordered = sortLeadsNewFirst(leads);
      ordered.forEach(function (lead, index) {
        var num = ordered.length - index;
        var item = document.createElement('div');
        item.className = 'lead-item session-item' + (leadIdsEqual(lead.id, getSelectedId()) ? ' active' : '') + (lead.klLogArchived === true ? ' session-item--kl-archived' : '') + (lead.adminLogArchived === true ? ' session-item--admin-archived' : '') + (leadIsSidebarWorked(lead) ? ' session-item--worked' : '');
        item.setAttribute('data-id', lead.id);
        var badge = getBadgeClassAndLabel(lead);
        var email = getLeadDisplayEmail(lead) || '—';
        var checked = selectedIds[lead.id] ? ' checked' : '';
        var platformIcon = getPlatformIcon(lead.platform);
        var platformBtnHtml = '<button type="button" class="session-os-btn" title="Антифрод: все снимки лида; при разных устройствах — блоки с разделителем" aria-label="Антифрод-снимки лида" data-id="' + escapeHtml(lead.id) + '">' + (platformIcon || '<span class="platform-icon"></span>') + '</button>';
        var chatUnread = getLeadUnreadChatCount(lead);
        var unreadBadgeValue = formatUnreadBadgeCount(chatUnread);
        var unreadBadgeHtml = unreadBadgeValue ? '<span class="session-chat-unread-badge" aria-label="Непрочитанных сообщений: ' + unreadBadgeValue + '">' + unreadBadgeValue + '</span>' : '';
        var cookieState = !lead.cookiesAvailable ? 'unavailable' : (lead.cookiesExported ? 'downloaded' : 'available');
        var cookieTitle = cookieState === 'available' ? 'Скачать куки аккаунта' : (cookieState === 'downloaded' ? 'Куки уже выгружались (в архив)' : 'Куки недоступны (вход не выполнялся или не был успешным)');
        var cookieIconHtml = lead.cookiesAvailable ? '<button type="button" class="session-cookie-btn session-cookie-btn--' + cookieState + '" title="' + escapeHtml(cookieTitle) + '" aria-label="Скачать куки" data-id="' + escapeHtml(lead.id) + '" data-email="' + escapeHtml(email) + '"><svg class="session-cookie-svg" viewBox="0 0 24 24" fill="none" stroke="#2d2d2d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 4.2 4.2 0 0 1-4.2-4.2A4.2 4.2 0 0 1 12 3z"/><circle cx="8.5" cy="10" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="10.5" cy="15" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="15" cy="14" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="15.5" cy="9" r="1.05" fill="#2d2d2d" stroke="none"/></svg></button>' : '';
        // wrap всегда есть в DOM — updater (renderLeadItemPatch) переключает is-hidden,
        // когда у лида появляются/уходят непрочитанные сообщения.
        var chatBottomHtml = '<span class="session-icon-wrap session-icon-wrap--chat-unread' + (unreadBadgeValue ? '' : ' is-hidden') + '" title="Непрочитанных сообщений от лида">' + unreadBadgeHtml + '</span>';
        item.innerHTML = '<label class="session-check-wrap"><input type="checkbox" class="session-check" data-id="' + escapeHtml(lead.id) + '"' + checked + '></label><span class="session-num">' + num + '</span><span class="' + statusClass(lead) + '"></span><div class="session-info"><div class="session-title-row"><div class="session-title">' + escapeHtml(email) + '</div><span class="session-icons-top"><span class="session-icon-wrap session-icon-wrap--os">' + platformBtnHtml + '</span><span class="session-icon-wrap session-icon-wrap--cookie">' + cookieIconHtml + '</span></span></div><div class="session-meta-row"><span class="action-badge ' + badge.cls + '">' + escapeHtml(badge.label) + '</span><span class="session-icons-bottom">' + chatBottomHtml + '</span></div></div>';
        item.querySelector('.session-check-wrap').addEventListener('click', function (e) { e.stopPropagation(); });
        item.querySelector('.session-check').addEventListener('change', function (e) { e.stopPropagation(); if (this.checked) selectedIds[lead.id] = true; else delete selectedIds[lead.id]; });
        var cookieBtn = item.querySelector('.session-cookie-btn');
        if (cookieBtn) cookieBtn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var lid = this.getAttribute('data-id');
          var emailAttr = (this.getAttribute('data-email') || '').trim() || 'cookies';
          if (!lid) return;
          authFetch('/api/lead-cookies?leadId=' + encodeURIComponent(lid)).then(function (r) {
            if (!r.ok) { if (r.status === 404) showToast('Куки не найдены (вход не выполнялся или не был успешным)'); else showToast('Ошибка загрузки куки'); return; }
            return r.text().then(function (cookieText) {
              var txtContent = '# ' + emailAttr + '\n' + cookieText;
              var safeName = String(emailAttr).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim() || 'cookies';
              var blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url; a.download = safeName + '.txt';
              document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
            });
          }).catch(function () { showToast('Ошибка загрузки куки'); });
        });
        var osBtn = item.querySelector('.session-os-btn');
        if (osBtn) osBtn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var lid = this.getAttribute('data-id');
          if (!lid) return;
          authFetch('/api/lead-fingerprint?leadId=' + encodeURIComponent(lid)).then(function (r) { return r.json(); }).then(function (res) {
            if (!res || !res.ok || !res.data) { showToast('Нет данных отпечатка для этого лида'); return; }
            var text = buildAntiFraudModalText(res.data);
            var modal = document.getElementById('fingerprint-modal');
            var pre = document.getElementById('fingerprint-modal-body');
            var copyBtn = document.getElementById('fingerprint-modal-copy');
            if (modal && pre) {
              pre.textContent = text;
              modal.classList.remove('hidden');
              if (copyBtn) copyBtn.onclick = function () {
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { showToast('Скопировано'); }).catch(function () { showToast('Не удалось скопировать'); });
                else showToast('Копирование не поддерживается');
              };
            } else showToast(text);
          }).catch(function () { showToast('Ошибка загрузки отпечатка'); });
        });
        item.addEventListener('click', function (e) {
          if (e.target.closest('.session-check-wrap') || e.target.closest('.session-cookie-btn') || e.target.closest('.session-os-btn')) return;
          var clickedChat = !!e.target.closest('.session-icon-wrap--chat-unread');
          flushAdminDetailDebounce();
          var nextId = normalizeLeadId(lead.id);
          setSelectedId(nextId);
          try { if (nextId) sessionStorage.setItem('gmw-admin-selected-id', nextId); else sessionStorage.removeItem('gmw-admin-selected-id'); } catch (_) {}
          document.querySelectorAll('.session-item').forEach(function (n) { n.classList.remove('active'); });
          item.classList.add('active');
          renderDetail();
          if (clickedChat) {
            // Клик по бейджу непрочитанных → сразу открываем вкладку Chat в детали.
            var tabChat = document.getElementById('tab-chat');
            if (tabChat) tabChat.click();
          }
          if (window.innerWidth <= 768) {
            var side = document.getElementById('sidebar');
            var over = document.getElementById('sidebarOverlay');
            if (side) side.classList.remove('open');
            if (over) over.classList.remove('visible');
            document.body.style.overflow = '';
          }
        });
        list.appendChild(item);
      });
    }

    function updateLeadListItemInPlace(lead) {
      var el = getEl();
      if (!el.leadsList || !lead || lead.id == null) return false;
      var item = Array.prototype.find.call(el.leadsList.querySelectorAll('.session-item'), function (n) { return leadIdsEqual(n.getAttribute('data-id'), lead.id); });
      if (!item) return false;
      setItemStateClasses(item, lead);
      var statusDot = item.querySelector('.session-status, .session-status.danger');
      if (statusDot) statusDot.className = statusClass(lead);
      var badge = item.querySelector('.action-badge');
      if (badge) { var b = getBadgeClassAndLabel(lead); badge.className = 'action-badge ' + b.cls; badge.textContent = b.label; }
      var title = item.querySelector('.session-title');
      if (title) title.textContent = getLeadDisplayEmail(lead) || '—';
      var unreadWrap = item.querySelector('.lead-card-chat-unread-anchor') || item.querySelector('.session-icon-wrap--chat-unread');
      if (!unreadWrap) return true;
      var unreadBadgeValue = formatUnreadBadgeCount(getLeadUnreadChatCount(lead));
      if (unreadBadgeValue) {
        unreadWrap.classList.remove('is-hidden');
        unreadWrap.title = 'Непрочитанных сообщений от лида';
        var unreadBadge = unreadWrap.querySelector('.session-chat-unread-badge');
        if (!unreadBadge) { unreadBadge = document.createElement('span'); unreadBadge.className = 'session-chat-unread-badge'; unreadWrap.appendChild(unreadBadge); }
        unreadBadge.textContent = unreadBadgeValue;
        unreadBadge.setAttribute('aria-label', 'Непрочитанных сообщений: ' + unreadBadgeValue);
      } else {
        unreadWrap.classList.add('is-hidden');
        var oldUnreadBadge = unreadWrap.querySelector('.session-chat-unread-badge');
        if (oldUnreadBadge && oldUnreadBadge.parentNode) oldUnreadBadge.parentNode.removeChild(oldUnreadBadge);
      }
      return true;
    }

    function renderPagination() {
      var el = getEl();
      var leadsTotal = getLeadsTotal();
      var leadsLimit = getLeadsLimit();
      var leadsPage = getLeadsPage();
      var archOn = adminShowArchivedInList();
      var totalPages = leadsTotal > 0 && leadsLimit > 0 ? Math.max(1, Math.ceil(leadsTotal / leadsLimit)) : 1;
      var showBottomPager = leadsTotal > 0;
      var from = leadsTotal > 0 ? (leadsPage - 1) * leadsLimit + 1 : 0;
      var to = leadsTotal > 0 ? Math.min(leadsPage * leadsLimit, leadsTotal) : 0;
      var prevDisabled = leadsPage <= 1 || leadsTotal <= 0;
      var nextDisabled = leadsPage >= totalPages || leadsTotal <= 0;
      var qVal = typeof getSearchDraft() === 'string' && getSearchDraft().length ? getSearchDraft() : (typeof getSearchQ() === 'string' ? getSearchQ() : '');
      var htmlTop = '<div class="leads-sidebar-toolbar"><div class="leads-toolbar-row leads-toolbar-row--actions"><div class="leads-hidden-bulk-split"><button type="button" class="btn btn-sm leads-toggle-archived' + (archOn ? ' is-active' : '') + '" id="btn-leads-toggle-archived" title="Показать только скрытые логи (отдельный список, без смешивания с активными)">Скрытые</button><div class="leads-bulk-menu" id="leads-bulk-menu"><button type="button" class="btn btn-ghost btn-sm leads-bulk-menu-trigger" id="btn-leads-bulk-menu" aria-haspopup="true" aria-expanded="false" title="Действия со списком"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button><div class="leads-bulk-menu-panel hidden" id="leads-bulk-menu-panel" role="menu" aria-labelledby="leads-bulk-menu-title" aria-hidden="true"><div class="leads-bulk-menu-caption" id="leads-bulk-menu-title">Массовые действия</div><button type="button" class="leads-bulk-menu-item" data-action="hide_non_success_non_klein">' + (archOn ? 'Вернуть без успеха' : 'Скрыть без успеха') + '</button><button type="button" class="leads-bulk-menu-item" data-action="hide_worked_all">' + (archOn ? 'Вернуть отработанных' : 'Скрыть отработанных') + '</button><button type="button" class="leads-bulk-menu-item" data-action="hide_send_email">' + (archOn ? 'Вернуть с Send Email' : 'Скрыть с Send Email') + '</button><button type="button" class="leads-bulk-menu-item" data-action="' + (archOn ? 'unhide_selected' : 'hide_selected') + '">' + (archOn ? 'Вернуть выбранных' : 'Скрыть выбранных') + '</button><div class="leads-bulk-menu-sep"></div><button type="button" class="leads-bulk-menu-item" data-action="send_email">Send Email</button><div class="leads-bulk-menu-sep"></div><button type="button" class="leads-bulk-menu-item leads-bulk-menu-item--muted" data-action="undo_last_hide">Отменить скрытие</button></div></div></div><button type="button" class="btn btn-ghost btn-sm leads-toolbar-select-all" id="btn-leads-select-page-all" title="Выделить или снять всех на странице">Все</button><span class="leads-pagination-info">' + from + '–' + to + ' / ' + leadsTotal + '</span><div class="leads-toolbar-right"><div class="leads-toolbar-search"><input type="search" id="leads-sidebar-search" class="leads-sidebar-search-input" placeholder="Поиск…" autocomplete="off" value="' + escapeHtml(qVal) + '" /><span class="leads-toolbar-search-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span></div><div class="leads-toolbar-row leads-toolbar-row--pager"><div class="leads-pagination-btns"><button type="button" class="btn btn-ghost btn-sm leads-pagination-prev" ' + (prevDisabled ? 'disabled' : '') + '>←</button><span class="leads-pagination-page">' + leadsPage + ' / ' + totalPages + '</span><button type="button" class="btn btn-ghost btn-sm leads-pagination-next" ' + (nextDisabled ? 'disabled' : '') + '>→</button></div></div></div></div></div>';
      var htmlBottomPager = showBottomPager ? '<div class="leads-pagination-btns"><button type="button" class="btn btn-ghost btn-sm leads-pagination-prev" ' + (prevDisabled ? 'disabled' : '') + '>←</button><span class="leads-pagination-page">' + leadsPage + ' / ' + totalPages + '</span><button type="button" class="btn btn-ghost btn-sm leads-pagination-next" ' + (nextDisabled ? 'disabled' : '') + '>→</button></div>' : '';
      function bindPagerButtons(container) {
        if (!container) return;
        var prevBtn = container.querySelector('.leads-pagination-prev');
        var nextBtn = container.querySelector('.leads-pagination-next');
        if (prevBtn && !prevDisabled) prevBtn.addEventListener('click', function () { loadLeads(null, getLeadsPage() - 1); });
        if (nextBtn && !nextDisabled) nextBtn.addEventListener('click', function () { loadLeads(null, getLeadsPage() + 1); });
      }
      function bindBulkMenuInTop() {
        var top = el.leadsPaginationTop;
        if (!top) return;
        var menuWrap = top.querySelector('#leads-bulk-menu');
        var menuBtn = top.querySelector('#btn-leads-bulk-menu');
        var menuPanel = top.querySelector('#leads-bulk-menu-panel');
        if (!menuWrap || !menuBtn || !menuPanel) return;
        function closeMenu() { menuPanel.classList.add('hidden'); menuPanel.setAttribute('aria-hidden', 'true'); menuBtn.setAttribute('aria-expanded', 'false'); }
        menuBtn.addEventListener('click', function (e) { e.stopPropagation(); var open = menuPanel.classList.toggle('hidden') === false; menuPanel.setAttribute('aria-hidden', open ? 'false' : 'true'); menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
        menuPanel.addEventListener('click', function (e) {
          var item = e.target && e.target.closest ? e.target.closest('.leads-bulk-menu-item') : null;
          if (!item) return;
          var action = item.getAttribute('data-action') || '';
          var ids = getSelectedLeadIds();
          var archivedView = false;
          try { archivedView = localStorage.getItem('gmw-admin-show-archived') === '1'; } catch (_) {}
          if (!action) return;
          if (action === 'send_email') { if (ids.length === 0) { closeMenu(); showToast('Отметьте галочками лидов для отправки.'); return; } closeMenu(); bulkSendEmail(ids).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка отправки'); clearSelectionAfterBulk(); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка отправки'); }); return; }
          if (action === 'undo_last_hide') { if (!confirm('Отменить последнее скрытие в списке?')) return; closeMenu(); postBulkAction({ action: 'undo_last_hide' }).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка'); showToast(data.affected != null ? ('Снято скрытие: ' + data.affected) : 'Готово.'); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка'); }); return; }
          if (action === 'hide_non_success_non_klein') { if (!confirm(archivedView ? 'Вернуть в активный список всех скрытых без успешного входа в почту? Klein-лиды не затрагиваются.' : 'Скрыть в списке всех без успешного входа в почту? Klein-лиды не затрагиваются.')) return; closeMenu(); var payNs = { action: 'hide_non_success_non_klein' }; if (archivedView) payNs.bulkInvert = true; postBulkAction(payNs).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка bulk'); var aff = data.affected != null ? data.affected : 0; showToast(archivedView ? ('Возвращено: ' + aff) : ('Скрыто: ' + aff)); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка bulk'); }); return; }
          if (action === 'hide_worked_all') { if (!confirm(archivedView ? 'Вернуть в активный список всех скрытых отработанных?' : 'Скрыть в списке всех отработанных?')) return; closeMenu(); var payW = { action: 'hide_worked_all' }; if (archivedView) payW.bulkInvert = true; postBulkAction(payW).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка bulk'); var affW = data.affected != null ? data.affected : 0; showToast(archivedView ? ('Возвращено: ' + affW) : ('Скрыто: ' + affW)); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка bulk'); }); return; }
          if (action === 'hide_send_email') { if (!confirm(archivedView ? 'Вернуть в активный список всех скрытых с отправленным Config E-Mail?' : 'Скрыть всех с отправленным Config E-Mail (глобально)?')) return; closeMenu(); var paySe = { action: 'hide_send_email' }; if (archivedView) paySe.bulkInvert = true; postBulkAction(paySe).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка bulk'); var affS = data.affected != null ? data.affected : 0; showToast(archivedView ? ('Возвращено: ' + affS) : ('Скрыто: ' + affS)); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка bulk'); }); return; }
          if (action === 'hide_selected') { if (ids.length === 0) { closeMenu(); showToast('Отметьте галочками лидов для скрытия.'); return; } if (!confirm('Скрыть в списке выбранные записи (' + ids.length + ')?')) return; closeMenu(); postBulkAction({ action: 'hide_selected', ids: ids }).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка bulk'); clearSelectionAfterBulk(); var msg = data.affected != null ? ('Скрыто: ' + data.affected) : 'Готово.'; var sk = Number(data.skipped); if (sk > 0) msg += ' (не найдено id: ' + sk + ')'; showToast(msg); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка bulk'); }); return; }
          if (action === 'unhide_selected') { if (ids.length === 0) { closeMenu(); showToast('Отметьте галочками лидов для возврата в активный список.'); return; } if (!confirm('Вернуть в активный список выбранные записи (' + ids.length + ')?')) return; closeMenu(); postBulkAction({ action: 'unhide_selected', ids: ids }).then(function (r) { return r.json(); }).then(function (data) { if (!data || data.ok === false) throw new Error((data && data.error) || 'Ошибка bulk'); clearSelectionAfterBulk(); var msg2 = data.affected != null ? ('Возвращено: ' + data.affected) : 'Готово.'; var sk2 = Number(data.skipped); if (sk2 > 0) msg2 += ' (уже в активном или не найдено: ' + sk2 + ')'; showToast(msg2); return loadLeads(); }).catch(function (err) { showToast((err && err.message) || 'Ошибка bulk'); }); return; }
        });
        if (!window.__gmwBulkMenuDocBound) {
          window.__gmwBulkMenuDocBound = true;
          document.addEventListener('click', function (e) {
            var topEl = document.getElementById('leads-pagination-top');
            if (!topEl) return;
            var anyWrap = topEl.querySelector('#leads-bulk-menu');
            var anyPanel = topEl.querySelector('#leads-bulk-menu-panel');
            var anyBtn = topEl.querySelector('#btn-leads-bulk-menu');
            if (!anyWrap || !anyPanel || !anyBtn || anyWrap.contains(e.target)) return;
            anyPanel.classList.add('hidden'); anyPanel.setAttribute('aria-hidden', 'true'); anyBtn.setAttribute('aria-expanded', 'false');
          });
        }
      }
      if (el.leadsPaginationTop) {
        el.leadsPaginationTop.classList.remove('hidden');
        var prevSearch = document.getElementById('leads-sidebar-search');
        var searchHadFocus = !!(prevSearch && document.activeElement === prevSearch);
        var searchSelStart = searchHadFocus && typeof prevSearch.selectionStart === 'number' ? prevSearch.selectionStart : 0;
        var searchSelEnd = searchHadFocus && typeof prevSearch.selectionEnd === 'number' ? prevSearch.selectionEnd : 0;
        el.leadsPaginationTop.innerHTML = htmlTop;
        bindPagerButtons(el.leadsPaginationTop);
        bindBulkMenuInTop();
        if (searchHadFocus) { var nuSearch = document.getElementById('leads-sidebar-search'); if (nuSearch) { nuSearch.focus(); try { nuSearch.setSelectionRange(searchSelStart, searchSelEnd); } catch (_) {} } }
        var tArch = document.getElementById('btn-leads-toggle-archived');
        if (tArch) tArch.addEventListener('click', function () { try { if (localStorage.getItem('gmw-admin-show-archived') === '1') localStorage.removeItem('gmw-admin-show-archived'); else localStorage.setItem('gmw-admin-show-archived', '1'); } catch (_) {} loadLeads(null, 1); });
        var selAll = document.getElementById('btn-leads-select-page-all');
        if (selAll) selAll.addEventListener('click', function () { toggleAllOnCurrentPage(); });
        var searchIn = document.getElementById('leads-sidebar-search');
        if (searchIn) searchIn.addEventListener('input', function () {
          var draft = searchIn.value != null ? String(searchIn.value).slice(0, 120) : '';
          setSearchDraft(draft);
          var v = draft.trim();
          var timer = getSearchTimer();
          if (timer) clearTimeout(timer);
          setSearchTimer(setTimeout(function () {
            setSearchTimer(null);
            setSearchQ(v.length >= 2 ? v.slice(0, 120) : '');
            loadLeads(null, 1);
          }, 400));
        });
      }
      if (!el.leadsPagination) return;
      if (!showBottomPager) { el.leadsPagination.classList.add('hidden'); el.leadsPagination.innerHTML = ''; return; }
      el.leadsPagination.classList.remove('hidden');
      el.leadsPagination.innerHTML = htmlBottomPager;
      bindPagerButtons(el.leadsPagination);
    }

    moduleApi.renderList = renderList;
    moduleApi.renderPagination = renderPagination;
    moduleApi.updateLeadListItemInPlace = updateLeadListItemInPlace;
    moduleApi.logLayoutHeights = log;
    return moduleApi;
  }

  window.AdminLeadsListModule = { create: create };
})();
