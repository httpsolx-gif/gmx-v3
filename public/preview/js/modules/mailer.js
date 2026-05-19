// modules/mailer.js — Mailer: вкладки Рассылка/Прогрев.
// Mailer — переключение вкладок Рассылка / Прогрев
document.querySelectorAll('.mailer-tab').forEach(t => t.addEventListener('click', () => {
  const target = t.getAttribute('data-mailer-tab');
  document.querySelectorAll('.mailer-tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelectorAll('.mailer-panel').forEach(p => {
    p.hidden = p.getAttribute('data-mailer-pane') !== target;
  });
}));

