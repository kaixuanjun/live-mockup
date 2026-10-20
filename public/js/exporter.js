/**
 * LiveMockup · 导出
 * 浏览器无法把 iframe 像素画进 canvas，所以走"捕获当前标签页 → 按舞台矩形裁切 → 重绘到固定分辨率 canvas
 * → MediaRecorder 编码"这条链路。好处是输出分辨率、画幅完全可控。
 */
(() => {
  const LONG_EDGE = 1920;

  function canvasSize(aspect) {
    const [aw, ah] = aspect.split(':').map(Number);
    const ar = aw / ah;
    let w, h;
    if (ar >= 1) {
      w = LONG_EDGE;
      h = Math.round(LONG_EDGE / ar);
    } else {
      h = LONG_EDGE;
      w = Math.round(LONG_EDGE * ar);
    }
    return { w: w - (w % 2), h: h - (h % 2) };
  }

  function pickMime() {
    const list = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    for (const m of list) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  const state = {
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    recorder: null,
    chunks: [],
    raf: 0,
    stageEl: null,
    active: false,
    startedAt: 0,
    // 真正落进画面的帧数：网页模式没法弹遮罩（会被录进去），
    // 帧号 / 速度只能靠这里数出来，显示在按钮上。
    frames: 0,
  };

  function drawFrame() {
    if (!state.active) return;
    const { video, ctx, canvas, stageEl } = state;
    if (video.videoWidth && stageEl) {
      const rect = stageEl.getBoundingClientRect();
      const scale = video.videoWidth / window.innerWidth;
      const sx = Math.round(rect.left * scale);
      const sy = Math.round(rect.top * scale);
      const sw = Math.round(rect.width * scale);
      const sh = Math.round(rect.height * scale);
      ctx.fillStyle = '#0b0c10';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        state.frames++;
      } catch (_) {}
    }
    state.raf = requestAnimationFrame(drawFrame);
  }

  /**
   * 客户端页面录制：不碰系统屏幕捕获（Electron 里 getDisplayMedia 默认 NotSupportedError），
   * 而是让主进程用 capturePage 抓「舞台矩形」那一块，逐帧喂给 ffmpeg。
   *
   * 关键点：按**墙钟**补帧。capturePage 一帧要十几毫秒，抓慢了不能把时间轴拉长，
   * 所以每个 tick 按已流逝时间补齐该有的帧数（复制当前画面），成片时长才和页面演示一致。
   */
  const client = {
    job: null, // { ctx, canvas, W, H, fps, frames, timer, t0, duration, stageEl, path, last }
  };

  function isClientCapture() {
    return !!(window.LM && window.LM.isClient && window.LM.page && window.LM.page.shot && window.LM.job);
  }

  async function startClientCapture({ stageEl, aspect, fps, duration, onBeforeRecord }) {
    const size = (window.Render && Render.canvasSize) ? Render.canvasSize(aspect) : { w: 1920, h: 1080 };
    const W = size.w;
    const H = size.h;
    if (onBeforeRecord) await onBeforeRecord();

    const beg = await window.LM.job.begin({
      width: W, height: H, fps, crf: 16, preset: 'veryfast',
      defaultName: 'livemockup-page.mp4',
    });
    if (!beg || beg.ok === false) throw new Error((beg && beg.error) || '无法开始录制');
    if (beg.canceled) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }

    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d', { alpha: false, willReadFrequently: true });

    client.job = {
      ctx, canvas: cv, W, H, fps: Math.max(1, fps), frames: 0, pushed: 0,
      timer: 0, t0: performance.now(), duration: Math.max(0.4, duration),
      stageEl, path: beg.path, last: null, stopped: false,
    };

    const tick = async () => {
      const job = client.job;
      if (!job || job.stopped) return;
      const rect = job.stageEl.getBoundingClientRect();
      const shot = await window.LM.page.shot({
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      });
      if (!job || job.stopped) return;
      if (shot && shot.ok && shot.data) {
        const bitmap = await createImageBitmap(new Blob([shot.data], { type: 'image/jpeg' }));
        ctx.fillStyle = '#0b0c10';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(bitmap, 0, 0, W, H);
        bitmap.close && bitmap.close();
        job.last = ctx.getImageData(0, 0, W, H);
      }
      // 按墙钟补齐帧数：慢的时候复制当前画面，别把时间轴拉长
      const elapsed = (performance.now() - job.t0) / 1000;
      const want = Math.min(Math.round(elapsed * job.fps), Math.round(job.duration * job.fps));
      if (job.last && want > job.pushed) {
        while (job.pushed < want) {
          const r = await window.LM.job.frame(job.last.data);
          if (r && r.ok === false) throw new Error(r.error || '写帧失败');
          job.pushed += 1;
          job.frames = job.pushed;
        }
      }
      if (!job.stopped && elapsed < job.duration) job.timer = setTimeout(tick, Math.max(0, 1000 / job.fps));
    };

    tick();
    return { width: W, height: H, native: true, path: beg.path };
  }

  async function stopClientCapture() {
    const job = client.job;
    if (!job) return null;
    job.stopped = true;
    clearTimeout(job.timer);
    client.job = null;
    // 补满时间轴（防止最后一拍还没到）
    const total = Math.round(job.duration * job.fps);
    while (job.last && job.pushed < total) {
      const r = await window.LM.job.frame(job.last.data);
      if (r && r.ok === false) break;
      job.pushed += 1;
    }
    const end = await window.LM.job.end();
    if (!end || end.ok === false) throw new Error((end && end.error) || '收尾失败');
    return { native: true, path: end.path || job.path, size: end.size || 0, frames: end.frames || job.pushed };
  }

  async function start({ stageEl, aspect = '9:16', fps = 60, bitrate = 16_000_000, onBeforeRecord, duration = 0 }) {
    const durationHint = duration;
    // 客户端：抓自己的画面，不需要屏幕捕获授权
    if (isClientCapture()) {
      return startClientCapture({ stageEl, aspect, fps, duration: durationHint, onBeforeRecord });
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前环境不支持屏幕捕获；客户端会走「抓自己画面」的路径，浏览器请用 Chrome / Edge。');
    }
    state.stageEl = stageEl;
    state.chunks = [];

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: fps,
        width: { ideal: 4096 },
        height: { ideal: 2304 },
      },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    });
    state.stream = stream;

    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('没有拿到视频轨道');
    track.addEventListener('ended', () => {
      if (state.active) state._endedByUser = true;
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    if (!video.videoWidth) {
      await new Promise((res) => {
        const done = () => res();
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 2500);
      });
    }
    state.video = video;

    const { w, h } = canvasSize(aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    state.canvas = canvas;
    // 和主渲染链路一致的显卡偏好：没有独显时浏览器会自然退回集显
    state.ctx = canvas.getContext('2d', { alpha: false, powerPreference: 'high-performance' });
    state.ctx.imageSmoothingQuality = 'high';

    // 真正的录制从这一刻开始：先让调用方收起一切不该出现在画面里的 UI
    // （导出遮罩、镜头按钮……它们盖在舞台上，会被一起录进去），
    // 再等两帧排版稳定，避免首帧是「移走遮罩的那一瞬间」。
    if (typeof onBeforeRecord === 'function') await onBeforeRecord();
    await new Promise((r) => setTimeout(r, 320));

    const cstream = canvas.captureStream(fps);
    const mime = pickMime();
    const rec = new MediaRecorder(cstream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: bitrate,
    });
    state.recorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) state.chunks.push(e.data);
    };
    rec.start(220);

    state.active = true;
    state.startedAt = performance.now();
    state.frames = 0;
    drawFrame();

    return { width: w, height: h, mime, stream };
  }

  function stop() {
    // 客户端页面录制：收尾走 ffmpeg（返回 { native, path, size }）
    if (client.job) return stopClientCapture();
    return new Promise((resolve) => {
      if (!state.recorder) return resolve(null);
      state.active = false;
      cancelAnimationFrame(state.raf);
      const finish = () => {
        const blob = new Blob(state.chunks, { type: state.chunks[0]?.type || 'video/webm' });
        state.stream?.getTracks().forEach((t) => t.stop());
        state.recorder = null;
        resolve(blob);
      };
      const rec = state.recorder;
      if (rec.state !== 'inactive') {
        rec.onstop = finish;
        rec.stop();
      } else {
        finish();
      }
    });
  }

  /**
   * 客户端里不再往「下载」目录扔文件：走原生保存对话框（用户自己选位置）。
   * 浏览器里保持原来的 a[download] 行为；原生保存失败也退回下载，别让人拿不到文件。
   */
  async function download(blob, name) {
    // 1) Electron 客户端：原生保存对话框
    if (window.LM && window.LM.isClient && window.LM.save) {
      try {
        const buf = await blob.arrayBuffer();
        const ext = String(name).split('.').pop();
        const r = await window.LM.save(buf, name, [{ name: ext.toUpperCase(), extensions: [ext] }]);
        if (r && !r.canceled && window.LM.reveal) window.LM.reveal(r.path);
        return r;
      } catch (err) {
        console.warn('[exporter] 原生保存失败，改用下载：', err && err.message);
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.Exporter = {
    start, stop, download, canvasSize,
    get active() { return state.active; },
    get endedByUser() { return !!state._endedByUser; },
    get elapsed() { return state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0; },
    /** 已经画进画布的帧数 / 实际抓取速度 */
    get frames() { return state.frames; },
    get fps() {
      const s = this.elapsed;
      return s > 0.15 ? state.frames / s : 0;
    },
  };
})();
