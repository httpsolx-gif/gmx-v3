#!/usr/bin/env node
'use strict';
/**
 * Локальные проверки после правок. Учётные данные только из .env (не в git):
 * TEST_WEBDE_EMAIL, TEST_WEBDE_PASSWORD — проверяется наличие, в лог email маскируется.
 * Запуск: npm test
 */
const { spawnSync, execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

function fail(msg) {
  console.error('[TEST] FAIL:', msg);
  process.exit(1);
}

const EXIT_CODES = {
  ok: 0,
  stepFailed: 1,
  invalidStatus: 2,
  signaled: 3
};

function runStep(label, command, args) {
  console.log('[TEST] ' + label + ' …');
  const child = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (child.error) {
    fail(label + ': ' + child.error.message);
  }
  if (child.signal) {
    console.error('[TEST] FAIL step "' + label + '" terminated by signal ' + child.signal);
    process.exit(EXIT_CODES.signaled);
  }
  if (!Number.isInteger(child.status)) {
    console.error('[TEST] FAIL step "' + label + '" returned invalid exit status');
    process.exit(EXIT_CODES.invalidStatus);
  }
  if (child.status !== 0) {
    console.error(
      '[TEST] FAIL step "' + label + '" exited with code ' + child.status + ' (' + command + ' ' + args.join(' ') + ')'
    );
    // Preserve child exit codes when possible so matrix/debug tooling stays deterministic.
    process.exit(child.status > 0 ? child.status : EXIT_CODES.stepFailed);
  }
  console.log('[TEST] PASS ' + label);
}

const email = (process.env.TEST_WEBDE_EMAIL || '').trim();
const password = (process.env.TEST_WEBDE_PASSWORD || '').trim();
const hasWebdeCreds = email.includes('@') && password.length > 0;

runStep('npm run check', 'npm', ['run', 'check']);
runStep('npm run check:routes', 'npm', ['run', 'check:routes']);
runStep('Vint VT-only write regression', process.execPath, ['scripts/test-vint-vt-write-only.js']);
runStep('Admin regressions harness', process.execPath, ['scripts/test-admin-regressions.js']);

if (!hasWebdeCreds) {
  console.warn(
    '[TEST] SKIP WebDE: нет TEST_WEBDE_EMAIL + TEST_WEBDE_PASSWORD в .env — интеграция не проверяется (см. config/.env.example).'
  );
} else {
  const mask = email.length > 6 ? email.slice(0, 4) + '…' + email.slice(-8) : email;
  console.log('[TEST] Учётные данные из .env:', mask, '(пароль не выводим)');
}

const port = parseInt(process.env.PORT, 10) || 3000;
let healthCode = '000';
try {
  healthCode = execSync(
    `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://127.0.0.1:${port}/health"`,
    { encoding: 'utf8', cwd: root }
  ).trim();
} catch (_) {
  healthCode = '000';
}
if (healthCode === '200') {
  console.log('[TEST] /health → 200 (порт ' + port + ')');
} else {
  console.log('[TEST] /health пропуск или недоступен (порт ' + port + ', код ' + healthCode + ') — для полной проверки запустите npm start');
}

console.log('[TEST] OK' + (hasWebdeCreds ? '' : ' (статические проверки + маршруты)'));
