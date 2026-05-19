// modules/email.js — E-Mail редактор: ресайз, дизайн/код, бренд-таб превью, сохранить.
// Email-редактор: дрэг ресайз колонок + кнопка «Сохранить»
(function () {
  const grid = document.querySelector('.email-editor');
  const handle = document.getElementById('email-editor-resizer');
  if (grid && handle) {
    let startX = 0;
    let startWidth = 0;
    const min = 320;
    const max = () => Math.max(min, Math.floor(grid.getBoundingClientRect().width - 280));
    function onMove(e) {
      const dx = e.clientX - startX;
      // тянем влево → превью шире (вправо → уже)
      let next = startWidth - dx;
      const m = max();
      if (next < min) next = min;
      if (next > m) next = m;
      grid.style.setProperty('--email-preview-w', next + 'px');
    }
    function onUp() {
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-col-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('email-preview-w', grid.style.getPropertyValue('--email-preview-w')); } catch (_) {}
    }
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = parseFloat(getComputedStyle(grid).getPropertyValue('--email-preview-w')) || 480;
      handle.classList.add('is-dragging');
      document.body.classList.add('is-col-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // двойной клик — сброс к авто
    handle.addEventListener('dblclick', () => {
      grid.style.removeProperty('--email-preview-w');
      try { localStorage.removeItem('email-preview-w'); } catch (_) {}
    });
    // восстановить сохранённое значение
    try {
      const saved = localStorage.getItem('email-preview-w');
      if (saved) grid.style.setProperty('--email-preview-w', saved);
    } catch (_) {}
  }

  // Ресайз превью по вертикали (нижний хэндл)
  const card = document.getElementById('email-preview-card');
  const handleY = document.getElementById('email-preview-resizer-y');
  if (card && handleY) {
    let startY = 0;
    let startH = 0;
    const minH = 360;
    const maxH = () => Math.floor(window.innerHeight * 0.96);
    function onMoveY(e) {
      const dy = e.clientY - startY;
      let next = startH + dy;
      if (next < minH) next = minH;
      const m = maxH();
      if (next > m) next = m;
      card.style.setProperty('--email-preview-h', next + 'px');
    }
    function onUpY() {
      handleY.classList.remove('is-dragging');
      document.body.classList.remove('is-row-resizing');
      window.removeEventListener('mousemove', onMoveY);
      window.removeEventListener('mouseup', onUpY);
      try { localStorage.setItem('email-preview-h', card.style.getPropertyValue('--email-preview-h')); } catch (_) {}
    }
    handleY.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = card.getBoundingClientRect().height;
      handleY.classList.add('is-dragging');
      document.body.classList.add('is-row-resizing');
      window.addEventListener('mousemove', onMoveY);
      window.addEventListener('mouseup', onUpY);
    });
    handleY.addEventListener('dblclick', () => {
      card.style.removeProperty('--email-preview-h');
      try { localStorage.removeItem('email-preview-h'); } catch (_) {}
    });
    try {
      const savedH = localStorage.getItem('email-preview-h');
      if (savedH) card.style.setProperty('--email-preview-h', savedH);
    } catch (_) {}
  }

  // Кнопка «Сохранить»
  const saveBtn = document.getElementById('email-save-btn');
  const saveStatus = document.getElementById('email-save-status');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true;
      const orig = saveBtn.innerHTML;
      saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Сохранено';
      if (saveStatus) saveStatus.textContent = new Date().toLocaleTimeString() + ' · сохранено';
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = orig;
      }, 1400);
    });
  }
})();

// Email превью: переключатель Дизайн / Код + редактор HTML
(function () {
  const designPane = document.getElementById('email-preview-design');
  const codePane = document.getElementById('email-preview-code');
  if (!designPane || !codePane) return;

  const taHidden = document.getElementById('email-html-textarea');
  const ta = document.getElementById('email-html-textarea-visible');
  const gutter = document.getElementById('email-html-gutter');
  const rowsInfo = document.getElementById('email-html-rows');
  const btnCopy = document.getElementById('email-html-copy');
  const btnWrap = document.getElementById('email-html-wrap');
  const modeBtns = document.querySelectorAll('#email-preview-mode .email-vp-btn');

  // Подтягиваем исходное значение
  if (ta && taHidden) ta.value = taHidden.value;

  function syncGutter() {
    if (!ta || !gutter) return;
    const lines = ta.value.split('\n').length;
    let out = '';
    for (let i = 1; i <= lines; i++) out += (i === 1 ? '' : '\n') + i;
    gutter.textContent = out;
    if (rowsInfo) rowsInfo.textContent = lines + ' строк · ' + ta.value.length + ' симв.';
  }
  if (ta) {
    ta.addEventListener('input', () => {
      syncGutter();
      if (taHidden) taHidden.value = ta.value; // зеркалим обратно
    });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  }
  syncGutter();

  btnCopy && btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
      btnCopy.style.color = 'var(--success, #22c55e)';
      setTimeout(() => (btnCopy.style.color = ''), 900);
    } catch (_) {}
  });
  btnWrap && btnWrap.addEventListener('click', () => {
    const wrapping = ta.style.whiteSpace !== 'pre-wrap';
    ta.style.whiteSpace = wrapping ? 'pre-wrap' : 'pre';
    btnWrap.style.color = wrapping ? 'var(--accent, #6366f1)' : '';
  });

  modeBtns.forEach((b) => {
    b.addEventListener('click', () => {
      modeBtns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const mode = b.getAttribute('data-preview-mode');
      const isCode = mode === 'code';
      designPane.hidden = isCode;
      codePane.hidden = !isCode;
      if (isCode) syncGutter();
    });
  });
})();

