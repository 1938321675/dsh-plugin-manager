'use strict';
/**
 * dump-state.js —— 导出本工具算出的每个行状态，供与 DSH 实际状态比对
 */

const path = require('path');
const { createService } = require('../src/core/index.js');

const HOMEDIR = require('os').homedir();
const profileDir = path.join(HOMEDIR, '.dsh', 'profiles', 'desktop');
const dataDir = path.join(__dirname, '..', 'data');

const svc = createService({ profileDir, dataDir });
const data = svc.collect();

const out = {};
for (const it of data.items) {
  out[it.name] = {
    enabled: it.enabled,
    rows: it.rowIds,
    reason: it.stateReason,
  };
}
console.log(JSON.stringify(out, null, 2));
