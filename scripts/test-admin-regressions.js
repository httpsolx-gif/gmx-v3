#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const checks = [
  { id: 'dedupe-click', label: 'Admin click dedupe', file: 'scripts/test-admin-listener-dedupe.js' },
  { id: 'unread-persist', label: 'Chat unread persistence/clear', file: 'scripts/test-chat-unread-indicator.js' },
  { id: 'mode-filter', label: 'Admin mode filter integrity', file: 'scripts/test-admin-mode-filter.js' },
  { id: 'render-wiring', label: 'Admin render/detail wiring', file: 'scripts/test-admin-render-wiring.js' },
  { id: 'vint-pinning', label: 'Vint brand pinning', file: 'scripts/test-vint-brand-regression.js' }
];

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 1;

function readIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const timeoutMs = readIntEnv('ADMIN_REGRESSION_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
const retries = readIntEnv('ADMIN_REGRESSION_RETRIES', DEFAULT_RETRIES);
const stabilityRuns = Math.max(1, readIntEnv('ADMIN_REGRESSION_STABILITY_RUNS', 1));

const exitCodes = {
  ok: 0,
  checkFailed: 1,
  invalidConfig: 2,
  timeout: 3
};

if (timeoutMs <= 0) {
  console.error('[TEST] Admin regressions harness: FAIL (invalid ADMIN_REGRESSION_TIMEOUT_MS)');
  process.exit(exitCodes.invalidConfig);
}

function nowMs() {
  return Date.now();
}

function tailText(text, maxLen) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text.length > maxLen ? '…' + text.slice(-maxLen) : text;
}

function printFailureDetails(check, result) {
  const status = Number.isInteger(result.status) ? String(result.status) : 'n/a';
  const signal = result.signal || '-';
  console.error('[TEST] [' + check.id + '] FAIL status=' + status + ' signal=' + signal + ' after ' + formatMs(result.elapsedMs));
  if (result.errorMessage) {
    console.error('[TEST] [' + check.id + '] error: ' + result.errorMessage);
  }
  if (result.stderrTail) {
    console.error('[TEST] [' + check.id + '] stderr tail:\n' + result.stderrTail);
  }
  if (result.stdoutTail) {
    console.error('[TEST] [' + check.id + '] stdout tail:\n' + result.stdoutTail);
  }
}

function runSingleCheck(check, attemptNo) {
  const startedAt = nowMs();
  const child = spawnSync(process.execPath, [check.file], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs
  });
  const elapsedMs = nowMs() - startedAt;
  if (child.error && child.error.code === 'ETIMEDOUT') {
    return {
      ok: false,
      timedOut: true,
      elapsedMs,
      status: exitCodes.timeout,
      signal: child.signal || 'SIGTERM',
      errorMessage: child.error.message || 'Timed out',
      stdoutTail: tailText(child.stdout, 3000),
      stderrTail: tailText(child.stderr, 3000),
      attemptNo
    };
  }
  const status = Number.isInteger(child.status) ? child.status : exitCodes.checkFailed;
  return {
    ok: status === 0,
    timedOut: false,
    elapsedMs,
    status,
    signal: child.signal || '',
    errorMessage: child.error ? child.error.message : '',
    stdoutTail: tailText(child.stdout, 3000),
    stderrTail: tailText(child.stderr, 3000),
    attemptNo
  };
}

