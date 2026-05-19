// modules/brand.js — переключатель E-Mail/Klein/Vint/Скрытые (mode-pill в топбаре).
// Brand switcher — updates topbar brand-pill logo
const brandPillImg = document.getElementById('brand-pill-img');
const brandLogos = {
  webde: 'https://www.designtagebuch.de/wp-content/uploads/mediathek//2019/05/web-de-logo.jpg',
  klein: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Kleinanzeigen_Logo_2023.svg/960px-Kleinanzeigen_Logo_2023.svg.png',
  vint:  'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Vinted_logo.png/1280px-Vinted_logo.png',
  gmx:   'https://upload.wikimedia.org/wikipedia/commons/4/4a/GMX-Logo_%282018-%29.svg'
};
const brandAlts = { webde: 'WEB.DE', klein: 'Kleinanzeigen', vint: 'Vinted', gmx: 'GMX' };
document.querySelectorAll('#mode-pill button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#mode-pill button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const key = b.getAttribute('data-brand');
  if (brandLogos[key]) {
    brandPillImg.src = brandLogos[key];
    brandPillImg.alt = brandAlts[key];
  }
}));

// Скрытые-toggle в топбаре
const hiddenToggle = document.getElementById('hidden-toggle');
if (hiddenToggle) hiddenToggle.addEventListener('click', () => {
  const on = hiddenToggle.getAttribute('aria-pressed') === 'true';
  hiddenToggle.setAttribute('aria-pressed', on ? 'false' : 'true');
});

