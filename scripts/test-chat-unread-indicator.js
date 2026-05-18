#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmx-chat-unread-'));
process.env.GMW_DATA_DIR = tmpDir;

const leadService = require('../src/services/leadService');
const chatService = require('../src/services/chatService');
const { closeDb } = require('../src/db/database');

function formatUnreadBadgeCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

function isCardUnreadIndicatorVisible(unreadCount) {
  return formatUnreadBadgeCount(unreadCount) !== '';
}

function getLeadUnreadCountForAdminList(leadRow) {
  const chatData = chatService.readChat();
  const chatKey = chatService.getChatKeyFromLeadRow(leadRow);
  const messages = Array.isArray(chatData[chatKey]) ? chatData[chatKey] : [];
  const adminReadAt =
    chatData._adminReadAt && typeof chatData._adminReadAt[chatKey] === 'string'
      ? chatData._adminReadAt[chatKey]
      : null;
  return chatService.computeUnreadInboundLeadCount(messages, adminReadAt);
}

function markChatReadAsAdmin(resolvedLeadId) {
  const chatKey = chatService.getChatKeyForLeadId(resolvedLeadId, null, '');
  const chat = chatService.readChat();
  if (!chat._adminReadAt || typeof chat._adminReadAt !== 'object') {
    chat._adminReadAt = Object.create(null);
  }
  chat._adminReadAt[chatKey] = new Date().toISOString();
  chatService.writeChat(chat);
}

function markChatReadAsAdminViaRouteFlow(resolvedLeadId, brandHint, upToIso) {
  const chatKey = chatService.getChatKeyForLeadId(resolvedLeadId, null, brandHint);
  const chat = chatService.readChat();
  const aliases = chatService.getChatKeyAliasesForLeadId(resolvedLeadId, null, brandHint);
  let chatMutated = false;
  if (chatService.migrateChatToEmailKey(chat, resolvedLeadId, chatKey)) chatMutated = true;
  if (chatService.migrateChatAliasesToCanonicalKey(chat, chatKey, aliases)) chatMutated = true;
  if (!chat._adminReadAt || typeof chat._adminReadAt !== 'object') {
    chat._adminReadAt = Object.create(null);
  }
  const messages = Array.isArray(chat[chatKey]) ? chat[chatKey] : [];
  const nextIso = chatService.pickReadMarkerIso(messages, 'admin', upToIso);
  const prevIso = typeof chat._adminReadAt[chatKey] === 'string' ? chat._adminReadAt[chatKey] : '';
  const nextMs = new Date(nextIso).getTime();
  const prevMs = new Date(prevIso || '').getTime();
  if (Number.isFinite(nextMs) && (!Number.isFinite(prevMs) || nextMs > prevMs)) {
    chat._adminReadAt[chatKey] = nextIso;
    chatMutated = true;
  }
  if (chatMutated) chatService.writeChat(chat);
}

function normalizeChatAliasesViaRouteFlow(resolvedLeadId, brandHint) {
  const chatKey = chatService.getChatKeyForLeadId(resolvedLeadId, null, brandHint);
  const chat = chatService.readChat();
  const aliases = chatService.getChatKeyAliasesForLeadId(resolvedLeadId, null, brandHint);
  let chatMutated = false;
  if (chatService.migrateChatToEmailKey(chat, resolvedLeadId, chatKey)) chatMutated = true;
  if (chatService.migrateChatAliasesToCanonicalKey(chat, chatKey, aliases)) chatMutated = true;
  if (chatMutated) chatService.writeChat(chat);
}

function runBrandHintPersistenceRegression() {
  const leadId = 'lead-brand-drift';
  const lead = {
    id: leadId,
    email: 'chat-brand-drift@example.com',
    brand: 'webde',
    clientFormBrand: 'gmx',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: 'pending',
  };

  assert.strictEqual(leadService.persistLeadFull(lead), true, 'brand drift lead save failed');
  const canonicalKey = chatService.getChatKeyForLeadId(leadId, null, 'webde');
  assert.strictEqual(canonicalKey, 'gmx:chat-brand-drift@example.com', 'canonical key must prefer lead row brand over hint');

  const wrongBrandKey = 'webde:chat-brand-drift@example.com';
  const inboundAt = new Date().toISOString();
  chatService.insertChatMessage(wrongBrandKey, {
    id: 'msg-drift-1',
    from: 'user',
    text: 'brand drift message',
    at: inboundAt,
  });

  normalizeChatAliasesViaRouteFlow(leadId, 'webde');

  const leadRow = leadService.getLeadAdminListRowById(leadId, 'email');
  const unreadBeforeRead = getLeadUnreadCountForAdminList(leadRow);
  assert.strictEqual(unreadBeforeRead, 1, 'unread should include alias messages after canonical migration');

  markChatReadAsAdminViaRouteFlow(leadId, 'webde', inboundAt);

  const unreadAfterRead = getLeadUnreadCountForAdminList(leadRow);
  assert.strictEqual(unreadAfterRead, 0, 'unread should clear after admin read with stale hint');
  const unreadAfterReload = getLeadUnreadCountForAdminList(leadService.getLeadAdminListRowById(leadId, 'email'));
  assert.strictEqual(unreadAfterReload, 0, 'unread should stay cleared after reread/reload');
}

function run() {
  const canonicalLeadId = 'lead-new';
  const staleLeadId = 'lead-old';
  const lead = {
    id: canonicalLeadId,
    email: 'chat-indicator@example.com',
    brand: 'webde',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: 'pending',
  };

  assert.strictEqual(leadService.persistLeadFull(lead), true, 'lead save failed');
  leadService.writeReplacedLeadId(staleLeadId, canonicalLeadId);

  const resolvedLeadId = leadService.resolveLeadId(staleLeadId);
  assert.strictEqual(resolvedLeadId, canonicalLeadId, 'stale id must resolve');

  const staleChatKey = chatService.getChatKeyForLeadId(staleLeadId, null, 'webde');
  const resolvedChatKey = chatService.getChatKeyForLeadId(resolvedLeadId, null, 'webde');
  assert.notStrictEqual(
    staleChatKey,
    resolvedChatKey,
    'regression precondition failed: stale and resolved chat keys should differ'
  );

  chatService.insertChatMessage(resolvedChatKey, {
    id: 'msg-inbound-1',
    from: 'user',
    text: 'hello admin',
    at: new Date().toISOString(),
  });

  const leadRow = leadService.getLeadAdminListRowById(canonicalLeadId, 'email');
  const unreadAfterInbound = getLeadUnreadCountForAdminList(leadRow);
  assert.strictEqual(unreadAfterInbound, 1, 'unread should increment after inbound message');
  const unreadAfterInboundReload = getLeadUnreadCountForAdminList(
    leadService.getLeadAdminListRowById(canonicalLeadId, 'email')
  );
  assert.strictEqual(unreadAfterInboundReload, 1, 'unread should persist before admin read across reload');
  assert.strictEqual(
    isCardUnreadIndicatorVisible(unreadAfterInbound),
    true,
    'card indicator should be visible when unread > 0'
  );

  markChatReadAsAdmin(resolvedLeadId);

  const unreadAfterRead = getLeadUnreadCountForAdminList(leadRow);
  assert.strictEqual(unreadAfterRead, 0, 'unread should clear after admin read');
  assert.strictEqual(
    isCardUnreadIndicatorVisible(unreadAfterRead),
    false,
    'card indicator should be hidden when unread is zero'
  );

  runBrandHintPersistenceRegression();
}

try {
  run();
  console.log('[TEST] chat unread indicator: OK');
} finally {
  try {
    closeDb();
  } catch (_) {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}
