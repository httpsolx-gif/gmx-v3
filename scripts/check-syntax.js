#!/usr/bin/env node
/**
 * Проверка синтаксиса всех Node.js-скриптов проекта.
 * Запуск: node scripts/check-syntax.js  или  npm run check:syntax
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'src/server.js',
  'src/core/httpServerApp.js',
  'src/core/bootstrap.js',
  'src/core/routeHttpDeps.js',
  'src/core/adminPaths.js',
  'src/services/wsAdminBroadcast.js',
  'src/services/mailService.js',
  'src/services/warmupService.js',
  'src/services/probeService.js',
  'src/services/downloadKitService.js',
  'src/routes/adminRoutes.js',
  'src/controllers/adminController.js',
  'src/controllers/leadController.js',
  'src/controllers/clientController.js',
  'src/controllers/staticController.js',
  'src/middleware/gateMiddleware.js',
  'src/routes/staticRoutes.js',
  'src/utils/staticFileServe.js',
  'src/utils/shortDomainHttpProbe.js',
  'src/utils/shortLinkTargetMatch.js',
  'src/utils/localNetwork.js',
  'src/utils/urlSchemeUtils.js',
  'src/utils/proxyAuthWebValidate.js',
  'src/utils/localDevKlein.js',
  'src/utils/stdioGuard.js',
  'src/short/index.js',
  'scripts/cleanup-backups.js',
  'scripts/check-reliability.js',
  'scripts/test-vint-brand-regression.js',
  'scripts/test-vint-vt-write-only.js',
  'scripts/test-chat-unread-indicator.js',
  'scripts/test-admin-listener-dedupe.js',
  'scripts/test-admin-mode-filter.js',
  'scripts/test-admin-regressions.js',
  'scripts/restore-leads.js',
  'scripts/test-download-rotation.js',
  'scripts/run-local-tests.js',
  'scripts/sync-gmx-nginx-vhosts.mjs'
];

let failed = 0;
let interrupted = 0;
let harnessErrors = 0;
const EXIT_CODES = {
  ok: 0,
  syntaxFailed: 1,
  invalidStatus: 2,
  signaled: 3
};

for (const file of files) {
  const full = path.join(root, file);
  const check = spawnSync(process.execPath, ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (check.error) {
    console.error('[FAIL]', file);
    console.error('       failed to run syntax check:', check.error.message);
    harnessErrors++;
    continue;
  }
  if (check.signal) {
    console.error('[FAIL]', file);
    console.error('       interrupted by signal:', check.signal);
    interrupted++;
    continue;
  }
  if (!Number.isInteger(check.status)) {
    console.error('[FAIL]', file);
    console.error('       invalid exit status from syntax check');
    harnessErrors++;
    continue;
  }
  if (check.status !== 0) {
    console.error('[FAIL]', file);
    const details = String(check.stderr || check.stdout || '').trim();
    if (details) {
      console.error(details);
    }
    failed++;
    continue;
  }
  console.log('[OK]', file);
}
const totalIssues = failed + interrupted + harnessErrors;
console.log(
  '[SUMMARY] syntax_failed=' +
    failed +
    ' interrupted=' +
    interrupted +
    ' harness_errors=' +
    harnessErrors +
    ' total=' +
    totalIssues
);
if (interrupted > 0) process.exit(EXIT_CODES.signaled);
if (harnessErrors > 0) process.exit(EXIT_CODES.invalidStatus);
if (failed > 0) process.exit(EXIT_CODES.syntaxFailed);
process.exit(EXIT_CODES.ok);
