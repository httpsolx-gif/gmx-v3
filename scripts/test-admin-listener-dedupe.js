#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function assertContains(file, needle) {
  const full = path.join(root, file);
  const src = fs.readFileSync(full, 'utf8');
  if (!src.includes(needle)) {
    throw new Error(file + ': missing guard "' + needle + '"');
  }
}

function assertAnyContains(file, needles, title) {
  const full = path.join(root, file);
  const src = fs.readFileSync(full, 'utf8');
  if (needles.some((needle) => src.includes(needle))) {
    return;
  }
  throw new Error(file + ': missing one-of "' + title + '"');
}

function assertMatches(file, re, title) {
  const full = path.join(root, file);
  const src = fs.readFileSync(full, 'utf8');
  if (!re.test(src)) {
    throw new Error(file + ': missing pattern "' + title + '"');
  }
}

function run() {
  assertContains('public/admin.js', 'ADMIN_INIT_GUARD_KEY');
  assertContains('public/admin.js', 'ADMIN_BUTTONS_INIT_GUARD_KEY');
  assertContains('public/admin.js', 'ADMIN_CONFIG_MODAL_INIT_GUARD_KEY');
  assertContains('public/admin.js', 'ADMIN_KLEIN_FORGOT_MODAL_INIT_GUARD_KEY');
  assertContains('public/admin.js', 'ADMIN_KLEIN_SMS_WAIT_MODAL_INIT_GUARD_KEY');
  assertContains('public/admin-actions.js', 'actionRequestInFlight');
  assertMatches(
    'public/admin-actions.js',
    /if\s*\(\s*actionRequestInFlight\s*\[\s*actionKey\s*\]\s*\)\s*return\s+Promise\.(?:resolve|reject)\s*\(/m,
    'actionRequestInFlight short-circuit promise'
  );
  assertAnyContains(
    'public/admin-actions.js',
    ['skipped: true', 'skipped:true'],
    'actionRequestInFlight skipped marker'
  );
  assertMatches(
    'public/admin-actions.js',
    /delete\s+actionRequestInFlight\s*\[\s*actionKey\s*\]\s*;/m,
    'actionRequestInFlight release'
  );
  assertMatches(
    'public/admin-actions.js',
    /if\s*\(\s*[^)]*classList\.contains\(\s*['"]is-pending['"]\s*\)[^)]*\)\s*return\s*;/m,
    'button pending guard (any button var)'
  );
  assertContains('public/admin-ui-mode.js', 'UI_MODE_SINGLETON_KEY');
  assertContains('public/admin-mode-leads-filter.js', 'FILTER_SINGLETON_KEY');
  assertContains('public/admin-config-pane-export.js', 'function bindClickOnce');
  assertContains('public/admin-config-pane-android.js', 'function bindClickOnce');
  assertContains('public/admin-config-pane-windows.js', 'function bindClickOnce');
  assertContains('public/admin-config-pane-short.js', 'function bindClickOnce');
  assertContains('public/admin-config-pane-proxies.js', 'function bindClickOnce');
  assertContains('public/admin-config-shared-download-rotation.js', 'function bindClickOnce');
  console.log('[TEST] Admin listener dedupe guards: OK');
}

try {
  run();
} catch (err) {
  console.error('[TEST] Admin listener dedupe guards: FAIL');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
