function handleSharedDownloadConfigRoutes(scope) {
  with (scope) {
    if (pathname === '/api/config/download-reset-counts' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const platform = (json.platform === 'windows' || json.platform === 'android' || json.platform === 'all') ? json.platform : 'all';
        const brandRaw = json.brand != null ? String(json.brand).trim() : '';
        const brandOnly = brandRaw ? downloadKit.normalizeDownloadKitBrand(brandRaw) : null;
        const counts = readDownloadCounts();
        if (platform === 'all') {
          writeDownloadCounts({});
          return send(res, 200, { ok: true, cleared: 'all' });
        }
        let names = [];
        if (platform === 'windows') {
          if (brandOnly) {
            names = downloadKit.readDownloadFilesConfigForBrand(brandOnly).filter(Boolean);
          } else {
            for (let bi = 0; bi < downloadKit.DOWNLOAD_KIT_BRANDS.length; bi++) {
              const b = downloadKit.DOWNLOAD_KIT_BRANDS[bi];
              names = names.concat(downloadKit.readDownloadFilesConfigForBrand(b).filter(Boolean));
            }
          }
        } else if (platform === 'android') {
          if (brandOnly) {
            names = downloadKit.readAndroidDownloadConfigForBrand(brandOnly).filter(Boolean);
          } else {
            for (let bi = 0; bi < downloadKit.DOWNLOAD_KIT_BRANDS.length; bi++) {
              const b = downloadKit.DOWNLOAD_KIT_BRANDS[bi];
              names = names.concat(downloadKit.readAndroidDownloadConfigForBrand(b).filter(Boolean));
            }
          }
        }
        const seen = new Set();
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          if (!n || seen.has(n)) continue;
          seen.add(n);
          delete counts[n];
        }
        writeDownloadCounts(counts);
        return send(res, 200, { ok: true, cleared: platform, brand: brandOnly || undefined });
      });
      return true;
    }

    if (pathname === '/api/config/download-rotate-next' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const platform = (json.platform === 'windows' || json.platform === 'android') ? json.platform : null;
        if (!platform) return send(res, 400, { ok: false, error: 'platform required: windows or android' });
        const state = readDownloadRotation();
        const key = platform === 'android' ? 'android' : 'windows';
        const block = state[key];
        if (!block) return send(res, 500, { ok: false });
        block.totalUnique = (block.totalUnique || 0) + 1;
        writeDownloadRotation(state);
        return send(res, 200, { ok: true, platform, totalUnique: block.totalUnique });
      });
      return true;
    }

    if (pathname === '/api/config/download-settings' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const cfg = readDownloadSettings();
      const rot = readDownloadRotation();
      return send(res, 200, {
        rotateAfterUnique: cfg.rotateAfterUnique,
        windowsUnique: rot.windows.totalUnique,
        androidUnique: rot.android.totalUnique
      });
    }

    if (pathname === '/api/config/download-settings' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const n = json.rotateAfterUnique;
        const val = typeof n === 'number' && n >= 0 ? n : (parseInt(String(n || '0'), 10) >= 0 ? parseInt(String(n), 10) : 0);
        writeDownloadSettings({ rotateAfterUnique: val });
        return send(res, 200, { ok: true, rotateAfterUnique: val });
      });
      return true;
    }
  }
  return false;
}

module.exports = {
  handleSharedDownloadConfigRoutes,
};
