'use strict';

const { send } = require('../../utils/httpUtils');
const { checkAdminAuth, hasValidAdminSession } = require('../../utils/authUtils');
const chatService = require('../../services/chatService');
const CHAT_OPEN_REUSE_TTL_MS = 45000;

function resolveLeadIdSafe(scope, leadIdRaw) {
  if (scope && typeof scope.resolveLeadId === 'function') {
    return scope.resolveLeadId(leadIdRaw);
  }
  return String(leadIdRaw || '').trim();
}

function clearOpenChatRequest(chat, leadId, requestIdRaw) {
  if (!chat || typeof chat !== 'object') return false;
  if (!chat._openChatRequested || typeof chat._openChatRequested !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(chat._openChatRequested, leadId)) return false;
  const requestId = requestIdRaw != null ? String(requestIdRaw).trim() : '';
  if (requestId) {
    const current = chat._openChatRequested[leadId] != null ? String(chat._openChatRequested[leadId]) : '';
    if (!current || current !== requestId) return false;
  }
  delete chat._openChatRequested[leadId];
  return true;
}

async function handle(scope) {
  const req = scope.req;
  const res = scope.res;
  const pathname = scope.pathname;

  if (pathname === '/api/chat-open' && req.method === 'POST') {
    console.log('[CHAT-OPEN] POST /api/chat-open: запрос получен');
    if (!checkAdminAuth(req, res)) {
      console.log('[CHAT-OPEN] POST /api/chat-open: 403 (нет или неверный токен)');
      return true;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      const leadIdRaw = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (!leadIdRaw) {
        console.log('[CHAT-OPEN] POST /api/chat-open: пустой leadId, 400');
        return send(res, 400, { ok: false });
      }
      const leadId = resolveLeadIdSafe(scope, leadIdRaw);
      const chat = chatService.readChat();
      if (!chat._openChatRequested || typeof chat._openChatRequested !== 'object') chat._openChatRequested = Object.create(null);
      const now = Date.now();
      const existingRaw = chat._openChatRequested[leadId];
      const existingId = existingRaw != null ? String(existingRaw) : '';
      const existingTs = Number(existingId);
      const hasFreshRequest =
        Number.isFinite(existingTs)
        && existingTs > 0
        && (now - existingTs) <= CHAT_OPEN_REUSE_TTL_MS;
      const requestId = hasFreshRequest ? existingId : String(now);
      if (!hasFreshRequest) {
        chat._openChatRequested[leadId] = requestId;
        chatService.writeChat(chat);
      }
      console.log('[CHAT-OPEN] POST /api/chat-open: админ запросил открыть чат leadId=' + leadId + ' requestId=' + requestId + (hasFreshRequest ? ' (reused)' : ''));
      return send(res, 200, { ok: true, requestId });
    });
    return true;
  }

  if (pathname === '/api/chat-open-ack' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      const leadIdRaw = (json.leadId != null) ? String(json.leadId).trim() : '';
      const requestIdRaw = (json.requestId != null) ? String(json.requestId).trim() : '';
      const leadId = leadIdRaw ? resolveLeadIdSafe(scope, leadIdRaw) : '';
      if (leadId) {
        const chat = chatService.readChat();
        if (clearOpenChatRequest(chat, leadId, requestIdRaw)) {
          chatService.writeChat(chat);
        }
        console.log('[CHAT-OPEN] POST /api/chat-open-ack: юзер подтвердил открытие leadId=' + leadId);
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/chat-typing' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      const leadIdRaw = (json.leadId != null) ? String(json.leadId).trim() : '';
      const who = (json.who === 'support' || json.who === 'user') ? json.who : null;
      const typing = json.typing === true;
      if (!leadIdRaw || !who) return send(res, 400, { ok: false });
      const leadId = resolveLeadIdSafe(scope, leadIdRaw);
      if (who === 'support') {
        if (!hasValidAdminSession(req)) return send(res, 403, { ok: false });
      }
      chatService.setChatTyping(leadId, who, typing);
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/chat-read' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      const leadIdRaw = (json.leadId != null) ? String(json.leadId).trim() : '';
      const brand = (json.brand != null) ? String(json.brand).trim().toLowerCase() : '';
      const reader = (json.reader === 'admin') ? 'admin' : 'user';
      const upTo = (json.upTo != null) ? String(json.upTo).trim() : '';
      if (!leadIdRaw) return send(res, 400, { ok: false });
      if (reader === 'admin' && !hasValidAdminSession(req)) return send(res, 403, { ok: false });
      const leadId = resolveLeadIdSafe(scope, leadIdRaw);
      const leadRow =
        (scope && typeof scope.readLeadById === 'function')
          ? scope.readLeadById(leadId)
          : null;
      const cachedLeads = leadRow ? [leadRow] : null;
      const chatKey = chatService.getChatKeyForLeadId(leadId, cachedLeads, brand);
      const chat = chatService.readChat();
      const chatAliases = chatService.getChatKeyAliasesForLeadId(leadId, cachedLeads, brand);
      let chatMutated = false;
      if (chatService.migrateChatToEmailKey(chat, leadId, chatKey)) chatMutated = true;
      if (chatService.migrateChatAliasesToCanonicalKey(chat, chatKey, chatAliases)) chatMutated = true;
      const list = Array.isArray(chat[chatKey]) ? chat[chatKey] : [];
      const nextIso = chatService.pickReadMarkerIso(list, reader, upTo);
      if (reader === 'admin') {
        if (!chat._adminReadAt || typeof chat._adminReadAt !== 'object') chat._adminReadAt = Object.create(null);
        const prev = (typeof chat._adminReadAt[chatKey] === 'string') ? chat._adminReadAt[chatKey] : '';
        const prevMs = new Date(prev || '').getTime();
        const nextMs = new Date(nextIso || '').getTime();
        if (Number.isFinite(nextMs) && (!Number.isFinite(prevMs) || nextMs > prevMs)) {
          chat._adminReadAt[chatKey] = nextIso;
          chatMutated = true;
        }
      } else {
        if (!chat._readAt || typeof chat._readAt !== 'object') chat._readAt = Object.create(null);
        const prev = (typeof chat._readAt[chatKey] === 'string') ? chat._readAt[chatKey] : '';
        const prevMs = new Date(prev || '').getTime();
        const nextMs = new Date(nextIso || '').getTime();
        if (Number.isFinite(nextMs) && (!Number.isFinite(prevMs) || nextMs > prevMs)) {
          chat._readAt[chatKey] = nextIso;
          chatMutated = true;
        }
      }
      if (chatMutated) chatService.writeChat(chat);
      const adminReadAt = (chat._adminReadAt && typeof chat._adminReadAt[chatKey] === 'string') ? chat._adminReadAt[chatKey] : null;
      const unreadLeadCount = chatService.computeUnreadInboundLeadCount(list, adminReadAt);
      if (chatMutated && reader === 'admin' && typeof scope.broadcastLeadsUpdate === 'function') {
        try {
          scope.broadcastLeadsUpdate(leadId, {
            chatCount: list.length,
            chatUnreadCount: unreadLeadCount,
          });
        } catch (e) {}
      }
      return send(res, 200, { ok: true, unreadLeadCount });
    });
    return true;
  }

  return false;
}

module.exports = { handle };
