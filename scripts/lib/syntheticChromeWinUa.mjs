/**
 * Синтетический User-Agent Chrome на Windows для пула webde_fingerprints
 * (Playwright + public/webde-fingerprints-pool.js).
 *
 * Несколько веток major.0.build.patch (псевдореалистично для DACH);
 * патч 100–960; часть профилей — Windows 11.
 */

/** От новых к старым; веса — чаще свежие релизы. */
export const CHROME_WIN_RELEASES = [
  { major: 143, build: '7492' },
  { major: 142, build: '7448' },
  { major: 141, build: '7396' },
  { major: 140, build: '7338' },
  { major: 139, build: '7258' },
  { major: 138, build: '7204' },
];

const RELEASE_WEIGHTS = [0.28, 0.24, 0.18, 0.14, 0.1, 0.06];

export function createPrng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function pickChromeWinRelease(rnd) {
  let r = rnd();
  for (let i = 0; i < CHROME_WIN_RELEASES.length; i++) {
    r -= RELEASE_WEIGHTS[i] || 1 / CHROME_WIN_RELEASES.length;
    if (r <= 0) return CHROME_WIN_RELEASES[i];
  }
  return CHROME_WIN_RELEASES[CHROME_WIN_RELEASES.length - 1];
}

/**
 * @param {() => number} rnd — возвращает [0,1)
 */
export function buildSyntheticChromeUserAgent(rnd) {
  const { major, build } = pickChromeWinRelease(rnd);
  const patch = 100 + Math.floor(rnd() * 861);
  const win11 = rnd() < 0.38;
  const nt = win11 ? 'Windows NT 11.0' : 'Windows NT 10.0';
  return `Mozilla/5.0 (${nt}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.${build}.${patch} Safari/537.36`;
}
