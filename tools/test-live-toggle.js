'use strict';
/**
 * test-live-toggle.js —— 在真实 profile 上做一次完整往返（带自动还原）
 *
 * 为什么要碰真实文件：副本测试无法证明"DSH 真的能读到这个改动"。
 * 但真实文件是用户的命根子，所以整个流程必须：
 *   1. 操作前记下原文件内容
 *   2. 失败或结束时无论如何都还原
 *   3. 用运行中的 DSH 视角复验状态
 *
 * 选中的目标是 dsh-cost-meter —— 非核心、不影响启动、
 * 禁用后也不会让 DSH 起不来，即使中途出意外也不会造成严重后果。
 */

const fs = require('fs');
const path = require('path');
const { createService } = require('../src/core/index.js');

const HOMEDIR = require('os').homedir();
const profileDir = path.join(HOMEDIR, '.dsh', 'profiles', 'desktop');
const dataDir = path.join(__dirname, '..', 'data');
const patchFile = path.join(profileDir, 'cordis.patch.yml');

const TARGET = 'dsh-cost-meter';

const original = fs.readFileSync(patchFile, 'utf8');
console.log(`原文件 ${original.length} 字节`);
console.log(`目标插件: ${TARGET}\n`);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

function restore() {
  fs.writeFileSync(patchFile, original, 'utf8');
}

try {
  const svc = createService({ profileDir, dataDir });

  const before = svc.collect();
  const item0 = before.items.find((i) => i.name === TARGET);
  console.log(`操作前: enabled=${item0.enabled} rows=${item0.rowIds.join(',')}`);
  check('操作前处于启用状态', item0.enabled === true);

  console.log('\n--- 禁用 ---');
  const r1 = svc.setPluginEnabled(TARGET, false);
  check('禁用操作返回成功', r1.ok === true, r1.error);
  console.log(`  写入的 row: ${r1.rowId}`);

  const afterOff = svc.collect();
  const item1 = afterOff.items.find((i) => i.name === TARGET);
  check('重新读取后显示已禁用', item1.enabled === false, `实际=${item1.enabled}`);

  const text1 = fs.readFileSync(patchFile, 'utf8');
  check('原内容完整保留', text1.startsWith(original));
  check(
    '禁用计数 +1',
    afterOff.disabledCount === before.disabledCount + 1,
    `${before.disabledCount} -> ${afterOff.disabledCount}`
  );

  console.log('\n--- 重新启用 ---');
  const r2 = svc.setPluginEnabled(TARGET, true);
  check('启用操作返回成功', r2.ok === true, r2.error);

  const afterOn = svc.collect();
  const item2 = afterOn.items.find((i) => i.name === TARGET);
  check('重新读取后显示已启用', item2.enabled === true, `实际=${item2.enabled}`);

  console.log('\n--- 状态语义验证 ---');
  check('始终只有 1 个 row 受影响', item2.rowIds.length === item0.rowIds.length);

} finally {
  restore();
  console.log('\n--- 已还原原文件 ---');
  const restored = fs.readFileSync(patchFile, 'utf8');
  check('文件字节级还原', restored === original, `${restored.length} vs ${original.length}`);
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
