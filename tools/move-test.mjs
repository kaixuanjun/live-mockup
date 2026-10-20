/**
 * LiveMockup · 运镜文件测试
 *
 * 1. 打包 / 解析往返一致（kind / version / keys / 缓动）
 * 2. 导出按钮真的产出文件，且文件里只有镜头数据
 * 3. 套到**不同时长**的工程：按比例铺满，末帧正好落在结尾
 * 4. Alt 模式：保持原速，只把起点对齐 0
 * 5. v1 运镜文件（编辑器像素）自动换算成比例
 * 6. 坏文件不会清空现有运镜
 */
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:4321';
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const KEYS = [
  { t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1, ease: 'easeInOut' },
  { t: 4, x: 0.12, y: -0.03, z: 0.2, rx: 6, ry: 22, rz: 3, scale: 1.2, ease: 'easeOut' },
  { t: 9.5, x: 0.3, y: 0.1, z: 0.29, rx: -4, ry: 35, rz: 0, scale: 1.05 },
];
const MOVE = { kind: 'livemockup-move', version: 2, name: '测试运镜', duration: 9.5, keys: KEYS };
const MOVE_JS = JSON.stringify(JSON.stringify(MOVE));

const browser = await launch({ port: 9432, width: 1600, height: 1000 });
const { evaluate } = browser;

try {
  await browser.goto(BASE + '/', 3600);
  await evaluate('localStorage.clear()');
  await browser.goto(BASE + '/', 3600);
  await sleep(900);

  const round = await evaluate(`(() => {
    const packed = MoveTrack.pack(${JSON.stringify(KEYS)}, 12, { device: 'phone', aspect: '9:16' });
    const parsed = MoveTrack.parse(JSON.stringify(packed));
    const strip = (list) => JSON.stringify(list.map((k) => [k.t, k.x, k.y, k.z, k.rx, k.ry, k.rz, k.scale]));
    return {
      kind: packed.kind, version: packed.version, duration: packed.duration,
      count: parsed.keys.length,
      same: strip(parsed.keys) === strip(${JSON.stringify(KEYS)}),
      hasEase: parsed.keys[1].ease === 'easeOut',
    };
  })()`);
  check(round.kind === 'livemockup-move' && round.version === 2, '运镜文件带 kind / version 标记',
    `${round.kind} v${round.version} · ${round.count} 个关键帧 · ${round.duration}s`);
  check(round.same && round.hasEase, '打包 → 解析：数值与缓动完全一致');

  await evaluate(`(async () => {
    document.querySelector('[data-move="orbit"]').click();
    let captured = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.download.endsWith('.json')) captured = { name: this.download, href: this.href };
      else orig.call(this);
    };
    document.querySelector('#moveExportBtn').click();
    // download() 是异步的（客户端分支要先 await），让一个宏任务再拆拦截
    await new Promise((r) => setTimeout(r, 60));
    HTMLAnchorElement.prototype.click = orig;
    window.__moveDl = captured;
  })()`);
  await sleep(300);
  const exported = await evaluate(`(async () => {
    if (!window.__moveDl) return { ok: false };
    const text = await (await fetch(window.__moveDl.href)).text();
    const data = JSON.parse(text);
    return {
      ok: true, name: window.__moveDl.name,
      kind: data.kind, version: data.version, count: data.keys.length,
      duration: data.duration, scene: data.scene,
      hasVideo: /blob:|"video"|"page"/.test(text),
    };
  })()`);
  check(exported.ok && /\.json$/.test(exported.name), '导出运镜：下载了一个 .json 文件', exported.name);
  check(exported.kind === 'livemockup-move' && exported.version === 2 && exported.count === 3,
    '文件内容只有镜头数据', `${exported.count} keys · ${exported.duration}s · scene=${JSON.stringify(exported.scene)}`);
  check(!exported.hasVideo, '文件不绑定视频（没有 video / page / blob）');

  await evaluate(`(() => {
    const el = document.querySelector('#durationInput');
    el.value = '19';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const scaled = await evaluate(`(async () => {
    const res = await App.applyMoveText(${MOVE_JS}, false);
    return { res, times: App.state.camera.map((k) => +k.t.toFixed(3)), duration: App.state.duration, n: App.state.camera.length };
  })()`);
  const expect = KEYS.map((k) => +(k.t * (19 / 9.5)).toFixed(3));
  check(scaled.n === 3 && Math.abs(scaled.times[2] - 19) < 0.05, '按比例套用：末帧正好落在时间轴结尾',
    `${JSON.stringify(scaled.times)} → 时间轴 ${scaled.duration}s`);
  check(JSON.stringify(scaled.times) === JSON.stringify(expect), '按比例套用：节奏等比保留',
    `期望 ${JSON.stringify(expect)}`);

  const kept = await evaluate(`(async () => {
    const res = await App.applyMoveText(${MOVE_JS}, true);
    return { res, times: App.state.camera.map((k) => +k.t.toFixed(3)), duration: App.state.duration };
  })()`);
  check(JSON.stringify(kept.times) === JSON.stringify([0, 4, 9.5]), 'Alt 保持原速：时间戳原样保留',
    JSON.stringify(kept.times));

  const legacy = await evaluate(`(async () => {
    const v1 = {
      version: 1, aspect: '16:9',
      camera: [
        { t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 },
        { t: 3, x: 341, y: 103, z: 500, rx: -12, ry: 27.5, rz: 0, scale: 1.21 },
      ],
    };
    await App.applyMoveText(JSON.stringify(v1), true);
    const k = App.state.camera[1];
    const box = Stage.refBox(16 / 9);
    return {
      x: +k.x.toFixed(4), y: +k.y.toFixed(4), z: +k.z.toFixed(4),
      expect: {
        x: +(341 / box.w).toFixed(4),
        y: +(103 / box.h).toFixed(4),
        z: +(500 / Stage.perspOf(box.h)).toFixed(4),
      },
    };
  })()`);
  check(legacy.x === legacy.expect.x && legacy.y === legacy.expect.y && legacy.z === legacy.expect.z,
    'v1 运镜文件（舞台像素）自动换算成比例',
    `x${legacy.x} y${legacy.y} z${legacy.z} · 期望 ${JSON.stringify(legacy.expect)}`);

  const bad = await evaluate(`(async () => {
    const before = App.state.camera.length;
    const r1 = await App.applyMoveText('{"kind":"livemockup-move","keys":[]}', true);
    const r2 = await App.applyMoveText('not json', true);
    const r3 = await App.applyMoveText('{"foo":1}', true);
    return { r1, r2, r3, before, after: App.state.camera.length };
  })()`);
  check(bad.r1 === null && bad.r2 === null && bad.r3 === null && bad.before === bad.after,
    '坏文件只提示、不清空现有运镜', `${bad.before} → ${bad.after} 个关键帧`);

  const problems = browser.problems.filter((p) => !/favicon/i.test(p));
  if (problems.length) {
    console.log('\n控制台问题:');
    problems.slice(0, 8).forEach((p) => console.log('  ' + p));
  }
} catch (err) {
  check(false, '异常中断', String((err && err.message) || err).slice(0, 140));
} finally {
  const problems = (browser.problems || []).filter((p) => !/favicon/i.test(p));
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ 运镜文件通过（${results.length} 项）`);
  }
  if (problems.length) console.log(`控制台问题 ${problems.length} 条`);
  process.exit(bad.length || problems.length ? 1 : 0);
}
