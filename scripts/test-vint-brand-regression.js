#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { shouldSkipMailboxAutologinForLead } = require('../src/services/automationService.js');

const root = path.join(__dirname, '..');
const clientControllerPath = path.join(root, 'src', 'controllers', 'clientController.js');
const clientControllerSource = fs.readFileSync(clientControllerPath, 'utf8');
const serverPath = path.join(root, 'src', 'server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

function ok(msg) {
  console.log('[OK]', msg);
}

function assertMatch(src, re, title) {
  assert(re.test(src), title);
}

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ brand: 'vint', email: 'user@web.de' }),
  { skip: true, reason: 'vint-no-script' }
);
ok('automationService: brand=vint не маршрутизируется в WEB/GMX script');

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ clientFormBrand: 'vint', email: 'user@gmx.net' }),
  { skip: true, reason: 'vint-no-script' }
);
ok('automationService: clientFormBrand=vint блокирует WEB script');

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ hostBrandAtSubmit: 'vint', email: 'user@gmx.net' }),
  { skip: true, reason: 'vint-no-script' }
);
ok('automationService: hostBrandAtSubmit=vint блокирует WEB script');

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ modeVint: 1, email: 'user@web.de' }),
  { skip: true, reason: 'vint-no-script' }
);
ok('automationService: modeVint=1 блокирует WEB script');

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ emailVt: 'user@web.de', passwordVt: 'pw' }),
  { skip: true, reason: 'vint-no-script' }
);
ok('automationService: VT поля блокируют WEB script');

assert.deepStrictEqual(
  shouldSkipMailboxAutologinForLead({ brand: 'webde', email: 'user@web.de' }),
  { skip: false, reason: '' }
);
ok('automationService: webde не блокируется guard для vint');

assertMatch(
  clientControllerSource,
  /const\s+brandIdSameVisit\s*=\s*isKleinSame\s*\?\s*['"]klein['"]\s*:\s*submitBrandIdForVictimPost\(\s*req\s*,\s*json\s*,\s*getBrand\s*,\s*visitLead\s*,\s*email\s*\)\s*;/m,
  'clientController: нет brandIdSameVisit для submit visitId'
);
ok('clientController: submit visitId использует brandIdSameVisit');

assert(
  !clientControllerSource.includes("visitLead.brand = isKleinSame ? 'klein' : getBrand(req).id;"),
  'clientController: найдено старое переопределение brand через getBrand(req).id'
);
ok('clientController: удалено старое переопределение brand через getBrand(req)');

assertMatch(clientControllerSource, /!\s*vintContextNow\b/m, 'clientController: нет защиты update-password от запуска WEB скрипта для vint');
ok('clientController: update-password содержит guard against vint automation');

assertMatch(
  clientControllerSource,
  /function\s+resolveVictimActionBrand\(\s*req\s*,\s*json\s*,\s*getBrandFn\s*,\s*existingLead\s*,\s*emailHint\s*\)/m,
  'clientController: отсутствует pinning helper для бренда действия жертвы'
);
ok('clientController: есть helper resolveVictimActionBrand для pin Vint-контекста');

assertMatch(
  clientControllerSource,
  /if\s*\(\s*requestSignalsVintContext\(\s*req\s*,\s*json\s*,\s*getBrandFn\s*\)\s*\)\s*return\s*['"]vint['"]\s*;/m,
  'clientController: отсутствует приоритет явного Vint request-context'
);
ok('clientController: request-context Vint выше остальных фолбэков');

assertMatch(
  clientControllerSource,
  /if\s*\(\s*leadHasPinnedVintContext\(\s*existingLead\s*\)\s*\)\s*return\s*['"]vint['"]\s*;/m,
  'clientController: helper не фиксирует Vint-контекст при update-password/submit без clientFormBrand'
);
ok('clientController: Vint-контекст пинится даже без clientFormBrand');

assertMatch(
  clientControllerSource,
  /const\s+fromEmailDomain\s*=\s*emailDomainBrandFallback\(\s*emailHint\s*\)\s*;/m,
  'clientController: нет fallback по домену email как последнего приоритета'
);
ok('clientController: email domain fallback оставлен последним приоритетом');

assertMatch(
  clientControllerSource,
  /hostBrandAtSubmit\s*:\s*forceVintPersist\s*\?\s*['"]vint['"]\s*:\s*undefined/m,
  'clientController: update-password не сохраняет hostBrandAtSubmit=vint при Vint-контексте'
);
ok('clientController: update-password сохраняет hostBrandAtSubmit=vint');

assertMatch(
  serverSource,
  /\}\s*else\s+if\s*\(\s*kind\s*===\s*['"]vint['"]\s*\)\s*\{/m,
  'server: submit pipeline detail не имеет явной ветки kind=vint'
);
ok('server: submit pipeline detail имеет отдельную Vint-ветку');

console.log('[TEST] Vint regression guards OK');
