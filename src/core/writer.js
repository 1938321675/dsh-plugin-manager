'use strict';
/**
 * writer.js —— 追加式写入插件启停状态
 *
 * 设计原则（这是整个程序最需要保守的地方）：
 *
 *   1. 只追加，不重写。
 *      现有 patch 文件有 66 条记录、1086 行、含深层嵌套的 model catalog，
 *      用 YAML 序列化器整份重写会改变格式、丢注释、甚至在解析不完美时丢内容。
 *      追加一条 `- id: x / disabled: true` 依赖"后写覆盖先写"语义，
 *      对文件其余部分字节级零影响。
 *
 *   2. 写前备份、写后回读校验。
 *      校验读回来的状态确实是期望值，否则用备份还原。
 *
 *   3. 只改一个 id 的一条记录，不做批量。
 *      一次操作一个插件，出问题好定位，也好回退。
 */

const fs = require('fs');
const path = require('path');

const MARKER = '# --- dsh-plugin-manager';

/** 生成追加到 patch 文件末尾的一段文本。 */
function buildEntry(rowId, enabled, note) {
  const stamp = formatStamp(new Date());
  const lines = [
    '',
    `${MARKER} ${stamp}${note ? ' ' + note : ''} ---`,
    `- id: ${rowId}`,
    `  disabled: ${enabled ? 'false' : 'true'}`,
  ];
  return lines.join('\n') + '\n';
}

function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function timestampForFile(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 备份 patch 文件到 backupDir，返回备份路径。 */
function backup(patchFile, backupDir, keep = 20) {
  if (!fs.existsSync(patchFile)) return null;
  fs.mkdirSync(backupDir, { recursive: true });

  // 同一秒内可能连续操作两次，必须防重名，否则第二份会覆盖第一份
  const base = `cordis.patch.yml.bak-${timestampForFile(new Date())}`;
  let target = path.join(backupDir, base);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(backupDir, `${base}-${n}`);
    n++;
  }
  fs.copyFileSync(patchFile, target);

  // 只保留最近 keep 份，避免无限堆积
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('cordis.patch.yml.bak-'))
      .map((f) => ({
        f,
        ms: fs.statSync(path.join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.ms - a.ms);
    for (const stale of files.slice(keep)) {
      fs.unlinkSync(path.join(backupDir, stale.f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }

  return target;
}

/**
 * 严格校验一个 patch 文件是否"可以安全地在末尾追加"。
 *
 * 为什么不能只 try/catch yaml.parse：
 * 有些畸形内容 yaml 库不抛异常而是宽容接受（例如重复键、
 * 部分缩进错乱会被当成嵌套）。这里再加两道结构检查：
 *   1. 必须能解析出数组（顶层必须是 patch 列表）
 *   2. 每个条目必须带 id 或 insert，否则说明结构已经不对了
 */
function checkParsable(yamlLib, patchFile) {
  let text;
  try {
    text = fs.readFileSync(patchFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `读取失败：${err.message}` };
  }

  // 全空白文件视为空列表，允许追加
  if (!text.trim()) return { ok: true };

  let doc;
  try {
    doc = yamlLib.parse(text);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (doc == null) return { ok: true };
  if (!Array.isArray(doc)) {
    return { ok: false, error: '顶层不是数组，不是有效的 patch 层' };
  }

  for (let i = 0; i < doc.length; i++) {
    const e = doc[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: `第 ${i + 1} 个条目不是映射结构` };
    }
    if (!e.id && !Array.isArray(e.insert)) {
      return {
        ok: false,
        error: `第 ${i + 1} 个条目既没有 id 也没有 insert，结构可疑`,
      };
    }
  }

  return { ok: true };
}

/**
 * 设置某个 row 的启停状态。
 *
 * @param {object} opts
 *   yamlLib       yaml 解析库
 *   patchFile     cordis.patch.yml 路径
 *   backupDir     备份目录
 *   rowId         要操作的 Loader row id
 *   enabled       true=启用，false=禁用
 *   verify        校验函数 (rowId, enabled) => boolean
 *   note          追加到注释里的说明
 * @returns {{ok:boolean, backupPath?:string, error?:string}}
 */
function setEnabled(opts) {
  const { yamlLib, patchFile, backupDir, rowId, enabled, verify, note } = opts;

  if (!rowId || typeof rowId !== 'string') {
    return { ok: false, error: '缺少 rowId' };
  }

  // 1. 确认文件当前能正常解析——解析不了就别动，避免雪上加霜
  if (fs.existsSync(patchFile)) {
    const guard = checkParsable(yamlLib, patchFile);
    if (!guard.ok) {
      return {
        ok: false,
        error:
          `现有 patch 文件已无法安全解析，为安全起见不写入：${guard.error}\n` +
          `请先手工修复该文件（备份在 ${backupDir}）`,
      };
    }
  }

  // 2. 备份
  let backupPath = null;
  try {
    backupPath = backup(patchFile, backupDir);
  } catch (err) {
    return { ok: false, error: `备份失败，已中止写入：${err.message}` };
  }

  // 3. 追加
  const before = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const addition = buildEntry(rowId, enabled, note);
  // 文件末尾没有换行时补一个，避免把新内容和上一行粘在一起
  const sep = before.length && !before.endsWith('\n') ? '\n' : '';

  try {
    fs.writeFileSync(patchFile, before + sep + addition, 'utf8');
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}`, backupPath };
  }

  // 4. 回读校验
  let verdict;
  try {
    verdict = verify(rowId, enabled);
  } catch (err) {
    verdict = { ok: false, error: `校验异常：${err.message}` };
  }

  if (!verdict || verdict.ok !== true) {
    // 校验没过 → 用备份还原，绝不让用户处于"改坏了且不知道"的状态
    let restored = false;
    try {
      if (backupPath) {
        fs.copyFileSync(backupPath, patchFile);
        restored = true;
      } else {
        fs.writeFileSync(patchFile, before, 'utf8');
        restored = true;
      }
    } catch {
      restored = false;
    }
    return {
      ok: false,
      backupPath,
      error:
        `写入后校验失败${restored ? '，已还原为写入前的内容' : '，且自动还原失败'}：` +
        (verdict?.error || '状态与预期不符'),
    };
  }

  return { ok: true, backupPath, addition };
}

module.exports = { setEnabled, checkParsable, buildEntry, backup, formatStamp };
