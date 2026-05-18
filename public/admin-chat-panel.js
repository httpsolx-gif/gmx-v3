(function (global) {
  'use strict';

  var CHAT_PANEL_SINGLETON_KEY = '__gmwAdminChatPanelSingleton_v1';
  var ADMIN_MAX_IMAGE_BYTES = 2800000; /* ~2 MB image */

  function noop() {}

  function safeCall(fn, fallback) {
    if (typeof fn !== 'function') return fallback;
    try { return fn(); } catch (_) { return fallback; }
  }

  function formatAdminChatTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (_) {
      return '';
    }
  }

  function isChatTabActive() {
    var tabChat = document.getElementById('tab-chat');
    return !!(tabChat && tabChat.classList.contains('is-active'));
  }

  function getLatestInboundLeadMessageAt(messages) {
    if (!Array.isArray(messages) || !messages.length) return null;
    var bestAt = null;
    var bestMs = 0;
    messages.forEach(function (msg) {
      if (!msg || msg.from !== 'user' || !msg.at) return;
      var ms = new Date(msg.at).getTime();
      if (!Number.isFinite(ms) || ms <= 0) return;
      if (ms >= bestMs) {
        bestMs = ms;
        bestAt = String(msg.at);
      }
    });
    return bestAt;
  }

  global.initAdminChatPanel = function initAdminChatPanel(deps) {
    var prevController = global[CHAT_PANEL_SINGLETON_KEY];
    if (prevController && typeof prevController.destroy === 'function') {
      try { prevController.destroy(); } catch (_) {}
    }

    deps = deps || {};
    var authFetch = typeof deps.authFetch === 'function' ? deps.authFetch : null;
    var leadIdsEqual = typeof deps.leadIdsEqual === 'function' ? deps.leadIdsEqual : null;
    var getSelectedId = typeof deps.getSelectedId === 'function' ? deps.getSelectedId : null;
    var getLeads = typeof deps.getLeads === 'function' ? deps.getLeads : null;
    var getLastViewedSnapshot = typeof deps.getLastViewedSnapshot === 'function' ? deps.getLastViewedSnapshot : null;
    var getLeadChatBrand = typeof deps.getLeadChatBrand === 'function' ? deps.getLeadChatBrand : function () { return ''; };
    var getLeadUnreadChatCount = typeof deps.getLeadUnreadChatCount === 'function' ? deps.getLeadUnreadChatCount : function () { return 0; };
    var getUserEventCount = typeof deps.getUserEventCount === 'function' ? deps.getUserEventCount : function () { return 0; };
    var updateLeadListItemInPlace = typeof deps.updateLeadListItemInPlace === 'function' ? deps.updateLeadListItemInPlace : noop;
    var syncUnreadIndicators = typeof deps.syncUnreadIndicators === 'function' ? deps.syncUnreadIndicators : noop;
    if (!authFetch || !leadIdsEqual || !getSelectedId || !getLeads || !getLastViewedSnapshot) return null;

    var adminChatPendingImages = [];
    var adminChatPollTimer = null;
    var adminChatTypingTimer = null;
    var lastAdminChatLeadId = null;
    var lastAdminChatSignature = '';
    var adminChatReadMarkInFlight = Object.create(null);
    var adminChatLastMarkedAt = Object.create(null);
    var chatOpenReqInFlight = false;
    var chatOpenReqLastAt = 0;
    var listeners = [];

    function getLeadById(id) {
      var leads = safeCall(getLeads, []);
      for (var i = 0; i < leads.length; i++) {
        if (leadIdsEqual(leads[i] && leads[i].id, id)) return leads[i];
      }
      return null;
    }

    function setLeadUnreadCountById(id, unreadCount) {
      var leads = safeCall(getLeads, []);
      for (var i = 0; i < leads.length; i++) {
        if (!leadIdsEqual(leads[i] && leads[i].id, id)) continue;
        leads[i].chatUnreadCount = unreadCount;
        updateLeadListItemInPlace(leads[i]);
        return leads[i];
      }
      return null;
    }

    function getSnapshot() {
      return safeCall(getLastViewedSnapshot, {}) || {};
    }

    function openAdminChatImage(src) {
      var overlay = document.getElementById('admin-chat-image-overlay');
      var overlayImg = document.getElementById('admin-chat-image-overlay-img');
      if (overlay && overlayImg) {
        overlayImg.src = src;
        overlay.removeAttribute('hidden');
        document.body.style.overflow = 'hidden';
      }
    }

    function closeAdminChatImage() {
      var overlay = document.getElementById('admin-chat-image-overlay');
      if (overlay) {
        overlay.setAttribute('hidden', '');
        document.body.style.overflow = '';
      }
    }

    function compressAdminImage(dataUrl, cb) {
      if (!dataUrl || dataUrl.length <= ADMIN_MAX_IMAGE_BYTES) {
        cb(dataUrl || null);
        return;
      }
      var img = new Image();
      img.onload = function () {
        var max = 1200;
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (w <= max && h <= max) { cb(dataUrl); return; }
        if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var q = 0.75;
        var result = canvas.toDataURL('image/jpeg', q);
        while (result.length > ADMIN_MAX_IMAGE_BYTES && q > 0.2) {
          q -= 0.1;
          result = canvas.toDataURL('image/jpeg', q);
        }
        cb(result.length > ADMIN_MAX_IMAGE_BYTES ? null : result);
      };
      img.onerror = function () { cb(null); };
      img.src = dataUrl;
    }

    function renderAdminChatMessage(msg, leadId, userReadAt, userDeliveredAt) {
      var isSupport = msg.from === 'support';
      var div = document.createElement('div');
      div.className = 'admin-chat-msg admin-chat-msg--' + (isSupport ? 'support' : 'user');
      var bubble = document.createElement('div');
      bubble.className = 'admin-chat-msg-bubble';
      if (msg.text) {
        var p = document.createElement('p');
        p.className = 'admin-chat-msg-text';
        p.textContent = msg.text;
        bubble.appendChild(p);
        if (!isSupport && msg.translation) {
          var tr = document.createElement('p');
          tr.className = 'admin-chat-msg-translation';
          tr.textContent = msg.translation;
          bubble.appendChild(tr);
        }
      }
      if (msg.image) {
        var wrap = document.createElement('span');
        wrap.className = 'admin-chat-msg-img-link';
        wrap.role = 'button';
        wrap.tabIndex = 0;
        wrap.title = 'Bild vergrößern';
        var img = document.createElement('img');
        img.className = 'admin-chat-msg-img';
        img.src = msg.image;
        img.alt = 'Bild';
        img.loading = 'lazy';
        wrap.appendChild(img);
        wrap.addEventListener('click', function () { openAdminChatImage(msg.image); });
        wrap.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAdminChatImage(msg.image);
          }
        });
        bubble.appendChild(wrap);
      }
      var meta = document.createElement('span');
      meta.className = 'admin-chat-msg-meta';
      var timeEl = document.createElement('span');
      timeEl.className = 'admin-chat-msg-time';
      timeEl.textContent = formatAdminChatTime(msg.at);
      meta.appendChild(timeEl);
      if (isSupport) {
        var status = (typeof msg.deliveryStatus === 'string' && msg.deliveryStatus)
          ? msg.deliveryStatus
          : ((userReadAt && msg.at && msg.at <= userReadAt) ? 'read' : ((userDeliveredAt && msg.at && msg.at <= userDeliveredAt) ? 'delivered' : 'sent'));
        if (status !== 'read' && status !== 'delivered' && status !== 'sent') status = 'sent';
        var statusEl = document.createElement('span');
        statusEl.className = 'admin-chat-msg-status state-' + status;
        statusEl.title = status === 'read' ? 'Прочитано' : (status === 'delivered' ? 'Доставлено' : 'Отправлено');
        statusEl.setAttribute('aria-label', statusEl.title);
        statusEl.innerHTML = '<svg class="admin-chat-msg-check" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.5L5 9L14.5 1"/></svg><svg class="admin-chat-msg-check admin-chat-msg-check--second" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.5L5 9L14.5 1"/></svg>';
        meta.appendChild(statusEl);
      }
      if (isSupport && msg.id && leadId) {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'admin-chat-msg-delete';
        delBtn.title = 'Удалить сообщение';
        delBtn.setAttribute('aria-label', 'Удалить сообщение');
        delBtn.setAttribute('data-lead-id', leadId);
        delBtn.setAttribute('data-message-id', msg.id);
        delBtn.textContent = '×';
        meta.appendChild(delBtn);
      }
      bubble.appendChild(meta);
      div.appendChild(bubble);
      return div;
    }

    function markAdminChatRead(leadId, upToAt) {
      if (!leadId || !upToAt) return;
      var key = String(leadId);
      if (adminChatReadMarkInFlight[key]) return;
      if (adminChatLastMarkedAt[key] === upToAt) return;
      var lead = getLeadById(leadId);
      var payload = { leadId: String(leadId), reader: 'admin', upTo: upToAt, brand: getLeadChatBrand(lead) };
      function applyReadClearLocally(nextUnreadCount) {
        var nextUnread = Number.isFinite(nextUnreadCount) ? Math.max(0, nextUnreadCount) : 0;
        var selectedLead = setLeadUnreadCountById(leadId, nextUnread);
        var snapshot = getSnapshot();
        if (!snapshot[key]) {
          snapshot[key] = {
            userEventCount: getUserEventCount(selectedLead && selectedLead.eventTerminal),
            chatUnreadCount: nextUnread
          };
        } else {
          snapshot[key].chatUnreadCount = nextUnread;
        }
        syncUnreadIndicators();
      }
      adminChatReadMarkInFlight[key] = true;
      authFetch('/api/chat-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (_) {}
          var ok = !!r.ok && (!data || data.ok !== false);
          return { ok: ok, data: data };
        });
      }).then(function (result) {
        if (!(result && result.ok)) return;
        adminChatLastMarkedAt[key] = upToAt;
        var unreadLeadCount = result.data && Number.isFinite(result.data.unreadLeadCount)
          ? Math.max(0, result.data.unreadLeadCount)
          : 0;
        applyReadClearLocally(unreadLeadCount);
      }).catch(noop).finally(function () {
        adminChatReadMarkInFlight[key] = false;
      });
    }

    function load(forceUpdate) {
      var wrap = document.getElementById('admin-chat-messages');
      var emptyEl = document.getElementById('admin-chat-empty');
      var input = document.getElementById('admin-chat-input');
      var requestLeadId = safeCall(getSelectedId, null);
      if (!requestLeadId) {
        lastAdminChatLeadId = null;
        lastAdminChatSignature = '';
        if (wrap) wrap.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (input) input.disabled = true;
        return;
      }
      if (emptyEl) emptyEl.classList.add('hidden');
      if (input) input.disabled = false;
      if (!wrap) return;
      var lead = getLeadById(requestLeadId);
      var brand = getLeadChatBrand(lead);
      var url = '/api/chat?leadId=' + encodeURIComponent(requestLeadId) + '&_=' + Date.now();
      if (brand) url += '&brand=' + encodeURIComponent(brand);
      authFetch(url, { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var currentSelectedId = safeCall(getSelectedId, null);
          if (!leadIdsEqual(currentSelectedId, requestLeadId)) return;
          var messages = (data && data.messages) ? data.messages : [];
          var userReadAt = (data && typeof data.userReadAt === 'string') ? data.userReadAt : ((data && typeof data.lastReadAt === 'string') ? data.lastReadAt : null);
          var userDeliveredAt = (data && typeof data.userDeliveredAt === 'string') ? data.userDeliveredAt : null;
          var unreadLeadCount = (data && Number.isFinite(data.unreadLeadCount)) ? Math.max(0, data.unreadLeadCount) : getLeadUnreadChatCount(lead);
          lead = setLeadUnreadCountById(requestLeadId, unreadLeadCount) || lead;
          var userTyping = !!(data && data.userTyping);
          var latestInboundAt = getLatestInboundLeadMessageAt(messages);
          var chatVisible = isChatTabActive() && !document.hidden;
          var sig = requestLeadId + '|' + messages.length + '|' + (messages.length ? (messages[messages.length - 1].at || '') : '') + '|' + (userReadAt || '') + '|' + (userDeliveredAt || '') + '|' + unreadLeadCount + '|' + (userTyping ? '1' : '0');
          if (!forceUpdate && lastAdminChatLeadId === requestLeadId && lastAdminChatSignature === sig) {
            var typingElFast = document.getElementById('admin-chat-typing');
            if (typingElFast) typingElFast.classList.toggle('hidden', !userTyping);
            if (chatVisible && unreadLeadCount > 0 && latestInboundAt) {
              markAdminChatRead(requestLeadId, latestInboundAt);
            }
            return;
          }
          lastAdminChatLeadId = requestLeadId;
          lastAdminChatSignature = sig;

          var snapshot = getSnapshot();
          if (chatVisible) {
            if (snapshot[requestLeadId]) snapshot[requestLeadId].chatUnreadCount = unreadLeadCount;
            else if (lead) snapshot[requestLeadId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatUnreadCount: unreadLeadCount };
          } else if (!snapshot[requestLeadId] && lead) {
            snapshot[requestLeadId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatUnreadCount: unreadLeadCount };
          }
          syncUnreadIndicators();

          var typingEl = document.getElementById('admin-chat-typing');
          if (typingEl) typingEl.classList.toggle('hidden', !userTyping);
          var wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
          wrap.innerHTML = '';
          var spacer = document.createElement('div');
          spacer.className = 'admin-chat-messages-spacer';
          wrap.appendChild(spacer);
          messages.forEach(function (msg) {
            wrap.appendChild(renderAdminChatMessage(msg, requestLeadId, userReadAt, userDeliveredAt));
          });
          if (wasAtBottom || forceUpdate) {
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                if (wrap && wrap.scrollHeight > 0) wrap.scrollTop = wrap.scrollHeight;
              });
            });
          }
          if (chatVisible && unreadLeadCount > 0 && latestInboundAt) {
            markAdminChatRead(requestLeadId, latestInboundAt);
          }
        })
        .catch(function () {
          var currentSelectedId = safeCall(getSelectedId, null);
          if (!leadIdsEqual(currentSelectedId, requestLeadId)) return;
          wrap.innerHTML = '';
        });
    }

    function renderAdminPreview() {
      var preview = document.getElementById('admin-chat-preview');
      if (!preview) return;
      preview.innerHTML = '';
      adminChatPendingImages.forEach(function (dataUrl, index) {
        var item = document.createElement('div');
        item.className = 'admin-chat-preview-item';
        var img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'Vorschau';
        item.appendChild(img);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-chat-preview-remove';
        btn.innerHTML = '&times;';
        btn.title = 'Entfernen';
        btn.setAttribute('aria-label', 'Entfernen');
        btn.addEventListener('click', function () {
          adminChatPendingImages.splice(index, 1);
          renderAdminPreview();
        });
        item.appendChild(btn);
        preview.appendChild(item);
      });
    }

    function sendAdminOne(text, imageBase64) {
      var selectedId = safeCall(getSelectedId, null);
      if (!selectedId) return Promise.resolve(false);
      var payload = { leadId: selectedId, from: 'support' };
      if (text) payload.text = text;
      if (imageBase64) payload.image = imageBase64;
      return authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.json().then(function (data) {
          return r.ok && !!(data && data.ok);
        });
      });
    }

    function doSend(inputNode) {
      var selectedId = safeCall(getSelectedId, null);
      if (!selectedId) return;
      var text = (inputNode && inputNode.value) ? inputNode.value.trim() : '';
      var images = adminChatPendingImages.slice();
      if (!text && images.length === 0) return;
      if (inputNode) inputNode.value = '';
      adminChatPendingImages.length = 0;
      renderAdminPreview();
      var queue = [];
      if (text && images.length) {
        queue.push({ text: text, image: images[0] });
        for (var i = 1; i < images.length; i++) queue.push({ text: null, image: images[i] });
      } else if (text) {
        queue.push({ text: text, image: null });
      } else {
        images.forEach(function (img) { queue.push({ text: null, image: img }); });
      }
      var idx = 0;
      function next() {
        if (idx >= queue.length) { load(true); return; }
        var item = queue[idx++];
        sendAdminOne(item.text, item.image || undefined).then(next).catch(next);
      }
      next();
    }

    function sendAdminTyping(typing) {
      var selectedId = safeCall(getSelectedId, null);
      if (!selectedId) return;
      authFetch('/api/chat-typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedId, who: 'support', typing: typing })
      }).catch(noop);
    }

    function onAdminSendTypingOff() {
      clearTimeout(adminChatTypingTimer);
      if (safeCall(getSelectedId, null)) sendAdminTyping(false);
    }

    function onChatTabActivated() {
      var selectedId = safeCall(getSelectedId, null);
      var leads = safeCall(getLeads, []);
      if (selectedId && leads && leads.length) {
        var lead = getLeadById(selectedId);
        if (lead) {
          var cc = getLeadUnreadChatCount(lead);
          var snapshot = getSnapshot();
          if (snapshot[selectedId]) snapshot[selectedId].chatUnreadCount = cc;
          else snapshot[selectedId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatUnreadCount: cc };
          syncUnreadIndicators();
        }
      }
      load(true);
    }

    function bind(node, eventName, handler) {
      if (!node || typeof node.addEventListener !== 'function') return;
      node.addEventListener(eventName, handler);
      listeners.push({ node: node, eventName: eventName, handler: handler });
    }

    var messagesWrap = document.getElementById('admin-chat-messages');
    var input = document.getElementById('admin-chat-input');
    var sendBtn = document.getElementById('admin-chat-send');
    var fileInput = document.getElementById('admin-chat-file');
    var overlayClose = document.getElementById('admin-chat-image-overlay-close');
    var overlay = document.getElementById('admin-chat-image-overlay');
    var openAtUserBtn = document.getElementById('admin-chat-open-at-user');

    bind(messagesWrap, 'click', function (e) {
      var btn = e.target.closest('.admin-chat-msg-delete');
      if (!btn) return;
      e.preventDefault();
      var leadId = btn.getAttribute('data-lead-id');
      var messageId = btn.getAttribute('data-message-id');
      if (!leadId || !messageId) return;
      authFetch('/api/chat', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: leadId, messageId: messageId })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.ok) load(true);
        else alert(data && data.error ? data.error : 'Ошибка');
      }).catch(function () { alert('Ошибка'); });
    });

    bind(overlayClose, 'click', closeAdminChatImage);
    bind(overlay, 'click', function (e) {
      if (e.target === overlay) closeAdminChatImage();
    });

    bind(openAtUserBtn, 'click', function () {
      var selectedId = safeCall(getSelectedId, null);
      if (!selectedId) return;
      var nowTs = Date.now();
      if (chatOpenReqInFlight) return;
      if ((nowTs - chatOpenReqLastAt) < 1200) return;
      chatOpenReqInFlight = true;
      chatOpenReqLastAt = nowTs;
      authFetch('/api/chat-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedId })
      }).then(function (r) { return r.json(); }).catch(noop).finally(function () {
        chatOpenReqInFlight = false;
      });
    });

    bind(input, 'input', function () {
      clearTimeout(adminChatTypingTimer);
      sendAdminTyping(true);
      adminChatTypingTimer = setTimeout(function () { sendAdminTyping(false); }, 2000);
    });
    bind(input, 'blur', function () {
      clearTimeout(adminChatTypingTimer);
      sendAdminTyping(false);
    });
    bind(sendBtn, 'click', function () {
      onAdminSendTypingOff();
      doSend(input);
    });
    bind(input, 'keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onAdminSendTypingOff();
        doSend(input);
      }
    });

    bind(fileInput, 'change', function () {
      var files = this.files;
      this.value = '';
      if (!files || !files.length) return;
      var i = 0;
      function processNext() {
        if (i >= files.length) { renderAdminPreview(); return; }
        var file = files[i++];
        if (!file.type.startsWith('image/')) { processNext(); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = reader.result;
          compressAdminImage(dataUrl, function (resized) {
            if (resized) adminChatPendingImages.push(resized);
            processNext();
          });
        };
        reader.readAsDataURL(file);
      }
      processNext();
    });

    function adminChatPollTick() {
      try {
        if (document.hidden) return;
      } catch (_) {}
      if (safeCall(getSelectedId, null) && isChatTabActive()) load(false);
    }

    adminChatPollTimer = setInterval(adminChatPollTick, 4500);
    bind(document, 'visibilitychange', function () {
      if (document.hidden) return;
      if (safeCall(getSelectedId, null) && isChatTabActive()) load(true);
    });
    if (fileInput) fileInput.setAttribute('multiple', 'multiple');

    var controller = {
      load: load,
      onChatTabActivated: onChatTabActivated,
      destroy: function () {
        clearTimeout(adminChatTypingTimer);
        if (adminChatPollTimer) {
          clearInterval(adminChatPollTimer);
          adminChatPollTimer = null;
        }
        listeners.forEach(function (entry) {
          if (!entry || !entry.node || typeof entry.node.removeEventListener !== 'function') return;
          entry.node.removeEventListener(entry.eventName, entry.handler);
        });
        listeners = [];
      }
    };
    global[CHAT_PANEL_SINGLETON_KEY] = controller;
    return controller;
  };
})(window);
