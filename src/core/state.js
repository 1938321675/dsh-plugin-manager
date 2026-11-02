'use strict';
/**
 * state.js —— 计算每个插件的启停状态
 *
 * ## 关键背景：row 的 disabled 来自两层
 *
 * Loader 的条目是分层组装出来的：
 *
 *   第一层  各 bundle 自带的 cordis.patch.yml   ← 插件在此 insert 自己的 row
 *   第二层  profile/cordis.patch.yml            ← 用户/工具在此覆盖或禁用
 *
 * 两层的语义都是"后写的覆盖先写的"。所以一个 row 的最终状态是：
 *
 *   插件自带 patch 里给的 disabled  ← 被 profile patch 里同 id 的 disabled 覆盖
 *
 * 只读 profile patch 是不够的。反例：dsh-ops 在自己 patch 里就把
 * panel / tui / hide-official 三条设成 disabled: true，
 * 只读 profile patch 会把这几个误判成"已启用"。
 *
 * ## 实测校准
 *
 * 已用运行中的 DSH 交叉验证：profile patch 里 tool-fs 先写
 * disabled: false 再写 disabled: true，运行时确实是禁用 ——
 * 证实"同文件内后写覆盖先写"。
 */

const fs = require('fs');
const path = require('path');

/**
 * 解析 patch 文件，返回 row 累积状态表。
 *
 * rows: Map<rowId, {
 *   id, name, disabled, dynamicDisabled, owned
 * }>
 *   disabled         true / false / null（null = 从未显式声明）
 *   dynamicDisabled  !!js 表达式原文，非空时 disabled 无意义
 *   owned            是否由 insert 新建（而非仅覆盖 config）
 */
function parsePatch(yamlLib, patchFile) {
  const result = {
    ok: false,
    exists: false,
    rows: new Map(),
    entryCount: 0,
    error: null,
    patchFile,
    mtimeMs: null,
    size: null,
  };

  let stat;
  try {
    stat = fs.statSync(patchFile);
    result.exists = true;
    result.mtimeMs = stat.mtimeMs;
    result.size = stat.size;
  } catch {
    return result;
  }

  let doc;
  try {
    doc = yamlLib.parse(fs.readFileSync(patchFile, 'utf8'));
  } catch (err) {
    result.error = `YAML 解析失败：${err.message}`;
    return result;
  }

  if (doc == null) {
    result.ok = true;
    return result;
  }
  if (!Array.isArray(doc)) {
    result.error = 'patch 文件顶层不是数组';
    return result;
  }

  result.entryCount = doc.length;

  // 顺序遍历，"后来覆盖先来"由 Map.set 天然实现
  doc.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;

    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) {
        if (row && typeof row === 'object' && row.id) {
          applyRow(result.rows, String(row.id), row, true);
        }
      }
      return;
    }

    if (entry.id) {
      applyRow(result.rows, String(entry.id), entry, false);
    }
  });

  result.ok = true;
  return result;
}

/**
 * 把一行 patch 合并进累积状态。
 *
 * 只有明确带 disabled 字段才更新禁用状态——
 * 不带该字段的 patch（例如只改 config）不应该把启用状态重置。
 * 这是 Cordis patch 的语义：字段级替换，不是整行替换。
 */
function applyRow(rows, id, row, fromInsert) {
  const prev = rows.get(id) || {
    id,
    name: null,
    disabled: null,
    dynamicDisabled: null,
    owned: false,
  };
  const next = { ...prev };

  if (fromInsert) next.owned = true;
  if (row.name) next.name = String(row.name);

  if (Object.prototype.hasOwnProperty.call(row, 'disabled')) {
    const d = row.disabled;
    if (typeof d === 'boolean') {
      next.disabled = d;
      next.dynamicDisabled = null;
    } else if (
      d != null &&
      typeof d === 'object' &&
      typeof d.__jsExpression === 'string'
    ) {
      // !!js 动态表达式：静态读不出真假
      next.disabled = null;
      next.dynamicDisabled = d.__jsExpression;
    }
  }
  rows.set(id, next);
}

