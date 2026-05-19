// modules/nav.js — view-switcher, config-nav, лиды-сайдбар, rail, kbar, init.
// View switcher
const body = document.getElementById('body');
const views = {
  leads:  document.getElementById('view-leads'),
  stats:  document.getElementById('view-stats'),
  config: document.getElementById('view-config'),
  mailer: document.getElementById('view-mailer'),
};
const ALL_VIEWS = ['view-leads', 'view-stats', 'view-config', 'view-mailer'];
function setView(v) {
  Object.entries(views).forEach(([k, el]) => { if (el) el.hidden = (k !== v); });
  body.classList.remove(...ALL_VIEWS);
  body.classList.add('view-' + v);
  document.body.classList.remove(...ALL_VIEWS);
  document.body.classList.add('view-' + v);
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === v));
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  const target = b.getAttribute('data-view');
  // toggle: повторный клик по уже активной view-кнопке возвращает в логи
  const cur = (body.className.match(/view-(leads|config|mailer)/) || [])[1];
  setView(cur === target && target !== 'leads' ? 'leads' : target);
}));

// Клик по бренд-пиллу в шапке: если в config/mailer — назад к логам.
const brandPill = document.getElementById('brand-pill');
if (brandPill) {
  brandPill.addEventListener('click', () => {
    const cur = (body.className.match(/view-(leads|config|mailer)/) || [])[1];
    if (cur && cur !== 'leads') setView('leads');
  });
}

// Lead-row выделение:
//   1) ПКМ по любому логу — входим в "режим выбора", лид выделяется.
//   2) Пока выбор есть → ЛКМ по любому логу = toggle выделения (не делает active).
//   3) Когда сняли все выделения → ЛКМ снова открывает лид как раньше.
//   Esc — снимает весь выбор разом.
function setSelectionMode(on) {
  document.body.classList.toggle('is-selecting', !!on);
}
function syncSelectionState() {
  const n = document.querySelectorAll('.lead-row.selected').length;
  setSelectionMode(n > 0);
}
let lastSelectAnchor = null; // последний лид, отмеченный ПКМ или Shift-click — точка отсчёта для shift-range
function rowsArray() { return Array.from(document.querySelectorAll('.lead-row')); }
function selectRange(fromEl, toEl, mode /* 'add' | 'set' */) {
  const rows = rowsArray();
  const i1 = rows.indexOf(fromEl);
  const i2 = rows.indexOf(toEl);
  if (i1 < 0 || i2 < 0) return;
  const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
  if (mode === 'set') rows.forEach((r) => r.classList.remove('selected'));
  for (let i = a; i <= b; i++) rows[i].classList.add('selected');
}

// Делегирование на .lead-list — обработчики переживают переотрисовку
// списка лидов из backend.js (innerHTML заменяет .lead-row элементы).
const leadList = document.querySelector('.lead-list');
if (leadList) {
  leadList.addEventListener('click', (e) => {
    const r = e.target.closest && e.target.closest('.lead-row');
    if (!r || !leadList.contains(r)) return;
    if (document.body.classList.contains('is-selecting')) {
      e.preventDefault();
      if (e.shiftKey && lastSelectAnchor && lastSelectAnchor !== r) {
        selectRange(lastSelectAnchor, r, 'add');
      } else {
        r.classList.toggle('selected');
        if (r.classList.contains('selected')) lastSelectAnchor = r;
      }
      syncSelectionState();
      return;
    }
    leadList.querySelectorAll('.lead-row').forEach((x) => x.classList.remove('active'));
    r.classList.add('active');
  });
  leadList.addEventListener('contextmenu', (e) => {
    const r = e.target.closest && e.target.closest('.lead-row');
    if (!r) return;
    e.preventDefault();
    r.classList.toggle('selected');
    if (r.classList.contains('selected')) lastSelectAnchor = r;
    syncSelectionState();
    if (window.toast && document.querySelectorAll('.lead-row.selected').length === 1 && r.classList.contains('selected')) {
      window.toast.info('Режим выбора', 'ЛКМ — добавить · Shift+ЛКМ — диапазон · Esc — снять');
    }
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sel = document.querySelectorAll('.lead-row.selected');
    if (sel.length) {
      sel.forEach((x) => x.classList.remove('selected'));
      syncSelectionState();
    }
  }
});

// Кнопка "Все" — выделяет всех / снимает всё выделение.
const selectAllBtn = document.getElementById('leads-select-all');
if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    const rows = document.querySelectorAll('.lead-row');
    const total = rows.length;
    const already = document.querySelectorAll('.lead-row.selected').length;
    if (already === total) {
      // всё выделено → снимаем
      rows.forEach((r) => r.classList.remove('selected'));
      lastSelectAnchor = null;
      syncSelectionState();
      if (window.toast) window.toast.info('Выделение снято');
    } else {
      rows.forEach((r) => r.classList.add('selected'));
      lastSelectAnchor = rows[0] || null;
      syncSelectionState();
      if (window.toast) window.toast.info('Выделены все', total + ' лид(ов) · ЛКМ — убрать конкретного');
    }
  });
}

// Right rail buttons — переключают, что показать в центральной зоне лида:
// Chat → чат с лидом, остальные → стандартный Events/Log.
const leadEvents = document.getElementById('lead-events');
const leadChat   = document.getElementById('lead-chat');
function setLeadCenter(name) {
  if (!leadEvents || !leadChat) return;
  const showChat = name === 'chat';
  leadEvents.hidden = showChat;
  leadChat.hidden = !showChat;
}
document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.rail-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  setLeadCenter(b.getAttribute('data-rail'));
}));


// Config nav — переключение страниц
document.querySelectorAll('.config-nav-item').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.config-nav-item').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const page = b.getAttribute('data-config');
  document.querySelectorAll('.config-pane-inner').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-page') === page);
  });
  const pane = document.querySelector('.config-pane');
  if (pane) pane.scrollTo({ top: 0, behavior: 'instant' });
}));

// Campaign rows
document.querySelectorAll('.campaign-row').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.campaign-row').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
}));

// Toggles
document.querySelectorAll('[data-toggle]').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));

// Command palette
const kbarOverlay = document.getElementById('kbar-overlay');
const kbarInput = document.getElementById('kbar-input');
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); kbarOverlay.classList.add('open'); setTimeout(() => kbarInput.focus(), 60); }
  if (e.key === 'Escape') {
    kbarOverlay.classList.remove('open');
    document.querySelectorAll('.dd-menu.open').forEach(m => m.classList.remove('open'));
  }
});
kbarOverlay.addEventListener('click', (e) => { if (e.target === kbarOverlay) kbarOverlay.classList.remove('open'); });
document.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => {
  setView(b.getAttribute('data-jump'));
  kbarOverlay.classList.remove('open');
}));

// init
setView('leads');

// Auto-hide first toast after 4s
setTimeout(() => {
  const t = document.querySelector('#toasts .toast');
  if (t) { t.style.transition = 'opacity 200ms, transform 200ms'; t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; setTimeout(() => t.remove(), 220); }
}, 4500);
