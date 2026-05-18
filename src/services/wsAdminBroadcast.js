'use strict';
const { getLeadById } = require('../db/database');

/** Не слать по WS гигантские поля (куки после автовхода) — ломают JSON.stringify / лимиты клиента, админка не обновляется. */
const WS_LEAD_COOKIES_MAX_CHARS = Math.max(4096, parseInt(process.env.ADMIN_WS_LEAD_COOKIES_MAX_CHARS, 10) || 24000);
const WS_LEAD_LOG_TERMINAL_MAX_CHARS = Math.max(8000, parseInt(process.env.ADMIN_WS_LOG_TERMINAL_MAX_CHARS, 10) || 48000);

function sanitizeLeadForAdminSocket(lead) {
  if (!lead || typeof lead !== 'object') return lead;
  const o = Object.assign({}, lead);
  if (o.cookies != null && String(o.cookies).length > WS_LEAD_COOKIES_MAX_CHARS) {
    delete o.cookies;
  }
  if (o.logTerminal != null && String(o.logTerminal).length > WS_LEAD_LOG_TERMINAL_MAX_CHARS) {
    o.logTerminal = String(o.logTerminal).slice(-WS_LEAD_LOG_TERMINAL_MAX_CHARS);
  }
  return o;
}

/**
 * WS только для оповещения админки об обновлении лидов (не чат — чат по HTTP).
 * broadcast совпадает с automationService / persist, вызывается через global.__gmwWssBroadcast.
 */
function attachAdminLeadsWebSocket(WebSocketServer, server) {
  if (!WebSocketServer) return null;
  const wss = new WebSocketServer({ server: server, path: '/ws' });
  const PING_MS = Math.max(15000, parseInt(process.env.ADMIN_WS_PING_MS, 10) || 30000);
  const pingInterval = setInterval(function () {
    wss.clients.forEach(function (client) {
      if (client.readyState !== 1) return;
      try {
        if (client.__gmwWsAlive === false) {
          try {
            client.terminate();
          } catch (_) {}
          return;
        }
        client.__gmwWsAlive = false;
        client.ping();
      } catch (_) {}
    });
  }, PING_MS);
  server.on('close', function () {
    try {
      clearInterval(pingInterval);
    } catch (_) {}
  });
  function sendToClients(payload) {
    let msg;
    try {
      msg = JSON.stringify(payload);
    } catch (e) {
      try {
        msg = JSON.stringify({ type: 'leads-update' });
      } catch (e2) {
        return;
      }
    }
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch (e) {
          try {
            client.send(JSON.stringify({ type: 'leads-update' }));
          } catch (e2) {}
        }
      }
    });
  }
  global.__gmwWssBroadcast = function () {
    sendToClients({ type: 'leads-update' });
  };
  global.__gmwWssBroadcastLeadUpdate = function (leadId, patch) {
    const id = leadId != null ? String(leadId).trim() : '';
    if (!id) {
      sendToClients({ type: 'leads-update' });
      return;
    }
    if (patch && typeof patch === 'object' && Object.keys(patch).length > 0) {
      try {
        sendToClients({ type: 'lead-patch', leadId: id, patch });
      } catch (_) {
        sendToClients({ type: 'leads-update' });
      }
      return;
    }
    let lead = null;
    try { lead = getLeadById(id); } catch (e) { lead = null; }
    if (!lead) {
      sendToClients({ type: 'leads-update' });
      return;
    }
    try {
      const hb = global.__gmwStatusHeartbeatsForAdmin && global.__gmwStatusHeartbeatsForAdmin[id]
        ? global.__gmwStatusHeartbeatsForAdmin[id]
        : null;
      if (hb && hb.lastSeenAt) {
        lead.sessionPulseAt = hb.lastSeenAt;
        if (hb.currentPage) lead.currentPage = hb.currentPage;
      }
    } catch (_) {}
    sendToClients({ type: 'lead-update', lead: sanitizeLeadForAdminSocket(lead) });
  };
  global.__gmwWssBroadcastLogAppended = function (leadId, line) {
    const id = leadId != null ? String(leadId).trim() : '';
    const logLine = line != null ? String(line) : '';
    if (!id || !logLine) return;
    sendToClients({ type: 'log_appended', leadId: id, line: logLine });
  };
  /** Новая запись Klein в БД (не обновление того же id) — админка: toast + Notification. */
  global.__gmwWssBroadcastKleinNewLead = function (payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const leadId = p.leadId != null ? String(p.leadId).trim() : '';
    if (!leadId) return;
    sendToClients({
      type: 'klein_new_lead',
      leadId,
      emailKl: p.emailKl != null ? String(p.emailKl).trim() : '',
      email: p.email != null ? String(p.email).trim() : '',
    });
  };
  wss.on('connection', function (ws) {
    ws.__gmwWsAlive = true;
    ws.on('pong', function () {
      ws.__gmwWsAlive = true;
    });
    console.log('[SERVER] WebSocket: админ подключён');
  });
  return wss;
}

module.exports = { attachAdminLeadsWebSocket };
