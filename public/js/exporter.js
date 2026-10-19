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

  async function start({ stageEl, aspect = '9:16', fps = 60, bitrate = 16_000_000, onBeforeRecord }) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前浏览器不支持屏幕捕获，请用 Chrome / Edge 打开。');
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

  function download(blob, name) {
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
