// modules/chart.js — интерактивный график статистики:
//  * клик по легенде Brand → скрывает/показывает серию
//  * клик по периоду → перерисовка точек/подписи (моковые данные)

const chartCard  = document.getElementById('main-chart');
if (chartCard) {
  const svg     = chartCard.querySelector('.chart-svg');
  const legend  = chartCard.querySelector('#chart-legend');
  const period  = chartCard.querySelector('#chart-period');
  const subLbl  = chartCard.querySelector('#chart-period-label');

  // === Toggle серии по клику в легенде ===
  legend && legend.querySelectorAll('.chart-legend-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-series');
      const on = btn.classList.toggle('is-on');
      const g = svg.querySelector(`g[data-series="${k}"]`);
      if (g) g.hidden = !on;
    });
  });

  // === Переключение периода ===
  const RANGES = {
    '24h': { label: 'Сегодня · 18 ноя · 248 событий',  xLabels: ['00:00','04:00','08:00','12:00','16:00','20:00','24:00'] },
    '7d':  { label: '12 ноя – 18 ноя · 1 284 событий', xLabels: ['12 ноя','13','14','15','16','17','18 ноя'] },
    '30d': { label: '20 окт – 18 ноя · 5 412 событий', xLabels: ['20 окт','24','28','01','05','12','18 ноя'] },
    '90d': { label: '20 авг – 18 ноя · 18 940 событий', xLabels: ['авг','сент','сент','окт','окт','нояб','нояб'] },
  };
  period && period.querySelectorAll('.chart-period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      period.querySelectorAll('.chart-period-btn').forEach((x) => x.classList.remove('is-on'));
      btn.classList.add('is-on');
      const r = btn.getAttribute('data-range');
      const cfg = RANGES[r];
      if (cfg) {
        if (subLbl) subLbl.textContent = cfg.label;
        const xTexts = svg.querySelectorAll('.chart-ax-x text');
        cfg.xLabels.forEach((s, i) => { if (xTexts[i]) xTexts[i].textContent = s; });
      }
    });
  });
}
