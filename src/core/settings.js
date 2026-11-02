'use strict';
/**
 * settings.js —— 程序设置的读写
 *
 * 目前只有一项：启动 DSH 的观察时长。
 *
 * 为什么这项要可配置：
 *   观察时长决定"多久没崩就算启动成功"。这个值和机器强相关：
 *   插件装得多、磁盘慢的机器，DSH 光启动就要一分多钟才弹界面。
 *   定得太短会把正常启动误判成崩溃，然后弹救援面板——
 *   那比不检测更糟，用户会以为真的坏了。
 *
 * 默认值取 120 秒，理由同上：宁可多等，也不要误报。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  /**
   * 启动观察时长（秒）。
   *
   * 180 秒是根据实际机器定的：本机插件装得多，DSH 从点击到弹出界面
   * 要一分半左右，期间进程稳定存活。观察期短于这个时长，
   * 正常启动会被误判成"还没起来"，救援面板就会乱弹。
   */
  launchTimeoutSec: 180,
};

/** 合理区间：太短没意义，太长用户以为卡死 */
const MIN_SEC = 10;
const MAX_SEC = 600;

function settingsFile(dataDir) {
  return path.join(dataDir, 'settings.json');
}

/** 把任意输入规整成合法秒数，非法值回落到默认。 */
function normalizeSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.launchTimeoutSec;
  const sec = Math.round(n);
  if (sec < MIN_SEC) return MIN_SEC;
  if (sec > MAX_SEC) return MAX_SEC;
  return sec;
}

/** 读取设置；文件不存在或损坏时返回默认值，不抛错。 */
function load(dataDir) {
  const file = settingsFile(dataDir);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = null;
  }
  return {
    launchTimeoutSec: normalizeSec(
      raw && raw.launchTimeoutSec != null
        ? raw.launchTimeoutSec
        : DEFAULTS.launchTimeoutSec
    ),
    // 让界面知道边界，输入框才好做校验提示
    minSec: MIN_SEC,
    maxSec: MAX_SEC,
  };
}

/** 保存设置，返回保存后的完整设置。 */
function save(dataDir, patch) {
  const current = load(dataDir);
  const next = {
    launchTimeoutSec:
      patch && patch.launchTimeoutSec != null
        ? normalizeSec(patch.launchTimeoutSec)
        : current.launchTimeoutSec,
  };

  const file = settingsFile(dataDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* 写不进去就返回内存里的值，界面仍能本次生效 */
  }

  return load(dataDir);
}

module.exports = { load, save, normalizeSec, DEFAULTS, MIN_SEC, MAX_SEC };
