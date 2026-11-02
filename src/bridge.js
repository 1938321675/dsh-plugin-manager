'use strict';
/**
 * bridge.js —— PowerShell 与 Node 核心逻辑之间的桥
 *
 * 调用方式（由 app.ps1 发起）：
 *   node src/bridge.js <输入 JSON 文件> <输出 JSON 文件>
 *
 * 为什么用文件而不是 stdin/stdout：
 *   命令行参数转义、中文编码、PowerShell 的管道行为在不同 Windows 版本上
 *   表现不一致；写文件 + 读文件是最稳的，也方便出问题时直接看中间产物。
 *
 * 输出一律是 JSON，形如：
 *   成功：{ ok: true, ... }
 *   失败：{ ok: false, error: "说明" }
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function writeOut(outFile, obj) {
  fs.writeFileSync(outFile, JSON.stringify(obj), 'utf8');
}

function main() {
  const [, , inFile, outFile] = process.argv;

  if (!inFile || !outFile) {
    console.error('用法: node bridge.js <in.json> <out.json>');
    process.exit(2);
  }

  let req;
  try {
    req = JSON.parse(fs.readFileSync(inFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    writeOut(outFile, { ok: false, error: `读取请求失败：${err.message}` });
    return;
  }

  const homedir = process.env.USERPROFILE || require('os').homedir();
  const profileDir =
    req.profileDir ||
    path.join(homedir, '.dsh', 'profiles', 'desktop');
  const dataDir = req.dataDir || path.join(ROOT, 'data');

  let svc;
  try {
    const { createService } = require('./core/index.js');
    svc = createService({ profileDir, dataDir });
  } catch (err) {
    writeOut(outFile, { ok: false, error: `核心模块加载失败：${err.message}` });
    return;
  }

  try {
    switch (req.cmd) {
      case 'ping': {
        writeOut(outFile, { ok: true, profileDir, version: '1.0.0' });
        return;
      }

      case 'load': {
        const data = svc.collect();
        writeOut(outFile, data);
        return;
      }

      case 'toggle': {
        const name = req.name;
        const enabled = req.enabled === true;
        if (!name) {
          writeOut(outFile, { ok: false, error: '缺少插件名' });
          return;
        }
        const result = svc.setPluginEnabled(name, enabled);
        writeOut(outFile, result);
        return;
      }

      case 'launch': {
        // 启动 DSH 并观察结果。这是"DSH 起不来"痛点的正解：
        // 由程序接管启动动作，失败了才知道要回滚。
        //
        // 观察时长来自设置（默认 120 秒）。传入的 watchMs 优先，
        // 但同样会被规整到合法区间——界面传错值也不会把观察期压到几秒。
        const launcher = require('./core/launcher.js');
        const settingsMod = require('./core/settings.js');
        const configuredSec = settingsMod.load(dataDir).launchTimeoutSec;
        const watchMs = req.watchMs
          ? req.watchMs
          : configuredSec * 1000;

        launcher
          .launchAndWatch({ watchMs })
          .then((result) => {
            writeOut(outFile, result);
          })
          .catch((err) => {
            writeOut(outFile, { ok: false, reason: 'error', message: err.message });
          });
        return; // 结果由 Promise 异步写入
      }

      case 'settings': {
        const settingsMod = require('./core/settings.js');
        if (req.save) {
          writeOut(outFile, {
            ok: true,
            settings: settingsMod.save(dataDir, req.settings || {}),
          });
        } else {
          writeOut(outFile, { ok: true, settings: settingsMod.load(dataDir) });
        }
        return;
      }

      case 'suspects': {
        const launcher = require('./core/launcher.js');
        const data = svc.collect();
        writeOut(outFile, {
          ok: true,
          items: launcher.suspectPlugins(data.items, req.limit || 3),
        });
        return;
      }

      case 'dshRunning': {
        const launcher = require('./core/launcher.js');
        writeOut(outFile, { ok: true, running: launcher.findDshExe() !== null });
        return;
      }

      default: {
        writeOut(outFile, { ok: false, error: `未知指令：${req.cmd}` });
        return;
      }
    }
  } catch (err) {
    writeOut(outFile, {
      ok: false,
      error: `执行 ${req.cmd} 时出错：${err.message}`,
      stack: process.env.DSH_PM_DEBUG ? err.stack : undefined,
    });
  }
}

main();
