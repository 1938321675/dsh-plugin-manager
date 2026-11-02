'use strict';
/**
 * plugins.js —— 第三方插件发现
 *
 * 数据源优先级（每个字段都用最可靠的那个）：
 *   1. profile/package.json 的 dependencies  → 插件清单的权威来源
 *   2. node_modules/<name> 真实目录          → 版本、link 目标、缺失判定
 *   3. 目录创建时间 + 本地首次发现快照        → 安装时间的稳定排序键
 *
 * 为什么要快照：重跑 pnpm install 或升级插件会重写目录，CreationTime 随之刷新，
 * 历史顺序就被打乱了。快照记录"本地第一次见到这个插件是什么时候"，之后只认它。
 */

const fs = require('fs');
const path = require('path');

const DAY = new Date('2000-01-01T00:00:00Z').getTime();

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * 解析依赖声明里的本地路径，例如：
 *   link:../../boot-timer          → <profile>/../../boot-timer
 *   file:./ofm-tarballs/x.tgz      → <profile>/ofm-tarballs/x.tgz
 * 返回绝对路径；非本地声明返回 null。
 */
function resolveLocalSpec(spec, profileDir) {
  if (typeof spec !== 'string') return null;
  const m = /^(?:link|file):(.+)$/i.exec(spec.trim());
  if (!m) return null;
  return path.resolve(profileDir, m[1]);
}

/**
 * 列出所有第三方插件。
 * 所谓"第三方"= profile/package.json 里 dependencies 声明的全部包，
 * 排除 @deepseek-ai/ 官方命名空间（那是 DSH 自带内核，不属于用户安装的插件）。
 */
function listPlugins(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJsonSafe(pkgFile);
  if (!pkg || !pkg.dependencies) {
    return { ok: false, error: `无法读取或解析 ${pkgFile}`, plugins: [] };
  }

  const nm = path.join(profileDir, 'node_modules');
  const disabledList = new Set(
    Array.isArray(pkg.dsh?.profile?.disabled) ? pkg.dsh.profile.disabled : []
  );

  const plugins = [];
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    // 官方内核包不算第三方插件
    if (name.startsWith('@deepseek-ai/')) continue;

    const installedDir = path.join(nm, name);
    const localDir = resolveLocalSpec(spec, profileDir);
    const realDir = localDir && fs.existsSync(localDir) ? localDir : installedDir;

    const installedStat = statSafe(installedDir);
    const realStat = statSafe(realDir);
    const manifest = readJsonSafe(path.join(realDir, 'package.json'));

    const missing = !installedStat && !realStat;
    const isLinked = Boolean(localDir);

    // 安装时间：优先用 node_modules 里的目录创建时间（pnpm 建链接的时刻），
    // 退回真实目录的创建时间
    const createdMs = installedStat
      ? installedStat.birthtimeMs || installedStat.ctimeMs
      : realStat
        ? realStat.birthtimeMs || realStat.ctimeMs
        : null;

    plugins.push({
      name,
      spec,
      version: manifest?.version || null,
      description: manifest?.description || '',
      isLinked,
      localPath: isLinked ? realDir : null,
      missing,
      createdMs,
      realDir,
      inProfileDisabledList: disabledList.has(name),
      hasManifest: Boolean(manifest),
      hasPatch: fs.existsSync(path.join(realDir, 'cordis.patch.yml')),
    });
  }

  return { ok: true, plugins, pkgFile, profileDir };
}

/**
 * 读出这个包作为 bundle 会"新建"哪些 row，以及它自己给的初始 disabled 值。
 *
 * 只认 `insert` 块里的 row —— 那才是 patch 新建的条目。
 * 不带 insert 的 `- id: xxx` 是"覆盖已有条目的 config"，不是自己新建的 row。
 *
 * 反例（真实踩过的坑）：dsh-unlag 的 patch 里有一段
 *     - id: hmr
 *       config: { base: !!js ..., root: [] }
 * 它只是把 DSH 内核热重载插件 hmr 的配置改掉，hmr 属于内核，
 * 如果把这种覆盖也算进它的 row，界面就会显示错误归属。
 *
 * 为什么还要读 disabled：有的包在自己的 patch 里就把部分 row 关掉了。
 * 例如 dsh-ops 的 panel / tui / hide-official 三条都是 disabled: true。
 * 只读 profile patch 会漏掉这层默认值，把它们误显示成"已启用"。
 *
 * 返回 [{ id, disabled }]，disabled 为 true/false/null（null=未声明）或 {expression}。
 */
function readDeclaredRows(yamlLib, realDir) {
  const patchFile = path.join(realDir, 'cordis.patch.yml');
  const st = statSafe(patchFile);
  if (!st) return [];
  let doc;
  try {
    doc = yamlLib.parse(fs.readFileSync(patchFile, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];

  const map = new Map();
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Array.isArray(entry.insert)) continue;
    for (const row of entry.insert) {
      if (!row || typeof row !== 'object' || !row.id) continue;
      const id = String(row.id);
      const prev = map.get(id) || { id, disabled: null };
      if (Object.prototype.hasOwnProperty.call(row, 'disabled')) {
        prev.disabled = normalizeDisabled(row.disabled);
      }
      map.set(id, prev);
    }
  }
  return [...map.values()];
}

/** 把 disabled 字段规整成 true / false / null / {expression} */
function normalizeDisabled(d) {
  if (typeof d === 'boolean') return d;
  if (d == null) return null;
  if (typeof d === 'object' && typeof d.__jsExpression === 'string') {
    return { expression: d.__jsExpression };
  }
  return null;
}

/**
 * 安装顺序排序键：
 *   1. 快照里记录的首次发现时间（最稳定，重装也不变）
 *   2. 目录创建时间
 * 都取不到时排到最后。
 */
function sortKey(plugin, snapshot) {
  const seen = snapshot?.plugins?.[plugin.name]?.firstSeenMs;
  if (typeof seen === 'number' && seen > DAY) return seen;
  if (typeof plugin.createdMs === 'number' && plugin.createdMs > DAY) return plugin.createdMs;
  return Number.MAX_SAFE_INTEGER;
}

/** 更新快照：记录首次发现时间，返回新的快照对象（不写盘）。 */
function mergeSnapshot(plugins, snapshot) {
  const now = Date.now();
  const next = { version: 1, plugins: { ...(snapshot?.plugins || {}) } };
  let changed = false;

  for (const p of plugins) {
    const cur = next.plugins[p.name];
    if (!cur) {
      // 第一次见到：用它自己的目录创建时间做基准，取不到就用当前时间
      const base =
        typeof p.createdMs === 'number' && p.createdMs > DAY ? p.createdMs : now;
      next.plugins[p.name] = {
        firstSeenMs: base,
        firstSeenAt: new Date(base).toISOString(),
      };
      changed = true;
    } else if (p.version && cur.version !== p.version) {
      // 只记录版本变化，不动 firstSeenMs —— 这是"安装顺序"稳定的关键
      next.plugins[p.name] = { ...cur, version: p.version };
      changed = true;
    }
  }

  return { snapshot: next, changed };
}

module.exports = {
  listPlugins,
  readDeclaredRows,
  normalizeDisabled,
  sortKey,
  mergeSnapshot,
  readJsonSafe,
  statSafe,
  resolveLocalSpec,
};
