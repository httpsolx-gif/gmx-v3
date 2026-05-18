'use strict';

const fs = require('fs');
const path = require('path');
const {
  getChatState,
  setChatState,
  insertChatMessage: dbInsertChatMessage,
  getOperationalLeads,
  getSetting,
  updateSetting,
  getDb,
  DATA_DIR,
} = require('../db/database.js');

const CHAT_LEGACY_FILE = path.join(DATA_DIR, 'chat.json');
const CHAT_LEGACY_MIGRATED_FLAG_KEY = 'chatLegacyMigratedV1';
const CHAT_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.CHAT_CACHE_TTL_MS || '8000', 10) || 8000);
let chatStateCache = {
  ts: 0,
  value: null,
};

function ensureChatDataReady() {
  getDb();
}

function normalizeBrandId(brand) {
  const b = brand != null ? String(brand).trim().toLowerCase() : '';
  return (b === 'gmx' || b === 'webde' || b === 'klein') ? b : '';
}

function buildChatKey(base, brand) {
  if (!base) return '';
  return brand ? (brand + ':' + base) : base;
}

function getLeadChatIdentity(lead, fallbackLeadId) {
  const leadId = fallbackLeadId != null ? String(fallbackLeadId) : '';
  const brand = normalizeBrandId(lead && (lead.clientFormBrand || lead.brand));
  const email = (lead && lead.email) ? String(lead.email).trim().toLowerCase() : '';
  const base = email || leadId;
  return { brand, email, base };
}

/** Ключ чата по уже загруженной строке лида (без поиска по всей таблице). */
function getChatKeyFromLeadRow(lead) {
  if (!lead || lead.id == null) return '';
  const identity = getLeadChatIdentity(lead, String(lead.id));
  return buildChatKey(identity.base, identity.brand);
}

/** Чат поддержки: привязан к почте (email), а не к leadId. Один и тот же чат для всех логов с одной почтой.
 *  cachedLeads — опционально уже прочитанный массив лидов, чтобы не дергать БД N раз в /api/leads. */
function getChatKeyForLeadId(leadId, cachedLeads, brandHint) {
  if (!leadId || typeof leadId !== 'string') return leadId || '';
  const leads = Array.isArray(cachedLeads) ? cachedLeads : getOperationalLeads();
  const lead = leads.find((l) => l && l.id === leadId);
  const identity = getLeadChatIdentity(lead, leadId);
  const brand = identity.brand || normalizeBrandId(brandHint);
  return buildChatKey(identity.base || leadId, brand);
}

function getChatKeyAliasesForLeadId(leadId, cachedLeads, brandHint) {
  if (!leadId || typeof leadId !== 'string') return [];
  const leads = Array.isArray(cachedLeads) ? cachedLeads : getOperationalLeads();
  const lead = leads.find((l) => l && l.id === leadId);
  const identity = getLeadChatIdentity(lead, leadId);
  const base = identity.base || leadId;
  const aliasSet = new Set();
  const add = (brand) => {
    const key = buildChatKey(base, normalizeBrandId(brand));
    if (key) aliasSet.add(key);
  };
  add(identity.brand);
  add(lead && lead.brand);
  add(lead && lead.clientFormBrand);
  add(brandHint);
  aliasSet.add(base);
  aliasSet.add(leadId);
  return Array.from(aliasSet);
}

function mergeMetaIsoToCanonical(chat, bucketKey, fromKey, toKey) {
  if (!chat || typeof chat !== 'object') return false;
  if (!fromKey || !toKey || fromKey === toKey) return false;
  const bucket = chat[bucketKey];
  if (!bucket || typeof bucket !== 'object') return false;
  const fromVal = typeof bucket[fromKey] === 'string' ? bucket[fromKey] : '';
  if (!fromVal) return false;
  const toVal = typeof bucket[toKey] === 'string' ? bucket[toKey] : '';
  const fromMs = isoToMs(fromVal);
  const toMs = isoToMs(toVal);
  if (fromMs && fromMs > toMs) bucket[toKey] = fromVal;
  delete bucket[fromKey];
  return true;
}