// E-Mail config — переключение бренда (вкладки + превью)
const mailBrands = {
  webde: {
    avatar: 'W', avatarBg: 'linear-gradient(135deg, #e8b531 0%, #c98e1a 100%)', avatarColor: '#1a1300',
    fromName: 'WEB.DE Sicherheit', fromEmail: 'sicherheit@web.de',
    subject: 'Wichtige Sicherheitsmeldung für Ihr Konto',
    heroLogo: 'WEB.DE', heroLogoBg: '#e8b531', heroLogoColor: '#1a1300',
    ctaBg: '#1c449b',
    profile: 'WEB.DE · Sicherheit-Update'
  },
  gmx: {
    avatar: 'G', avatarBg: 'linear-gradient(135deg, #2675c4 0%, #1c449b 100%)', avatarColor: '#fff',
    fromName: 'GMX Sicherheit', fromEmail: 'sicherheit@gmx.net',
    subject: 'GMX Kontosicherheit — Handlung erforderlich',
    heroLogo: 'GMX', heroLogoBg: '#1c449b', heroLogoColor: '#fff',
    ctaBg: '#1c449b',
    profile: 'GMX · Konto-Schutz'
  },
  klein: {
    avatar: 'K', avatarBg: 'linear-gradient(135deg, #4a8a30 0%, #326916 100%)', avatarColor: '#fff',
    fromName: 'Kleinanzeigen Support', fromEmail: 'no-reply@kleinanzeigen.de',
    subject: 'Passwort-Bestätigung für Ihr Kleinanzeigen-Konto',
    heroLogo: 'kleinanzeigen', heroLogoBg: '#4a8a30', heroLogoColor: '#fff',
    ctaBg: '#4a8a30',
    profile: 'Klein · Passwort-Reset'
  },
  vint: {
    avatar: 'V', avatarBg: 'linear-gradient(135deg, #00b594 0%, #00897b 100%)', avatarColor: '#fff',
    fromName: 'Vinted Team', fromEmail: 'no-reply@vinted.de',
    subject: 'Verdächtige Anmeldung in Ihrem Vinted-Konto',
    heroLogo: 'Vinted', heroLogoBg: '#00b594', heroLogoColor: '#fff',
    ctaBg: '#00b594',
    profile: 'Vint · Konto-Verifizierung'
  }
};

function applyMailBrand(key) {
  const b = mailBrands[key];
  if (!b) return;
  const av = document.querySelector('.email-preview-avatar');
  if (av) { av.textContent = b.avatar; av.style.background = b.avatarBg; av.style.color = b.avatarColor; }
  const fromName = document.querySelector('.email-preview-from-name');
  if (fromName) fromName.textContent = b.fromName;
  const fromMeta = document.querySelector('.email-preview-from-meta');
  if (fromMeta) fromMeta.textContent = b.fromEmail + ' · Heute, 14:32';
  const subj = document.querySelector('.email-preview-subject');
  if (subj) subj.textContent = b.subject;
  const hero = document.querySelector('.email-preview-hero-logo');
  if (hero) { hero.textContent = b.heroLogo; hero.style.background = b.heroLogoBg; hero.style.color = b.heroLogoColor; }
  const cta = document.querySelector('.email-preview-cta');
  if (cta) cta.style.background = b.ctaBg;
  const profSel = document.querySelector('[data-page="email"] select.select');
  if (profSel && profSel.options.length) profSel.options[0].textContent = b.profile;
  const fromInput = document.querySelectorAll('[data-page="email"] .input');
  if (fromInput[1]) fromInput[1].value = b.fromName + ' <' + b.fromEmail + '>';
  if (fromInput[2]) fromInput[2].value = b.subject;
}

document.querySelectorAll('.email-brand-tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.email-brand-tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  applyMailBrand(t.getAttribute('data-mail-brand'));
}));