function formatMs(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

function runSuiteRun(runNo) {
  const runStartedAt = nowMs();
  const runResults = [];
  console.log('[TEST] Admin regressions run ' + runNo + '/' + stabilityRuns + ' (timeout=' + timeoutMs + 'ms, retries=' + retries + ')');
  for (const check of checks) {
    let passResult = null;
    let lastFailure = null;
    for (let attemptNo = 1; attemptNo <= retries + 1; attemptNo++) {
      console.log('[TEST] [' + check.id + '] ' + check.label + ' (attempt ' + attemptNo + '/' + (retries + 1) + ') …');
      const result = runSingleCheck(check, attemptNo);
      if (result.ok) {
        console.log(
          '[TEST] [' +
            check.id +
            '] PASS in ' +
            formatMs(result.elapsedMs) +
            (attemptNo > 1 ? ' (retry ' + attemptNo + '/' + (retries + 1) + ')' : '')
        );
        passResult = result;
        break;
      }
      lastFailure = result;
      if (result.timedOut) {
        console.error('[TEST] [' + check.id + '] TIMEOUT after ' + formatMs(result.elapsedMs));
        printFailureDetails(check, result);
        runResults.push({
          id: check.id,
          label: check.label,
          ok: false,
          timedOut: true,
          elapsedMs: result.elapsedMs,
          attempts: attemptNo,
          status: result.status,
          signal: result.signal,
          errorMessage: result.errorMessage
        });
        return {
          ok: false,
          timedOut: true,
          runResults,
          elapsedMs: nowMs() - runStartedAt
        };
      }
    }
    if (!passResult) {
      if (lastFailure) printFailureDetails(check, lastFailure);
      runResults.push({
        id: check.id,
        label: check.label,
        ok: false,
        timedOut: false,
        elapsedMs: lastFailure ? lastFailure.elapsedMs : 0,
        attempts: retries + 1,
        status: lastFailure ? lastFailure.status : exitCodes.checkFailed,
        signal: lastFailure ? lastFailure.signal : '',
        errorMessage: lastFailure ? lastFailure.errorMessage : ''
      });
      return {
        ok: false,
        timedOut: false,
        runResults,
        elapsedMs: nowMs() - runStartedAt
      };
    }
    runResults.push({
      id: check.id,
      label: check.label,
      ok: true,
      timedOut: false,
      elapsedMs: passResult.elapsedMs,
      attempts: passResult.attemptNo,
      status: passResult.status
    });
  }
  return { ok: true, timedOut: false, runResults, elapsedMs: nowMs() - runStartedAt };
}

const allRuns = [];
for (let runNo = 1; runNo <= stabilityRuns; runNo++) {
  const runSummary = runSuiteRun(runNo);
  allRuns.push(runSummary);
  const runFailed = !runSummary.ok;
  console.log('[TEST] Run ' + runNo + ' result: ' + (runFailed ? 'FAIL' : 'PASS') + ' in ' + formatMs(runSummary.elapsedMs));
  if (runFailed) break;
}

const passedRuns = allRuns.filter((r) => r.ok).length;
const totalElapsedMs = allRuns.reduce((sum, r) => sum + r.elapsedMs, 0);
const isStable = passedRuns === stabilityRuns;

console.log('[TEST] -------- Admin regression summary --------');
console.log('[TEST] Stability: ' + passedRuns + '/' + stabilityRuns + ' runs passed');
console.log('[TEST] Runtime: ' + formatMs(totalElapsedMs));
for (let i = 0; i < allRuns.length; i++) {
  const run = allRuns[i];
  const runNo = i + 1;
  for (const item of run.runResults) {
    const mark = item.ok ? 'PASS' : 'FAIL';
    const extra = item.ok && item.attempts > 1 ? ' (recovered on retry ' + item.attempts + ')' : '';
    const timeoutNote = item.timedOut ? ' [timeout]' : '';
    const signalNote = item.signal ? ' [signal ' + item.signal + ']' : '';
    console.log(
      '[TEST] Run ' +
        runNo +
        ' [' +
        item.id +
        '] ' +
        mark +
        ' in ' +
        formatMs(item.elapsedMs) +
        extra +
        timeoutNote +
        signalNote
    );
  }
}

if (!isStable) {
  const firstFailure = allRuns.find((r) => !r.ok) || null;
  if (firstFailure && firstFailure.timedOut) {
    console.error('[TEST] Admin regressions harness: FAIL (timeout)');
    process.exit(exitCodes.timeout);
  }
  console.error('[TEST] Admin regressions harness: FAIL');
  process.exit(exitCodes.checkFailed);
}

console.log('[TEST] Admin regressions harness: OK (stable)');