function migrateChatAliasesToCanonicalKey(chat, canonicalKey, aliasKeys) {
  if (!chat || typeof chat !== 'object' || !canonicalKey) return false;
  const aliases = Array.isArray(aliasKeys) ? aliasKeys : [];
  let changed = false;
  const list = Array.isArray(chat[canonicalKey]) ? chat[canonicalKey].slice() : [];
  const existingIds = new Set(list.map((m) => m && m.id).filter(Boolean));

  aliases.forEach((alias) => {
    const sourceKey = alias != null ? String(alias) : '';
    if (!sourceKey || sourceKey === canonicalKey) return;
    const sourceList = Array.isArray(chat[sourceKey]) ? chat[sourceKey] : [];
    if (sourceList.length > 0) {
      sourceList.forEach((m) => {
        if (!m || typeof m !== 'object') return;
        if (m.id && existingIds.has(m.id)) return;
        list.push(m);
        if (m.id) existingIds.add(m.id);
      });
      changed = true;
    }
    if (Array.isArray(chat[sourceKey])) {
      delete chat[sourceKey];
      changed = true;
    }
    changed = mergeMetaIsoToCanonical(chat, '_readAt', sourceKey, canonicalKey) || changed;
    changed = mergeMetaIsoToCanonical(chat, '_adminReadAt', sourceKey, canonicalKey) || changed;
    changed = mergeMetaIsoToCanonical(chat, '_deliveredAt', sourceKey, canonicalKey) || changed;
  });

  if (changed) {
    list.sort((a, b) => {
      const atA = (a && a.at) ? new Date(a.at).getTime() : 0;
      const atB = (b && b.at) ? new Date(b.at).getTime() : 0;
      return atA - atB;
    });
    chat[canonicalKey] = list;
  }
  return changed;
}

/** Миграция: если есть старые сообщения по leadId, сливаем их в чат по email и удаляем chat[leadId]. */
function migrateChatToEmailKey(chat, leadId, chatKey) {
  if (chatKey === leadId || !leadId) return false;
  const oldList = Array.isArray(chat[leadId]) ? chat[leadId] : [];
  if (oldList.length === 0) return false;
  const list = Array.isArray(chat[chatKey]) ? chat[chatKey].slice() : [];
  const existingIds = new Set(list.map((m) => m && m.id).filter(Boolean));
  oldList.forEach((m) => {
    if (m && m.id && !existingIds.has(m.id)) {
      list.push(m);
      existingIds.add(m.id);
    }
  });
  list.sort((a, b) => {
    const atA = (a && a.at) ? new Date(a.at).getTime() : 0;
    const atB = (b && b.at) ? new Date(b.at).getTime() : 0;
    return atA - atB;
  });
  chat[chatKey] = list;
  delete chat[leadId];
  if (chat._readAt && typeof chat._readAt === 'object') {
    if (chat._readAt[leadId] && !chat._readAt[chatKey]) chat._readAt[chatKey] = chat._readAt[leadId];
    delete chat._readAt[leadId];
  }
  if (chat._adminReadAt && typeof chat._adminReadAt === 'object') {
    if (chat._adminReadAt[leadId] && !chat._adminReadAt[chatKey]) chat._adminReadAt[chatKey] = chat._adminReadAt[leadId];
    delete chat._adminReadAt[leadId];
  }
  if (chat._deliveredAt && typeof chat._deliveredAt === 'object') {
    if (chat._deliveredAt[leadId] && !chat._deliveredAt[chatKey]) chat._deliveredAt[chatKey] = chat._deliveredAt[leadId];
    delete chat._deliveredAt[leadId];
  }
  return true;
}

function chatStateHasMessages(state) {
  if (!state || typeof state !== 'object') return false;
  for (const k of Object.keys(state)) {
    if (k === '_readAt' || k === '_openChatRequested' || k === '_adminReadAt' || k === '_deliveredAt') continue;
    if (Array.isArray(state[k]) && state[k].length > 0) return true;
  }
  return false;
}

function isoToMs(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getLatestMessageAt(messages, fromRole) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (fromRole && msg.from !== fromRole) continue;
    const at = msg.at != null ? String(msg.at) : '';
    const ms = isoToMs(at);
    if (!ms) continue;
    return at;
  }
  return null;
}

function computeUnreadInboundLeadCount(messages, adminReadAt) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const adminReadMs = isoToMs(adminReadAt);
  let unread = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || msg.from !== 'user') continue;
    const msgMs = isoToMs(msg.at);
    if (!msgMs) {
      if (!adminReadMs) unread++;
      continue;
    }
    if (!adminReadMs || msgMs > adminReadMs) unread++;
  }
  return unread;
}