/**
 * 计算一个插件是否启用。
 *
 * 合并顺序：先吃插件自带 patch 的默认值，再让 profile patch 覆盖。
 *
 * ## 多 row 插件的判定（这里有个真实踩过的坑）
 *
 * 有些插件会插入多条 row，其中一部分默认就是关的。
 * 例如 dsh-ops 插 7 条，panel / tui / hide-official 三条默认 disabled: true——
 * 那是它自己的可选功能默认关闭，不代表整个插件被用户禁用了。
 *
 * 所以判定规则是：
 *   - **profile patch 明确禁用**了它的 row → 判定为已禁用（这是用户的意图）
 *   - 只有插件自带 patch 里默认关的 row → 仍算启用，但在详情里如实列出
 *   - 全部 row（含默认关的）都处于关闭 → 才算已禁用
 *
 * 否则用户会看到"dsh-ops 被禁用了"却完全没关过它，直接困惑。
 *
 * @param {object} plugin             listPlugins 产出的插件对象
 * @param {Array}  declaredRows       [{id, disabled}] 来自插件自带 patch
 * @param {object} profilePatch       parsePatch 的结果（profile 层）
 * @param {object} pkg                profile 的 package.json
 */
function computeEnabled(plugin, declaredRows, profilePatch, pkg) {
  const rows = declaredRows || [];
  const details = [];
  let dynamicNote = null;
  let explicitDisable = null; // profile 层明确禁用
  let allDisabled = rows.length > 0;

  for (const decl of rows) {
    const id = decl.id;

    // 第一层：插件自带 patch 给的默认值（代表插件的出厂设计）
    let effective = decl.disabled;
    let source = '插件自带';
    let fromProfile = false;

    // 第二层：profile patch 覆盖（代表用户/本工具的操作）
    const override = profilePatch.rows.get(id);
    if (override) {
      if (override.dynamicDisabled) {
        dynamicNote = override.dynamicDisabled;
        details.push({
          id,
          disabled: null,
          defaultDisabled: decl.disabled === true,
          note: `profile 中为动态表达式：${override.dynamicDisabled}`,
        });
        allDisabled = false;
        continue;
      }
      if (override.disabled !== null) {
        effective = override.disabled;
        source = 'profile patch';
        fromProfile = true;
      }
    }

    if (effective === true) {
      if (fromProfile) explicitDisable = explicitDisable || id;
      details.push({
        id,
        disabled: true,
        defaultDisabled: decl.disabled === true,
        note: fromProfile ? '禁用（profile patch）' : '禁用（插件自带默认）',
      });
    } else {
      allDisabled = false;
      details.push({
        id,
        disabled: false,
        defaultDisabled: decl.disabled === true,
        note: effective === false ? `启用（${source}）` : '默认启用',
      });
    }
  }

  const rowIds = rows.map((d) => d.id);
  const optionalOff = details.filter(
    (d) => d.defaultDisabled && d.disabled !== false
  );

  // 1. profile 层明确禁用 → 这是用户意图，直接算已禁用
  if (explicitDisable) {
    return {
      enabled: false,
      reason: `row ${explicitDisable} 已被禁用`,
      rowIds,
      rowDetail: details,
      dynamic: false,
    };
  }

  // 2. 动态表达式决定了主 row 的状态
  if (dynamicNote) {
    return {
      enabled: null,
      reason: `状态由动态表达式决定：${dynamicNote}`,
      rowIds,
      rowDetail: details,
      dynamic: true,
    };
  }

  // 3. 包名级禁用列表
  if (plugin.inProfileDisabledList) {
    return {
      enabled: false,
      reason: 'package.json 的 dsh.profile.disabled 中列出',
      rowIds,
      rowDetail: details,
      dynamic: false,
    };
  }

  // 4. 所有 row 都关掉了 → 整个插件停摆
  if (rows.length > 0 && allDisabled) {
    return {
      enabled: false,
      reason: '全部 row 均已禁用',
      rowIds,
      rowDetail: details,
      dynamic: false,
    };
  }

  // 5. 其余情况算启用；若插件自带若干可选 row 默认关闭，如实标注
  let reason;
  if (!rows.length) {
    reason = '无独立 row（客户端插件/随宿主加载）';
  } else if (optionalOff.length) {
    reason = `已启用（${optionalOff.length} 个可选功能默认关闭：${optionalOff
      .map((d) => d.id)
      .join('、')}）`;
  } else {
    reason = '已启用';
  }

  return { enabled: true, reason, rowIds, rowDetail: details, dynamic: false };
}

module.exports = { parsePatch, computeEnabled };
