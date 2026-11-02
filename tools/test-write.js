'use strict';
/**
 * test-write.js —— 写入往返测试
 *
 * 在一个**副本**上测试写入逻辑，绝不碰真实 profile 文件。
 * 验证目标：
 *   1. 追加一条 disabled: true 后，解析出来的状态确实变成禁用
 *   2. 原文件的其他内容字节级未变（只在末尾多了追加段）
 *   3. 撤回（追加 disabled: false）后状态恢复
 *   4. 备份文件确实生成
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const yamlLibMod = require('../src/core/yaml-lib');
const stateMod = require('../src/core/state');
const writerMod = require('../src/core/writer');

const yamlLib = yamlLibMod.load();

const REAL_PATCH = path.join(
  require('os').homedir(),
  '.dsh',
  'profiles',
  'desktop',
  'cordis.patch.yml'
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-test-'));
const patchFile = path.join(tmpDir, 'cordis.patch.yml');
const backupDir = path.join(tmpDir, 'backups');

fs.copyFileSync(REAL_PATCH, patchFile);
const original = fs.readFileSync(patchFile, 'utf8');
console.log(`测试副本: ${patchFile}`);
console.log(`原文件大小: ${original.length} 字节`);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
    fail++;
  }
}

// 选一个真实存在的、当前未被覆盖的 row 做测试
const before = stateMod.parsePatch(yamlLib, patchFile);
const targetId = [...before.rows.keys()].find((id) => {
  const r = before.rows.get(id);
  return r.disabled === null && !r.dynamicDisabled;
});
console.log(`测试目标 row: ${targetId}（原始 disabled=${before.rows.get(targetId)?.disabled}）`);

console.log('\n--- 1. 禁用 ---');
const r1 = writerMod.setEnabled({
  yamlLib,
  patchFile,
  backupDir,
  rowId: targetId,
  enabled: false,
  note: '(测试)',
  verify: (id, want) => {
    const re = stateMod.parsePatch(yamlLib, patchFile);
    const row = re.rows.get(id);
    return { ok: row && (row.disabled !== true) === want, error: `实际 disabled=${row?.disabled}` };
  },
});
check('写入返回成功', r1.ok === true, r1.error);
check('生成了备份文件', Boolean(r1.backupPath) && fs.existsSync(r1.backupPath));

const afterDisable = stateMod.parsePatch(yamlLib, patchFile);
check(`row ${targetId} 现在被禁用`, afterDisable.rows.get(targetId)?.disabled === true);

const textAfterDisable = fs.readFileSync(patchFile, 'utf8');
check(
  '原有内容完整保留（写后内容以原内容开头）',
  textAfterDisable.startsWith(original),
  `原 ${original.length} 字节 / 现 ${textAfterDisable.length} 字节`
);
check(
  '只追加了预期长度',
  textAfterDisable.length > original.length,
  `新增 ${textAfterDisable.length - original.length} 字节`
);
console.log('  追加的内容:');
for (const line of textAfterDisable.slice(original.length).split('\n')) {
  if (line.trim()) console.log(`    | ${line}`);
}

console.log('\n--- 2. 重新启用 ---');
const r2 = writerMod.setEnabled({
  yamlLib,
  patchFile,
  backupDir,
  rowId: targetId,
  enabled: true,
  note: '(测试恢复)',
  verify: (id, want) => {
    const re = stateMod.parsePatch(yamlLib, patchFile);
    const row = re.rows.get(id);
    return { ok: row && (row.disabled !== true) === want, error: `实际 disabled=${row?.disabled}` };
  },
});
check('写入返回成功', r2.ok === true, r2.error);

const afterEnable = stateMod.parsePatch(yamlLib, patchFile);
check(`row ${targetId} 现在已启用`, afterEnable.rows.get(targetId)?.disabled === false);

console.log('\n--- 3. 后写覆盖先写的验证 ---');
check(
  '文件里该 row 出现两次（先禁用后启用）',
  (fs.readFileSync(patchFile, 'utf8').match(new RegExp(`- id: ${targetId}\\b`, 'g')) || []).length >= 2
);
check(
  '最终状态取最后一条（启用）',
  afterEnable.rows.get(targetId)?.disabled === false
);

console.log('\n--- 4. 备份保留策略 ---');
const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('cordis.patch.yml.bak-'));
check(`备份目录有 ${backups.length} 份文件`, backups.length >= 2);

console.log('\n--- 5. 损坏文件的保护 ---');
const badFile = path.join(tmpDir, 'bad.yml');
fs.writeFileSync(badFile, '- id: x\n   bad_indent: [unclosed\n', 'utf8');
const r3 = writerMod.setEnabled({
  yamlLib,
  patchFile: badFile,
  backupDir,
  rowId: 'x',
  enabled: false,
  verify: () => ({ ok: true }),
});
check('拒绝写入已损坏的文件', r3.ok === false, r3.error?.slice(0, 60));
check(
  '损坏文件未被改动',
  fs.readFileSync(badFile, 'utf8') === '- id: x\n   bad_indent: [unclosed\n'
);

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
console.log(`临时目录（可删除）: ${tmpDir}`);
process.exit(fail > 0 ? 1 : 0);
