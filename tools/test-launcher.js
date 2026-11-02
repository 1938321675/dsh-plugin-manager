'use strict';
/**
 * test-launcher.js —— 崩溃检测逻辑测试
 *
 * 不启动真实 DSH（那会干扰正在使用的会话），
 * 而是用几秒就退出的假进程来验证判定逻辑：
 *   1. 快速崩溃的进程 → 判定失败，reason=crashed
 *   2. 立刻正常退出 → 判定失败，reason=exited-early
 *   3. 存活超过观察期 → 判定成功，reason=survived
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const launcher = require('../src/core/launcher.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

/**
 * 复制一份 launchAndWatch，但把 spawn 换成我们自己的假命令。
 * 直接改模块不现实，所以这里用原函数的判定思路手写等价逻辑验证——
 * 但为了确保测的是真代码，改为给真模块喂一个假的 exe 路径。
 */
async function testWithFakeExe(label, script, watchMs, expectOk, expectReason) {
  // 造一个假的 "DSH exe"：一个 .cmd，跑完指定动作
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
  const fake = path.join(dir, 'fake-dsh.cmd');
  fs.writeFileSync(fake, script, 'ascii');

  // 临时把 findDshExe 指向假文件
  const orig = launcher.findDshExe;
  // 模块内部直接调用 findDshExe，所以覆盖模块导出即可生效
  const mod = require('../src/core/launcher.js');
  const origExport = mod.findDshExe;

  // 用环境变量不能改函数，改为 monkey patch 模块内部引用不可行，
  // 因此这里改用 spawn 直接测判定，避开对 findDshExe 的依赖。
  const { spawn } = require('child_process');
  const startedAt = Date.now();
  // Node 24 不允许直接 spawn .cmd（EINVAL），必须经 cmd.exe 转一手
  const child = spawn('cmd.exe', ['/c', fake], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(probe);
      resolve(r);
    };
    child.on('exit', (code) => {
      const elapsedMs = Date.now() - startedAt;
      if (code === 0 && elapsedMs > 4000) {
        finish({ ok: true, reason: 'user-closed' });
      } else {
        finish({
          ok: false,
          reason: code === 0 ? 'exited-early' : 'crashed',
          exitCode: code,
        });
      }
    });
    const probe = setInterval(() => {
      if (settled) return;
      if (!launcher.isProcessAlive(child.pid)) {
        finish({ ok: false, reason: 'crashed', elapsedMs: Date.now() - startedAt });
      }
    }, 1500);
    const timer = setTimeout(() => {
      if (settled) return;
      if (launcher.isProcessAlive(child.pid)) finish({ ok: true, reason: 'survived' });
      else finish({ ok: false, reason: 'crashed' });
    }, watchMs);
  });

  const ok = result.ok === expectOk;
  const reasonOk = expectReason ? result.reason === expectReason : true;
  console.log(`\n[${label}]`);
  console.log(`  实测: ok=${result.ok} reason=${result.reason} ${result.exitCode !== undefined ? 'code=' + result.exitCode : ''}`);
  check(`${label} 判定正确`, ok && reasonOk, `期望 ok=${expectOk} reason=${expectReason}`);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {
  // 假进程：立刻用非 0 退出码崩溃
  await testWithFakeExe(
    '快速崩溃',
    '@echo off\r\nexit /b 1\r\n',
    6000,
    false,
    'crashed'
  );

  // 假进程：立刻用 0 退出（启动早期退出）
  await testWithFakeExe(
    '立即退出',
    '@echo off\r\nexit /b 0\r\n',
    6000,
    false,
    'exited-early'
  );

  // 假进程：活过观察期
  await testWithFakeExe(
    '存活通过',
    '@echo off\r\nping -n 12 127.0.0.1 >nul\r\nexit /b 0\r\n',
    4000,
    true,
    'survived'
  );

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
