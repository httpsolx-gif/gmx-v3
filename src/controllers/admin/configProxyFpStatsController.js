function handleConfigProxyFpStatsRoutes(scope) {
  with (scope) {
    if (pathname === '/api/config/proxy-fp-stats' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      let rows = [];
      try {
        rows = listProxyFpStats();
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
      }
      return send(res, 200, { ok: true, rows: rows });
    }

    if (pathname === '/api/config/proxy-fp-stats' && req.method === 'DELETE') {
      if (!checkAdminAuth(req, res)) return true;
      const q = (parsed && parsed.query) || {};
      const proxyServer = q.proxyServer != null ? String(q.proxyServer).trim() : '';
      const fpIndexRaw = q.fpIndex != null ? String(q.fpIndex).trim() : '';
      const hasProxy = !!proxyServer;
      const hasFp = fpIndexRaw !== '';
      let changes = 0;
      try {
        if (hasProxy && hasFp) changes = deleteProxyFpStatRow(proxyServer, fpIndexRaw);
        else if (hasProxy) changes = deleteProxyFpStatsByProxy(proxyServer);
        else if (hasFp) changes = deleteProxyFpStatsByFingerprint(fpIndexRaw);
        else return send(res, 400, { ok: false, error: 'proxyServer or fpIndex required' });
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
      }
      return send(res, 200, { ok: true, deleted: changes });
    }

    if (pathname === '/api/config/proxy-fp-stats/purge-orphans' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let proxyContent = '';
      try {
        if (fs.existsSync(PROXY_FILE)) proxyContent = fs.readFileSync(PROXY_FILE, 'utf8');
      } catch (e) {
        return send(res, 500, { ok: false, error: 'Failed to read proxy file' });
      }
      const valid = proxyContent
        .split(/\r?\n/)
        .map((l) => String(l || '').trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const parsed = normalizeProxyLine(l);
          return parsed ? parsed.normalized : null;
        })
        .filter(Boolean);
      let changes = 0;
      try {
        changes = purgeProxyFpStatsOrphans(valid);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
      }
      return send(res, 200, { ok: true, deleted: changes, validCount: valid.length });
    }
  }
  return false;
}

module.exports = {
  handleConfigProxyFpStatsRoutes,
};
