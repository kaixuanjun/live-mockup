/**
 * LiveMockup · 安卓客户端「保存导出文件」链路测试
 *
 * WebView 里 `<a download>` 是不生效的，所以 Android 版必须走 Capacitor 的
 * Filesystem 插件。真机不在手边，这里用**假的 Capacitor.Plugins** 验证 JS 契约：
 *   · 调的是 writeFile，路径落在 LiveMockup/<文件名>，目录 DOCUMENTS，base64 数据正确
 *   · 会顺带取一次 getUri
 *   · Electron 客户端优先（LM.save），浏览器在什么都没有时退回 a[download]
 */
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:4321';
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const browser = await launch({ port: 9441, width: 1200, height: 800 });
const { evaluate } = browser;

try {
  await browser.goto(BASE + '/', 3600);
  await evaluate('localStorage.clear()');
  await browser.goto(BASE + '/', 3600);
  await sleep(900);

  /* ── 1. 安卓：写进 Documents/LiveMockup ── */
  const android = await evaluate(`(async () => {
    const calls = [];
    window.Capacitor = {
      Plugins: {
        Filesystem: {
          writeFile: async (o) => { calls.push(['writeFile', o]); return { uri: 'file:///documents/LiveMockup/x.mp4' }; },
          getUri: async (o) => { calls.push(['getUri', o]); return { uri: 'content://doc/LiveMockup/x.mp4' }; },
        },
      },
    };
    const blob = new Blob(['hello mp4'], { type: 'video/mp4' });
    const res = await Exporter.download(blob, 'x.mp4');
    return { calls, res, expectB64: btoa('hello mp4') };
  })()`);

  const write = (android.calls.find((c) => c[0] === 'writeFile') || [])[1] || {};
  check(android.calls.length >= 2, '调用了 Filesystem（writeFile + getUri）',
    android.calls.map((c) => c[0]).join(', '));
  check(write.path === 'LiveMockup/x.mp4', '写到 Documents/LiveMockup/<文件名>', String(write.path));
  check(write.directory === 'DOCUMENTS' && write.recursive === true, '目录参数正确',
    `directory=${write.directory} recursive=${write.recursive}`);
  check(write.data === android.expectB64, '内容是 base64 编码的原始字节',
    `${String(write.data).slice(0, 16)}… (${String(write.data).length} 字符)`);
  check(android.res && android.res.ok && android.res.platform === 'android', '返回安卓保存结果',
    JSON.stringify(android.res).slice(0, 120));

  /* ── 2. Electron 优先 ── */
  const electron = await evaluate(`(async () => {
    const calls = [];
    const prevLM = window.LM;
    window.LM = {
      isClient: true,
      save: async (buf, name) => { calls.push(['save', name, buf.byteLength]); return { canceled: false, path: 'C:/tmp/' + name }; },
      reveal: async (p) => { calls.push(['reveal', p]); return true; },
    };
    const res = await Exporter.download(new Blob(['abc'], { type: 'video/mp4' }), 'y.mp4');
    window.LM = prevLM;
    return { calls, res };
  })()`);
  check(electron.calls.some((c) => c[0] === 'save' && c[1] === 'y.mp4'), 'Electron 里优先走原生保存对话框',
    JSON.stringify(electron.calls));
  check(electron.calls.some((c) => c[0] === 'reveal'), '保存后定位到文件');

  /* ── 3. 什么都没有时退回浏览器下载 ── */
  const web = await evaluate(`(async () => {
    delete window.Capacitor;
    const prevLM = window.LM;
    delete window.LM;
    let clicked = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicked = { download: this.download, hasBlob: String(this.href).startsWith('blob:') };
      // 不真的触发下载
    };
    try {
      await Exporter.download(new Blob(['web'], { type: 'text/plain' }), 'z.json');
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    window.LM = prevLM;
    return clicked;
  })()`);
  check(web && web.download === 'z.json' && web.hasBlob, '浏览器里仍是 a[download] 下载',
    JSON.stringify(web));

  if (browser.problems.length) {
    console.log('\n控制台问题:');
    browser.problems.slice(0, 6).forEach((p) => console.log('  ' + p));
  }
} catch (err) {
  check(false, '异常中断', String((err && err.message) || err).slice(0, 160));
} finally {
  const problems = (browser.problems || []).filter((p) => !/favicon/i.test(p));
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ 安卓保存链路通过（${results.length} 项）`);
  }
  if (problems.length) console.log(`控制台问题 ${problems.length} 条`);
  process.exit(bad.length || problems.length ? 1 : 0);
}
