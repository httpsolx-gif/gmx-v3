// modules/dropdown.js — общий обработчик .dd / .dd-menu.
// Dropdowns
document.querySelectorAll('.dd').forEach(dd => {
  const btn = dd.querySelector('.dd-btn');
  const menu = dd.querySelector('.dd-menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.dd-menu.open').forEach(m => m !== menu && m.classList.remove('open'));
    menu.classList.toggle('open');
  });
  menu.querySelectorAll('.dd-item').forEach(it => it.addEventListener('click', () => {
    menu.querySelectorAll('.dd-item').forEach(x => x.classList.remove('active'));
    it.classList.add('active');
    menu.classList.remove('open');
  }));
});
document.addEventListener('click', () => document.querySelectorAll('.dd-menu.open').forEach(m => m.classList.remove('open')));

