/**
 * LiveMockup · 导出链路测试
 *
 * headless 里没有屏幕共享选择器，所以把 getDisplayMedia 换成一个会动的假流
 * （1280×800 渐变 canvas），其余全部走真实代码：舞台裁切 → 1080×1920 canvas
 * → MediaRecorder(webm) → download(blob)。验证的是导出链路本身，不是屏幕捕获。
 */
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:4321';
const log = (...a) => console.log('·', ...a);

const browser = await launch({ port: 9341, width: 1600, height: 1000 });
let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

try {
  const { evaluate } = browser;
  await browser.goto(BASE + '/', 3200);

  await evaluate(`new Promise((r) => {
    if (document.querySelector('#frame')?.getAttribute('src')) return r(1);
    setTimeout(() => r(1), 1500);
  })`);
  log('应用已载入');

  // 缩短时长，让一次导出在几秒内跑完
  await evaluate(`(() => { const el = document.querySelector('#durationInput');
    el.value = '4'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  log('时长设为 4 秒');

  // ── 安装假屏幕流 + 拦截下载 ──
  await evaluate(`(() => {
    window.__cstream = [];
    const orig = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...a) {
      window.__cstream.push({ w: this.width, h: this.height });
      return orig.apply(this, a);
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 800;
      const ctx = c.getContext('2d');
      let hue = 0;
      setInterval(() => {
        hue = (hue + 6) % 360;
        const g = ctx.createLinearGradient(0, 0, 1280, 800);
        g.addColorStop(0, 'hsl(' + hue + ',85%,60%)');
        g.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ',85%,32%)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 1280, 800);
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fillRect(0, 700, 1280, 100);
      }, 16);
      return c.captureStream(30);
    };
    window.Exporter.download = (blob, name) => {
      window.__exportInfo = { name, size: blob.size, type: blob.type };
    };
  })()`);
  log('已注入假屏幕流');

  await browser.click('#exportBtn');
  await sleep(2600);
  const during = await evaluate(`({
    exporting: document.body.classList.contains('exporting'),
    noPanels: document.body.classList.contains('no-panels'),
    maskVisible: getComputedStyle(document.querySelector('#exportMask')).display !== 'none',
    camVisible: getComputedStyle(document.querySelector('.camtoggle')).display !== 'none',
    btn: document.querySelector('#exportBtn').innerText.trim(),
    stage: Math.round(document.querySelector('#stage').getBoundingClientRect().width),
    wrapW: document.querySelector('.stagewrap').clientWidth,
    wrapH: document.querySelector('.stagewrap').clientHeight,
    stageH: Math.round(document.querySelector('#stage').getBoundingClientRect().height),
  })`);
  log('导出中几何:', JSON.stringify(during));
  ok(during.exporting, '进入导出态');
  ok(!during.maskVisible, '导出遮罩未盖在舞台上（否则会被录进视频）');
  ok(!during.camVisible, '镜头按钮已隐藏');
  ok(during.stageH > 850, '导出时舞台吃满窗口高度', during.stage + '×' + during.stageH + ' 画布 ' + during.wrapW + '×' + during.wrapH);
  ok(/录制\s*\d+\s*\/\s*\d+\s*帧/.test(during.btn), '按钮显示 当前帧/总帧数（这条路上遮罩会被录进画面，只能写按钮）', during.btn);
  ok(/fps/.test(during.btn), '按钮显示抓取速度 fps', during.btn);
  await browser.shot('07-exporting');

  // 等下载回调（最长 30s）
  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await evaluate(`window.__exportInfo || null`);
    if (info) break;
    await sleep(500);
  }

  ok(!!info, '导出回调完成');
  if (info) {
    const { size, type, name } = info;
    const streamSize = await evaluate(`(window.__cstream || []).filter((c) => c.w >= 1000 && c.h >= 1000)[0] || null`);
    ok(size > 80_000, 'webm 体积合理', (size / 1024).toFixed(0) + ' KB');
    ok(/webm|mp4/.test(type), '容器格式正确', type);
    ok(!!streamSize && streamSize.w === 1080 && streamSize.h === 1920, '9:16 输出 1080×1920', JSON.stringify(streamSize));
    ok(/^livemockup-.*\.webm$/.test(name), '文件名规范', name);
  }

  const toast = await evaluate(`(document.querySelector('#appToast')?.innerText || '').trim()`);
  ok(/导出完成/.test(toast), '提示导出完成', toast);

  const after = await evaluate(`({
    exporting: document.body.classList.contains('exporting'),
    stage: Math.round(document.querySelector('#stage').getBoundingClientRect().width),
    stageH: Math.round(document.querySelector('#stage').getBoundingClientRect().height),
    btn: document.querySelector('#exportBtn').innerText.trim(),
  })`);
  ok(!after.exporting, '导出后恢复编辑态');
  ok(after.stageH < 800 && after.stage > 200, '舞台尺寸复原', after.stage + '×' + after.stageH);
  ok(/导出视频/.test(after.btn), '按钮文案复原', after.btn);

  // 换 16:9 再验一次 canvas 尺寸，覆盖 canvasSize 的另一分支
  await evaluate(`(() => { const s = document.querySelector('#aspectSel');
    s.value = '16:9'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  const r = await evaluate(`window.Exporter.canvasSize('16:9')`);
  ok(r.w === 1920 && r.h === 1080, '16:9 尺寸计算正确', JSON.stringify(r));

  if (browser.problems.length) {
    console.log('\n控制台问题:');
    browser.problems.forEach((p) => console.log('  ' + p));
  }
} finally {
  await browser.close();
}

console.log('\n═══ 结果 ═══');
console.log(failed === 0 ? '✓ 导出台账全部通过' : `✗ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