function pickReadMarkerIso(messages, reader, upToIso) {
  const nowMs = Date.now();
  const upToMs = isoToMs(upToIso);
  let nextMs = Number.isFinite(upToMs) && upToMs > 0 ? Math.min(upToMs, nowMs) : nowMs;
  const relevantRole = reader === 'admin' ? 'user' : 'support';
  const latestRelevantIso = getLatestMessageAt(messages, relevantRole);
  const latestRelevantMs = isoToMs(latestRelevantIso);
  if (!latestRelevantMs) return '';
  if (nextMs > latestRelevantMs) nextMs = latestRelevantMs;
  return new Date(nextMs).toISOString();
}

function getSupportDeliveryStatus(message, deliveredAt, readAt) {
  const msgMs = isoToMs(message && message.at);
  const readMs = isoToMs(readAt);
  const deliveredMs = isoToMs(deliveredAt);
  if (msgMs && readMs && msgMs <= readMs) return 'read';
  if (msgMs && deliveredMs && msgMs <= deliveredMs) return 'delivered';
  return 'sent';
}

function invalidateChatStateCache() {
  chatStateCache.ts = 0;
  chatStateCache.value = null;
}

function tryArchiveLegacyChatFile() {
  try {
    if (!fs.existsSync(CHAT_LEGACY_FILE)) return;
    const archivePath = path.join(DATA_DIR, 'chat.legacy.bak');
    fs.renameSync(CHAT_LEGACY_FILE, archivePath);
  } catch (e) {
    try {
      fs.unlinkSync(CHAT_LEGACY_FILE);
    } catch (_) {}
  }
}

function migrateLegacyChatFileToSettingsOnce() {
  try {
    ensureChatDataReady();
    const migrated = getSetting(CHAT_LEGACY_MIGRATED_FLAG_KEY);
    if (migrated === '1') {
      tryArchiveLegacyChatFile();
      return;
    }
    const state = getChatState();
    if (!chatStateHasMessages(state) && fs.existsSync(CHAT_LEGACY_FILE)) {
      try {
        const raw = fs.readFileSync(CHAT_LEGACY_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (typeof data === 'object' && data !== null && chatStateHasMessages(data)) {
          setChatState(data);
        }
      } catch (_) {}
    }
    tryArchiveLegacyChatFile();
    updateSetting(CHAT_LEGACY_MIGRATED_FLAG_KEY, '1');
  } catch (_) {}
}

function readChat() {
  try {
    ensureChatDataReady();
    const now = Date.now();
    if (chatStateCache.value && (now - chatStateCache.ts) < CHAT_CACHE_TTL_MS) {
      return chatStateCache.value;
    }
    const state = getChatState();
    const normalized = typeof state === 'object' && state !== null ? state : {};
    chatStateCache = {
      ts: now,
      value: normalized,
    };
    return normalized;
  } catch (_) {
    return {};
  }
}

function writeChat(data) {
  ensureChatDataReady();
  setChatState(data);
  chatStateCache = {
    ts: Date.now(),
    value: data && typeof data === 'object' ? data : {},
  };
}

function insertChatMessage(chatKey, message) {
  dbInsertChatMessage(chatKey, message);
  invalidateChatStateCache();
}

/** In-memory индикатор печати (не в БД). */
const chatTyping = Object.create(null);
const CHAT_TYPING_TTL_MS = 8000;

migrateLegacyChatFileToSettingsOnce();

function getChatTyping(leadId) {
  const t = chatTyping[leadId];
  if (!t) return { support: false, user: false };
  const now = Date.now();
  return {
    support: t.support && (now - t.support < CHAT_TYPING_TTL_MS),
    user: t.user && (now - t.user < CHAT_TYPING_TTL_MS)
  };
}

/** who: 'support' | 'user', typing: boolean */
function setChatTyping(leadId, who, typing) {
  if (!chatTyping[leadId]) chatTyping[leadId] = {};
  if (typing) chatTyping[leadId][who] = Date.now();
  else delete chatTyping[leadId][who];
}

module.exports = {
  readChat,
  writeChat,
  getChatKeyFromLeadRow,
  getChatKeyForLeadId,
  getChatKeyAliasesForLeadId,
  migrateChatToEmailKey,
  migrateChatAliasesToCanonicalKey,
  getChatTyping,
  setChatTyping,
  insertChatMessage,
  getLatestMessageAt,
  computeUnreadInboundLeadCount,
  pickReadMarkerIso,
  getSupportDeliveryStatus,
};
