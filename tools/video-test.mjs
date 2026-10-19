/**
 * 录屏视频模式测试
 *
 * 不依赖任何外部视频文件：在页面里用 canvas + captureStream + MediaRecorder
 * 现造一段 1280×720 的 WebM，再走 App.loadVideoSrc() 载入——
 * 这条路径和用户拖进一个 .webm 完全一致（同样会撞上 duration=Infinity 的坑）。
 */
import { launch, sleep } from './cdp.mjs';

const PORT = 4321;
const results = [];
const problems = [];

function check(ok, label, detail) {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({ port: 9337, width: 1600, height: 1000 });
const { evaluate } = browser;

try {
  await browser.goto(`http://localhost:${PORT}/`, 3000);
  // 清掉上一次的状态再重载一遍，避免继承别人的 device/aspect
  await evaluate(`localStorage.clear()`);
  await browser.goto(`http://localhost:${PORT}/`, 3000);
  await sleep(600);

  /* ── 1. 现造一段录屏 ── */
  const made = await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    const stream = c.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    // 不要 await rec.onstart：headless 下这个事件不稳定，等它会把整段 evaluate 挂死
    rec.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const p = (performance.now() - t0) / 3000;
        const grd = g.createLinearGradient(0, 0, 1280, 720);
        grd.addColorStop(0, 'hsl(' + Math.round(p * 90 + 210) + ', 70%, 22%)');
        grd.addColorStop(1, 'hsl(' + Math.round(p * 90 + 300) + ', 70%, 12%)');
        g.fillStyle = grd; g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.font = '600 64px system-ui, sans-serif';
        g.fillText('SCREEN RECORDING', 90, 300);
        g.font = '400 34px system-ui, sans-serif';
        g.fillStyle = 'rgba(255,255,255,.75)';
        g.fillText('1280 x 720  ·  ' + (p * 3).toFixed(1) + 's', 92, 360);
        g.fillStyle = 'rgba(124,92,255,.9)';
        g.fillRect(90, 420, Math.min(1, p) * 1100, 16);
        if (p < 1.3) requestAnimationFrame(draw); else resolve();
      };
      draw();
      setTimeout(resolve, 9000); // rAF 被节流时的兜底
    });
    rec.stop();
    const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: mime })); });
    stream.getTracks().forEach((t) => t.stop());
    window.__testVideoUrl = URL.createObjectURL(blob);
    return { size: blob.size, mime };
  })()`);
  check(made.size > 1000, '造出测试录屏', `${(made.size / 1024).toFixed(0)} KB · ${made.mime}`);

  /* ── 2. 载入到样机屏幕 ── */
  await evaluate(`App.loadVideoSrc(window.__testVideoUrl)`);
  await sleep(900);

  const st = await evaluate(`App.state`);
  check(st.mode === 'video', '切换到录屏模式', `mode=${st.mode}`);
  check(st.video.w === 1280 && st.video.h === 720, '读到输入分辨率', `${st.video.w}×${st.video.h}`);
  check(st.video.duration > 2.4 && st.video.duration < 6.5, '读到时长（MediaRecorder 的 Infinity 兜底生效）', `${st.video.duration.toFixed(2)}s`);
  check(st.device === 'auto', '机型自动切到「自适应分辨率」', `device=${st.device}`);
  check(st.aspect === 'auto', '画幅自动切到「自适应」', `aspect=${st.aspect}`);
  check(st.effectiveAspect === '1280:720', '导出画幅跟着输入走', st.effectiveAspect);

  const dom = await evaluate(`(() => {
    const v = document.querySelector('#videoEl');
    const f = document.querySelector('#frame');
    const d = document.querySelector('#device');
    return {
      bodyClass: document.body.classList.contains('mode-video'),
      videoDisplay: getComputedStyle(v).display,
      frameDisplay: getComputedStyle(f).display,
      // 用布局尺寸而不是 getBoundingClientRect：镜头默认带旋转，投影后的外框会变窄
      ratio: d.offsetWidth / d.offsetHeight,
      autoOn: !!document.querySelector('#deviceSeg [data-device="auto"].is-on'),
      aspectSel: document.querySelector('#aspectSel').value,
      recordDisabled: document.querySelector('#recordBtn').disabled,
      keys: document.querySelectorAll('#laneCamera .key').length,
      meta: document.querySelector('#videoMeta')?.textContent || '',
      preset: getComputedStyle(document.querySelector('#presetList')).display,
      videoBox: getComputedStyle(document.querySelector('#videoBox')).display,
    };
  })()`);
  check(dom.bodyClass, 'body 进入 mode-video');
  check(dom.videoDisplay === 'block', '视频层可见', dom.videoDisplay);
  check(dom.frameDisplay === 'none', 'iframe 已隐藏', dom.frameDisplay);
  check(Math.abs(dom.ratio - 1280 / 720) < 0.06, '样机比例=输入分辨率比例', dom.ratio.toFixed(3));
  check(dom.autoOn, '「自适应」机型按钮高亮');
  check(dom.aspectSel === 'auto', '画幅下拉显示 auto', dom.aspectSel);
  check(dom.recordDisabled, '录屏模式下禁用「录制操作」');
  check(/1280×720/.test(dom.meta), '左侧显示视频信息', dom.meta.trim().slice(0, 40));
  check(dom.preset === 'none' && dom.videoBox !== 'none', '左侧换成录屏入口（隐藏内置演示）', `preset=${dom.preset} / box=${dom.videoBox}`);

  /* ── 3. 时间轴与视频双向对齐 ── */
  await evaluate(`App.seek(1.2)`);
  await sleep(320);
  let s2 = await evaluate(`App.state`);
  check(Math.abs(s2.currentTime - 1.2) < 0.22, 'seek 把视频定位到 1.2s', `currentTime=${s2.currentTime.toFixed(2)}`);
  check(Math.abs(s2.t - 1.2) < 0.05, '播放头同步到 1.2s', `t=${s2.t.toFixed(2)}`);

  await evaluate(`App.play()`);
  await sleep(700);
  s2 = await evaluate(`App.state`);
  check(s2.playing, '播放中', `t=${s2.t.toFixed(2)}`);
  check(Math.abs(s2.t - s2.currentTime) < 0.25, '播放头跟着视频走（视频当时钟）', `Δ=${Math.abs(s2.t - s2.currentTime).toFixed(3)}s`);
  const advanced = s2.t;
  await evaluate(`App.stop()`);
  await sleep(200);
  s2 = await evaluate(`App.state`);
  check(!s2.playing && Math.abs(s2.currentTime - advanced) < 0.4, '暂停后画面停住', `currentTime=${s2.currentTime.toFixed(2)}`);

  await browser.shot('24-video');

  /* ── 4. 镜头关键帧仍然可用 + 导出尺寸 ── */
  const cam = await evaluate(`(async () => {
    App.seek(2.4);
    document.querySelector('#addKeyBtn').click();
    await new Promise((r) => setTimeout(r, 220));
    const before = JSON.parse(localStorage.getItem('livemockup:project:v1') || '{}');
    return {
      keys: document.querySelectorAll('#laneCamera .key').length,
      duration: App.state.duration,
      savedMode: before.mode,
      savedVideo: before.video,
      exportSize: Exporter.canvasSize(App.state.effectiveAspect),
    };
  })()`);
  check(cam.keys >= 2, '录屏模式下仍可加镜头关键帧', `${cam.keys} 帧`);
  check(Math.abs(cam.duration - 3) < 1.2, '时间轴时长=视频时长', `${cam.duration}s`);
  check(cam.savedMode === 'video' && cam.savedVideo && cam.savedVideo.w === 1280, '工程里记住 mode 与视频信息');
  const size = cam.exportSize;
  check(size.w >= 1280 && Math.abs(size.w / size.h - 1280 / 720) < 0.02, '导出画布按 16:9 输出', `${size.w}×${size.h}`);

  /* ── 5. 真的导出一段（内部逐帧渲染，不再碰屏幕捕获） ── */
  await evaluate(`(() => {
    const el = document.querySelector('#durationInput');
    el.value = '2'; el.dispatchEvent(new Event('change', { bubbles: true }));
    // 内部渲染的核心保证：任何情况下都不该再打开共享选择器
    window.__gdm = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__gdm++;
      throw new Error('录屏模式不应调用 getDisplayMedia');
    };
    window.Exporter.download = (blob, name) => {
      window.__exportInfo = { name, size: blob.size, type: blob.type };
      window.__blob = blob;
    };
  })()`);
  await browser.click('#exportBtn');
  await sleep(1300);
  const during = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      frozen: document.body.classList.contains('is-frozen'),
      layoutVisible: getComputedStyle(q('.layout')).visibility,
      mask: getComputedStyle(q('#exportMask')).display,
      isRenderCard: q('#exportCard').classList.contains('is-render'),
      title: q('#exportTitle').textContent,
      frames: q('#exportFrames').textContent,
      fps: q('#exportFps').textContent,
      eta: q('#exportEta').textContent,
      format: q('#exportFormat').textContent,
      pct: q('#exportPct').textContent,
      cancel: !q('#exportCancel').hidden,
      preview: q('#exportPreview').width > 0 && q('#exportPreview').height > 0,
    };
  })()`);
  check(during.frozen, '渲染时主界面被冻结（body.is-frozen）');
  check(during.layoutVisible === 'hidden', '冻结时编辑器不参与重绘（省 CPU 给渲染）', during.layoutVisible);
  check(during.mask !== 'none' && during.isRenderCard, '弹出渲染进度窗', during.mask);
  check(/逐帧渲染/.test(during.title), '弹窗标题说明是逐帧渲染', during.title);
  check(/^\d+ \/ \d+$/.test(during.frames.trim()), '弹窗显示 当前帧/总帧数', during.frames);
  check(/fps/.test(during.fps), '弹窗显示导出速度 fps', `${during.fps} · 已用/剩余 ${during.eta} · ${during.pct}`);
  check(/1920×1080/.test(during.format), '弹窗显示输出规格', during.format);
  check(during.cancel, '弹窗有「取消导出」');
  check(during.preview, '弹窗有逐帧预览画面');
  // 主界面被藏起来省合成 CPU，但视频仍必须真的解码进画面 —— 预览里得有内容
  await sleep(600);
  const preview = await evaluate(`(() => {
    const c = document.querySelector('#exportPreview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min: Math.round(min), max: Math.round(max) };
  })()`);
  check(preview.max - preview.min > 25, '预览里是真实合成画面（隐藏主界面不影响取帧）',
    `亮度范围 ${preview.min}~${preview.max}`);
  await browser.shot('27-render-progress');

  // 主界面被冻结，但弹窗必须还在动 —— 这才是「卡死」的反面
  const f1 = await evaluate(`document.querySelector('#exportFrames').textContent`);
  await sleep(700);
  const f2 = await evaluate(`document.querySelector('#exportFrames').textContent`);
  check(f1 !== f2 && f1 !== '0 / 60', '渲染中弹窗帧号持续跳动（主线程没被占死）', `${f1} → ${f2}`);
  const totalFrames = await evaluate(`Number(document.querySelector('#exportFrames').textContent.split('/')[1])`);
  check(totalFrames === 60, '2 秒 × 30fps = 60 帧', `${totalFrames} 帧`);

  let info = null;
  for (let i = 0; i < 90; i++) {
    info = await evaluate(`window.__exportInfo || null`);
    if (info) break;
    await sleep(500);
  }
  check(!!info && info.size > 20000, '导出出片', info ? `${(info.size / 1024).toFixed(0)} KB · ${info.type}` : '无');
  check(!!info && /\.webm$/.test(info.name || ''), '文件名规范', info?.name || '无');
  const gdm = await evaluate(`window.__gdm`);
  check(gdm === 0, '整段导出从未调用 getDisplayMedia', `调用 ${gdm} 次`);
  const after = await evaluate(`(async () => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    v.src = URL.createObjectURL(window.__blob);
    await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
    return {
      frozen: document.body.classList.contains('is-frozen'),
      mask: getComputedStyle(document.querySelector('#exportMask')).display,
      btn: document.querySelector('#exportBtn').innerText.trim(),
      t: App.state.t,
      w: v.videoWidth, h: v.videoHeight, dur: v.duration,
      frames: document.querySelector('#exportFrames').textContent,
    };
  })()`);
  check(!after.frozen && after.mask === 'none', '导出后解锁并收起弹窗');
  check(after.btn === '导出视频', '按钮文案复原', after.btn);
  check(after.t < 0.2, '渲染结束后播放头回到 0', `${after.t.toFixed(2)}s`);
  check(after.w === 1920 && after.h === 1080, '内部渲染按 16:9 出 1080p', `${after.w}×${after.h}`);
  check(Math.abs(after.dur - 2) < 0.08, '成片时长严格 = 时间轴时长（不跟墙钟走）', `${after.dur.toFixed(3)}s`);
  check(/^60 \/ 60$/.test(after.frames.trim()), '收尾帧号 = 总帧数', after.frames);
  await browser.shot('26-video-export');

  /* ── 6. 退出录屏模式回到网页 ── */
  await evaluate(`App.setMode('page')`);
  await sleep(400);
  const back = await evaluate(`(() => ({
    mode: App.state.mode,
    device: App.state.device,
    aspect: App.state.aspect,
    videoDisplay: getComputedStyle(document.querySelector('#videoEl')).display,
    recordDisabled: document.querySelector('#recordBtn').disabled,
    preset: getComputedStyle(document.querySelector('#presetList')).display,
    videoBox: getComputedStyle(document.querySelector('#videoBox')).display,
  }))()`);
  check(back.mode === 'page', '可以切回网页模式');
  check(back.device === 'phone' && back.aspect === '9:16', '自适应尺寸回退成手机 + 9:16', `${back.device} / ${back.aspect}`);
  check(back.videoDisplay === 'none' && !back.recordDisabled, '视频层隐藏、录制按钮恢复', back.videoDisplay);
  check(back.videoBox === 'none' && back.preset !== 'none', '切回网页后左侧恢复内置演示', `box=${back.videoBox} / preset=${back.preset}`);

  await browser.shot('25-video-back');
} catch (err) {
  problems.push('异常: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
} finally {
  const consoleProblems = (browser.problems || []).filter((p) => !/favicon/i.test(p));
  await browser.close();
  console.log('\n═══ 结果 ═══');
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ 录屏模式全部通过（${results.length} 项）`);
  }
  if (consoleProblems.length) {
    console.log('控制台问题:');
    consoleProblems.slice(0, 8).forEach((p) => console.log('   · ' + p));
  }
  if (problems.length) problems.forEach((p) => console.log('   ! ' + p));
  process.exit(bad.length || consoleProblems.length || problems.length ? 1 : 0);
}
