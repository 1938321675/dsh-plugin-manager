'use strict';
/**
 * verify-rows.js —— 交叉验证 row 归属与状态（只读）
 *
 * 检查目标：
 *   1. 每个插件声明的 row，是否真的能在 profile patch 或插件自带 patch 里找到定义
 *   2. 是否有 row 归属不明（既不属于任何插件，也不是已知内核 row）
 *   3. 状态判定是否自洽
 *
 * 这个脚本是防止张冠李戴的守门脚本，改完 state.js 后应该跑一遍。
 */

const path = require('path');
const fs = require('fs');
const { createService } = require('../src/core/index.js');
const yamlLibMod = require('../src/core/yaml-lib');
const stateMod = require('../src/core/state');
const pluginsMod = require('../src/core/plugins');

const HOMEDIR = require('os').homedir();
const profileDir = path.join(HOMEDIR, '.dsh', 'profiles', 'desktop');
const dataDir = path.join(__dirname, '..', 'data');

const yamlLib = yamlLibMod.load();
const svc = createService({ yamlLib, profileDir, dataDir });
const data = svc.collect();
const patch = stateMod.parsePatch(yamlLib, data.patchFile);

console.log('=== 1. 插件声明的 row 在哪里能找到定义 ===');
let missing = 0;
for (const it of data.items) {
  if (!it.rowIds.length) continue;
  const pdir = path.join(profileDir, 'node_modules', it.name);
  const ownRows = fs.existsSync(pdir)
    ? pluginsMod.readDeclaredRows(yamlLib, pdir).map((r) => r.id)
    : [];
  const unresolved = it.rowIds.filter((id) => !ownRows.includes(id));
  if (unresolved.length) {
    console.log(`  [找不到定义] ${it.name} -> ${unresolved.join(', ')}`);
    missing++;
  }
}
if (!missing) {
  console.log('  全部 row 都能在插件自带 patch 中找到定义');
}

console.log('');
console.log('=== 2. profile patch 里出现、但不属于任何插件的 row ===');
const owned = new Set();
for (const it of data.items) for (const id of it.rowIds) owned.add(id);
const unowned = [...patch.rows.keys()].filter((id) => !owned.has(id));
console.log(`  profile patch 共涉及 ${patch.rows.size} 个 row id，其中 ${unowned.length} 个不归属第三方插件：`);
for (const id of unowned) {
  const r = patch.rows.get(id);
  const dis = r.dynamicDisabled ? 'dynamic' : String(r.disabled);
  console.log(`    ${id}  (disabled=${dis}, 首次来自 insert=${r.owned})`);
}

console.log('');
console.log('=== 3. 完全没有任何 row 的插件 ===');
const noRow = data.items.filter((i) => i.rowIds.length === 0);
if (!noRow.length) console.log('  无');
for (const it of noRow) console.log(`  ${it.name} — ${it.stateReason}`);

console.log('');
console.log('=== 4. 状态汇总 ===');
console.log(
  `  插件 ${data.pluginCount} 个：启用 ${data.enabledCount} / 禁用 ${data.disabledCount} / 动态 ${data.dynamicCount} / 缺失 ${data.missingCount}`
);

process.exit(missing > 0 ? 1 : 0);
