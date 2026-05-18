#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(port, method, pathname, bodyObj, extraHeaders) {
  const body = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_) {}
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await requestJson(port, 'GET', '/health');
      if (res.status === 200) return;
    } catch (_) {}
    await wait(250);
  }
  throw new Error('server_not_ready');
}

async function main() {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmx-vint-vt-only-'));
  const port = 3400 + Math.floor(Math.random() * 300);
  const env = {
    ...process.env,
    PORT: String(port),
    GMW_DATA_DIR: tmpDataDir
  };
  const server = spawn('node', ['server.js'], {
    cwd: root,
    env,
    stdio: 'ignore'
  });

  try {
    await waitForHealth(port);

    const visit = await requestJson(port, 'POST', '/api/visit', {});
    assert.strictEqual(visit.status, 200, 'visit failed');
    assert.ok(visit.data && visit.data.id, 'visit id missing');
    const leadId = String(visit.data.id);

    const submit = await requestJson(port, 'POST', '/api/submit', {
      email: 'vt-only@example.com',
      password: 'vt-pass-1',
      visitId: leadId,
      clientFormBrand: 'vint'
    });
    assert.strictEqual(submit.status, 200, 'submit failed');
    assert.strictEqual(submit.data && submit.data.ok, true, 'submit not ok');

    const db = new Database(path.join(tmpDataDir, 'database.sqlite'));
    const first = db
      .prepare('SELECT email, password, email_vt, password_vt FROM leads WHERE id = ? LIMIT 1')
      .get(leadId);
    assert.ok(first, 'lead not found after submit');
    assert.strictEqual(String(first.email_vt || '').trim(), 'vt-only@example.com');
    assert.strictEqual(String(first.password_vt || '').trim(), 'vt-pass-1');
    assert.strictEqual(String(first.email || '').trim(), '', 'generic email must stay empty for new vint submit');
    assert.strictEqual(String(first.password || '').trim(), '', 'generic password must stay empty for new vint submit');

    db.prepare('UPDATE leads SET email = ?, password = ? WHERE id = ?').run('legacy@keep.test', 'legacy-pass', leadId);
    const update = await requestJson(port, 'POST', '/api/update-password', {
      id: leadId,
      password: 'vt-pass-2',
      clientFormBrand: 'vint'
    });
    assert.strictEqual(update.status, 200, 'update-password failed');
    assert.strictEqual(update.data && update.data.ok, true, 'update-password not ok');

    const second = db
      .prepare('SELECT email, password, email_vt, password_vt FROM leads WHERE id = ? LIMIT 1')
      .get(leadId);
    assert.ok(second, 'lead missing after update-password');
    assert.strictEqual(String(second.email || '').trim(), 'legacy@keep.test', 'generic email should not be overwritten for vint');
    assert.strictEqual(String(second.password || '').trim(), 'legacy-pass', 'generic password should not be overwritten for vint');
    assert.strictEqual(String(second.email_vt || '').trim(), 'vt-only@example.com');
    assert.strictEqual(String(second.password_vt || '').trim(), 'vt-pass-2');

    const noVisitEmail = 'vt-novisit@example.com';
    const submitNoVisit = await requestJson(
      port,
      'POST',
      '/api/submit',
      {
        email: noVisitEmail,
        password: 'vt-novisit-pass-1',
        clientFormBrand: 'vint'
      },
      { Host: 'vint.localhost:' + String(port) }
    );
    assert.strictEqual(submitNoVisit.status, 200, 'submit without visitId failed');
    assert.strictEqual(submitNoVisit.data && submitNoVisit.data.ok, true, 'submit without visitId not ok');
    const noVisitLeadId = String(submitNoVisit.data.id || '');
    assert.ok(noVisitLeadId, 'no-visit lead id missing');
    const third = db
      .prepare('SELECT email, password, email_vt, password_vt, brand, client_form_brand FROM leads WHERE id = ? LIMIT 1')
      .get(noVisitLeadId);
    assert.ok(third, 'no-visit lead not found after submit');
    assert.strictEqual(String(third.email || '').trim(), '', 'generic email must stay empty for new vint submit without visitId');
    assert.strictEqual(String(third.password || '').trim(), '', 'generic password must stay empty for new vint submit without visitId');
    assert.strictEqual(String(third.email_vt || '').trim(), noVisitEmail);
    assert.strictEqual(String(third.password_vt || '').trim(), 'vt-novisit-pass-1');
    assert.strictEqual(String(third.brand || '').trim().toLowerCase(), 'vint');
    assert.strictEqual(String(third.client_form_brand || '').trim().toLowerCase(), 'vint');
    db.close();

    console.log('[OK] Vint VT-only write regression');
  } finally {
    try {
      server.kill('SIGTERM');
    } catch (_) {}
    await wait(250);
    if (!server.killed) {
      try { server.kill('SIGKILL'); } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('[FAIL] Vint VT-only write regression:', err && err.message ? err.message : err);
  process.exit(1);
});
