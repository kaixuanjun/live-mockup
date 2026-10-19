/**
 * LiveMockup · 主控
 * 串起：载入页面 → 录制操作 → 镜头关键帧 → 时间轴回放 → 导出视频
 */
(() => {
  const K = '__live_mockup__';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const dom = {
    urlInput: $('#urlInput'),
    loadBtn: $('#loadBtn'),
    reloadBtn: $('#reloadBtn'),
    recordBtn: $('#recordBtn'),
    playBtn: $('#playBtn'),
    exportBtn: $('#exportBtn'),
    stillBtn: $('#stillBtn'),
    frame: $('#frame'),
    videoEl: $('#videoEl'),
    modeSeg: $('#modeSeg'),
    presetList: $('#presetList'),
    videoBox: $('#videoBox'),
    dropZone: $('#dropZone'),
    videoFile: $('#videoFile'),
    videoMeta: $('#videoMeta'),
    pageHint: $('#pageHint'),
    stage: $('#stage'),
    stageLoading: $('#stageLoading'),
    stageLoadingText: $('#stageLoadingText'),
    recBadge: $('#recBadge'),
    recTime: $('#recTime'),
    frameInfo: $('#frameInfo'),
    currentT: $('#currentT'),
    inspectorBody: $('#inspectorBody'),
    durationInput: $('#durationInput'),
    rippleToggle: $('#rippleToggle'),
    autoKeyToggle: $('#autoKeyToggle'),
    statusBar: $('#statusBar'),
    glareToggle: $('#glareToggle'),
    aspectSel: $('#aspectSel'),
    deviceSeg: $('#deviceSeg'),
    colorSeg: $('#colorSeg'),
    bgList: $('#bgList'),
    moveList: $('#moveList'),
    tlPlayBtn: $('#tlPlayBtn'),
    tlAddKey: $('#tlAddKey'),
    tlClearActions: $('#tlClearActions'),
    tlCount: $('#tlCount'),
    addKeyBtn: $('#addKeyBtn'),
    delKeyBtn: $('#delKeyBtn'),
    loopToggle: $('#loopToggle'),
    exportMask: $('#exportMask'),
    exportCard: $('#exportCard'),
    exportTitle: $('#exportTitle'),
    exportMsg: $('#exportMsg'),
    exportProgress: $('#exportProgress'),
    exportHint: $('#exportHint'),
    exportPct: $('#exportPct'),
    exportGrid: $('#exportGrid'),
    exportFrames: $('#exportFrames'),
    exportFps: $('#exportFps'),
    exportEta: $('#exportEta'),
    exportFormat: $('#exportFormat'),
    exportPreview: $('#exportPreview'),
    exportCancel: $('#exportCancel'),
    appToast: $('#appToast'),
    saveProjectBtn: $('#saveProjectBtn'),
    openProjectBtn: $('#openProjectBtn'),
    projectFile: $('#projectFile'),
    toggleChromeBtn: $('#toggleChromeBtn'),
    browserUrl: null,
  };

  /* ═══════════════ 状态 ═══════════════ */

  const DEFAULT_CAM = { x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 };

  /** 内置演示：一个预设 = 一整套场景（页面 + 机型 + 画幅 + 背景） */
  const PRESETS = {
    coffee: { device: 'phone', aspect: '9:16', bg: 'aurora', color: 'midnight' },
    site: { device: 'browser', aspect: '16:9', bg: 'studio', color: 'midnight' },
  };

  /** 工程格式版本：2 = 镜头位移存「相对画面」的比例（v1 是编辑器舞台像素） */
  const PROJECT_VERSION = 2;

  const project = {
    version: PROJECT_VERSION,
    mode: 'page',                                   // 'page' 演示网页 | 'video' 播放录屏
    video: { name: '', w: 0, h: 0, duration: 0 },   // 录屏模式下的输入源信息（文件本身不持久化）
    page: { input: '', src: '', startSrc: '' },
    device: 'phone',
    color: 'midnight',
    bg: 'aurora',
    aspect: '9:16',
    duration: 12,
    camera: [],
    actions: [],
    ui: { statusBar: true, glare: true, ripple: true, autoKey: true, loop: false },
  };

  const player = {
    t: 0,
    playing: false,
    raf: 0,
    wall: 0,
    cursor: 0,
    queue: Promise.resolve(),
    agentReady: false,
    rebuilding: false,
    queuedRebuild: null,
    stopWaiters: [],
  };

  let recording = null; // {wallStart, epochStart, lastUrl}
  let videoObjectUrl = ''; // 本地文件的 blob URL，切换时释放
  let selection = null; // {kind, index}
  let pendingHello = null;
  let frameEpoch = 0;
  let currentFrameUrl = '';
  let lastTapAt = 0;
  let pendingTargetT = 0;
  let reconcileTimer = null;
  const rpc = new Map();
  let rpcId = 1;

  /* ═══════════════ 工具 ═══════════════ */

  function toast(msg, ms = 2400) {
    dom.appToast.textContent = msg;
    dom.appToast.classList.add('is-on');
    clearTimeout(toast._h);
    toast._h = setTimeout(() => dom.appToast.classList.remove('is-on'), ms);
  }

  function fmt(t) {
    const s = Math.max(0, t);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
  }

  function showLoading(text) {
    dom.stageLoadingText.textContent = text || '载入页面…';
    dom.stageLoading.classList.add('is-on');
  }
  function hideLoading() {
    dom.stageLoading.classList.remove('is-on');
  }

  /** 本地开发地址一律走 http：dev server 通常没有证书，补 https 会直接 502 */
  function looksLocal(u) {
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.local)(:\d+)?(\/|$)/i.test(u)
      || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(u);
  }

  /** 规范成绝对地址：URL 会补上站点根的尾斜杠，否则相对路径会解析到父级去 */
  function normalizeAbs(u) {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  }

  function toFrameSrc(input) {
    const u = String(input || '').trim();
    if (!u) return '';
    if (u.startsWith('/')) return u;
    if (/^https?:\/\//i.test(u)) return '/p/' + normalizeAbs(u);
    // 没写协议：本地地址补 http，其余补 https（远端多会自己 301 到 https，代理会跟着改写）
    const scheme = looksLocal(u) ? 'http://' : 'https://';
    return '/p/' + normalizeAbs(scheme + u.replace(/^\/+/, ''));
  }

  function frameSrcFromUrl(u) {
    try {
      const url = new URL(u);
      return url.pathname + url.search + url.hash;
    } catch {
      return u;
    }
  }

  /* ═══════════════ 录屏视频模式 ═══════════════ */

  const isVideo = () => project.mode === 'video';
  const videoDur = () => Number(project.video.duration) || 0;

  /**
   * 导出/舞台用的画幅。录屏模式下选了「自适应」时，
   * 直接把输入视频的像素比例交给 Exporter，避免多一次缩放糊掉。
   */
  /**
   * 场景级规格：机型 / 屏幕尺寸 / 输出画幅。**整段视频只有这一份，不跟关键帧走。**
   * 预览（Stage）和渲染（Render）都从这里取，两边不再各算一套。
   */
  function sceneSpec() {
    const autoSize = Stage.autoSize
      || (project.video.w && project.video.h ? { w: project.video.w, h: project.video.h } : null);
    return {
      device: project.device,
      autoSize: project.device === 'auto' ? autoSize : null,
      aspect: effectiveAspect(),
    };
  }

  /**
   * 输出画框：镜头里的 x/y 是它宽/高的比例，z 是它透视距离的比例。
   * 面板读数按这个画框换算成 px —— 和成片同一参考系，换窗口、换电脑都不变。
   */
  function outFrame() {
    const { w, h } = Render.canvasSize(effectiveAspect());
    return { w, h, persp: Stage.perspOf(h) };
  }

  function effectiveAspect() {
    if (project.aspect !== 'auto') return project.aspect;
    const s = Stage.autoSize || (project.video.w ? { w: project.video.w, h: project.video.h } : null);
    if (s && s.w && s.h) return `${Math.round(s.w)}:${Math.round(s.h)}`;
    return '9:16';
  }

  function setMode(mode, silent) {
    project.mode = mode === 'video' ? 'video' : 'page';
    const video = isVideo();
    document.body.classList.toggle('mode-video', video);
    dom.modeSeg?.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.mode === project.mode);
    });
    if (dom.videoBox) dom.videoBox.hidden = !video;
    if (dom.presetList) dom.presetList.hidden = video;
    if (dom.pageHint) dom.pageHint.hidden = video;
    dom.recordBtn.disabled = video;
    dom.recordBtn.title = video ? '录屏模式下没有可录的操作' : '在样机里点几下，动作会变成时间轴上的点';
    // 「自适应」只在录屏模式有意义：尺寸/画幅都跟着输入视频走
    const autoDev = dom.deviceSeg.querySelector('[data-device="auto"]');
    if (autoDev) autoDev.disabled = !video;
    const autoAsp = dom.aspectSel.querySelector('option[value="auto"]');
    if (autoAsp) autoAsp.disabled = !video;
    dom.urlInput.placeholder = video
      ? '粘贴视频直链（mp4 / webm），或从左侧选本地录屏'
      : '输入网址，或选择左侧内置演示页';
    if (video && !/^https?:/i.test(dom.urlInput.value || '')) dom.urlInput.value = '';
    if (!video) {
      if (project.device === 'auto') setDevice('phone', true);
      if (project.aspect === 'auto') setAspect('9:16', true);
      document.body.classList.remove('mode-video');
    }
    if (!silent) autosave();
  }

  /**
   * 读时长。MediaRecorder 产出的 WebM 常常把 duration 报成 Infinity，
   * 这时只能「先 seek 到极远处」逼浏览器算出真实长度——用户自己录的屏基本都是这种文件。
   */
  function readDuration(v) {
    if (Number.isFinite(v.duration) && v.duration > 0) return Promise.resolve(v.duration);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (d) => {
        if (settled) return;
        settled = true;
        v.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        try { v.currentTime = 0; } catch (_) {}
        resolve(Number.isFinite(d) && d > 0 ? d : 0);
      };
      const onSeeked = () => finish(v.duration > 0 && Number.isFinite(v.duration) ? v.duration : v.currentTime);
      const timer = setTimeout(() => finish(v.duration), 1600);
      v.addEventListener('seeked', onSeeked);
      try { v.currentTime = 1e101; } catch (_) { finish(0); }
    });
  }

  /**
   * 把 src 挂到 <video> 上并等元数据。
   * 拿不到 videoWidth 说明容器/编码浏览器放不了（比如 mkv），要明确报错而不是留个黑屏。
   */
  function attachVideoSrc(src) {
    return new Promise((resolve, reject) => {
      const v = dom.videoEl;
      let done = false;
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', bad);
        clearTimeout(timer);
      };
      const ok = async () => {
        if (done) return;
        done = true;
        cleanup();
        if (!v.videoWidth || !v.videoHeight) {
          return reject(new Error('读不到视频尺寸，可能编码不被浏览器支持'));
        }
        const duration = await readDuration(v);
        resolve({ w: v.videoWidth, h: v.videoHeight, duration });
      };
      const bad = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('视频载入失败：格式不支持，或该地址不允许跨站播放'));
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('视频读取超时（12 秒）'));
      }, 12000);
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', bad);
      v.src = src;
      v.load();
    });
  }

  /** source: File 或 http(s) 地址 */
  async function loadVideo(source, name) {
    stopPlay();
    recording = null;
    setMode('video', true);

    let src = typeof source === 'string' ? source : '';
    if (typeof source === 'string') {
      if (videoObjectUrl) { URL.revokeObjectURL(videoObjectUrl); videoObjectUrl = ''; }
    } else {
      if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
      videoObjectUrl = URL.createObjectURL(source);
      src = videoObjectUrl;
    }

    showLoading('读取视频…');
    try {
      const prev = { ...project.video };
      const meta = await attachVideoSrc(src);
      const label = name || (source && source.name) || src.split('/').pop() || 'video';
      // 本地视频文件浏览器不给我们记住路径，重开工程必须重新选一次文件。
      // 只要选的还是同一段（同名同分辨率），就不能动镜头轨和时长 ——
      // 否则每次「重新选文件」都会把整条运镜清成一个默认机位。
      const relink = project.camera.length > 0
        && prev.w === meta.w && prev.h === meta.h
        && (!prev.name || prev.name === label);
      project.video = { name: label, w: meta.w, h: meta.h, duration: meta.duration };
      project.page = { input: label, src, startSrc: src };
      project.actions = [];
      player.cursor = 0;
      selection = null;
      Stage.setAutoSize(meta.w, meta.h);
      setDevice('auto', true);
      setAspect('auto', true);
      const dur = Math.round(meta.duration * 100) / 100;
      if (!relink) {
        project.duration = dur > 0 ? Math.min(120, Math.max(1, dur)) : 12;
        project.camera = [{ t: 0, ...DEFAULT_CAM }];
      }
      dom.durationInput.value = String(project.duration);
      if (dom.videoMeta) dom.videoMeta.textContent = `${meta.w}×${meta.h} · ${fmt(meta.duration)} · ${label}`;
      // 地址栏在录屏模式下是「视频直链」输入框：本地文件就别留个假地址在那儿
      dom.urlInput.value = /^https?:/i.test(src) ? src : '';
      if (dom.dropZone) dom.dropZone.classList.add('is-loaded');
      dom.frameInfo.textContent = `录屏 · ${meta.w}×${meta.h}`;
      seek(0);
      refreshTimeline();
      renderInspector();
      autosave();
      const cut = dur > 120 ? `，时间轴只取前 120 秒` : '';
      if (relink) {
        toast(`已重新接上录屏 · ${meta.w}×${meta.h} · 镜头与时间轴都保留`, 3600);
      } else {
        toast(`已载入录屏 · ${meta.w}×${meta.h} · ${fmt(meta.duration)}${cut}`, 3200);
      }
    } catch (err) {
      if (dom.videoMeta) dom.videoMeta.textContent = `载入失败：${err.message || err}`;
      toast(`视频载入失败：${err.message || err}`, 3600);
    } finally {
      hideLoading();
    }
  }

  /** 把 <video> 的播放位置对齐到 t（播放中不打断，只对齐） */
  function syncVideo(t) {
    if (!isVideo()) return;
    const v = dom.videoEl;
    if (!v.src) return;
    const d = videoDur() || (Number.isFinite(v.duration) ? v.duration : 0);
    const target = clamp(t, 0, d ? Math.max(0, d - 0.02) : t);
    if (Math.abs((v.currentTime || 0) - target) > 0.03) {
      try { v.currentTime = target; } catch (_) { /* 元数据还没就绪 */ }
    }
  }

  /* ═══════════════ 与页面通信 ═══════════════ */

  function send(type, payload = {}, timeout = 4500) {
    return new Promise((resolve) => {
      if (!dom.frame.contentWindow) return resolve({ ok: false, error: 'no-frame' });
      const id = rpcId++;
      rpc.set(id, resolve);
      try {
        dom.frame.contentWindow.postMessage({ [K]: 1, id, type, ...payload }, '*');
      } catch (e) {
        rpc.delete(id);
        return resolve({ ok: false, error: String(e) });
      }
      setTimeout(() => {
        if (rpc.has(id)) {
          rpc.delete(id);
          resolve({ ok: false, error: 'timeout' });
        }
      }, timeout);
    });
  }

  function loadFrame(src, { silent = false } = {}) {
    return new Promise((resolve) => {
      if (!src) return resolve({ ok: false });
      frameEpoch++;
      const epoch = frameEpoch;
      player.agentReady = false;
      pendingHello = {
        epoch,
        resolve: (msg) => resolve({ ok: true, ...msg }),
      };
      if (!silent) showLoading('载入页面…');
      if (dom.frame.getAttribute('src') === src) {
        try {
          dom.frame.contentWindow.location.reload();
        } catch (_) {
          dom.frame.src = src;
        }
      } else {
        dom.frame.src = src;
      }
      setTimeout(() => {
        if (pendingHello && pendingHello.epoch === epoch) {
          pendingHello = null;
          hideLoading();
          resolve({ ok: false, timeout: true });
        }
      }, 15000);
    });
  }

  function onHello(msg) {
    player.agentReady = true;
    const src = frameSrcFromUrl(msg.url);
    const prev = currentFrameUrl;
    currentFrameUrl = src;
    dom.frameInfo.textContent = `${msg.vw}×${msg.vh} · ${src.replace(/^\/p\//, '') || '空白'}`;
    if (msg.title) document.title = `${msg.title} · LiveMockup`;
    Stage.setBrowserUrl(src.replace(/^\/p\//, ''));

    // 恢复模式（页面重载后 agent 会重置）
    send('config', { ripple: project.ui.ripple !== false });
    if (recording) {
      send('set-mode', { mode: 'record' });
    } else if (player.playing) {
      send('set-mode', { mode: 'play' });
    }

    // 录制期间发生跳转 → 记录 navigate
    if (recording && prev && src !== prev) {
      const causedByTap = lastTapAt && Date.now() - lastTapAt < 1500;
      if (!causedByTap) {
        pushAction({ type: 'navigate', url: msg.url, src, label: '跳转到 ' + src.replace(/^\/p\//, '') });
      }
      recording.lastUrl = src;
    }

    if (pendingHello && pendingHello.epoch === frameEpoch) {
      const p = pendingHello;
      pendingHello = null;
      hideLoading();
      p.resolve(msg);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== dom.frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d[K] !== 1) return;

    if (d.type === 'hello') return onHello(d);
    if (d.type === 'ack') {
      const fn = rpc.get(d.id);
      if (fn) {
        rpc.delete(d.id);
        fn(d);
      }
      return;
    }
    if (d.type === 'event') return onAgentEvent(d.action);
    if (d.type === 'nav') {
      if (recording) {
        const causedByTap = lastTapAt && Date.now() - lastTapAt < 1500;
        if (!causedByTap && d.url) {
          pushAction({ type: 'navigate', url: d.url, src: frameSrcFromUrl(d.url), label: '路由跳转' });
        }
        recording.lastUrl = frameSrcFromUrl(d.url);
      }
    }
  });

  /* ═══════════════ 录制 ═══════════════ */

  function pushAction(a) {
    const t = clamp((Date.now() - recording.epochStart) / 1000, 0, 120);
    a.t = Math.round(t * 1000) / 1000;
    if (a.type === 'tap') lastTapAt = Date.now();
    project.actions.push(a);
    project.actions.sort((x, y) => x.t - y.t);
    project.duration = Math.max(project.duration, Math.ceil((a.t + 0.8) * 2) / 2);
    player.cursor = project.actions.length;
    refreshTimeline();
    Timeline.setTime(project.t);
  }

  function onAgentEvent(a) {
    if (!recording || !a) return;
    const t = ((a.at || Date.now()) - recording.epochStart) / 1000;
    delete a.at;
    a.t = Math.round(clamp(t, 0, 120) * 1000) / 1000;
    if (a.type === 'tap') lastTapAt = Date.now();

    // 连续输入同一元素 → 合并为一条
    const last = project.actions[project.actions.length - 1];
    if (a.type === 'type' && last && last.type === 'type' && last.selector === a.selector) {
      last.value = a.value;
      last.t = a.t;
      last.label = a.label;
      refreshTimeline();
      return;
    }

    project.actions.push(a);
    project.actions.sort((x, y) => x.t - y.t);
    project.duration = Math.max(project.duration, Math.ceil((a.t + 0.8) * 2) / 2);
    dom.durationInput.value = project.duration.toFixed(1);
    player.cursor = project.actions.length;
    refreshTimeline();
    Timeline.setTime(project.t);
  }

  async function startRecording() {
    if (!project.page.src) return toast('先载入一个页面');
    if (project.actions.length) {
      const ok = confirm(`录制会替换现有 ${project.actions.length} 个动作（镜头关键帧保留）。继续？`);
      if (!ok) return;
    }
    stopPlay();
    project.actions = [];
    project.camera = project.camera.length ? project.camera : [{ t: 0, ...DEFAULT_CAM }];
    project.duration = 12;
    dom.durationInput.value = '12';
    await loadFrame(project.page.src);
    await sleep(350);
    await send('set-mode', { mode: 'record' });

    recording = {
      wallStart: performance.now(),
      epochStart: Date.now(),
      lastUrl: currentFrameUrl,
    };
    player.cursor = 0;
    project.t = 0;
    Stage.apply(DEFAULT_CAM);
    Timeline.setTime(0);
    refreshTimeline();
    dom.recordBtn.classList.add('is-on');
    dom.recordBtn.innerHTML = '<span class="dot"></span>停止录制';
    dom.recBadge.classList.add('is-on');
    $('.timeline').classList.add('recording');
    if (!player.agentReady) toast('页面运行时没有响应，录制可能为空', 3200);
    recordingTick();
  }

  function recordingTick() {
    if (!recording) return;
    const t = (Date.now() - recording.epochStart) / 1000;
    dom.recTime.textContent = fmt(t);
    requestAnimationFrame(recordingTick);
  }

  async function stopRecording() {
    if (!recording) return;
    const t = (Date.now() - recording.epochStart) / 1000;
    recording = null;
    dom.recordBtn.classList.remove('is-on');
    dom.recordBtn.innerHTML = '<span class="dot"></span>录制操作';
    dom.recBadge.classList.remove('is-on');
    $('.timeline').classList.remove('recording');
    await send('set-mode', { mode: 'idle' });
    project.duration = Math.max(3, Math.ceil((t + 0.8) * 2) / 2);
    dom.durationInput.value = project.duration;
    if (!project.camera.length) applyMove('push', { silent: true });
    await ensureStateAt(0);
    refreshTimeline();
    autosave();
    toast(`录制完成：${project.actions.length} 个动作`);
  }

  /* ═══════════════ 镜头关键帧 ═══════════════ */

  function addKeyAt(t, cam, ease = 'easeInOut') {
    const tt = Math.round(clamp(t, 0, project.duration) * 1000) / 1000;
    const existing = project.camera.findIndex((k) => Math.abs(k.t - tt) < 0.06);
    // 注意顺序：t / ease 必须最后写，姿态里若混进残渣也不能把它们覆盖掉
    const key = { ...DEFAULT_CAM, ...cam, t: tt, ease };
    let ref;
    if (existing >= 0) {
      Object.assign(project.camera[existing], key);
      ref = project.camera[existing];
    } else {
      ref = key;
      project.camera.push(key);
    }
    project.camera.sort((a, b) => a.t - b.t);
    refreshTimeline();
    return project.camera.indexOf(ref);
  }

  function nearestKey(t, tol = 0.35) {
    let best = -1;
    let bd = Infinity;
    project.camera.forEach((k, i) => {
      const d = Math.abs(k.t - t);
      if (d < bd) { bd = d; best = i; }
    });
    return bd <= tol ? best : -1;
  }

  const MOVES = {
    push: (d) => [
      { t: 0, ...DEFAULT_CAM, ry: -10, scale: 0.94, ease: 'easeInOut' },
      { t: d, ...DEFAULT_CAM, ry: -14, scale: 1.16, y: -0.031, ease: 'easeInOut' },
    ],
    orbit: (d) => [
      { t: 0, ...DEFAULT_CAM, ry: -34, rx: 4, scale: 0.94, ease: 'easeInOut' },
      { t: d * 0.55, ...DEFAULT_CAM, ry: 8, rx: 1, scale: 1.02, ease: 'easeInOut' },
      { t: d, ...DEFAULT_CAM, ry: 32, rx: -2, scale: 0.96, ease: 'easeInOut' },
    ],
    // y 是「画框高度的比例」（v2 单位）：0.045 ≈ 参考画框上的 26px
    float: (d) => [
      { t: 0, ...DEFAULT_CAM, y: 0.045, ry: -14, scale: 0.98, ease: 'easeOut' },
      { t: d, ...DEFAULT_CAM, y: -0.052, ry: -10, scale: 1.04, ease: 'easeInOut' },
    ],
    breathe: (d) => [
      { t: 0, ...DEFAULT_CAM, scale: 1, ease: 'easeInOut' },
      { t: d * 0.5, ...DEFAULT_CAM, scale: 1.035, ease: 'easeInOut' },
      { t: d, ...DEFAULT_CAM, scale: 1, ease: 'easeInOut' },
    ],
    reset: () => [{ t: 0, ...DEFAULT_CAM }],
  };

  function applyMove(name, opt = {}) {
    const fn = MOVES[name];
    if (!fn) return;
    project.camera = fn(project.duration).map((k) => ({ ...k }));
    Stage.apply(Stage.sample(project.camera, project.t));
    refreshTimeline();
    if (!opt.silent) toast('已生成镜头关键帧，可继续微调');
  }

  /* ═══════════════ 时间轴 / 播放 ═══════════════ */

  function refreshTimeline() {
    Timeline.render({
      duration: project.duration,
      camera: project.camera,
      actions: project.actions,
      t: project.t,
      selection,
      recording: !!recording,
    });
    dom.currentT.textContent = `${fmt(project.t)} / ${fmt(project.duration)}`;
    dom.tlCount.textContent = `${project.actions.length} 个动作 · ${project.camera.length} 个关键帧`;
  }

  function applyCameraAt(t) {
    Stage.apply(Stage.sample(project.camera, t));
  }

  /** 只刷新检视器顶部两行读数（播放头 / 段进度 / 此刻机位）。
   *  整块 renderInspector 会重建 DOM，播放中每帧调一次会打断正在拖的滑块。 */
  function refreshReadout() {
    if (!selection || selection.kind !== 'cam') return;
    const k = project.camera[selection.index];
    if (!k) return;
    const el = dom.inspectorBody.querySelector('.readout');
    const dim = dom.inspectorBody.querySelector('.readout--dim');
    if (!el || !dim) return;
    const seg = Stage.segmentAt(project.camera, project.t);
    const inSeg = !!(seg && seg.span && seg.raw > 0 && seg.raw < 1);
    const prog = seg && seg.span ? Math.round(clamp(seg.raw, 0, 1) * 100) : 0;
    const nextKey = project.camera[selection.index + 1];
    const cur = Stage.sample(project.camera, project.t);
    el.innerHTML = `<span>播放头 ${fmt(project.t)}</span><span class="sep">·</span>`
      + `<span>${inSeg ? `段内 ${prog}%` : (nextKey ? '段外（在帧上）' : '末帧')}</span>`;
    dim.textContent = `此刻机位 x${Math.round(cur.x)} y${Math.round(cur.y)} ry${Math.round(cur.ry)}° ${cur.scale.toFixed(2)}×`;
  }

  function seek(t, immediate = false) {
    player.t = clamp(t, 0, project.duration);
    project.t = player.t;
    applyCameraAt(player.t);
    Timeline.setTime(player.t);
    refreshReadout();
    dom.currentT.textContent = `${fmt(player.t)} / ${fmt(project.duration)}`;
    if (isVideo()) {
      // 拖动时间轴时别让视频继续播，否则画面和播放头对不上
      if (player.playing) stopPlay();
      syncVideo(player.t);
      return;
    }
    if (immediate) {
      scheduleReconcile(player.t, 130);
    }
  }

  function scheduleReconcile(targetT, delay = 140) {
    pendingTargetT = targetT;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => { runReconcile(targetT); }, delay);
  }

  function actionsUpTo(t) {
    let n = 0;
    for (const a of project.actions) if (a.t <= t + 1e-4) n++;
    return n;
  }

  async function runReconcile(targetT) {
    if (player.rebuilding) {
      player.queuedRebuild = targetT;
      return;
    }
    const need = actionsUpTo(targetT);
    if (need < player.cursor) return rebuildTo(targetT);
    while (player.cursor < need) {
      if (Math.abs(pendingTargetT - targetT) > 0.001 && !player.playing) return;
      const a = project.actions[player.cursor];
      await execAction(a);
      player.cursor++;
    }
  }

  async function ensureStateAt(t) {
    clearTimeout(reconcileTimer);
    pendingTargetT = t;
    const need = actionsUpTo(t);
    if (need === player.cursor) return;
    await (need < player.cursor ? rebuildTo(t) : runReconcile(t));
  }

  async function rebuildTo(t) {
    if (player.rebuilding) { player.queuedRebuild = t; return; }
    player.rebuilding = true;
    showLoading('重建页面状态…');
    try {
      await loadFrame(project.page.startSrc, { silent: true });
      player.cursor = 0;
      const need = actionsUpTo(t);
      for (let i = 0; i < need; i++) {
        await execAction(project.actions[i]);
        player.cursor = i + 1;
      }
    } catch (_) {
    } finally {
      player.rebuilding = false;
      hideLoading();
    }
    if (player.queuedRebuild != null) {
      const q = player.queuedRebuild;
      player.queuedRebuild = null;
      if (Math.abs(q - t) > 0.05) {
        const need = actionsUpTo(q);
        if (need < player.cursor) await rebuildTo(q);
        else await runReconcile(q);
      }
    }
  }

  async function execAction(a) {
    if (!a) return;
    if (a.type === 'navigate') {
      await loadFrame(a.src || toFrameSrc(a.url), { silent: true });
      await sleep(120);
      return;
    }
    const before = currentFrameUrl;
    const res = await send('exec', { action: a });
    a._failed = !res.ok;
    if (!res.ok && res.error !== 'timeout') {
      // 元素没找到：不打断播放
    }
    if (a.type === 'tap') {
      await sleep(150);
      if (currentFrameUrl !== before) {
        // 点击引发了跳转，等新页面就绪
        await new Promise((resolve) => {
          const started = Date.now();
          const iv = setInterval(() => {
            if (player.agentReady && currentFrameUrl !== before) {
              clearInterval(iv);
              resolve();
            } else if (Date.now() - started > 6000) {
              clearInterval(iv);
              resolve();
            }
          }, 100);
        });
        await sleep(120);
      }
    }
  }

  function setPlayIcon(playing) {
    dom.playBtn.textContent = playing ? '❚❚' : '▶';
    dom.tlPlayBtn.textContent = playing ? '❚❚' : '▶';
  }

  async function play() {
    if (player.playing) return;
    if (project.t >= project.duration - 0.03) {
      seek(0);
      await ensureStateAt(0);
    }
    if (isVideo()) {
      // 视频模式没有 agent：不要 send('set-mode')，否则 RPC 会等到超时
      const v = dom.videoEl;
      if (!v.src) return toast('还没有选择录屏视频', 3000);
      syncVideo(project.t);
      player.playing = true;
      setPlayIcon(true);
      try { await v.play(); } catch (_) { /* 用户没交互时可能被拒，rAF 仍会推进 */ }
      tick();
      return;
    }
    await send('set-mode', { mode: 'play' });
    player.playing = true;
    setPlayIcon(true);
    player.wall = performance.now() - player.t * 1000;
    tick();
  }

  function stopPlay() {
    if (!player.playing) return;
    player.playing = false;
    cancelAnimationFrame(player.raf);
    setPlayIcon(false);
    if (isVideo()) {
      try { dom.videoEl.pause(); } catch (_) {}
    } else {
      send('set-mode', { mode: 'idle' });
    }
    player.stopWaiters.splice(0).forEach((fn) => fn());
  }

  /** 播放自然结束（视频播完 / 到达时间轴末尾）：统一收尾 + 循环 */
  function finishPlaying() {
    player.playing = false;
    cancelAnimationFrame(player.raf);
    setPlayIcon(false);
    if (isVideo()) {
      try { dom.videoEl.pause(); } catch (_) {}
    } else {
      send('set-mode', { mode: 'idle' });
    }
    player.stopWaiters.splice(0).forEach((fn) => fn());
    if (project.ui.loop) {
      setTimeout(async () => {
        seek(0);
        await ensureStateAt(0);
        play();
      }, 380);
    }
  }

  /** 视频当时间轴：每帧读 currentTime 驱动镜头与播放头 */
  function tickVideo() {
    if (!player.playing) return;
    const v = dom.videoEl;
    const d = videoDur() || (Number.isFinite(v.duration) ? v.duration : 0);
    const t = Math.min(project.duration, Math.max(0, v.currentTime || 0));
    player.t = t;
    project.t = t;
    applyCameraAt(t);
    Timeline.setTime(t);
    refreshReadout();
    dom.currentT.textContent = `${fmt(t)} / ${fmt(project.duration)}`;
    const ended = v.ended || (d > 0 && v.currentTime >= d - 0.06);
    if (ended || t >= project.duration - 0.02) {
      player.t = Math.min(project.duration, t);
      project.t = player.t;
      dom.currentT.textContent = `${fmt(project.t)} / ${fmt(project.duration)}`;
      finishPlaying();
      return;
    }
    player.raf = requestAnimationFrame(tickVideo);
  }

  function tick() {
    if (!player.playing) return;
    if (isVideo()) return tickVideo();
    const t = (performance.now() - player.wall) / 1000;
    if (t >= project.duration) {
      player.t = project.duration;
      project.t = project.duration;
      applyCameraAt(project.duration);
      Timeline.setTime(project.duration);
      dom.currentT.textContent = `${fmt(project.duration)} / ${fmt(project.duration)}`;
      finishPlaying();
      return;
    }
    player.t = t;
    project.t = t;
    applyCameraAt(t);
    Timeline.setTime(t);
    dom.currentT.textContent = `${fmt(t)} / ${fmt(project.duration)}`;
    while (player.cursor < project.actions.length && project.actions[player.cursor].t <= t) {
      const a = project.actions[player.cursor++];
      player.queue = player.queue.then(() => execAction(a)).catch(() => {});
    }
    player.raf = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (player.playing) stopPlay();
    else await play();
  }

  /* ═══════════════ 检视器 ═══════════════ */

  /* ── 缓动曲线 ── */

  const CURVE_W = 246;
  const CURVE_H = 124;
  const CURVE_PAD = 12;
  const CURVE_VLO = -0.3;
  const CURVE_VHI = 1.3;

  const cvx = (t) => CURVE_PAD + t * (CURVE_W - CURVE_PAD * 2);
  const cvy = (v) => CURVE_PAD + ((CURVE_VHI - v) / (CURVE_VHI - CURVE_VLO)) * (CURVE_H - CURVE_PAD * 2);

  function keyBezier(k) {
    if (Array.isArray(k.bezier) && k.bezier.length === 4) return k.bezier.slice();
    const p = Stage.BEZIER_PRESETS[k.ease] || Stage.BEZIER_PRESETS.easeInOut;
    return p.slice();
  }

  function presetOfKey(k) {
    if (k.hold || (Array.isArray(k.bezier) && k.bezier.length === 4)) return null;
    return Stage.BEZIER_PRESETS[k.ease] ? k.ease : 'easeInOut';
  }

  function curvePath(b) {
    const [x1, y1, x2, y2] = b;
    const pt = (t) => {
      const u = 1 - t;
      const x = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
      const y = 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
      return [cvx(x), cvy(y)];
    };
    let d = '';
    for (let i = 0; i <= 40; i++) {
      const [x, y] = pt(i / 40);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  }

  function paintCurve(svg, k) {
    const b = keyBezier(k);
    const el1 = svg.querySelector('.h1');
    const el2 = svg.querySelector('.h2');
    const l1 = svg.querySelector('.l1');
    const l2 = svg.querySelector('.l2');
    svg.querySelector('.curve__path').setAttribute('d', curvePath(b));
    el1.setAttribute('cx', cvx(b[0]).toFixed(1));
    el1.setAttribute('cy', cvy(b[1]).toFixed(1));
    el2.setAttribute('cx', cvx(b[2]).toFixed(1));
    el2.setAttribute('cy', cvy(b[3]).toFixed(1));
    l1.setAttribute('x2', cvx(b[0]).toFixed(1));
    l1.setAttribute('y2', cvy(b[1]).toFixed(1));
    l2.setAttribute('x2', cvx(b[2]).toFixed(1));
    l2.setAttribute('y2', cvy(b[3]).toFixed(1));
    svg.classList.toggle('is-hold', !!k.hold);
  }

  function bindCurve(box, k) {
    const svg = box.querySelector('.curve');
    if (!svg) return;
    let which = 0;
    const toVal = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = CURVE_W / (r.width || CURVE_W);
      const sy = CURVE_H / (r.height || CURVE_H);
      const x = (ev.clientX - r.left) * sx;
      const y = (ev.clientY - r.top) * sy;
      const tx = (x - CURVE_PAD) / (CURVE_W - CURVE_PAD * 2);
      const vy = CURVE_VHI - ((y - CURVE_PAD) / (CURVE_H - CURVE_PAD * 2)) * (CURVE_VHI - CURVE_VLO);
      return { x: clamp(tx, 0, 1), y: clamp(vy, CURVE_VLO, CURVE_VHI) };
    };
    const grab = (ev, n) => {
      ev.preventDefault();
      ev.stopPropagation();
      which = n;
      k.hold = false;
      svg.classList.add('dragging');
      svg.setPointerCapture?.(ev.pointerId);
      // 播放头若不在受这段缓动影响的区间里，先挪进去，拖手柄时才看得到变化
      const j = project.camera.indexOf(k);
      const nx = project.camera[j + 1];
      if (nx && (project.t <= k.t + 0.01 || project.t >= nx.t - 0.01)) {
        seek((k.t + nx.t) / 2, false);
      }
    };
    svg.querySelector('.h1').addEventListener('pointerdown', (ev) => grab(ev, 1));
    svg.querySelector('.h2').addEventListener('pointerdown', (ev) => grab(ev, 2));
    svg.addEventListener('pointermove', (ev) => {
      if (!which) return;
      const p = toVal(ev);
      const b = keyBezier(k);
      if (which === 1) { b[0] = p.x; b[1] = p.y; } else { b[2] = p.x; b[3] = p.y; }
      k.bezier = b;
      delete k.ease;
      paintCurve(svg, k);
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
      const ro = box.querySelector('.curve__readout');
      if (ro) ro.textContent = `cubic-bezier(${b.map((n) => n.toFixed(2)).join(', ')})`;
      svg.classList.remove('is-hold');
      applyCameraAt(project.t);
    });
    const release = () => {
      if (!which) return;
      which = 0;
      svg.classList.remove('dragging');
      refreshTimeline();
      autosave();
      renderInspector();
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
  }

  /* ── 关键帧小工具 ── */

  let poseClip = null;

  const roundT = (t) => Math.round(clamp(t, 0, project.duration) * 100) / 100;

  function keyListHtml() {
    if (project.camera.length < 2) return '';
    const rows = project.camera.map((k, i) => {
      const p = presetOfKey(k);
      const ease = k.hold ? '保持' : (p ? Stage.PRESET_LABEL[p] : '自定义');
      const on = selection && selection.kind === 'cam' && (i === selection.index || (selection.extra || []).includes(i));
      return `<button class="krow${on ? ' is-sel' : ''}" data-goto="${i}">
        <span class="krow__t">${fmt(k.t)}</span>
        <span class="krow__e">${ease}</span>
      </button>`;
    }).join('');
    return `<div class="insp-sec">全部关键帧 <span class="dim">${project.camera.length}</span></div>
      <div class="insp-list">${rows}</div>`;
  }

  function duplicateKey(index) {
    const src = project.camera[index];
    if (!src) return;
    const t = roundT(src.t + 0.2);
    const copy = { ...src, t };
    project.camera.push(copy);
    project.camera.sort((a, b) => a.t - b.t);
    selection = { kind: 'cam', index: project.camera.indexOf(copy), extra: [] };
    applyCameraAt(project.t);
    refreshTimeline();
    autosave();
    renderInspector();
    toast(`已复制到 ${fmt(t)}`);
  }

  /** 把超出时长的关键帧拉回时间轴内（改短时长时用） */
  function clampKeysToDuration() {
    let moved = 0;
    project.camera.forEach((k) => {
      if (k.t > project.duration) { k.t = project.duration; moved++; }
    });
    if (moved) {
      project.camera.sort((a, b) => a.t - b.t);
      toast(`${moved} 个关键帧被拉到新的结尾`);
    }
  }

  /** 载入/导入时归一化关键帧：排序、补默认缓动、夹时间 */
  function normalizeCamera() {
    const list = Array.isArray(project.camera) ? project.camera : [];
    list.forEach((k) => {
      k.t = Math.max(0, Number(k.t) || 0);
      if (!k.hold && !Array.isArray(k.bezier) && !Stage.BEZIER_PRESETS[k.ease]) k.ease = 'easeInOut';
      ['x', 'y', 'z', 'rx', 'ry', 'rz'].forEach((f) => {
        if (!Number.isFinite(Number(k[f]))) k[f] = DEFAULT_CAM[f];
        else k[f] = Number(k[f]);
      });
      if (!Number.isFinite(Number(k.scale)) || Number(k.scale) <= 0) k.scale = 1;
      else k.scale = Number(k.scale);
    });
    list.sort((a, b) => a.t - b.t);
    project.camera = list;
  }

  function renderInspector() {
    const box = dom.inspectorBody;
    box.classList.remove('inspector-empty');
    if (!selection) {
      box.className = 'inspector-empty';
      box.innerHTML = `
        <p class="hint">在时间轴上选择镜头关键帧或页面动作，即可在这里微调。</p>
        <ul class="tips">
          <li><b>录制操作</b>：在样机里真实点几下，动作会变成时间轴上的点。</li>
          <li><b>拖动舞台</b>：调整镜头角度。</li>
          <li><b>+ 关键帧</b>：把当前镜头姿态固定到一个时间点。</li>
        </ul>`;
      return;
    }

    if (selection.kind === 'cam') {
      const k = project.camera[selection.index];
      if (!k) { selection = null; return renderInspector(); }
      const b = keyBezier(k);
      const preset = presetOfKey(k);
      const seg = Stage.segmentAt(project.camera, project.t);
      const cur = Stage.sample(project.camera, project.t);
      const inSeg = !!(seg && seg.span && seg.raw > 0 && seg.raw < 1);
      const prog = seg && seg.span ? Math.round(clamp(seg.raw, 0, 1) * 100) : 0;
      const multi = (selection.extra || []).length;
      const nextKey = project.camera[selection.index + 1];
      const of = outFrame();

      box.innerHTML = `
        <div class="insp-head">
          <span class="tag tag--cam">镜头</span>
          <span class="t">${fmt(k.t)}</span>
          ${multi ? `<span class="dim">+${multi}</span>` : ''}
        </div>
        <div class="readout">
          <span>播放头 ${fmt(project.t)}</span>
          <span class="sep">·</span>
          <span>${inSeg ? `段内 ${prog}%` : (nextKey ? '段外（在帧上）' : '末帧')}</span>
        </div>
        <div class="readout readout--dim">此刻机位 x${Math.round(cur.x * of.w)} y${Math.round(cur.y * of.h)} ry${Math.round(cur.ry)}° ${cur.scale.toFixed(2)}×</div>
        ${slider('x', '水平', k.x, -0.6, 0.6, 0.001, 'px')}
        ${slider('y', '垂直', k.y, -1, 1, 0.001, 'px')}
        ${slider('z', '进深', k.z, -0.24, 0.3, 0.001, 'px')}
        ${slider('ry', '偏航', k.ry, -60, 60, 0.5, '°')}
        ${slider('rx', '俯仰', k.rx, -45, 45, 0.5, '°')}
        ${slider('rz', '旋转', k.rz, -30, 30, 0.5, '°')}
        ${slider('scale', '缩放', k.scale, 0.5, 1.8, 0.01, '×')}
        <div class="insp-row insp-row--time"><label>时间</label>
          <input type="number" step="0.05" min="0" max="${project.duration}" value="${k.t.toFixed(2)}" data-k="time">
          <button class="mini" data-act="align" title="把这一帧移到播放头">对齐</button>
        </div>
        <div class="insp-sec">到下一帧的缓动
          <span class="dim">${k.hold ? '保持' : (preset ? Stage.PRESET_LABEL[preset] : '自定义')}</span>
        </div>
        <div class="chips">
          ${Object.entries(Stage.PRESET_LABEL).map(([v, l]) => `<button class="chip ${preset === v ? 'is-on' : ''}" data-preset="${v}">${l}</button>`).join('')}
        </div>
        <div class="curvewrap">
          <svg class="curve${k.hold ? ' is-hold' : ''}" width="${CURVE_W}" height="${CURVE_H}" viewBox="0 0 ${CURVE_W} ${CURVE_H}">
            <rect class="curve__bg" x="0.5" y="0.5" width="${CURVE_W - 1}" height="${CURVE_H - 1}" rx="8"></rect>
            <line class="curve__diag" x1="${cvx(0)}" y1="${cvy(0)}" x2="${cvx(1)}" y2="${cvy(1)}"></line>
            <line class="curve__base" x1="${cvx(0)}" y1="${cvy(0)}" x2="${cvx(1)}" y2="${cvy(0)}"></line>
            <line class="curve__leg l1" x1="${cvx(0)}" y1="${cvy(0)}" x2="${cvx(b[0])}" y2="${cvy(b[1])}"></line>
            <line class="curve__leg l2" x1="${cvx(1)}" y1="${cvy(1)}" x2="${cvx(b[2])}" y2="${cvy(b[3])}"></line>
            <path class="curve__path" d="${curvePath(b)}"></path>
            <circle class="curve__dot" cx="${cvx(0)}" cy="${cvy(0)}" r="2.5"></circle>
            <circle class="curve__dot" cx="${cvx(1)}" cy="${cvy(1)}" r="2.5"></circle>
            <circle class="curve__handle h1" cx="${cvx(b[0])}" cy="${cvy(b[1])}" r="5.5"></circle>
            <circle class="curve__handle h2" cx="${cvx(b[2])}" cy="${cvy(b[3])}" r="5.5"></circle>
          </svg>
          <div class="curve__readout">${k.hold ? '保持（阶梯，不插值）' : `cubic-bezier(${b.map((n) => n.toFixed(2)).join(', ')})`}</div>
        </div>
        <label class="insp-check"><input type="checkbox" data-k="hold" ${k.hold ? 'checked' : ''}> 保持到下一帧（阶梯，不做插值）</label>
        <div class="btnrow">
          <button class="btn btn--ghost" data-act="goto" title="把播放头移到这一帧">跳到</button>
          <button class="btn btn--ghost" data-act="copyPose">复制姿态</button>
          <button class="btn btn--ghost" data-act="pastePose" ${poseClip ? '' : 'disabled'}>粘贴姿态</button>
        </div>
        <div class="btnrow">
          <button class="btn btn--ghost" data-act="dup" title="复制一帧到 0.2s 之后（Ctrl+D）">复制帧</button>
          <button class="btn btn--ghost insp-danger" data-act="del">删除</button>
        </div>
        ${keyListHtml()}`;

      const refreshAfter = () => {
        applyCameraAt(project.t);
        refreshTimeline();
        autosave();
        renderInspector();
      };

      $$('input[type="range"]', box).forEach((inp) => {
        inp.addEventListener('input', () => {
          const key = inp.dataset.k;
          const v = parseFloat(inp.value);
          if (Math.abs(project.t - k.t) > 0.02) seek(k.t, false);
          k[key] = v;
          inp.parentElement.querySelector('.val').textContent = fmtVal(key, v);
          applyCameraAt(project.t);
          refreshTimeline();
          autosave();
        });
      });

      box.querySelector('[data-k="time"]')?.addEventListener('change', (e) => {
        k.t = roundT(clamp(parseFloat(e.target.value) || 0, 0, project.duration));
        project.camera.sort((p, q) => p.t - q.t);
        selection = { kind: 'cam', index: project.camera.indexOf(k), extra: [] };
        refreshAfter();
      });

      box.querySelectorAll('.chip').forEach((c) => {
        c.addEventListener('click', () => {
          const name = c.dataset.preset;
          k.hold = false;
          k.bezier = Stage.BEZIER_PRESETS[name].slice();
          delete k.ease;
          refreshAfter();
        });
      });

      box.querySelector('[data-k="hold"]')?.addEventListener('change', (e) => {
        k.hold = e.target.checked;
        refreshAfter();
      });

      box.querySelector('[data-act="align"]')?.addEventListener('click', () => {
        k.t = roundT(project.t);
        project.camera.sort((p, q) => p.t - q.t);
        selection = { kind: 'cam', index: project.camera.indexOf(k), extra: [] };
        refreshAfter();
      });
      box.querySelector('[data-act="copyPose"]')?.addEventListener('click', () => {
        poseClip = { x: k.x, y: k.y, z: k.z, rx: k.rx, ry: k.ry, rz: k.rz, scale: k.scale };
        toast('已复制这一帧的机位');
        renderInspector();
      });
      box.querySelector('[data-act="pastePose"]')?.addEventListener('click', () => {
        if (!poseClip) return;
        Object.assign(k, poseClip);
        seek(k.t, false);
        refreshAfter();
        toast('已粘贴机位');
      });
      box.querySelector('[data-act="dup"]')?.addEventListener('click', () => duplicateKey(selection.index));
      box.querySelector('[data-act="goto"]')?.addEventListener('click', () => seek(k.t, true));
      box.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteSelection());
      box.querySelectorAll('.krow').forEach((row) => {
        row.addEventListener('click', () => {
          selection = { kind: 'cam', index: Number(row.dataset.goto), extra: [] };
          renderInspector();
          Timeline.setSelection(selection);
        });
      });

      bindCurve(box, k);
      return;
    }

    const a = project.actions[selection.index];
    if (!a) { selection = null; return renderInspector(); }
    const typeLabel = {
      tap: '点击', type: '输入', scroll: '滚动', select: '下拉选择',
      check: '勾选', navigate: '页面跳转',
    }[a.type] || a.type;

    box.innerHTML = `
      <div class="insp-head">
        <span class="tag tag--act">${typeLabel}</span>
        <span class="t">${fmt(a.t)}</span>
      </div>
      <div class="insp-row"><label>时间</label>
        <input type="number" step="0.1" min="0" max="${project.duration}" value="${a.t.toFixed(2)}" data-k="time">
        <span class="val">s</span></div>
      <div class="insp-row"><label>对象</label>
        <input type="text" value="${escapeAttr(a.label || '')}" data-k="label" placeholder="（无标签）"></div>
      <div class="insp-row"><label>值</label>
        <input type="text" value="${escapeAttr(a.value || a.src || a.selector || '')}" data-k="value" ${a.type === 'navigate' ? 'title="跳转地址"' : 'title="选择器"'}>
      </div>
      ${a._failed ? '<p class="hint" style="color:#ff8b95">回放时没有找到该元素，页面结构可能已变化。</p>' : ''}
      <div class="btnrow" style="margin-top:12px">
        <button class="btn btn--ghost" data-act="test">重放这一条</button>
        <button class="btn btn--ghost insp-danger" data-act="del">删除</button>
      </div>`;

    box.querySelector('[data-k="time"]')?.addEventListener('change', (e) => {
      a.t = clamp(parseFloat(e.target.value) || 0, 0, project.duration);
      project.actions.sort((x, y) => x.t - y.t);
      selection.index = project.actions.indexOf(a);
      refreshTimeline();
      renderInspector();
    });
    box.querySelector('[data-k="label"]')?.addEventListener('change', (e) => {
      a.label = e.target.value;
      refreshTimeline();
    });
    box.querySelector('[data-k="value"]')?.addEventListener('change', (e) => {
      if (a.type === 'navigate') a.url = e.target.value;
      else a.selector = e.target.value;
      refreshTimeline();
    });
    box.querySelector('[data-act="test"]')?.addEventListener('click', async () => {
      player.cursor = Math.max(0, selection.index);
      const res = await execAction(a);
      toast(res === false || a._failed ? '执行失败' : '已重放');
    });
    box.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteSelection());
  }

  function slider(key, label, value, min, max, step, unit) {
    return `<div class="insp-row">
      <label>${label}</label>
      <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
      <span class="val">${fmtVal(key, value)}</span>
    </div>`;
  }
  function fmtVal(key, v) {
    if (key === 'scale') return v.toFixed(2) + '×';
    if (key === 'ry' || key === 'rx' || key === 'rz') return Math.round(v) + '°';
    const f = outFrame();
    if (key === 'x') return Math.round(v * f.w) + 'px';
    if (key === 'y') return Math.round(v * f.h) + 'px';
    if (key === 'z') return Math.round(v * f.persp) + 'px';
    return Math.round(v) + 'px';
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function deleteSelection() {
    if (!selection) return;
    const list = selection.kind === 'cam' ? project.camera : project.actions;
    const idx = [selection.index, ...(selection.extra || [])]
      .filter((i, n, arr) => Number.isInteger(i) && arr.indexOf(i) === n && i >= 0 && i < list.length)
      .sort((a, b) => b - a);
    if (!idx.length) return;
    idx.forEach((i) => list.splice(i, 1));
    selection = null;
    applyCameraAt(project.t);
    refreshTimeline();
    renderInspector();
    autosave();
    if (idx.length > 1) toast(`已删除 ${idx.length} 项`);
  }

  /* ═══════════════ 导出 ═══════════════ */

  /**
   * 导出期间主界面被「冻结」：
   *   · 遮罩吃掉所有指针事件（body.is-frozen → pointer-events:none）
   *   · 键盘在 keydown 里直接 return，只剩 Esc = 取消
   * 冻结是刻意的：逐帧渲染时主线程被渲染循环占着，如果还允许改镜头 / 拖时间轴，
   * 改到一半的那一帧会算进成片里，而且每次交互都要重排，反而让渲染更慢。
   */
  const frozen = { on: false };

  function setFrozen(on) {
    frozen.on = !!on;
    document.body.classList.toggle('is-frozen', frozen.on);
  }

  function fmtDur(s) {
    const v = Math.max(0, Math.round(s || 0));
    if (v < 60) return `${v}s`;
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
  }

  /**
   * @param {{title?:string, msg?:string, hint?:string, render?:boolean}} o
   * render=true 才是「逐帧渲染」面板：帧号 / 速度 / 缩略预览 / 取消。
   */
  function showExportDialog({ title, msg, hint, render } = {}) {
    // 上一个操作留下的 toast 会懒在弹窗底下好一会儿，导出前先收掉
    clearTimeout(toast._h);
    dom.appToast.classList.remove('is-on');
    dom.exportTitle.textContent = title || '正在导出视频';
    dom.exportMsg.textContent = msg || '';
    dom.exportHint.textContent = hint || '';
    dom.exportMask.classList.toggle('is-render', !!render);
    dom.exportCard.classList.toggle('is-render', !!render);
    dom.exportGrid.hidden = !render;
    dom.exportPct.hidden = !render;
    dom.exportCancel.hidden = !render;
    dom.exportCancel.disabled = false;
    dom.exportCancel.textContent = '取消导出';
    dom.exportProgress.style.width = '0%';
    dom.exportPct.textContent = '0%';
    dom.exportMask.classList.add('is-on');
  }

  function setExportMessage(msg) {
    dom.exportMsg.textContent = msg;
  }

  function hideExportMask() {
    dom.exportMask.classList.remove('is-on');
    dom.exportMask.classList.remove('is-render');
  }

  function requestCancelExport() {
    if (Render.active) {
      dom.exportCancel.disabled = true;
      dom.exportCancel.textContent = '正在取消…';
      setExportMessage('正在收尾，取消完成后不会生成文件…');
      Render.abort();
      return;
    }
    // 网页模式：遮罩不能出现（会被录进画面），只能直接把录制停掉
    if (Exporter.active) {
      pageAbort = true;
      toast('正在停止录制…', 2000);
    }
  }

  let previewAt = 0;
  let pageAbort = false; // 网页模式导出的「取消」信号（那条路上没有弹窗可点）

  /** 逐帧进度：帧号 / 速度 / 用时 / 缩略图（预览限速 8Hz，别和渲染抢时间） */
  function paintExportProgress(p) {
    dom.exportProgress.style.width = p.pct + '%';
    dom.exportPct.textContent = p.pct + '%';
    dom.exportFrames.textContent = `${p.frame} / ${p.total}`;
    dom.exportFps.textContent = p.fps > 0.05 ? `${p.fps.toFixed(1)} fps` : '—';
    dom.exportEta.textContent = `${fmtDur(p.elapsed)} / ${p.eta ? fmtDur(p.eta) : '—'}`;
    dom.exportFormat.textContent = `${p.width}×${p.height} · ${p.label} · ${p.targetFps}fps`
      + (p.backend ? ` · ${p.backend === 'webgl2' ? 'WebGL' : '2D'}` : '');

    const now = performance.now();
    if (!p.canvas || now - previewAt < 120) return;
    previewAt = now;
    const cv = dom.exportPreview;
    const w = 150;
    const h = Math.max(40, Math.round((w * p.canvas.height) / p.canvas.width));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    try { cv.getContext('2d').drawImage(p.canvas, 0, 0, w, h); } catch (_) {}
  }

  function resetExportPreview() {
    const cv = dom.exportPreview;
    if (!cv) return;
    const { w, h } = Render.canvasSize(effectiveAspect());
    const pw = 150;
    const ph = Math.max(40, Math.round((pw * h) / w));
    cv.width = pw;
    cv.height = ph;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, pw, ph);
    previewAt = 0;
    dom.exportFrames.textContent = `0 / 0`;
    dom.exportFps.textContent = '—';
    dom.exportEta.textContent = '—';
    dom.exportFormat.textContent = `${w}×${h}`;
  }

  function stampName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `livemockup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /* ── 录屏模式：canvas 内部逐帧渲染，不碰屏幕捕获、不跟墙钟 ── */
  async function exportVideoInternal() {
    if (Render.active) return toast('已经在渲染了，先等它跑完或点「取消导出」', 3200);
    if (!dom.videoEl.videoWidth) return toast('视频还没就绪：先把这段录屏选上再导出', 4200);
    // 机型 / 屏幕尺寸 / 输出画幅 都是场景级的，整段视频用这一份
    const spec = sceneSpec();
    if (spec.device === 'auto' && !spec.autoSize) {
      return toast('「自适应机型」要先选定录屏文件（否则不知道该用多大屏幕）', 4200);
    }
    const btnLabel = dom.exportBtn.innerHTML;
    const duration = Math.max(0.4, Math.min(120, Number(project.duration) || 1));
    const aspect = spec.aspect;
    const targetFps = 30;
    const total = Math.max(1, Math.round(duration * targetFps));
    const { w: outW, h: outH } = Render.canvasSize(aspect);
    const offline = Render.offline;

    stopPlay();
    setFrozen(true);
    dom.exportBtn.classList.add('is-busy');
    dom.exportBtn.innerHTML = '<span class="dot"></span>渲染中…';
    showExportDialog({
      title: offline ? '正在逐帧渲染' : '正在实时录制',
      msg: offline
        ? `主界面已锁定 · 共 ${total} 帧，每一帧都渲染并编码完成才走下一帧（慢一点，但不丢帧）`
        : '当前环境没有 WebCodecs（需要 https 或 localhost），退回实时录制：界面照样锁定，但可能丢帧。',
      hint: offline
        ? '逐帧离线渲染 · 成片时长严格等于时间轴时长 · Esc 也可以取消'
        : '实时录制 · 渲染速度受机器负载影响',
      render: true,
    });
    resetExportPreview();

    const startedAt = performance.now();
    try {
      const blob = await Render.render({
        video: dom.videoEl,
        aspect,
        camera: project.camera,
        bg: project.bg,
        color: project.color,
        model: spec.device,
        autoSize: spec.autoSize,
        glare: project.ui.glare !== false,
        duration,
        fps: targetFps,
        onProgress: paintExportProgress,
        onPhase: (phase) => {
          if (phase === 'encode') setExportMessage('画面已经渲染完，正在封装 WebM（写时长与索引）…');
        },
      });

      const secs = (performance.now() - startedAt) / 1000;
      Exporter.download(blob, stampName() + '.webm');
      toast(`导出完成 · ${outW}×${outH} · ${total} 帧 · ${(blob.size / 1048576).toFixed(1)} MB · 用时 ${secs.toFixed(1)}s`, 5200);
    } catch (err) {
      if (err && err.aborted) toast('已取消导出，没有生成文件', 3000);
      else toast('渲染失败：' + (err?.message || err), 5200);
    } finally {
      setFrozen(false);
      hideExportMask();
      dom.exportBtn.innerHTML = btnLabel;
      dom.exportBtn.classList.remove('is-busy');
      seek(0);
    }
  }

  /** 导出「当前播放头这一帧」的 PNG：和成片同一条渲染链路，用来核对画质/排查撕裂 */
  async function exportStillFrame() {
    if (Render.active) return toast('正在渲染，稍等一下', 2600);
    if (isVideo() && !dom.videoEl.videoWidth) return toast('视频还没就绪：先把这段录屏选上', 3600);
    if (!isVideo()) return toast('「当前帧 PNG」目前只支持录屏视频模式', 3600);
    const spec = sceneSpec();
    if (spec.device === 'auto' && !spec.autoSize) return toast('「自适应机型」要先选定录屏文件', 3600);
    const t = Math.max(0, Number(project.t) || 0);
    const pose = Stage.sample(project.camera, t);
    const fps = 30;
    let png = null;
    setFrozen(true);
    try {
      await Render.render({
        video: dom.videoEl,
        aspect: spec.aspect,
        camera: [{ ...pose, t: 0 }],
        bg: project.bg,
        color: project.color,
        model: spec.device,
        autoSize: spec.autoSize,
        glare: project.ui.glare !== false,
        duration: 1 / fps,
        fps,
        onProgress: (p) => {
          if (p.frame !== p.total || !p.canvas) return;
          const cv = document.createElement('canvas');
          cv.width = p.canvas.width;
          cv.height = p.canvas.height;
          cv.getContext('2d').drawImage(p.canvas, 0, 0);
          png = cv.toDataURL('image/png');
        },
      });
      if (!png) return toast('没有拿到画面', 3000);
      const a = document.createElement('a');
      a.href = png;
      a.download = `${stampName()}-frame-${t.toFixed(2)}s.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(`已导出当前帧 · ${fmt(t)} · 和成片同一套渲染`, 4200);
    } catch (err) {
      toast('导出当前帧失败：' + (err?.message || err), 4200);
    } finally {
      setFrozen(false);
      seek(project.t);
    }
  }

  async function exportVideo() {
    if (!project.page.src) return toast(isVideo() ? '先选择一个录屏视频' : '先载入一个页面');
    if (isVideo()) return exportVideoInternal();
    if (!project.actions.length && !project.camera.length) return toast('时间轴还是空的，先录一段操作');
    stopPlay();

    const btnLabel = dom.exportBtn.innerHTML;
    let started = false;
    let progTimer = 0;

    showExportDialog({
      title: '正在导出视频',
      msg: '请在弹出的窗口里选择「此标签页」，然后点共享。',
      hint: '网页模式必须实时捕获标签页（iframe 的像素浏览器不让读），所以这条路上不能冻结画面。',
    });

    try {
      const info = await Exporter.start({
        stageEl: dom.stage,
        aspect: effectiveAspect(),
        // 网页模式的 iframe 像素拿不到（浏览器不允许），只能屏幕捕获。
        // 30fps 已经够用，编码压力只有 60fps 的一半，不容易把界面拖住。
        fps: 30,
        // 遮罩和镜头按钮盖在舞台上，会被一起录进视频 —— 录制开始前收干净，
        // 顺便把侧栏折起来让舞台吃满窗口，输出更锐利。
        onBeforeRecord: async () => {
          hideExportMask();
          document.body.classList.add('exporting');
          setFrozen(true); // 录屏期间不许有人碰界面（点一下就会被录进去）
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          Stage.fit();
          await sleep(180);
          Stage.fit();
        },
      });
      started = true;

      const total = Math.max(1, project.duration);
      const targetFrames = Math.max(1, Math.round(total * 30));
      dom.exportBtn.classList.add('is-busy');
      // 网页模式没有弹窗可用（遮罩会被录进画面），帧号和速度只能写在按钮上
      const paintProgress = () => {
        const frames = Exporter.frames;
        // captureStream 最多只吃 30fps，画得再快也不会被多录
        const fps = Math.min(30, Exporter.fps);
        dom.exportBtn.innerHTML = `<span class="dot"></span>录制 ${Math.min(frames, targetFrames)}/${targetFrames} 帧`
          + (fps > 0.3 ? ` · ${fps.toFixed(1)}fps` : '');
      };
      paintProgress();
      progTimer = setInterval(paintProgress, 200);

      await sleep(400);
      seek(0);
      await ensureStateAt(0);
      await sleep(300);
      await play();

      await new Promise((resolve) => {
        // 播放自然结束 / 用户取消（这个模式没有弹窗可点，只能按 Esc）都会走到这里
        let done = false;
        let iv = 0;
        let to = 0;
        const fin = () => {
          if (done) return;
          done = true;
          clearInterval(iv);
          clearTimeout(to);
          resolve();
        };
        player.stopWaiters.push(fin);
        iv = setInterval(() => { if (pageAbort) fin(); }, 120);
        to = setTimeout(fin, (project.duration + 12) * 1000);
      });
      await sleep(250);

      const blob = await Exporter.stop();
      clearInterval(progTimer);
      document.body.classList.remove('exporting');
      Stage.fit();
      dom.exportBtn.innerHTML = btnLabel;
      dom.exportBtn.classList.remove('is-busy');

      if (pageAbort) {
        pageAbort = false;
        return toast('已取消导出，没有生成文件', 3000);
      }
      if (!blob || !blob.size) return toast('没有捕获到画面');
      Exporter.download(blob, `livemockup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`);
      toast(`导出完成 · ${info.width}×${info.height} · ${(blob.size / 1048576).toFixed(1)} MB`, 4200);
    } catch (err) {
      if (started) {
        try { await Exporter.stop(); } catch (_) {}
        toast(err?.name === 'AbortError' ? '已取消导出' : '导出中断：' + (err?.message || err), 4200);
      } else {
        toast('导出失败：' + (err?.message || err), 4200);
      }
    } finally {
      pageAbort = false;
      clearInterval(progTimer);
      hideExportMask();
      setFrozen(false);
      document.body.classList.remove('exporting');
      Stage.fit();
      dom.exportBtn.innerHTML = btnLabel;
      dom.exportBtn.classList.remove('is-busy');
    }
  }

  /* ═══════════════ 工程存取 ═══════════════ */

  function serialize() {
    return JSON.stringify({
      version: PROJECT_VERSION,
      mode: project.mode,
      // 只存视频的元信息：本地文件的 blob URL 换会话就失效，重开时提示重新选择
      video: { name: project.video.name, w: project.video.w, h: project.video.h, duration: project.video.duration },
      page: project.page,
      device: project.device,
      color: project.color,
      bg: project.bg,
      aspect: project.aspect,
      duration: project.duration,
      camera: project.camera,
      actions: project.actions.map((a) => ({ ...a, _failed: undefined })),
      ui: project.ui,
    }, null, 2);
  }

  /**
   * v1 → v2：旧工程里的 x/y/z 是「编辑器舞台 CSS 像素」。
   * 换算用 Stage.refBox()（按标准窗口推算的参考画框），与当前窗口大小无关，
   * 所以同一个旧工程在任何机器上换算出来的比例一致。
   */
  function migrateCameraUnits(p) {
    const ver = Number(p.version) || 1;
    if (ver >= PROJECT_VERSION) return false;
    const list = Array.isArray(p.camera) ? p.camera : [];
    if (!list.length) { p.version = PROJECT_VERSION; return false; }
    const ar = (() => {
      const a = String(p.aspect || '9:16');
      if (a === 'auto') {
        const v = p.video || {};
        return v.w && v.h ? v.w / v.h : 9 / 16;
      }
      const [aw, ah] = a.split(':').map(Number);
      return aw && ah ? aw / ah : 9 / 16;
    })();
    const box = Stage.refBox(ar);
    const persp = Stage.perspOf(box.h);
    list.forEach((k) => {
      k.x = (Number(k.x) || 0) / box.w;
      k.y = (Number(k.y) || 0) / box.h;
      k.z = (Number(k.z) || 0) / persp;
    });
    p.version = PROJECT_VERSION;
    return true;
  }

  function applyProject(raw) {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!p || !p.page) throw new Error('不是有效的 LiveMockup 工程');
    const migrated = migrateCameraUnits(p);
    project.mode = p.mode === 'video' ? 'video' : 'page';
    project.video = { name: '', w: 0, h: 0, duration: 0, ...(p.video || {}) };
    project.page = { ...project.page, ...p.page };
    project.device = p.device || 'phone';
    project.color = p.color || 'midnight';
    project.bg = p.bg || 'aurora';
    project.aspect = p.aspect || '9:16';
    project.duration = p.duration || 12;
    project.camera = p.camera || [];
    project.actions = p.actions || [];
    project.ui = { ...project.ui, ...(p.ui || {}) };
    normalizeCamera();
    syncUiFromProject();
    refreshTimeline();
    renderInspector();
    if (migrated) {
      toast('旧工程位移已换算成「相对画面」的比例：之后换窗口、换电脑构图都不再变（读数现在是成片画布上的 px）', 6400);
    }
  }

  function syncUiFromProject() {
    dom.urlInput.value = project.page.input || '';
    dom.modeSeg?.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === project.mode));
    dom.deviceSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.device === project.device));
    $$('#colorSeg button').forEach((b) => b.classList.toggle('is-on', b.dataset.color === project.color));
    $$('#bgList button').forEach((b) => b.classList.toggle('is-on', b.dataset.bg === project.bg));
    dom.aspectSel.value = project.aspect;
    dom.durationInput.value = String(project.duration);
    dom.rippleToggle.checked = project.ui.ripple !== false;
    dom.autoKeyToggle.checked = project.ui.autoKey !== false;
    dom.loopToggle.checked = !!project.ui.loop;
    dom.statusBar.checked = project.ui.statusBar !== false;
    dom.glareToggle.checked = project.ui.glare !== false;
    document.body.classList.toggle('no-status', project.ui.statusBar === false);
    document.body.classList.toggle('no-glare', project.ui.glare === false);
    if (project.video.w) Stage.setAutoSize(project.video.w, project.video.h);
    setMode(project.mode, true);
    Stage.setDevice(project.device);
    Stage.setColor(project.color);
    Stage.setBg(project.bg);
    Stage.setAspect(project.aspect);
  }

  const LS_KEY = 'livemockup:project:v1';
  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, serialize()); } catch (_) {}
    }, 600);
  }

  /* ═══════════════ 事件绑定 ═══════════════ */

  async function loadUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return toast(isVideo() ? '请粘贴视频地址，或选本地录屏' : '请输入网址');

    // 录屏模式下，地址栏当作视频直链用（/demo/... 之类的站内路径仍当网页处理）
    if (isVideo() && !raw.startsWith('/')) {
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
      return loadVideo(url);
    }

    const src = toFrameSrc(raw);
    if (!src) return toast('请输入网址');
    if (isVideo()) setMode('page', true);
    stopPlay();
    project.page.input = raw;
    project.page.src = src;
    project.page.startSrc = src;
    project.actions = [];
    player.cursor = 0;
    selection = null;
    dom.frameInfo.textContent = '载入中…';
    const res = await loadFrame(src);
    if (!res.ok) {
      hideLoading();
      toast('页面载入超时，检查网址或网络');
      return;
    }
    if (!project.camera.length) project.camera = [{ t: 0, ...DEFAULT_CAM }];
    project.duration = project.duration || 12;
    seek(0);
    refreshTimeline();
    renderInspector();
    autosave();
    if (!player.agentReady) toast('页面已载入，但没有注入运行时（可能被站点策略挡住），录制功能会失效', 4000);
  }

  // ── 场景三件套（机型 / 颜色 / 背景 / 画幅）─────────────────────────────────
  function setDevice(v, silent) {
    project.device = v;
    $$('#deviceSeg button').forEach((x) => x.classList.toggle('is-on', x.dataset.device === v));
    Stage.setDevice(v);
    if (!silent) autosave();
  }
  function setColor(v, silent) {
    project.color = v;
    $$('#colorSeg button').forEach((x) => x.classList.toggle('is-on', x.dataset.color === v));
    Stage.setColor(v);
    if (!silent) autosave();
  }
  function setBg(v, silent) {
    project.bg = v;
    $$('#bgList button').forEach((x) => x.classList.toggle('is-on', x.dataset.bg === v));
    Stage.setBg(v);
    if (!silent) autosave();
  }
  function setAspect(v, silent) {
    project.aspect = v;
    dom.aspectSel.value = v;
    Stage.setAspect(v);
    if (!silent) autosave();
  }

  function presetKey(demo) {
    const m = /^\/demo\/([^/]+)\/?$/.exec(demo || '');
    return m ? m[1] : '';
  }

  function bind() {
    dom.loadBtn.addEventListener('click', () => loadUrl(dom.urlInput.value));
    dom.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadUrl(dom.urlInput.value);
    });
    dom.reloadBtn.addEventListener('click', async () => {
      if (!project.page.src) return;
      if (isVideo()) {
        if (/^https?:/i.test(project.page.src)) await loadVideo(project.page.src);
        else toast('本地录屏需要重新选择文件', 3000);
        return;
      }
      await loadFrame(project.page.src);
      toast('已重载');
    });

    /* ── 网页 / 录屏 模式切换 ── */
    dom.modeSeg?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.mode === project.mode) return;
      stopPlay();
      if (b.dataset.mode === 'video') {
        setMode('video');
        if (!dom.videoEl.src) toast('从左侧选一段录屏，或粘贴视频直链', 3200);
      } else {
        setMode('page');
        if (project.page.src && !project.page.src.startsWith('blob:')) loadFrame(project.page.src);
      }
    });

    /* ── 本地录屏：点击选择 / 拖放 ── */
    dom.dropZone?.addEventListener('click', () => dom.videoFile?.click());
    dom.videoFile?.addEventListener('change', () => {
      const f = dom.videoFile.files?.[0];
      if (f) loadVideo(f);
      dom.videoFile.value = '';
    });
    if (dom.dropZone) {
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((ev) => dom.dropZone.addEventListener(ev, (e) => {
        stop(e);
        dom.dropZone.classList.add('is-over');
      }));
      ['dragleave', 'dragend'].forEach((ev) => dom.dropZone.addEventListener(ev, (e) => {
        stop(e);
        dom.dropZone.classList.remove('is-over');
      }));
      dom.dropZone.addEventListener('drop', (e) => {
        stop(e);
        dom.dropZone.classList.remove('is-over');
        const f = e.dataTransfer?.files?.[0];
        if (!f) return toast('没读到文件', 2600);
        if (!/^video\//i.test(f.type)) return toast('请拖入视频文件（mp4 / webm）', 3000);
        loadVideo(f);
      });
    }

    $$('.preset').forEach((b) => {
      b.addEventListener('click', () => {
        $$('.preset').forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
        const preset = PRESETS[presetKey(b.dataset.demo)] || {};
        if (isVideo()) setMode('page', true);
        if (preset.device) setDevice(preset.device, true);
        if (preset.aspect) setAspect(preset.aspect, true);
        if (preset.bg) setBg(preset.bg, true);
        if (preset.color) setColor(preset.color, true);
        loadUrl(b.dataset.demo);
      });
    });

    dom.recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
    dom.playBtn.addEventListener('click', togglePlay);
    dom.tlPlayBtn.addEventListener('click', togglePlay);
    dom.exportBtn.addEventListener('click', exportVideo);
    dom.stillBtn?.addEventListener('click', exportStillFrame);
    dom.exportCancel?.addEventListener('click', requestCancelExport);

    // 渲染中直接关页面会白等一场，拦一下
    window.addEventListener('beforeunload', (e) => {
      if (!frozen.on) return;
      e.preventDefault();
      e.returnValue = '';
    });

    dom.deviceSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.device === 'auto') {
        if (!isVideo()) return toast('「自适应分辨率」只在录屏模式下可用', 3000);
        const s = Stage.autoSize || (project.video.w ? { w: project.video.w, h: project.video.h } : null);
        if (!s) return toast('先选择一段录屏视频', 3000);
        Stage.setAutoSize(s.w, s.h);
      }
      setDevice(b.dataset.device);
    });
    dom.colorSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setColor(b.dataset.color);
    });
    dom.bgList.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setBg(b.dataset.bg);
    });
    dom.aspectSel.addEventListener('change', () => {
      if (dom.aspectSel.value === 'auto' && !isVideo()) {
        dom.aspectSel.value = project.aspect === 'auto' ? '9:16' : project.aspect;
        return toast('「自适应画幅」只在录屏模式下可用', 3000);
      }
      setAspect(dom.aspectSel.value);
    });
    dom.durationInput.addEventListener('change', () => {
      project.duration = clamp(parseFloat(dom.durationInput.value) || 12, 2, 120);
      dom.durationInput.value = String(project.duration);
      clampKeysToDuration();
      seek(Math.min(project.t, project.duration));
      refreshTimeline();
      renderInspector();
      autosave();
    });
    dom.rippleToggle.addEventListener('change', () => {
      project.ui.ripple = dom.rippleToggle.checked;
      send('config', { ripple: project.ui.ripple });
      autosave();
    });
    dom.autoKeyToggle.addEventListener('change', () => {
      project.ui.autoKey = dom.autoKeyToggle.checked;
      autosave();
    });
    dom.loopToggle.addEventListener('change', () => {
      project.ui.loop = dom.loopToggle.checked;
      autosave();
    });
    dom.statusBar.addEventListener('change', () => {
      project.ui.statusBar = dom.statusBar.checked;
      document.body.classList.toggle('no-status', !dom.statusBar.checked);
      autosave();
    });
    dom.glareToggle.addEventListener('change', () => {
      project.ui.glare = dom.glareToggle.checked;
      document.body.classList.toggle('no-glare', !dom.glareToggle.checked);
      autosave();
    });

    dom.moveList.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      applyMove(b.dataset.move);
      autosave();
    });

    dom.addKeyBtn.addEventListener('click', addKeyFromCurrent);
    dom.tlAddKey.addEventListener('click', addKeyFromCurrent);

    dom.delKeyBtn.addEventListener('click', deleteSelection);
    dom.tlClearActions.addEventListener('click', () => {
      if (!project.actions.length) return;
      if (!confirm('清空所有页面动作？')) return;
      project.actions = [];
      player.cursor = 0;
      refreshTimeline();
      autosave();
    });

    momoToggle();

    dom.toggleChromeBtn.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('no-panels');
      dom.toggleChromeBtn.textContent = hidden ? '显示面板' : '隐藏面板';
      setTimeout(() => { Stage.fit(); }, 60);
    });

    dom.saveProjectBtn.addEventListener('click', () => {
      const blob = new Blob([serialize()], { type: 'application/json' });
      Exporter.download(blob, `livemockup-project-${Date.now()}.json`);
      toast('工程已保存');
    });
    dom.openProjectBtn.addEventListener('click', () => dom.projectFile.click());
    dom.projectFile.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        applyProject(await f.text());
        if (project.mode === 'video') {
          // 工程 JSON 里只有录屏的元信息，文件本身不可能跟着走。
          // 不能拿那个失效的 blob 去 loadFrame（那是给网页模式用的）：
          // 只要摘掉旧视频源、提示重选一次，镜头轨和时间轴就都还在。
          try { dom.videoEl.pause(); } catch (_) {}
          dom.videoEl.removeAttribute('src');
          try { dom.videoEl.load(); } catch (_) {}
          if (videoObjectUrl) { URL.revokeObjectURL(videoObjectUrl); videoObjectUrl = ''; }
          if (dom.dropZone) dom.dropZone.classList.remove('is-loaded');
          await restoreVideo();
          seek(0);
          refreshTimeline();
          renderInspector();
          autosave();
        } else {
          await loadFrame(project.page.startSrc || project.page.src);
          toast('工程已导入');
        }
      } catch (err) {
        toast('导入失败：' + err.message);
      }
      e.target.value = '';
    });

    Timeline.onSeek((t) => seek(t, true));
    Timeline.onSelect((kind, index, opt = {}) => {
      if (kind == null) {
        selection = null;
        renderInspector();
        Timeline.setSelection(selection);
        return;
      }
      if (opt.box) {
        // 框选：把矩形里命中的项整批变成多选（Shift 框选 = 并入已有选择）
        const list = kind === 'cam' ? project.camera : project.actions;
        const base = (opt.shift && selection && selection.kind === kind)
          ? [selection.index, ...(selection.extra || [])]
          : [];
        const merged = [...new Set([...base, ...opt.box])]
          .filter((i) => i >= 0 && i < list.length)
          .sort((a, b) => a - b);
        if (!merged.length) {
          selection = null;
        } else {
          selection = { kind, index: merged[0], extra: merged.slice(1) };
        }
        renderInspector();
        Timeline.setSelection(selection);
        if (selection && merged.length > 1) toast(`框选了 ${merged.length} 项`);
        return;
      }
      if (opt.shift && selection && selection.kind === kind) {
        // Shift 点击：把这一项加入 / 移出多选
        const extra = (selection.extra || []).slice();
        const at = extra.indexOf(index);
        if (at >= 0) extra.splice(at, 1);
        else if (index !== selection.index) extra.push(index);
        selection = { ...selection, extra };
      } else if (selection && selection.kind === kind
        && [selection.index, ...(selection.extra || [])].includes(index)) {
        // 点在「已选中的一员」上：保留整批选择，否则一拖动就把多选收成单选
      } else {
        selection = { kind, index, extra: [] };
      }
      renderInspector();
      Timeline.setSelection(selection);
    });
    Timeline.onDrag((kind, index, t, phase) => {
      const list = kind === 'cam' ? project.camera : project.actions;
      const item = list[index];
      if (phase === 'move' && t != null && item) {
        item.t = t;
        if (kind === 'cam') applyCameraAt(project.t);
        dom.tlCount.textContent = `${project.actions.length} 个动作 · ${project.camera.length} 个关键帧`;
        return;
      }
      if (phase === 'end') {
        project.camera.sort((a, b) => a.t - b.t);
        project.actions.sort((a, b) => a.t - b.t);
        selection = item ? { kind, index: list.indexOf(item), extra: [] } : null;
        refreshTimeline();
        Timeline.setSelection(selection);
        renderInspector();
        autosave();
      }
    });
    /* 多选整批平移（框选出好几帧后拖其中任意一个，其余跟着走） */
    Timeline.onDragGroup((kind, moves, phase) => {
      const list = kind === 'cam' ? project.camera : project.actions;
      moves.forEach(({ index, t }) => {
        const it = list[index];
        if (it) it.t = t;
      });
      if (phase === 'move') {
        if (kind === 'cam') applyCameraAt(project.t);
        return;
      }
      // 排序后按对象引用把选中索引找回来（时间一变顺序就变了）
      const keep = selection && selection.kind === kind
        ? [selection.index, ...(selection.extra || [])].map((i) => list[i]).filter(Boolean)
        : [];
      list.sort((a, b) => a.t - b.t);
      const idx = keep.map((it) => list.indexOf(it)).filter((i) => i >= 0).sort((a, b) => a - b);
      selection = idx.length ? { kind, index: idx[0], extra: idx.slice(1) } : null;
      if (kind === 'cam') applyCameraAt(project.t);
      refreshTimeline();
      Timeline.setSelection(selection);
      renderInspector();
      autosave();
    });

    Stage.onCamInput((cam, kind) => {
      if (recording) return;
      if (!project.ui.autoKey) {
        if (kind === 'dragend') toast('未写入关键帧，点「+ 关键帧」可固定当前机位');
        return;
      }
      // 只在「播放头附近」就地更新；离得远就插新帧，绝不悄悄改掉别的帧
      const same = project.camera.find((k) => Math.abs(k.t - project.t) <= 0.12);
      if (same) {
        Object.assign(same, cam);
      } else {
        // 顺序：先姿态，再 t / ease —— 姿态里夹带的旧字段不能盖掉新帧的时间
        const key = { ...DEFAULT_CAM, ...cam, t: roundT(project.t), ease: 'easeInOut' };
        project.camera.push(key);
        project.camera.sort((a, b) => a.t - b.t);
        selection = { kind: 'cam', index: project.camera.indexOf(key), extra: [] };
      }
      if (kind !== 'drag') {
        refreshTimeline();
        if (kind === 'dragend') { renderInspector(); autosave(); }
      }
    });

    window.addEventListener('keydown', (e) => {
      // 冻结中：只剩 Esc（取消导出）有意义，别的快捷键一律不响应
      if (frozen.on) {
        if (e.key === 'Escape') { e.preventDefault(); requestCancelExport(); }
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (selection && selection.kind === 'cam') duplicateKey(selection.index);
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C') && selection && selection.kind === 'cam') {
        const k = project.camera[selection.index];
        if (k) {
          poseClip = { x: k.x, y: k.y, z: k.z, rx: k.rx, ry: k.ry, rz: k.rz, scale: k.scale };
          toast('已复制机位（Ctrl+V 粘到别的帧）');
        }
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V') && poseClip && selection && selection.kind === 'cam') {
        e.preventDefault();
        const k = project.camera[selection.index];
        if (k) { Object.assign(k, poseClip); applyCameraAt(project.t); refreshTimeline(); renderInspector(); autosave(); toast('已粘贴机位'); }
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (selection) { e.preventDefault(); deleteSelection(); } }
      // Alt + ←/→ 微调选中的关键帧，普通 ←/→ 移动播放头
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey && selection && selection.kind === 'cam') {
        e.preventDefault();
        const k = project.camera[selection.index];
        if (k) {
          const step = e.shiftKey ? 0.5 : 0.05;
          k.t = roundT(k.t + (e.key === 'ArrowLeft' ? -step : step));
          project.camera.sort((a, b) => a.t - b.t);
          selection = { kind: 'cam', index: project.camera.indexOf(k), extra: [] };
          applyCameraAt(project.t);
          refreshTimeline();
          renderInspector();
          autosave();
        }
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seek(player.t - (e.shiftKey ? 1 : 0.1), true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(player.t + (e.shiftKey ? 1 : 0.1), true); }
      if (e.key === 'k') { addKeyFromCurrent(); }
    });

    dom.stage.addEventListener('click', () => dom.stage.classList.add('touched'));
  }

  function momoToggle() {}

  async function addKeyFromCurrent() {
    const idx = addKeyAt(project.t, Stage.cam);
    selection = { kind: 'cam', index: idx >= 0 ? idx : nearestKey(project.t, 0.2) };
    refreshTimeline();
    renderInspector();
    autosave();
    toast(`已在 ${fmt(project.t)} 固定机位`);
  }

  /** 重开页面时恢复录屏模式：本地文件的 blob URL 活不过一个会话，只能提示重选 */
  async function restoreVideo() {
    const src = project.page.src || '';
    if (project.video.w) Stage.setAutoSize(project.video.w, project.video.h);
    if (/^https?:\/\//i.test(src)) {
      showLoading('重连视频…');
      try {
        await attachVideoSrc(src);
        dom.dropZone?.classList.add('is-loaded');
        if (dom.videoMeta) {
          dom.videoMeta.textContent = `${project.video.w}×${project.video.h} · ${fmt(project.video.duration)} · ${project.video.name}`;
        }
        dom.frameInfo.textContent = `录屏 · ${project.video.w}×${project.video.h}`;
      } catch (err) {
        if (dom.videoMeta) dom.videoMeta.textContent = `视频重连失败：${err.message || err}`;
      } finally {
        hideLoading();
      }
      return;
    }
    if (dom.videoMeta) {
      dom.videoMeta.textContent = project.video.w
        ? `${project.video.w}×${project.video.h} · ${fmt(project.video.duration)} · ${project.video.name}（需要重新选择文件）`
        : '上次选的是本地文件，浏览器不允许记住路径，请重新选择一次。';
    }
    dom.frameInfo.textContent = '录屏 · 等待选择文件';
    toast('上次的录屏是本地文件，请重新选一次（时间轴和镜头都还在）', 4200);
  }

  /* ═══════════════ 启动 ═══════════════ */

  async function boot() {
    Stage.init();
    bind();
    Stage.onShieldToggle(() => {});

    let restored = false;
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        applyProject(saved);
        restored = true;
      }
    } catch (_) {}

    if (restored && project.mode === 'video') {
      // 录屏模式没有可演示的页面，不载入 iframe
      dom.urlInput.value = project.page.input || '';
      refreshTimeline();
      renderInspector();
      await restoreVideo();
      seek(0);
      refreshTimeline();
      window.addEventListener('beforeunload', () => { try { localStorage.setItem(LS_KEY, serialize()); } catch (_) {} });
      setInterval(autosave, 15000);
      return;
    }

    const startSrc = restored && project.page.startSrc ? project.page.startSrc : '/demo/coffee/';
    const startInput = restored && project.page.input ? project.page.input : '/demo/coffee/';
    dom.urlInput.value = startInput;
    const preset = $$('.preset').find((b) => b.dataset.demo === startSrc);
    if (preset) preset.classList.add('is-on');

    project.page = { input: startInput, src: startSrc, startSrc };
    if (!restored) {
      project.camera = [{ t: 0, ...DEFAULT_CAM }];
      project.duration = 12;
    }
    setMode('page', true);
    syncUiFromProject();
    refreshTimeline();
    renderInspector();
    await loadFrame(startSrc);
    seek(0);
    refreshTimeline();
    window.addEventListener('beforeunload', () => { try { localStorage.setItem(LS_KEY, serialize()); } catch (_) {} });
    setInterval(autosave, 15000);
  }

  /* 供测试与脚本调用 */
  window.App = {
    /** 等价于界面上的「导入」：只应用状态，不碰 iframe / 视频源 */
    loadProject(raw) {
      applyProject(raw);
      refreshTimeline();
      renderInspector();
      autosave();
      return { mode: project.mode, keys: project.camera.length, aspect: project.aspect, device: project.device };
    },
    loadVideoSrc(src) { return loadVideo(src); },
    loadVideoFile(file) { return loadVideo(file); },
    setMode: (m) => setMode(m),
    seek: (t) => seek(t, true),
    play, stop: stopPlay,
    get state() {
      return {
        mode: project.mode, t: project.t, duration: project.duration,
        version: project.version, camera: project.camera.map((k) => ({ ...k })),
        device: project.device, aspect: project.aspect,
        effectiveAspect: effectiveAspect(),
        autoSize: Stage.autoSize,
        video: { ...project.video },
        playing: player.playing,
        currentTime: dom.videoEl.currentTime || 0,
      };
    },
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
