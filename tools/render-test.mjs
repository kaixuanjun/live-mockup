/**
 * LiveMockup · 逐帧离线渲染测试
 *
 * 验的是「机制」而不是界面：Render.render 是不是真的按帧号渲染、时间戳准不准、
 * 封出来的 WebM 浏览器能不能解、能不能拖、取消是否干净。
 *
 * 关键判据：成片时长必须严格等于 帧数 / fps —— 这就是「放弃实时渲染」换来的东西。
 * 旧的实时实现做不到：墙钟快一点慢一点，时长就跟着漂。
 */
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:4321';
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const browser = await launch({ port: 9359, width: 1600, height: 1000 });
const { evaluate } = browser;

try {
  await browser.goto(BASE + '/', 3200);
  await evaluate(`localStorage.clear()`);
  await browser.goto(BASE + '/', 3200);
  await sleep(600);

  /* ── 0. 运行环境必须支持离线编码 ── */
  const env = await evaluate(`({ offline: Render.offline, hasEncoder: typeof VideoEncoder, hasMuxer: typeof WebmMuxer, secure: window.isSecureContext })`);
  check(env.secure, '安全上下文（WebCodecs 前提）', String(env.secure));
  check(env.hasEncoder === 'function' && env.hasMuxer === 'object', 'WebCodecs + 自带 WebM 封装可用', JSON.stringify(env));
  check(env.offline, 'Render 报告具备离线逐帧能力');

  /* ── 1. 现造一段 3 秒 1280×720 录屏 ── */
  const made = await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    const stream = c.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const p = (performance.now() - t0) / 3000;
        const grd = g.createLinearGradient(0, 0, 1280, 720);
        grd.addColorStop(0, 'hsl(' + Math.round(p * 90 + 210) + ',70%,22%)');
        grd.addColorStop(1, 'hsl(' + Math.round(p * 90 + 300) + ',70%,12%)');
        g.fillStyle = grd; g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff'; g.font = '600 64px system-ui,sans-serif';
        g.fillText('FRAME ' + Math.round(p * 90), 90, 300);
        g.fillStyle = 'rgba(124,92,255,.9)';
        g.fillRect(90, 420, Math.min(1, p) * 1100, 16);
        if (p < 1.3) requestAnimationFrame(draw); else resolve();
      };
      draw(); setTimeout(resolve, 8000);
    });
    rec.stop();
    const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: mime })); });
    stream.getTracks().forEach((t) => t.stop());
    window.__vurl = URL.createObjectURL(blob);
    return { size: blob.size };
  })()`);
  check(made.size > 1000, '造出测试录屏', `${(made.size / 1024).toFixed(0)} KB`);

  await evaluate(`App.loadVideoSrc(window.__vurl)`);
  await sleep(1000);
  const st = await evaluate(`App.state`);
  check(st.mode === 'video' && st.video.w === 1280, '载入录屏视频', `${st.video.w}×${st.video.h}`);

  /* ── 2. 逐帧渲染：帧数、时长、时间戳 ── */
  const r = await evaluate(`(async () => {
    const marks = [];
    const t0 = performance.now();
    const blob = await Render.render({
      video: document.querySelector('#videoEl'),
      aspect: '16:9',
      camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
      bg: 'aurora', color: 'midnight', model: 'auto', autoSize: { w: 1280, h: 720 },
      duration: 1, fps: 30,
      onProgress: (p) => marks.push({ frame: p.frame, total: p.total, fps: +p.fps.toFixed(2), pct: p.pct }),
    });
    const ms = performance.now() - t0;
    const stats = Render.stats;
    window.__out = blob;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    await new Promise((res) => { v.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 4000); });
    return {
      ms: Math.round(ms), size: blob.size, type: blob.type,
      w: v.videoWidth, h: v.videoHeight, dur: v.duration,
      stats, first: marks[0], last: marks[marks.length - 1], count: marks.length,
    };
  })()`);

  check(r.size > 10_000, '封出 WebM', `${(r.size / 1024).toFixed(0)} KB · ${r.type}`);
  check(r.w === 1920 && r.h === 1080, '按画幅输出 1080p', `${r.w}×${r.h}`);
  check(Math.abs(r.dur - 1) < 0.06, '成片时长 = 帧数/fps（不跟墙钟漂）', `${r.dur.toFixed(3)}s（渲染用了 ${(r.ms / 1000).toFixed(1)}s）`);
  check(r.stats.frames === 30, '30 帧一帧不少', `渲染了 ${r.stats.frames} 帧`);
  check(r.last && r.last.frame === 30 && r.last.total === 30 && r.last.pct === 100, '进度收尾到 30/30 · 100%', JSON.stringify(r.last));
  check(r.count > 3, '进度是逐帧回调', `${r.count} 次回调`);
  console.log('   分阶段耗时(ms/帧):', JSON.stringify(r.stats));

  /* ── 3. 成片能被拖动、每帧内容不同（证明是真逐帧，不是一张静止画面） ── */
  const seekable = await evaluate(`(async () => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    v.src = URL.createObjectURL(window.__out);
    await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
    const grab = async (t) => {
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; setTimeout(r, 1200); });
      const c = document.createElement('canvas'); c.width = 128; c.height = 72;
      const g = c.getContext('2d'); g.drawImage(v, 0, 0, 128, 72);
      return g.getImageData(0, 0, 128, 72).data;
    };
    // 两帧之间的平均像素差：真逐帧的话每一帧内容都不一样
    const mad = (p, q) => {
      let d = 0, n = 0;
      for (let i = 0; i < p.length; i += 4) { d += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]); n += 3; }
      return +(d / n).toFixed(2);
    };
    const a = await grab(0.02);
    const b = await grab(0.5);
    const c2 = await grab(0.95);
    return { ab: mad(a, b), bc: mad(b, c2), ac: mad(a, c2), seeked: v.currentTime };
  })()`);
  check(Math.abs(seekable.seeked - 0.95) < 0.15, '成片可定位（Cues 索引生效）', `seek→${seekable.seeked.toFixed(2)}s`);
  check(seekable.ab > 1 && seekable.bc > 1, '不同时间点是不同画面（真逐帧）',
    `帧差 0.02→0.5s ${seekable.ab} · 0.5→0.95s ${seekable.bc} · 0.02→0.95s ${seekable.ac}`);

  /* ── 4. 同一时间轴渲染两次，时长完全一致（确定性） ── */
  const twice = await evaluate(`(async () => {
    const args = {
      video: document.querySelector('#videoEl'), aspect: '16:9',
      camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
      bg: 'aurora', color: 'midnight', model: 'auto', autoSize: { w: 1280, h: 720 },
      duration: 0.5, fps: 30,
    };
    const dur = async (blob) => {
      const v = document.createElement('video');
      v.muted = true; v.src = URL.createObjectURL(blob);
      await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
      return v.duration;
    };
    const a = await dur(await Render.render(args));
    const b = await dur(await Render.render(args));
    return { a, b };
  })()`);
  check(twice.a === twice.b && Math.abs(twice.a - 0.5) < 0.04, '两次渲染时长完全一致', `${twice.a} / ${twice.b}`);

  /* ── 5. 取消：不产出文件、状态复位 ── */
  const cancel = await evaluate(`(async () => {
    const p = Render.render({
      video: document.querySelector('#videoEl'), aspect: '9:16',
      camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
      bg: 'warm', color: 'sand', model: 'phone',
      duration: 4, fps: 30,
    });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
    const midFrames = Render.stats.frames;
    Render.abort();
    let err = null;
    try { await p; } catch (e) { err = { message: e && e.message, aborted: !!(e && e.aborted) }; }
    return { err, midFrames, active: Render.active, after: Render.stats.frames };
  })()`);
  check(!!cancel.err && cancel.err.aborted, '取消会以 aborted 结束', JSON.stringify(cancel.err));
  check(cancel.midFrames > 0 && cancel.midFrames < 120, '取消时确实已经渲染了一部分帧', `${cancel.midFrames} 帧`);
  check(!cancel.active, '取消后不再占着渲染锁');

  /* ── 6. 9:16 手机机身 + 镜头运动：画面里真的有设备 ── */
  const phone = await evaluate(`(async () => {
    const blob = await Render.render({
      video: document.querySelector('#videoEl'),
      aspect: '9:16',
      camera: [
        { t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 },
        { t: 1, x: 0, y: -0.034, z: 0, rx: 6, ry: 18, rz: 0, scale: 1.15 },
      ],
      bg: 'mint', color: 'midnight', model: 'phone',
      duration: 1, fps: 30,
    });
    window.__phone = blob;
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 0.5; setTimeout(r, 1200); });
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
    const mid = px(540, 960);      // 机身内部（屏幕）
    const corner = px(20, 20);     // 背景
    // 把中间一帧存出来，人工看一眼
    const thumb = document.createElement('canvas'); thumb.width = 216; thumb.height = 384;
    thumb.getContext('2d').drawImage(c, 0, 0, 216, 384);
    return { w: v.videoWidth, h: v.videoHeight, dur: v.duration, mid, corner, png: thumb.toDataURL('image/png') };
  })()`);
  check(phone.w === 1080 && phone.h === 1920, '9:16 输出 1080×1920', `${phone.w}×${phone.h}`);
  const diff = Math.abs(phone.mid[0] - phone.corner[0]) + Math.abs(phone.mid[1] - phone.corner[1]) + Math.abs(phone.mid[2] - phone.corner[2]);
  check(diff > 20, '画面中心是样机、四角是背景（合成正确）', `中间 rgb(${phone.mid}) vs 角落 rgb(${phone.corner})`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(new URL('../.shots/80-offline-frame.png', import.meta.url), Buffer.from(phone.png.split(',')[1], 'base64'));

  /* ── 7. 大偏航不能撕裂：WebGL 合成的几何误差不随偏航增长 ── */
  // 逐格仿射逼近透视时，误差 ∝ 格宽²×透视强度：偏航一大，格子之间就错开成阶梯。
  // 这里用「96×96 细网格」当参考解（它本身已经接近解析解），分别在 0° 和 60° 下比。
  // 判据不是绝对值（细网格自己也有重采样柔化），而是**误差有没有随偏航增长**。
  const yaw = await evaluate(`(async () => {
    const frame = async (blob) => {
      const v = document.createElement('video');
      v.muted = true; v.src = URL.createObjectURL(blob);
      await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 0.03; setTimeout(r, 800); });
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
      const g = c.getContext('2d'); g.drawImage(v, 0, 0);
      return g.getImageData(0, 0, 1920, 1080).data;
    };
    const render = (ry, preferGL, gridHint) => Render.render({
      video: document.querySelector('#videoEl'), aspect: '16:9',
      camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry, rz: 0, scale: 1 }],
      bg: 'night', color: 'silver', model: 'browser',
      duration: 0.1, fps: 30, preferGL, gridHint,
    });
    // 只比机身内部的像素：背景和阴影的差异不算几何误差
    const mad = (a, b) => {
      let sum = 0, n = 0;
      for (let i = 0; i < a.length; i += 4) {
        const lum = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
        if (lum < 140) continue;
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        n += 3;
      }
      return n ? +(sum / n).toFixed(2) : -1;
    };
    const glBlob0 = await render(0, true, 0);
    const backend = Render.backend;   // 必须紧接着 GL 渲染读，后面几次是强制 2D
    const gl0 = mad(await frame(glBlob0), await frame(await render(0, false, 96)));
    const ref60 = await frame(await render(60, false, 96));
    const gl60 = mad(await frame(await render(60, true, 0)), ref60);
    const old60 = mad(await frame(await render(60, false, 12)), ref60);
    const fallback = Render.backend;
    return { backend, gl0, gl60, old60, fallback };
  })()`);
  check(yaw.backend === 'webgl2', '合成走 WebGL2（真实透视，不是逐格仿射）', yaw.backend);
  check(yaw.gl60 - yaw.gl0 < 3, '偏航 60° 不撕裂：几何误差不随偏航增长',
    `0° 误差 ${yaw.gl0} → 60° 误差 ${yaw.gl60}`);
  check(yaw.old60 - yaw.gl60 > 6, '对照：旧的逐格仿射在 60° 偏航下误差明显更大（就是撕裂）',
    `旧 12×12 = ${yaw.old60} vs WebGL = ${yaw.gl60}`);
  check(yaw.fallback === 'canvas2d', '强制 prefersGL:false 时能退回 canvas2D 兜底', yaw.fallback);

  /* ── 8. 没有 WebCodecs 时退回实时录制（局域网 http 打开就是这条路） ── */
  const fallback = await evaluate(`(async () => {
    Object.defineProperty(window, 'VideoEncoder', { value: undefined, configurable: true });
    const offline = Render.offline;
    const blob = await Render.render({
      video: document.querySelector('#videoEl'), aspect: '16:9',
      camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
      bg: 'night', color: 'silver', model: 'auto', autoSize: { w: 1280, h: 720 },
      duration: 1.2, fps: 30,
    });
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
    return { offline, size: blob.size, w: v.videoWidth, h: v.videoHeight };
  })()`);
  check(fallback.offline === false && fallback.size > 10_000, '没有 WebCodecs 时退回实时录制仍能出片',
    `${(fallback.size / 1024).toFixed(0)} KB · ${fallback.w}×${fallback.h}`);

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
  const bad = results.filter((x) => !x.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((x) => console.log(`   · ${x.label}${x.detail ? ' — ' + x.detail : ''}`));
  } else {
    console.log(`✓ 逐帧渲染全部通过（${results.length} 项）`);
  }
  if (consoleProblems.length) {
    console.log('控制台问题:');
    consoleProblems.slice(0, 8).forEach((p) => console.log('   · ' + p));
  }
  process.exit(bad.length || consoleProblems.length ? 1 : 0);
}
