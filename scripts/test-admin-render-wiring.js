#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(label + ': missing "' + needle + '"');
  }
}

function assertMatches(haystack, pattern, label) {
  if (!pattern.test(haystack)) {
    throw new Error(label + ': missing pattern "' + pattern + '"');
  }
}

function run() {
  const adminJs = read('public/admin.js');
  const leadsListJs = read('public/admin-leads-list.js');
  const leadDetailJs = read('public/admin-lead-detail.js');

  // Lead list module is created and wired with detail/list callbacks from host file.
  assertMatches(adminJs, /window\.AdminLeadsListModule\.create\s*\(\s*\{/m, 'admin.js');
  assertMatches(adminJs, /renderDetail\s*:\s*renderDetail\b/m, 'admin.js');
  assertMatches(adminJs, /loadLeads\s*:\s*loadLeads\b/m, 'admin.js');
  assertMatches(adminJs, /function\s+renderList\s*\(\s*\)\s*\{[\s\S]*?module\.renderList\s*\(\s*\)/m, 'admin.js');
  assertMatches(
    adminJs,
    /function\s+renderPagination\s*\(\s*\)\s*\{[\s\S]*?module\.renderPagination\s*\(\s*\)/m,
    'admin.js'
  );
  assertMatches(
    adminJs,
    /function\s+renderDetail\s*\(\s*\)\s*\{[\s\S]*?(adminLeadDetail\.renderLeadDetailPanel|renderLeadDetailPanel)/m,
    'admin.js'
  );

  // Item selection inside split lead list module still updates active lead and detail panel.
  assertMatches(leadsListJs, /item\.addEventListener\(\s*['"]click['"]/m, 'admin-leads-list.js');
  assertContains(leadsListJs, 'setSelectedId(nextId);', 'admin-leads-list.js');
  assertContains(leadsListJs, 'renderDetail();', 'admin-leads-list.js');

  // Detail render is delegated to split detail module.
  assertContains(adminJs, 'adminLeadDetail.renderLeadDetailPanel({', 'admin.js');
  assertContains(leadDetailJs, 'function renderLeadDetailPanel(ctx)', 'admin-lead-detail.js');
  assertContains(leadDetailJs, 'window.AdminLeadDetail = {', 'admin-lead-detail.js');

  console.log('[TEST] Admin render/selection/detail wiring guards: OK');
}

try {
  run();
} catch (err) {
  console.error('[TEST] Admin render/selection/detail wiring guards: FAIL');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
