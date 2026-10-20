/**
 * 由主进程用 ELECTRON_RUN_AS_NODE=1 拉起：在**纯 Node 进程**里写注册表。
 *
 * 为什么要绕这一下：Electron 的浏览器进程里 `reg.exe add/delete` 会被拒
 * （`reg query` 却正常），而同一个调用在一个普通 Node 进程里是好的。
 * 与其猜原因，不如把「写」这件事放到明确可用的进程里做，只多一次进程启动。
 *
 * 用法：electron.exe --node-script gpu-write.cjs apply <exe> [level]
 *                                  gpu-write.cjs clear <exe>
 * 输出：单行 JSON（{ ok, before, after, changed } 或 { ok:false, error }）
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const [action, exe, level] = process.argv.slice(2);
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'gpu-prefs.mjs')).href);
  if (action === 'apply') {
    const r = await mod.setLevel(String(exe || ''), Number(level) || 2);
    process.stdout.write(JSON.stringify({ ok: true, ...r }));
    return;
  }
  if (action === 'clear') {
    const r = await mod.clearLevel(String(exe || ''));
    process.stdout.write(JSON.stringify({ ok: true, ...r }));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: '未知动作：' + action }));
  process.exitCode = 2;
})().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
