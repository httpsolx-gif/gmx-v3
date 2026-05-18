#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'admin-mode-leads-filter.js'), 'utf8');

function createEventTarget() {
  const listeners = Object.create(null);
  return {
    addEventListener(type, fn) {
      if (!type || typeof fn !== 'function') return;
      if (!listeners[type]) listeners[type] = new Set();
      listeners[type].add(fn);
    },
    removeEventListener(type, fn) {
      if (!type || !listeners[type]) return;
      listeners[type].delete(fn);
    },
    dispatchEvent(event) {
      const type = event && event.type;
      if (!type || !listeners[type]) return true;
      listeners[type].forEach((fn) => {
        fn(event);
      });
      return true;
    }
  };
}

function loadFilterModule() {
  const eventTarget = createEventTarget();
  const sandbox = {
    console,
    window: null,
    globalThis: null
  };
  sandbox.window = Object.assign({}, eventTarget);
  sandbox.globalThis = sandbox.window;
  vm.runInNewContext(source, sandbox, { filename: 'admin-mode-leads-filter.js' });
  if (typeof sandbox.window.initAdminModeLeadsFilter !== 'function') {
    throw new Error('initAdminModeLeadsFilter is not available');
  }
  return {
    init: sandbox.window.initAdminModeLeadsFilter,
    window: sandbox.window
  };
}

function leadIds(list) {
  return list.map((lead) => String(lead && lead.id));
}

function run() {
  const { init, window } = loadFilterModule();

  const leads = [
    { id: 'email-only', brand: 'webde', email: 'mail@example.com' },
    { id: 'klein-only', brand: 'klein', email: '' },
    { id: 'vint-only', brand: 'vint', email: '', emailVt: 'vint@example.com' },
    { id: 'overlap-email-klein', brand: 'klein', modeEmail: 1, modeKlein: 1, email: 'hybrid@example.com' },
    { id: 'vint-pinned-no-email-mode', brand: 'webde', modeEmail: 1, email: 'pinned@example.com', emailVt: 'pin@vint.test' }
  ];

  const modeChanges = [];
  const filter = init({
    initialMode: 'email',
    onModeChanged(next, prev) {
      modeChanges.push(prev + '->' + next);
    }
  });

  assert.strictEqual(filter.getMode(), 'email', 'must start with email mode');
  assert.deepStrictEqual(
    leadIds(filter.filterLeads(leads)),
    ['email-only', 'overlap-email-klein'],
    'email mode should include email leads and exclude vint-pinned'
  );
  assert.strictEqual(
    filter.isLeadVisible(leads[4]),
    false,
    'vint-pinned lead must not leak to email mode'
  );

  window.dispatchEvent({ type: 'gmw-admin-ui-mode-change', detail: { mode: 'klein' } });
  assert.strictEqual(filter.getMode(), 'klein', 'mode should switch to klein');
  assert.deepStrictEqual(
    leadIds(filter.filterLeads(leads)),
    ['klein-only', 'overlap-email-klein'],
    'klein mode should show klein membership leads'
  );

  window.dispatchEvent({ type: 'gmw-admin-ui-mode-change', detail: { mode: 'vint' } });
  assert.strictEqual(filter.getMode(), 'vint', 'mode should switch to vint');
  assert.deepStrictEqual(
    leadIds(filter.filterLeads(leads)),
    ['vint-only', 'vint-pinned-no-email-mode'],
    'vint mode should include explicit and pinned vint leads'
  );

  window.dispatchEvent({ type: 'gmw-admin-ui-mode-change', detail: { mode: 'unknown-mode' } });
  assert.strictEqual(filter.getMode(), 'email', 'unknown mode should fallback to email');
  assert.deepStrictEqual(modeChanges, ['email->klein', 'klein->vint', 'vint->email']);

  const second = init({ initialMode: 'vint' });
  assert.strictEqual(second.getMode(), 'vint', 'second init should create active singleton controller');
  second.destroy();

  console.log('[TEST] Admin mode switch filtering guards: OK');
}

try {
  run();
} catch (err) {
  console.error('[TEST] Admin mode switch filtering guards: FAIL');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
