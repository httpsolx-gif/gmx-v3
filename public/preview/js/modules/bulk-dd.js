// modules/bulk-dd.js — выпадашка массовых действий рядом с "Все".
// + помечает <body> классом ui-mode-{webde|gmx|klein|vint} от выбранного
//   бренда в топбаре, чтобы CSS прятал пункты не своего бренда.

import { toast } from './toast.js';

const dd      = document.getElementById('bulk-dd');
const trigger = document.getElementById('bulk-dd-trigger');
const menu    = document.getElementById('bulk-dd-menu');
const selCountEl = document.getElementById('bulk-sel-count');

function open() {
  if (!menu) return;
  menu.hidden = false;
  trigger && trigger.setAttribute('aria-expanded', 'true');
  // обновляем счётчик выбранных при открытии
  if (selCountEl) {
    const n = document.querySelectorAll('.lead-row.selected').length;
    selCountEl.textContent = n;
    selCountEl.style.display = n ? '' : 'none';
  }
}
function close() {
  if (!menu) return;
  menu.hidden = true;
  trigger && trigger.setAttribute('aria-expanded', 'false');
}

trigger && trigger.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden ? open() : close();
});
document.addEventListener('click', (e) => {
  if (dd && !dd.contains(e.target)) close();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

// === Действия ===
const ACTIONS = {
  'hide-worked':   { title: 'Отработанные скрыты',     sub: '— перенесены в архив' },
  'hide-selected': { title: 'Выбранные скрыты',         sub: 'Esc — снять выделение' },
  'hide-no-mail':  { title: 'Без входа в почту скрыты', sub: 'Перенесено в архив' },
  'show-archived': { title: 'Архив открыт',             sub: 'Кнопка вернётся при следующем добавлении' },
  'undo-hide':     { title: 'Последнее скрытие отменено' },
};
menu && menu.querySelectorAll('.bulk-dd-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const k = btn.getAttribute('data-bulk');
    const a = ACTIONS[k];
    if (k === 'hide-selected') {
      const n = document.querySelectorAll('.lead-row.selected').length;
      if (!n) { toast.warning('Никто не выбран', 'ПКМ по логам — добавит в выделение'); close(); return; }
      document.querySelectorAll('.lead-row.selected').forEach((r) => {
        r.style.transition = 'opacity 180ms, height 180ms';
        r.style.opacity = '0';
        setTimeout(() => r.remove(), 200);
      });
      toast.success('Выбранные скрыты', `${n} лид(ов) → архив`);
    } else if (a) {
      toast[k === 'undo-hide' ? 'info' : 'success'](a.title, a.sub || '');
    }
    close();
  });
});

// === Связка с топбаром: <body class="ui-mode-…"> ===
// Активный data-brand в #mode-pill определяет видимые пункты меню.
function syncUiMode() {
  const active = document.querySelector('#mode-pill button.active');
  const key = active ? active.getAttribute('data-brand') : 'webde';
  const map = { webde: 'email', gmx: 'email', klein: 'klein', vint: 'vint', hidden: 'email' };
  const ui = map[key] || 'email';
  document.body.classList.remove('ui-mode-email', 'ui-mode-klein', 'ui-mode-vint');
  document.body.classList.add('ui-mode-' + ui);
}
syncUiMode();
document.querySelectorAll('#mode-pill button').forEach((b) => b.addEventListener('click', syncUiMode));
