/** Admin realtime WS connector with explicit callbacks/deps. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   pollLeadsIfTabVisible: function(): void,
   *   loadLeads: function(function()=): void,
   *   getSelectedId: function(): string,
   *   loadAdminChat: function(boolean=): void,
   *   onLeadPatch: function(string, object): void,
   *   onLeadUpdate: function(object): void,
   *   onLogAppended: function(string, string): void,
   *   onLeadsUpdate: function(): void,
   *   onKleinNewLead: function(object): void
   * }} deps
   * @returns {{ connect: function(): void }|undefined}
   */
  function initAdminRealtimeWs(deps) {
    if (!deps) return;
    if (typeof deps.pollLeadsIfTabVisible !== 'function') return;
    if (typeof deps.loadLeads !== 'function') return;
    if (typeof deps.getSelectedId !== 'function') return;
    if (typeof deps.loadAdminChat !== 'function') return;
    if (typeof deps.onLeadPatch !== 'function') return;
    if (typeof deps.onLeadUpdate !== 'function') return;
    if (typeof deps.onLogAppended !== 'function') return;
    if (typeof deps.onLeadsUpdate !== 'function') return;
    if (typeof deps.onKleinNewLead !== 'function') return;

    var ws = null;
    var wsReconnectTimer = null;
    var pollFallbackInterval = null;
    var skipNextLeadsUpdateUntilMs = 0;

    function ensurePollFallback() {
      if (!pollFallbackInterval) pollFallbackInterval = setInterval(deps.pollLeadsIfTabVisible, 5000);
    }

    function clearPollFallback() {
      if (pollFallbackInterval) {
        clearInterval(pollFallbackInterval);
        pollFallbackInterval = null;
      }
    }

    function connect() {
      if (ws && ws.readyState === 1) return;
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var wsUrl = proto + '//' + location.host + '/ws';
      try {
        ws = new WebSocket(wsUrl);
        var socket = ws;
        function handleDisconnect() {
          if (ws !== socket) return;
          ws = null;
          ensurePollFallback();
          if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
          wsReconnectTimer = setTimeout(connect, 3000);
        }
        ws.onopen = function () {
          if (ws !== socket) return;
          if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
          }
          clearPollFallback();
          deps.loadLeads(function () {
            if (deps.getSelectedId()) deps.loadAdminChat(true);
          });
        };
        ws.onmessage = function (ev) {
          if (ws !== socket) return;
          try {
            var data = JSON.parse(ev.data);
            if (data.type === 'lead-patch' && data.leadId != null && data.patch && typeof data.patch === 'object') {
              skipNextLeadsUpdateUntilMs = Date.now() + 900;
              deps.onLeadPatch(data.leadId, data.patch);
              return;
            }
            if (data.type === 'lead-update' && data.lead && data.lead.id != null) {
              skipNextLeadsUpdateUntilMs = Date.now() + 900;
              deps.onLeadUpdate(data.lead);
              return;
            }
            if (data.type === 'log_appended' && data.leadId && data.line) {
              deps.onLogAppended(data.leadId, data.line);
              return;
            }
            if (data.type === 'klein_new_lead') {
              deps.onKleinNewLead(data);
              return;
            }
            if (data.type === 'leads-update') {
              if (Date.now() < skipNextLeadsUpdateUntilMs) return;
              deps.onLeadsUpdate();
            }
          } catch (e) {}
        };
        ws.onclose = handleDisconnect;
        ws.onerror = handleDisconnect;
      } catch (e) {
        ensurePollFallback();
        wsReconnectTimer = setTimeout(connect, 5000);
      }
    }

    return {
      connect: connect
    };
  }

  global.initAdminRealtimeWs = initAdminRealtimeWs;
})(window);
