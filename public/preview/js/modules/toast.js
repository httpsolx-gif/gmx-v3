// modules/toast.js — единая система всплывающих уведомлений.
// Использование: import { toast } from './toast.js'; toast.success('Заголовок', 'Подзаголовок');

const ICONS = {
  success: '<polyline points="20 6 9 17 4 12"/>',
  info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  error:   '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
};

const COLORS = {
  success: 'var(--success)',
  info:    'var(--info, var(--accent))',
  warning: 'var(--warning)',
  error:   'var(--danger)',
};

function ensureContainer() {
  let c = document.getElementById('toasts');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toasts';
    c.className = 'toasts';
    document.body.appendChild(c);
  }
  return c;
}

function show(level, title, sub) {
  const container = ensureContainer();
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.opacity = '0';
  el.style.transform = 'translateY(8px)';
  el.style.transition = 'opacity 180ms, transform 180ms';
  el.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="${COLORS[level] || 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[level] || ICONS.info}</svg>
    <div>
      <div class="toast-title">${title || ''}</div>
      ${sub ? `<div class="toast-sub">${sub}</div>` : ''}
    </div>
  `;
  container.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

export const toast = {
  success: (t, s) => show('success', t, s),
  info:    (t, s) => show('info', t, s),
  warning: (t, s) => show('warning', t, s),
  error:   (t, s) => show('error', t, s),
};

// Делаем доступным глобально — для inline-onclick в HTML, если кому-то удобнее
window.toast = toast;
