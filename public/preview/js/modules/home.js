// modules/home.js — режимы по брендам + сохранить на главной.
// Главная: переключатели режимов по брендам + чип-сегменты + Сохранить
(function () {
  // mode-row: сегменты режима, активен один в строке
  document.querySelectorAll('.mode-row').forEach((row) => {
    row.querySelectorAll('.mode-seg').forEach((seg) => {
      seg.addEventListener('click', () => {
        row.querySelectorAll('.mode-seg').forEach((x) => x.classList.remove('active'));
        seg.classList.add('active');
      });
    });
  });
  // chip-tab внутри home-pane (стартовая страница / UI-режим)
  document.querySelectorAll('[data-page="home"] .input-row').forEach((group) => {
    const chips = group.querySelectorAll('.chip-tab');
    chips.forEach((c) => c.addEventListener('click', () => {
      chips.forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
    }));
  });
  // Кнопка «Сохранить» на главной
  const btn = document.getElementById('home-save-btn');
  const status = document.getElementById('home-save-status');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Сохранено';
      if (status) status.textContent = new Date().toLocaleTimeString() + ' · сохранено';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; }, 1400);
    });
  }
})();

