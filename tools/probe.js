'use strict';
/**
 * probe.js —— 只读验证脚本（不写任何文件）
 * 用真实 profile 数据跑一遍聚合逻辑，输出与运行中 DSH 的实测结果比对。
 */

const path = require('path');
const { createService } = require('../src/core/index.js');

const HOMEDIR = require('os').homedir();
const profileDir = path.join(HOMEDIR, '.dsh', 'profiles', 'desktop');
const dataDir = path.join(__dirname, '..', 'data');

const svc = createService({ profileDir, dataDir });
const data = svc.collect();

if (!data.ok) {
  console.error('FAILED:', data.error);
  process.exit(1);
}

console.log('profile         :', data.profileDir);
console.log('patch 文件      :', data.patchFile);
console.log('patch 存在      :', data.patchExists);
console.log('patch 解析错误  :', data.patchError || '(无)');
console.log('patch 顶层条目  :', data.patchEntryCount);
console.log('DSH 运行中      :', data.dshRunning);
console.log('插件总数        :', data.pluginCount);
console.log('  已启用        :', data.enabledCount);
console.log('  已禁用        :', data.disabledCount);
console.log('  动态表达式    :', data.dynamicCount);
console.log('  安装缺失      :', data.missingCount);
console.log('');
console.log('=== 按安装时间倒序 ===');
for (const it of data.items) {
  const when =
    it.installMs >= 1e12
      ? new Date(it.installMs).toISOString().slice(0, 16).replace('T', ' ')
      : '(未知)';
  const flag = it.missing ? 'MISS' : it.enabled === true ? ' ON ' : it.enabled === false ? 'OFF ' : 'DYN ';
  console.log(`${flag} ${when.padEnd(16)} ${String(it.version || '-').padEnd(11)} ${it.name}`);
  console.log(`     row: ${it.rowIds.length ? it.rowIds.join(',') : '-'}`);
  console.log(`     依据: ${it.stateReason}`);
}
