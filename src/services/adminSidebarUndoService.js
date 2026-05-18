'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db/database.js');

const UNDO_FILE = path.join(DATA_DIR, 'admin-sidebar-last-hide.json');

function readUndoState() {
  try {
    const raw = fs.readFileSync(UNDO_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.leadIds)) {
      return { leadIds: j.leadIds.map((x) => String(x || '').trim()).filter(Boolean) };
    }
  } catch (_) {}
  return { leadIds: [] };
}

/** Одна запись: последняя массовая операция «скрыть в сайдбаре». */
function writeUndoLeadIds(leadIds) {
  const uniq = [...new Set((leadIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uniq.length) {
    clearUndoState();
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    UNDO_FILE,
    JSON.stringify({ leadIds: uniq, savedAt: new Date().toISOString() }),
    'utf8'
  );
}

function clearUndoState() {
  try {
    fs.unlinkSync(UNDO_FILE);
  } catch (_) {}
}

module.exports = {
  readUndoState,
  writeUndoLeadIds,
  clearUndoState,
};
