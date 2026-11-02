'use strict';
/**
 * launcher.js —— 带崩溃检测的 DSH 启动器
 *
 * 这是整个程序最核心的痛点解决方案：
 *
 *   你原来的流程是「DSH 起不来 → 手动去改配置文件禁用最新插件 → 再试」，
 *   循环往复，非常麻烦。
 *
 *   现在由程序接管启动动作，并盯着启动结果：
 *     - 进程异常退出（非 0 退出码）→ 判定启动失败
 *     - 失败时告诉界面"是刚才启动的，失败了，退出了 N 秒"
 *     - 界面弹出救援面板，按安装时间倒序列出最近的插件
 *     - 一键禁用后可以再点启动
 *
 * 为什么不检查"窗口是否出现"：
 *   Electron 应用启动后主进程常驻，但窗口渲染失败也会退出码 0。
 *   退出码只能确定"进程崩了"，不能确定"界面可用"。
 *   所以这里判定的是"进程是否异常退出"，这是可靠且不误报的判据；
 *   启动成功与否的最终确认仍然交给用户的眼睛，程序不猜。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 找 DSH 可执行文件。 */
function findDshExe() {
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'DeepSeek Harness',
      'DeepSeek Harness.exe'
    ),
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    'C:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 启动 DSH 并观察一段时间。
 *
 * @param {object} opts
 *   watchMs   观察时长（默认 25 秒）
 *   onEvent   进度回调 (event) => void
 *             { phase: 'started'|'running'|'exited'|'timeout', ... }
 * @returns {Promise<{ok:boolean, reason?:string, exitCode?:number, elapsedMs?:number, exe?:string}>}
 */
function launchAndWatch(opts = {}) {
  // 默认观察 180 秒。
  // 这个值不是拍脑袋定的：插件装得多的机器，DSH 光启动到弹界面
  // 就要一分多钟，期间进程稳稳活着。观察期短于这个时长，
  // 正常的慢启动会被误判成"还没起来"，救援面板乱弹反而添乱。
  const watchMs = opts.watchMs || 120000;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const exe = findDshExe();
  if (!exe) {
    return Promise.resolve({
      ok: false,
      reason: 'not-found',
      message: '找不到 DeepSeek Harness.exe，请确认已安装桌面版 DSH',
    });
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    let child;
    try {
      // detached + unref：DSH 是常驻桌面程序，我们只要知道它有没有立刻崩，
      // 不应该把自己变成它的父进程管理者。
      child = spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: 'spawn-failed',
        message: `启动失败：${err.message}`,
        exe,
      });
      return;
    }

    child.unref();
    onEvent({ phase: 'started', pid: child.pid, exe });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(probe);
      onEvent({
        phase: result.ok ? 'running' : 'exited',
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
      resolve(result);
    };

    // 进程退出：这是崩溃的可靠信号
    child.on('exit', (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      // code=0 且启动后存活超过一段时间 → 视为正常（用户主动关掉也算）
      if (code === 0 && elapsedMs > 4000) {
        finish({ ok: true, reason: 'user-closed', exitCode: code, elapsedMs, exe });
        return;
      }
      finish({
        ok: false,
        reason: code === 0 ? 'exited-early' : 'crashed',
        exitCode: code,
        signal,
        elapsedMs,
        exe,
        message:
          code === 0
            ? `进程启动后 ${(elapsedMs / 1000).toFixed(1)} 秒就退出了（退出码 0）`
            : `进程异常退出，退出码 ${code}`,
      });
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        reason: 'error',
        message: `启动出错：${err.message}`,
        exe,
        elapsedMs: Date.now() - startedAt,
      });
    });

    // 存活观察：detached 的子进程拿不到可靠的 exit 事件，
    // 用 tasklist 主动确认它还活着。
    const probe = setInterval(() => {
      if (settled) return;
      const alive = isProcessAlive(child.pid);
      if (!alive) {
        finish({
          ok: false,
          reason: 'crashed',
          elapsedMs: Date.now() - startedAt,
          exe,
          message: `进程启动后 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒消失，判定启动失败`,
        });
      }
    }, 1500);

    // 观察期结束还活着 → 认为启动成功
    const timer = setTimeout(() => {
      if (settled) return;
      const alive = isProcessAlive(child.pid);
      if (alive) {
        finish({
          ok: true,
          reason: 'survived',
          elapsedMs: Date.now() - startedAt,
          exe,
        });
      } else {
        finish({
          ok: false,
          reason: 'crashed',
          elapsedMs: Date.now() - startedAt,
          exe,
          message: '进程在观察期内退出，判定启动失败',
        });
      }
    }, watchMs);
  });
}

/** 用 tasklist 判断某 PID 是否还活着。 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      windowsHide: true,
      timeout: 4000,
    });
    const text = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
    return text.includes(String(pid));
  } catch {
    return false;
  }
}

/**
 * 选出"最可能是罪魁祸首"的插件：按安装时间倒序，取前 N 个。
 * 你最近在开发插件，坏插件几乎总是刚装/刚改的那个。
 */
function suspectPlugins(items, limit = 3) {
  return [...items]
    .filter((i) => !i.missing)
    .sort((a, b) => b.installMs - a.installMs)
    .slice(0, limit)
    .map((i) => ({
      name: i.name,
      version: i.version,
      installMs: i.installMs,
      isLinked: i.isLinked,
      enabled: i.enabled,
      rowIds: i.rowIds,
    }));
}

module.exports = { launchAndWatch, findDshExe, isProcessAlive, suspectPlugins };
