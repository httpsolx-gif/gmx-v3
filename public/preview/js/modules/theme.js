// modules/theme.js — переключение тёмная/светлая, запоминание в localStorage.
// Theme toggle
(function() {
  const root = document.documentElement;
  const stored = localStorage.getItem('admin-preview-theme');
  if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    localStorage.setItem('admin-preview-theme', next);
  });
})();

