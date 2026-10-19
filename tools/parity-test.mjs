/**
 * LiveMockup · 「编辑器画面 == 渲染画面」一致性测试
 *
 * 1) 取景比例一致：舞台的 --fit 与渲染器用的 fit 只差画布/舞台的整数取整（<1%）
 * 2) 普通机位：四角标记在两张图里重合，整体逐像素差小
 * 3) 极限机位（大偏航 + 推进 + 平移，工程第 10 帧那种）：整体仍然一致
 *
 * 这一组专门守住三类回归：
 *  - 两边各算一套取景（0.88 vs 0.78 边距、x/y/z 按舞台像素却直接用在 1920 画布上）
 *  - 样机/阴影贴图被设成 alpha:false，机身外面套一圈黑框
 *  - 编辑器里有、渲染里缺席的装饰（玻璃反光）
 */
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:4321';
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

// v2 单位：x = 画框宽的比例，y = 画框高的比例，z = 透视距离的比例
const NORMAL = { x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1, t: 0 };
const EXTREME = { x: 0.33, y: 0.177, z: 0.294, rx: -12, ry: 27.5, rz: 0, scale: 1.21, t: 0 };
// 有位移、机身完整在画内：换窗口尺寸时用「四角位置」比几何（不受重采样锐度影响）
const SHIFT = { x: 0.2, y: 0.1, z: 0.2, rx: 2, ry: -12, rz: 0, scale: 1, t: 0 };

  const PROJECT = {
    version: 2, mode: 'video',
    video: { name: 'parity.mp4', w: 2880, h: 1800, duration: 4 },
    page: { input: 'parity.mp4', src: '', startSrc: '' },
    device: 'auto', color: 'sand', bg: 'paper', aspect: '16:9', duration: 4,
    camera: [NORMAL],
    actions: [],
    ui: { statusBar: false, glare: true, ripple: true, autoKey: true, loop: false },
  };

const browser = await launch({ port: 9397, width: 1600, height: 1000 });
const { evaluate, cdp } = browser;

const measure = async (pose) => {
  // 编辑器侧也要切到同一个机位：把这条机位灌进工程再 seek(0)
  await evaluate(`App.loadProject(${JSON.stringify(JSON.stringify({ ...PROJECT, camera: [pose] }))})`);
  await evaluate(`App.seek(0)`);
  await sleep(500);
  await evaluate(`(() => {
    for (const sel of ['.camtoggle', '.stage__hint', '.stage__loading', '.stage__rec', '.camshield']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
  })()`);
  const geo = await evaluate(`(() => {
    const st = document.querySelector('#stage').getBoundingClientRect();
    return { x: st.left, y: st.top, w: st.width, h: st.height };
  })()`);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(geo.x), y: Math.round(geo.y), width: Math.round(geo.w), height: Math.round(geo.h), scale: 1 },
  });
  const previewPng = 'data:image/png;base64,' + shot.data;

  const rendered = await evaluate(`(async () => {
    const st = document.querySelector('#stage');
    let out = null;
    await Render.render({
      video: document.querySelector('#videoEl'),
      aspect: App.state.effectiveAspect,
      camera: [${JSON.stringify(pose)}],
      bg: 'paper', color: 'sand', glare: true,
      model: App.state.device, autoSize: App.state.autoSize,
      stage: { w: st.clientWidth, h: st.clientHeight },
      duration: 0.1, fps: 30,
      onProgress: (p) => {
        if (p.frame !== p.total || !p.canvas) return;
        const cv = document.createElement('canvas');
        cv.width = p.canvas.width; cv.height = p.canvas.height;
        cv.getContext('2d').drawImage(p.canvas, 0, 0);
        out = cv.toDataURL('image/png');
      },
    });
    return { png: out, backend: Render.backend };
  })()`);

  const cmp = await evaluate(`(async () => {
    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const a = await load(${JSON.stringify(previewPng)});
    const b = await load(${JSON.stringify(rendered.png)});
    const W = 480, H = 270;
    const mk = (im) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    };
    const da = mk(a), db = mk(b);
    let sum = 0, n = 0;
    for (let i = 0; i < da.length; i += 4) {
      sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      n += 3;
    }
    const marks = [
      ['TL', (r, g, b2) => r > 110 && g < 90 && b2 < 90],
      ['TR', (r, g, b2) => g > 80 && r < 90 && b2 < 90],
      ['BL', (r, g, b2) => b2 > 120 && r < 90 && g < 90],
      ['BR', (r, g, b2) => r > 80 && b2 > 80 && g < 80],
    ];
    const centroid = (d, test) => {
      let sx = 0, sy = 0, cnt = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!test(d[i], d[i + 1], d[i + 2])) continue;
        sx += x; sy += y; cnt++;
      }
      return cnt > 30 ? { x: sx / cnt / W, y: sy / cnt / H } : null;
    };
    const out = { mad: +(sum / n).toFixed(2), worst: 0, seen: 0 };
    for (const [name, test] of marks) {
      const pa = centroid(da, test), pb = centroid(db, test);
      if (!pa || !pb) continue;
      out.seen++;
      const d = Math.hypot((pa.x - pb.x) * W, (pa.y - pb.y) * H);
      out[name] = +d.toFixed(1);
      if (d > out.worst) out.worst = +d.toFixed(1);
    }
    return out;
  })()`);
  return { cmp, backend: rendered.backend };
};

