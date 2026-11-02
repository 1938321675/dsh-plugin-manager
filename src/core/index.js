'use strict';
/**
 * index.js —— 数据聚合层
 *
 * 把 plugins / state / writer 三个模块拼成界面直接可用的结构。
 * 这里也是唯一判定"该禁哪个 row"的地方，界面只管显示和发指令。
 */

const fs = require('fs');
const path = require('path');

const pluginsMod = require('./plugins');
const stateMod = require('./state');
const writerMod = require('./writer');
const yamlLibMod = require('./yaml-lib');

/**
 * @param {object} opts  { profileDir, dataDir }
 */
function createService(opts) {
  const yamlLib = opts.yamlLib || yamlLibMod.load();
  const profileDir = opts.profileDir;
  const dataDir = opts.dataDir;
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const backupDir = path.join(dataDir, 'backups');
  const snapshotFile = path.join(dataDir, 'plugin-registry.json');

  function readSnapshot() {
    return pluginsMod.readJsonSafe(snapshotFile) || { version: 1, plugins: {} };
  }

  function writeSnapshot(snapshot) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = snapshotFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tmp, snapshotFile);
      return true;
    } catch {
      return false;
    }
  }

  /** 读 patch 并沿用同一份解析结果，避免反复 IO。 */
  function loadPatch() {
    return stateMod.parsePatch(yamlLib, patchFile);
  }

  /** 汇总所有插件 + 状态，返回界面用的大对象。 */
  function collect() {
    const listing = pluginsMod.listPlugins(profileDir);
    if (!listing.ok) {
      return { ok: false, error: listing.error };
    }

    const patch = loadPatch();
    const pkg = pluginsMod.readJsonSafe(path.join(profileDir, 'package.json')) || {};
    const snapshot = readSnapshot();

    // 更新快照（记录首次发现时间），只有变化时才落盘
    const merged = pluginsMod.mergeSnapshot(listing.plugins, snapshot);
    if (merged.changed) writeSnapshot(merged.snapshot);
    const effectiveSnapshot = merged.snapshot;

    const items = listing.plugins.map((p) => {
      const declaredRows = p.missing
        ? []
        : pluginsMod.readDeclaredRows(yamlLib, p.realDir);
      const state = stateMod.computeEnabled(p, declaredRows, patch, pkg);
      return {
        name: p.name,
        version: p.version,
        spec: p.spec,
        description: p.description,
        isLinked: p.isLinked,
        localPath: p.localPath,
        missing: p.missing,
        hasPatch: p.hasPatch,
        installMs: pluginsMod.sortKey(p, effectiveSnapshot),
        enabled: state.enabled,
        dynamic: state.dynamic,
        stateReason: state.reason,
        rowIds: state.rowIds,
        rowDetail: state.rowDetail,
      };
    });

    // 按安装时间倒序：最新的排最前面（最可能是坏插件的那一个）
    items.sort((a, b) => b.installMs - a.installMs);

    return {
      ok: true,
      profileDir,
      patchFile,
      patchExists: patch.exists,
      patchMtime: patch.mtimeMs || null,
      patchError: patch.error,
      patchEntryCount: patch.entryCount,
      pluginCount: items.length,
      enabledCount: items.filter((i) => i.enabled === true).length,
      disabledCount: items.filter((i) => i.enabled === false).length,
      dynamicCount: items.filter((i) => i.enabled === null).length,
      missingCount: items.filter((i) => i.missing).length,
      dshRunning: isDshRunning(),
      items,
    };
  }

  /** 当前 DSH 桌面进程是否在运行。 */
  function isDshRunning() {
    try {
      const { execFileSync } = require('child_process');
      // tasklist 的输出编码取决于系统代码页，中文系统下进程名可能是 ASCII，
      // 但为稳妥起见统一用 UTF-8 解码再判断，失败则退回 latin1
      const out = execFileSync(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH', '/FO', 'CSV'],
        { windowsHide: true, timeout: 5000 }
      );
      const text = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
      return /DeepSeek Harness\.exe/i.test(text);
    } catch {
      return null; // 探测不了就返回 null，界面显示"未知"
    }
  }

  /**
   * 切换一个插件的启停。
   * 校验方式是重新解析整份 patch，确认该 row 最终状态等于期望值——
   * 这样连"追加位置被后面的覆盖"这种隐蔽问题也能兜住。
   */
  function setPluginEnabled(name, enabled, rowIdOverride) {
    const listing = pluginsMod.listPlugins(profileDir);
    if (!listing.ok) return { ok: false, error: listing.error };

    const plugin = listing.plugins.find((p) => p.name === name);
    if (!plugin) return { ok: false, error: `未找到插件 ${name}` };
    if (plugin.missing) {
      return { ok: false, error: `插件 ${name} 未正确安装，无法修改状态` };
    }

    const patch = loadPatch();
    const declaredRows = pluginsMod.readDeclaredRows(yamlLib, plugin.realDir);
    const state = stateMod.computeEnabled(plugin, declaredRows, patch, {});

    // 决定写哪一条 row：
    //   - 显式指定优先
    //   - 否则取第一条"当前未被禁用"的 row（关掉它就能让插件停摆）
    //   - 全部已禁用时取第一条（用于重新启用）
    let targetId = rowIdOverride;
    if (!targetId) {
      const enabledRow = (state.rowDetail || []).find((d) => d.disabled !== true);
      targetId = enabledRow?.id || state.rowIds[0];
    }
    if (!targetId) {
      return {
        ok: false,
        error:
          `插件 ${name} 在 Loader 中没有独立 row（属于客户端插件或随宿主加载），` +
          `无法单独启停。它通常附属于其宿主插件。`,
      };
    }

    const result = writerMod.setEnabled({
      yamlLib,
      patchFile,
      backupDir,
      rowId: targetId,
      enabled,
      note: `(${name})`,
      verify: (id, want) => {
        // 重新解析整份文件，取该 id 最后一条的 disabled
        const recheck = stateMod.parsePatch(yamlLib, patchFile);
        if (!recheck.ok) return { ok: false, error: recheck.error };
        const row = recheck.rows.get(id);
        if (!row) return { ok: false, error: `写入后找不到 row ${id}` };
        const actual = row.disabled !== true;
        if (actual !== want) {
          return { ok: false, error: `row ${id} 实际状态为 ${actual}，期望 ${want}` };
        }
        return { ok: true };
      },
    });

    return { ...result, rowId: targetId };
  }

  return { collect, setPluginEnabled, patchFile, backupDir, profileDir };
}

module.exports = { createService };