try {
  await browser.goto(BASE + '/', 3600);
  await evaluate(`localStorage.clear()`);
  await browser.goto(BASE + '/', 3600);
  await sleep(900);

  await evaluate(`App.loadProject(${JSON.stringify(JSON.stringify(PROJECT))})`);
  await sleep(500);

  await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 2880; c.height = 1800;
    const g = c.getContext('2d');
    g.fillStyle = '#f2efe8'; g.fillRect(0, 0, 2880, 1800);
    const MW = 240, MX = Math.round(2880 * 0.1), MY = Math.round(1800 * 0.1);
    g.fillStyle = '#e11'; g.fillRect(MX, MY, MW, MW);
    g.fillStyle = '#1a1'; g.fillRect(2880 - MX - MW, MY, MW, MW);
    g.fillStyle = '#11e'; g.fillRect(MX, 1800 - MY - MW, MW, MW);
    g.fillStyle = '#a1a'; g.fillRect(2880 - MX - MW, 1800 - MY - MW, MW, MW);
    g.fillStyle = '#1d2430'; g.font = '700 110px system-ui,sans-serif';
    g.fillText('PARITY 一致性', 400, 460);
    g.strokeStyle = '#9aa2b0'; g.lineWidth = 3;
    for (let i = 0; i < 12; i++) { const y = 620 + i * 90; g.beginPath(); g.moveTo(400, y); g.lineTo(2480, y); g.stroke(); }
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(100);
    await new Promise((r) => setTimeout(r, 1000));
    rec.stop();
    const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
    stream.getTracks().forEach((t) => t.stop());
    const v = document.querySelector('#videoEl');
    v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 5000); });
    v.pause();
    document.querySelector('#stageLoading').classList.remove('is-on');
    App.seek(0);
  })()`);
  await sleep(600);

  const fit = await evaluate(`(() => {
    const st = document.querySelector('#stage');
    const dev = document.querySelector('#device');
    const W = 1920, H = 1080;
    const fitCSS = parseFloat(dev.style.getPropertyValue('--fit'));
    const fitR = Stage.fitOf(dev.dataset.model, dev.offsetWidth, dev.offsetHeight, W, H);
    return { fitCSS, fitR: fitR / (W / st.clientWidth), stageW: st.clientWidth, stageH: st.clientHeight };
  })()`);
  const fitErr = Math.abs(fit.fitCSS - fit.fitR) / fit.fitCSS;
  check(fitErr < 0.01, '取景比例：编辑器与渲染用的是同一套边距',
    `--fit ${fit.fitCSS.toFixed(5)} vs 渲染 ${fit.fitR.toFixed(5)}（差 ${(fitErr * 100).toFixed(2)}%）· 舞台 ${fit.stageW}×${fit.stageH}`);

  const a = await measure(NORMAL);
  check(a.cmp.mad < 12, '普通机位：整体画面一致', `逐像素差 ${a.cmp.mad}/255 · 后端 ${a.backend}`);
  check(a.cmp.seen === 4 && a.cmp.worst < 8, '普通机位：四角标记重合（≤8px @480）',
    `最大偏差 ${a.cmp.worst}px（TL ${a.cmp.TL} / TR ${a.cmp.TR} / BL ${a.cmp.BL} / BR ${a.cmp.BR}）`);

  const b = await measure(EXTREME);
  check(b.cmp.mad < 12, '极限机位（大偏航 + 推进 + 平移）画面仍一致',
    `逐像素差 ${b.cmp.mad}/255（可见角标 ${b.cmp.seen} 个，最大偏差 ${b.cmp.worst}px）`);

  /* ── 4. 换窗口尺寸：构图必须完全不动（坐标系统一之后的核心保证） ── */
  const previewPng = async () => {
    await evaluate(`(() => {
      document.body.classList.add('no-glare');
      for (const sel of ['.camtoggle', '.stage__hint', '.stage__loading', '.stage__rec', '.camshield']) {
        const el = document.querySelector(sel); if (el) el.style.display = 'none';
      }
    })()`);
    await sleep(250);
    const g = await evaluate(`(() => {
      const st = document.querySelector('#stage').getBoundingClientRect();
      return { x: st.left, y: st.top, w: st.width, h: st.height };
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.w), height: Math.round(g.h), scale: 1 },
    });
    return { png: 'data:image/png;base64,' + shot.data, size: [Math.round(g.w), Math.round(g.h)] };
  };

  await evaluate(`App.loadProject(${JSON.stringify(JSON.stringify({ ...PROJECT, camera: [SHIFT] }))})`);
  await evaluate('App.seek(0)');
  await sleep(500);
  const atWide = await previewPng();

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 780, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const atNarrow = await previewPng();

  const drift = await evaluate(`(async () => {
    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const a = await load(${JSON.stringify(atWide.png)});
    const b = await load(${JSON.stringify(atNarrow.png)});
    const W = 720, H = 405;
    const mk = (im) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    };
    const da = mk(a), db = mk(b);
    let sum = 0, n = 0;
    for (let i = 0; i < da.length; i += 4) {
      sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      n += 3;
    }
    const marks = [
      ['TL', (r, g, b2) => r > 110 && g < 90 && b2 < 90],
      ['TR', (r, g, b2) => g > 80 && r < 90 && b2 < 90],
      ['BL', (r, g, b2) => b2 > 120 && r < 90 && g < 90],
      ['BR', (r, g, b2) => r > 80 && b2 > 80 && g < 80],
    ];
    const centroid = (d, test) => {
      let sx = 0, sy = 0, cnt = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!test(d[i], d[i + 1], d[i + 2])) continue;
        sx += x; sy += y; cnt++;
      }
      return cnt > 60 ? { x: sx / cnt / W, y: sy / cnt / H } : null;
    };
    const out = { mad: +(sum / n).toFixed(2), worst: 0, seen: 0, per: {} };
    for (const [name, test] of marks) {
      const pa = centroid(da, test), pb = centroid(db, test);
      if (!pa || !pb) continue;
      out.seen++;
      const d = Math.hypot((pa.x - pb.x) * W, (pa.y - pb.y) * H);
      out.per[name] = +d.toFixed(1);
      if (d > out.worst) out.worst = +d.toFixed(1);
    }
    return out;
  })()`);

  check(drift.seen >= 2 && drift.worst < 8, '换窗口尺寸（1600×1000 → 1240×780）构图不变（四角位置）',
    `舞台 ${atWide.size.join('×')} → ${atNarrow.size.join('×')} · 角位最大偏移 ${drift.worst}px@720（TL ${drift.per.TL} / TR ${drift.per.TR} / BL ${drift.per.BL} / BR ${drift.per.BR}）· 逐像素差 ${drift.mad}`);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  if (browser.problems.length) {
    console.log('\n控制台问题:');
    browser.problems.slice(0, 8).forEach((p) => console.log('  ' + p));
  }
} catch (err) {
  console.log('异常: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  results.push({ ok: false, label: '异常中断' });
} finally {
  const consoleProblems = (browser.problems || []).filter((p) => !/favicon/i.test(p));
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ 编辑器 / 渲染一致性通过（${results.length} 项）`);
  }
  if (consoleProblems.length) {
    console.log('控制台问题:');
    consoleProblems.slice(0, 8).forEach((p) => console.log('   · ' + p));
  }
  process.exit(bad.length || consoleProblems.length ? 1 : 0);
}
