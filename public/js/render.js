/**
 * LiveMockup · 内部渲染导出（离线逐帧）
 *
 * 整段视频由 canvas 逐帧合成：
 *   背景预设 → 样机外壳（渐变+圆角）→ 屏幕内容（video 的某一帧）→ 按镜头做透视投影贴回去
 *
 * 两条硬性目标：
 *
 * 1. **每一帧都要真的渲染出来。** 旧实现是「边播边合成」：用 rAF 跟着墙钟跑，
 *    渲染一帧超过 33ms 就直接丢掉那一帧，output 里出现跳帧卡顿。现在改成
 *    离线逐帧：第 i 帧固定对应时间 i/fps，先把 video 精确定位到那一帧，
 *    再画、再编码，然后才走下一帧。慢就是慢，不会丢帧，时间轴也不会漂。
 *
 * 2. **主线程别被拖死。** 编码走 WebCodecs VideoEncoder + 自带的 WebM 封装
 *    （webm-muxer.js），每帧带精确时间戳；因此渲染速度与墙钟解耦，
 *    输出时长永远等于时间轴时长。WebCodecs 不可用时才退回 MediaRecorder 实时录制。
 *
 * 相机投影与 stage.js / app.css 完全对齐：
 *   .device{transform:scale(fit)}  →  .world{translate3d rotateX rotateY rotateZ scale}
 *   .stage{perspective:1700px}
 */
(() => {
  const LONG_EDGE = 1920;
  const PERSP = 1700;

  /**
   * 透视距离＝画面高度的固定倍数，与 Stage.perspOf 同源：
   * 参考画框（582 高）对应 1700px，于是 1080 高的成片画布 = 3155px。
   */
  const PERSP_K = 1700 / 582;
  function perspOf(h) {
    return Math.max(1, PERSP_K * Math.max(1, h));
  } // 与 .stage 的 perspective 一致
  const RAD = Math.PI / 180;

  const MODELS = {
    phone: { dw: 390, dh: 844, pad: 12, radius: 54 },
    tablet: { dw: 834, dh: 1112, pad: 16, radius: 38 },
    browser: { dw: 1180, dh: 736, pad: 0, radius: 14 },
  };
  const COLORS = {
    midnight: ['#3a3d47', '#14161b', '#282b34'],
    silver: ['#eceef3', '#b9bcc4', '#d6d9df'],
    sand: ['#f0dcc0', '#c8a882', '#e2cbb0'],
  };

  /* ───────────── GPU 适配器（有独显就用独显） ───────────── */

  /**
   * 浏览器默认按「省电」给 WebGL / canvas2D 挑适配器，双显卡机器上通常落在集显，
   * 于是渲染时核显 100%、独显 0%。页面能做的只有一件事：**每个上下文都显式请求
   * `powerPreference: 'high-performance'`** —— 有独显时浏览器会把上下文建在独显上，
   * 没有独显时这个偏好自然退化成集显（不会失败）。
   *
   * 三个知道边界：
   *  - 这是「请求」不是「命令」。Chromium 会尽量满足，但 Win 图形设置 / 驱动面板
   *    里把 msedge.exe 指定成「节能」时，浏览器会尊重系统设置。
   *  - 硬件编码器（VideoEncoder）跟随 GPU 进程实际使用的适配器，所以先把上下文
   *    要成高性能，编码才有机会跟着上独显。
   *  - 拿不到 WebGPU / WEBGL_debug_renderer_info 时，探测结果只是名字猜的，
   *    但上下文请求本身不受影响。
   */
  const HP = 'high-performance';

  const gpu = {
    /** 探测到的适配器名（可能为空） */
    adapter: '',
    /** 名字看起来像独显 */
    discrete: false,
    /** 'discrete' | 'integrated' | 'software' | 'unknown' */
    kind: 'unknown',
    /** 合成后端：webgl2 / canvas2d */
    backend: '',
    /** 探测来源：webgpu / webgl / none */
    source: 'none',
    /** 编码器是否拿到了硬件编码 */
    hwEncode: null,
    /** 上下文是否真的拿到了高性能适配器（只有在能读名字时才可信） */
    requested: true,
  };

  // 适配器名字只能启发式判断：先排软件渲染（WARP / SwiftShader），再认独显和集显
  const SOFTWARE_RE = /basic render driver|swiftshader|software rasterizer|llvmpipe|mesa offscreen|warp/i;
  const DISCRETE_RE = /nvidia|geforce|rtx|quadro|radeon\s*(rx|pro|vii)|intel\s*arc|arc\s*a\d|apple\s*m\d/i;
  const INTEGRATED_RE = /intel.*(hd|uhd|iris)|hd graphics|uhd graphics|radeon.*(vega|graphics)/i;

  /** @returns {'discrete'|'integrated'|'software'|'unknown'} */
  function classifyAdapter(name) {
    if (!name) return 'unknown';
    if (SOFTWARE_RE.test(name)) return 'software';
    if (DISCRETE_RE.test(name)) return 'discrete';
    if (INTEGRATED_RE.test(name)) return 'integrated';
    return 'unknown';
  }

  function readGLAdapter(gl) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      return String(name || '');
    } catch (_) { return ''; }
  }

  /** 显卡状态一变（探测到名字 / 定了后端 / 编码器确认硬件编码）就通知界面 */
  const gpuListeners = new Set();
  function notifyGpu() {
    const report = gpuReport();
    gpuListeners.forEach((fn) => {
      try { fn(report); } catch (_) { /* 界面自己的错不该影响渲染 */ }
    });
  }

  function rememberAdapter(name, source) {
    if (!name || gpu.adapter) return;
    gpu.adapter = name;
    gpu.source = source;
    gpu.kind = classifyAdapter(name);
    gpu.discrete = gpu.kind === 'discrete';
    notifyGpu();
  }

  /**
   * 一句话结论：面板和徽标都用它。
   * 注意「读不到名字」不等于没请求 —— 请求已经发了，只是浏览器没暴露适配器信息。
   */
  function gpuReport() {
    const kind = gpu.adapter ? gpu.kind : 'unknown';
    const verdict = kind === 'discrete' ? 'ok'
      : kind === 'integrated' ? 'integrated'
        : kind === 'software' ? 'software' : 'unknown';
    const headline = verdict === 'ok' ? '正在使用独立显卡'
      : verdict === 'integrated' ? '正在使用集成显卡'
        : verdict === 'software' ? '正在用软件光栅化（最慢）'
          : '读不到显卡名称（已请求高性能）';
    return {
      adapter: gpu.adapter || '',
      kind,
      verdict,
      discrete: kind === 'discrete',
      source: gpu.source,
      backend: state.backend || gpu.backend || '',
      hwEncode: gpu.hwEncode,
      requested: HP,
      headline,
    };
  }

  /** 2D 上下文：也带上高性能偏好（不支持该字段的浏览器会直接忽略） */
  function ctx2d(cv, extra) {
    return cv.getContext('2d', { alpha: false, powerPreference: HP, ...extra });
  }

  /**
   * WebGL 上下文：先要高性能，失败再退回默认（没有独显的机器就是这一步）。
   * 注意同一个 canvas 上第一次 getContext 成功后再换参数不会重建，
   * 所以只有真的返回 null 才会走到下一档。
   */
  function glCtx(cv, opts) {
    const gl2hp = cv.getContext('webgl2', { ...opts, powerPreference: HP });
    if (gl2hp) { rememberAdapter(readGLAdapter(gl2hp), 'webgl'); return gl2hp; }
    const gl2 = cv.getContext('webgl2', { ...opts, powerPreference: 'default' });
    if (gl2) { rememberAdapter(readGLAdapter(gl2), 'webgl'); return gl2; }
    const gl1hp = cv.getContext('webgl', { ...opts, powerPreference: HP });
    if (gl1hp) { rememberAdapter(readGLAdapter(gl1hp), 'webgl'); return gl1hp; }
    const gl1 = cv.getContext('webgl', { ...opts, powerPreference: 'default' });
    if (gl1) { rememberAdapter(readGLAdapter(gl1), 'webgl'); return gl1; }
    return null;
  }

  /**
   * 尽早把高性能适配器「唤醒」一次：WebGPU 的 requestAdapter 会按偏好挑适配器，
   * 顺带让我们能读到适配器信息。脚本加载时跑一次，渲染开始时 GPU 进程已经切过去了。
   */
  async function probeGPU() {
    if (!navigator.gpu || !navigator.gpu.requestAdapter) return;
    try {
      const a = await navigator.gpu.requestAdapter({ powerPreference: HP });
      if (!a) return;
      const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
      const name = info
        ? [info.description, info.device, info.vendor, info.architecture].filter(Boolean).join(' ')
        : '';
      if (name) rememberAdapter(name, 'webgpu');
    } catch (_) { /* 没有 WebGPU 就等 WebGL 那边报 */ }
  }

  /* ───────────── 画布尺寸 ───────────── */

  function canvasSize(aspect) {
    const [aw, ah] = String(aspect || '9:16').split(':').map(Number);
    const ar = (aw || 9) / (ah || 16);
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

  /* ───────────── 背景 ───────────── */

  function lin(ctx, W, H, deg, stops) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const len = Math.abs(W * dx) + Math.abs(H * dy);
    const g = ctx.createLinearGradient(
      W / 2 - (dx * len) / 2, H / 2 - (dy * len) / 2,
      W / 2 + (dx * len) / 2, H / 2 + (dy * len) / 2,
    );
    stops.forEach(([c, p]) => g.addColorStop(p, c));
    return g;
  }

  // canvas 没有椭圆渐变，用缩放坐标系伪造一个
  function radial(ctx, cx, cy, rx, ry, stops) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(1, rx), Math.max(1, ry));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    stops.forEach(([c, p]) => g.addColorStop(p, c));
    ctx.fillStyle = g;
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
  }

  const BG = {
    aurora(ctx, W, H) {
      ctx.fillStyle = lin(ctx, W, H, 160, [['#0f1120', 0], ['#05060a', 1]]);
      ctx.fillRect(0, 0, W, H);
      radial(ctx, W * 0.2, H * 0.15, W * 1.2, H * 0.9, [['rgba(75,47,138,1)', 0], ['rgba(75,47,138,0)', 1]]);
      radial(ctx, W * 0.85, H * 0.8, W * 1.0, H * 0.8, [['rgba(31,111,120,1)', 0], ['rgba(31,111,120,0)', 1]]);
    },
    studio(ctx, W, H) {
      radial(ctx, W * 0.5, H * 0.3, W * 0.9, H * 0.7, [['#6e7482', 0], ['#2c2f38', 0.7], ['#1a1c22', 1]]);
    },
    warm(ctx, W, H) {
      ctx.fillStyle = lin(ctx, W, H, 150, [['#f6e3cd', 0], ['#e9b98d', 0.6], ['#d79a6a', 1]]);
      ctx.fillRect(0, 0, W, H);
    },
    paper(ctx, W, H) {
      ctx.fillStyle = lin(ctx, W, H, 150, [['#f4f1ea', 0], ['#e6e1d6', 1]]);
      ctx.fillRect(0, 0, W, H);
    },
    night(ctx, W, H) {
      radial(ctx, W * 0.5, H * 0.25, W * 0.8, H * 0.6, [['#1d2333', 0], ['#06070b', 0.75], ['#06070b', 1]]);
    },
    mint(ctx, W, H) {
      ctx.fillStyle = lin(ctx, W, H, 150, [['#d7f0e5', 0], ['#a8d9c8', 0.7], ['#7cc4ad', 1]]);
      ctx.fillRect(0, 0, W, H);
    },
  };

  function paintBg(ctx, W, H, name) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, W, H);
    (BG[name] || BG.aurora)(ctx, W, H);
    ctx.restore();
  }

  /* ───────────── 圆角路径 ───────────── */

  // r 可以是数字或 [tl,tr,br,bl]
  function roundRect(ctx, x, y, w, h, r) {
    const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  /** 同一套圆角，但产出可复用的 Path2D（省掉每帧重建路径） */
  function roundRectPath(x, y, w, h, r) {
    const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
    const p = new Path2D();
    p.moveTo(x + tl, y);
    p.lineTo(x + w - tr, y);
    p.arcTo(x + w, y, x + w, y + tr, tr);
    p.lineTo(x + w, y + h - br);
    p.arcTo(x + w, y + h, x + w - br, y + h, br);
    p.lineTo(x + bl, y + h);
    p.arcTo(x, y + h, x, y + h - bl, bl);
    p.lineTo(x, y + tl);
    p.arcTo(x, y, x + tl, y, tl);
    p.closePath();
    return p;
  }

  function screenRadius(cfg) {
    const { pad, radius } = cfg;
    const sr = pad === 0
      ? radius
      : (cfg.model === 'phone' || cfg.model === 'tablet' ? radius - 4 : radius);
    return cfg.model === 'browser' ? [0, 0, sr, sr] : sr;
  }

  /* ───────────── 样机贴图 ───────────── */

  function makeTexture(bw, bh, k) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(bw * k));
    cv.height = Math.max(2, Math.round(bh * k));
    // 这张贴图要带 alpha：圆角外、屏幕圆角外都必须是透明的，
    // 不能跟着输出画布用 alpha:false（那样会变成不透明黑，机身外面套一圈黑框）。
    const ctx = ctx2d(cv, { alpha: true });
    ctx.scale(k, k);
    return { cv, ctx, k };
  }

  // 只重画会变的那层（屏幕里的 video 帧），外壳只在建贴图时画一次
  function paintShell(ctx, bw, bh, cfg) {
    const { pad, radius } = cfg;
    const [s1, s2, s3] = COLORS[cfg.color] || COLORS.midnight;
    const rOuter = radius + pad;

    ctx.save();
    ctx.clearRect(0, 0, bw, bh);
    roundRect(ctx, 0, 0, bw, bh, rOuter);
    const g = lin(ctx, bw, bh, 150, [[s1, 0], [s3, 0.22], [s2, 0.52], [s3, 0.8], [s1, 1]]);
    ctx.fillStyle = g;
    ctx.fill();

    // 一圈极淡的高光，避免边框看起来像纯色块
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.stroke();

    roundRect(ctx, pad, pad, bw - pad * 2, bh - pad * 2, screenRadius(cfg));
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  /**
   * 玻璃反光。编辑器里是 .device__glare 一层 CSS 叠加（linear 118deg + 顶部径向高光，
   * mix-blend-mode: screen，opacity .9）；渲染器以前完全没画，所以开着反光的工程
   * 预览和成片会明显不一样。这里按同样的渐变画进样机贴图，透视贴回时自动跟着形变。
   */
  function paintGlare(tex, cfg) {
    const { ctx } = tex;
    const bw = tex.cv.width / tex.k;
    const bh = tex.cv.height / tex.k;
    const pad = cfg.pad;
    const w = bw - pad * 2;
    const h = bh - pad * 2;

    ctx.save();
    ctx.clip(tex.screenPath);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.9;

    // linear-gradient(118deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.05) 26%, transparent 42%)
    const a = (118 * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    const cx = pad + w / 2;
    const cy = pad + h / 2;
    const g1 = ctx.createLinearGradient(
      cx - (dx * len) / 2, cy - (dy * len) / 2,
      cx + (dx * len) / 2, cy + (dy * len) / 2,
    );
    g1.addColorStop(0, 'rgba(255,255,255,.16)');
    g1.addColorStop(0.26, 'rgba(255,255,255,.05)');
    g1.addColorStop(0.42, 'rgba(255,255,255,0)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(pad, pad, w, h);

    // radial-gradient(120% 60% at 80% -10%, rgba(255,255,255,.18), transparent 60%)
    ctx.save();
    ctx.translate(pad + w * 0.8, pad + h * -0.1);
    ctx.scale(Math.max(1, w * 1.2), Math.max(1, h * 0.6));
    const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g2.addColorStop(0, 'rgba(255,255,255,.18)');
    g2.addColorStop(0.6, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();

    ctx.restore();
  }

  function paintScreen(tex, cfg, video) {
    const { ctx } = tex;
    const bw = tex.cv.width / tex.k;
    const bh = tex.cv.height / tex.k;
    const { pad } = cfg;
    const sw = bw - pad * 2;
    const sh = bh - pad * 2;

    ctx.save();
    ctx.clip(tex.screenPath);
    ctx.fillStyle = '#000';
    ctx.fillRect(pad, pad, sw, sh);
    if (video && video.videoWidth && video.videoHeight) {
      const ar = video.videoWidth / video.videoHeight;
      let dw = sw;
      let dh = sw / ar;
      if (dh > sh) {
        dh = sh;
        dw = sh * ar;
      }
      const dx = pad + (sw - dw) / 2;
      const dy = pad + (sh - dh) / 2;
      // 只有「真的在缩小」才值得花高质量过滤（medium 比 low 贵 4 倍）。
      // 贴图分辨率是按投影后尺寸算的，多数情况是 1:1 或放大，low 就够，看不出差别。
      ctx.imageSmoothingQuality = dw >= video.videoWidth * 0.9 ? 'low' : 'medium';
      // video 可以是 <video>，也可以是原生解码出来的帧包装 { videoWidth, videoHeight, __frame }
      ctx.drawImage(video.__frame || video, dx, dy, dw, dh);
    }
    ctx.restore();
  }

  /* ───────────── 阴影 ───────────── */

  const SHADOW_PAD = 52; // 阴影贴图在设备四周留的空白（设备坐标）

  /**
   * 阴影每帧都在变（跟着镜头走），但它是低频的：
   * 与其每帧对整块画布做一次 blur，不如**只做一次**模糊贴图，
   * 之后按仿射变换整张贴上去。blur 成本从「每帧」降到「渲染开始时一次」。
   */
  function makeShadowSprite(bw, bh, cfg) {
    const S = SHADOW_PAD;
    const cw = bw + S * 2;
    const ch = bh + S * 2;
    const k = Math.min(0.6, 520 / Math.max(cw, ch));
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(cw * k));
    cv.height = Math.max(2, Math.round(ch * k));
    // 阴影贴图整张就是「模糊后的 alpha」，必须是透明画布；
    // 设成 alpha:false 会退化成一块实心黑，机身四周出现硬边黑框。
    const ctx = ctx2d(cv, { alpha: true });
    ctx.scale(k, k);
    ctx.filter = 'blur(18px)';
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    roundRect(ctx, S, S, bw, bh, cfg.radius + cfg.pad);
    ctx.fill();
    return { cv, cw, ch };
  }

  /* ───────────── 镜头投影（一次算矩阵，逐点只做乘加） ───────────── */

  /**
   * 把设备局部坐标 (u,v)（相对设备中心，含 fit 缩放）投到输出画布坐标。
   * 变换顺序与 CSS 一致：scale → rotateZ → rotateY → rotateX → translate3d → perspective
   *
   * 除最后一步的透视除法外整条链都是线性的，所以先把它折成 6 个系数，
   * 之后每个网格顶点只做几次乘加 —— 旧实现每个顶点都要新建一个数组，
   * 一帧上千次分配，GC 抖动本身就是卡顿来源之一。
   */
  function cameraMatrix(cam, W, H, fit, persp) {
    const ax = (cam.rx || 0) * RAD;
    const ay = (cam.ry || 0) * RAD;
    const az = (cam.rz || 0) * RAD;
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);
    const s = (Number.isFinite(cam.scale) ? cam.scale : 1) * fit;
    return {
      A: s * cz * cy,
      B: -s * sz * cy,
      C: s * (cx * sz + sx * cz * sy),
      D: s * (cx * cz - sx * sz * sy),
      E: s * (sx * sz - cx * cz * sy),
      F: s * (sx * cz + cx * sz * sy),
      tx: cam.x || 0,
      ty: cam.y || 0,
      tz: cam.z || 0,
      w2: W / 2,
      h2: H / 2,
      // 透视距离跟着「场景比例」走：镜头里的 x/y/z 是舞台像素，
      // 换到输出画布上整台摄影机要等比放大，否则同一个 z 的透视强度会变。
      persp: Number.isFinite(persp) && persp > 0 ? persp : PERSP,
    };
  }

  let _px = 0;
  let _py = 0;
  function project(M, u, v) {
    const X = M.A * u + M.B * v + M.tx;
    const Y = M.C * u + M.D * v + M.ty;
    const Z = M.E * u + M.F * v + M.tz;
    const k = M.persp / (M.persp - Z);
    _px = M.w2 + X * k;
    _py = M.h2 + Y * k;
  }

  /**
   * 逐格仿射，逼近透视投影（canvas 2D 没有真正的梯形贴图）。
   * 格子数按「投影后的像素尺寸」定：目标每格 ~72 输出像素，
   * 于是小画面不会白切 256 刀，大画面也不会糊。
   */
  function gridFor(M, bw, bh) {
    project(M, -bw / 2, -bh / 2);
    const x0 = _px, y0 = _py;
    project(M, bw / 2, -bh / 2);
    const ew = Math.hypot(_px - x0, _py - y0);
    project(M, -bw / 2, bh / 2);
    const eh = Math.hypot(_px - x0, _py - y0);
    return Math.max(6, Math.min(20, Math.round(Math.max(ew, eh) / 52)));
  }

  function warpTexture(dst, tex, bw, bh, M, grid) {
    const k = tex.k;
    const cw = bw / grid;
    const ch = bh / grid;
    // 每格向四周多铺 2%：相邻格重叠，重叠处画的是同一批像素，
    // 不会变暗，却能把逐格仿射在格子缝上留下的 1px 空隙盖掉。
    const ox = cw * 0.02;
    const oy = ch * 0.02;
    const du = cw + ox * 2;
    const dv = ch + oy * 2;

    dst.save();
    dst.beginPath();
    // 透视变换把直线映射成直线，所以四边形裁切用四个角就够（不用采样整圈）
    project(M, -bw / 2, -bh / 2); dst.moveTo(_px, _py);
    project(M, bw / 2, -bh / 2); dst.lineTo(_px, _py);
    project(M, bw / 2, bh / 2); dst.lineTo(_px, _py);
    project(M, -bw / 2, bh / 2); dst.lineTo(_px, _py);
    dst.closePath();
    dst.clip();

    for (let j = 0; j < grid; j++) {
      const v0 = -bh / 2 + j * ch - oy;
      const v1 = v0 + dv;
      const sy = (v0 + bh / 2) * k;
      const sh = dv * k;
      for (let i = 0; i < grid; i++) {
        const u0 = -bw / 2 + i * cw - ox;
        const u1 = u0 + du;
        project(M, u0, v0); const x00 = _px, y00 = _py;
        project(M, u1, v0); const x10 = _px, y10 = _py;
        project(M, u0, v1); const x01 = _px, y01 = _py;
        const sx = (u0 + bw / 2) * k;
        const sw = du * k;
        dst.setTransform(
          (x10 - x00) / sw, (y10 - y00) / sw,
          (x01 - x00) / sh, (y01 - y00) / sh,
          x00, y00,
        );
        dst.drawImage(tex.cv, sx, sy, sw, sh, 0, 0, sw, sh);
      }
    }
    dst.restore();
    dst.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawShadow(dst, sprite, M, bw, bh, fit) {
    const W0 = sprite.cw;
    const H0 = sprite.ch;
    const shift = bh * 0.06 * fit; // 轻微下坠，和 CSS 里那条阴影一致
    project(M, -W0 / 2, -H0 / 2); const x00 = _px, y00 = _py + shift;
    project(M, W0 / 2, -H0 / 2); const x10 = _px, y10 = _py + shift;
    project(M, -W0 / 2, H0 / 2); const x01 = _px, y01 = _py + shift;
    const sw = sprite.cv.width;
    const sh = sprite.cv.height;
    dst.setTransform(
      (x10 - x00) / sw, (y10 - y00) / sw,
      (x01 - x00) / sh, (y01 - y00) / sh,
      x00, y00,
    );
    dst.drawImage(sprite.cv, 0, 0);
    dst.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** 投影后设备外框的像素包围盒（四角就够：边一定是直线） */
  function quadBounds(M, bw, bh, pad, W, H) {
    project(M, -bw / 2, -bh / 2); let x0 = _px, y0 = _py; let x1 = _px, y1 = _py;
    project(M, bw / 2, -bh / 2); x0 = Math.min(x0, _px); x1 = Math.max(x1, _px); y0 = Math.min(y0, _py); y1 = Math.max(y1, _py);
    project(M, bw / 2, bh / 2); x0 = Math.min(x0, _px); x1 = Math.max(x1, _px); y0 = Math.min(y0, _py); y1 = Math.max(y1, _py);
    project(M, -bw / 2, bh / 2); x0 = Math.min(x0, _px); x1 = Math.max(x1, _px); y0 = Math.min(y0, _py); y1 = Math.max(y1, _py);
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad));
    y1 = Math.min(H, Math.ceil(y1 + pad));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  function unionRect(a, b) {
    if (!a) return b;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const r = Math.max(a.x + a.w, b.x + b.w);
    const bt = Math.max(a.y + a.h, b.y + b.h);
    return { x, y, w: r - x, h: bt - y };
  }

  /* ───────────── 取镜头姿态 ───────────── */

  function poseAt(camera, t) {
    if (window.Stage && typeof Stage.sample === 'function') return Stage.sample(camera || [], t);
    return { x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 };
  }

/* ───────────── 合成器：WebGL2（精确透视） / canvas2D（兜底） ───────────── */

  /*
   * 为什么不是「把网格切得更细」：canvas 2D 没有梯形贴图，只能把小格逐格用仿射逼近透视。
   * 仿射逼近的误差 ∝ 格宽² × 透视强度 —— 偏航 60° 时，12×12 的网格在 1080p 上
   * 单格误差就有 8px，相邻格错开就成阶梯，看起来就是画面被撕裂（横线被切成一段段、
   * 文字错位）。数值上要压到亚像素得切 3000+ 格，每格一次 drawImage，代价不可接受。
   *
   * WebGL 一步到位：把四个角的**齐次坐标**丢给光栅化器，硬件自己除 w 并做透视校正插值，
   * 几何上精确，没有格子自然没有接缝。
   *   screen = (X/w, Y/w)，w = (PERSP - Z)/PERSP
   *   令 gl_Position = (2X/W, -2Y/H, 0, w)，GPU 除完就是 NDC。
   * WebGL2 拿不到时退回逐格仿射，并把网格加密（比旧版细一档），尽量减轻撕裂。
   */

  const GL_VERT = `#version 300 es
in vec3 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos.xy, 0.0, aPos.z);
}`;

  const GL_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV);
}`;

  function compileProgram(gl) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, GL_VERT);
    const fs = mk(gl.FRAGMENT_SHADER, GL_FRAG);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    return p;
  }

  /** @returns {null | {out:HTMLCanvasElement, paint:Function}} */
  function createGLPainter(a) {
    const { W, H, bw, bh, fit, persp, camera, cfg, bgCanvas, tex, shadow } = a;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;

    let gl = null;
    try {
      // 先要独显（powerPreference 见文件头 GPU 段），失败或没有独显时自动退回默认
      gl = glCtx(canvas, {
        alpha: false,
        antialias: true,          // 机身圆角/斜边的锯齿靠 MSAA
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        // 每帧都要把画布读回去做 VideoFrame 和弹窗预览，不能让它被合成分解掉
        preserveDrawingBuffer: true,
      });
    } catch (_) { gl = null; }
    if (!gl) return null;

    const program = compileProgram(gl);
    if (!program) return null;

    gl.useProgram(program);
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aUV = gl.getAttribLocation(program, 'aUV');
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, 6 * 5 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 20, 12);

    gl.viewport(0, 0, W, H);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 贴图是预乘 alpha

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const anisoMax = aniso ? Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;

    function makeTex(src) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return t;
    }

    const bgTex = makeTex(bgCanvas);
    const shTex = makeTex(shadow.cv);
    const devTex = makeTex(tex.cv);

    // 全屏背景：w=1 就退化成普通的正交铺满
    const screenQuad = [
      { x: -W / 2, y: -H / 2, w: 1, u: 0, v: 0 },
      { x: W / 2, y: -H / 2, w: 1, u: 1, v: 0 },
      { x: W / 2, y: H / 2, w: 1, u: 1, v: 1 },
      { x: -W / 2, y: H / 2, w: 1, u: 0, v: 1 },
    ];

    /**
     * 设备空间矩形 → 四个齐次角点。
     * shiftY 是**屏幕像素**的下坠量：因为 screen_y = H/2 + Y/w，屏幕下移 s 等价于 Y += s·w。
     */
    function corners(M, u0, v0, u1, v1, shiftY) {
      const us = [u0, u1, u1, u0];
      const vs = [v0, v0, v1, v1];
      const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      const pts = [];
      for (let i = 0; i < 4; i++) {
        const u = us[i];
        const v = vs[i];
        const X = M.A * u + M.B * v + M.tx;
        const Y = M.C * u + M.D * v + M.ty;
        const Z = M.E * u + M.F * v + M.tz;
        let w = (M.persp - Z) / M.persp;
        // 极端机位会把样机的一部推到「相机后面」，那时 w≤0 会让三角形翻面成乱码；
        // 夹一个极小正值，让它退化成被裁掉的超大四边形，而不是闪一片花屏。
        if (!(w > 0.02)) w = 0.02;
        pts.push({ x: X, y: Y + (shiftY || 0) * w, w, u: uvs[i * 2], v: uvs[i * 2 + 1] });
      }
      return pts;
    }

    const verts = new Float32Array(30);
    const ORD = [0, 1, 2, 0, 2, 3];

    function draw(texObj, pts, useMips) {
      for (let k = 0; k < 6; k++) {
        const p = pts[ORD[k]];
        verts[k * 5] = (2 * p.x) / W;
        verts[k * 5 + 1] = (-2 * p.y) / H;
        verts[k * 5 + 2] = p.w;
        verts[k * 5 + 3] = p.u;
        verts[k * 5 + 4] = p.v;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
      gl.bindTexture(gl.TEXTURE_2D, texObj);
      if (useMips) {
        // 透视压缩的那一侧是强缩小采样：只靠双线性会把细线抽成虚线（看着就是「撕裂」）。
        // 开 mip 链 + 最大各向异性；放大侧 LOD≤0，仍然走 LINEAR，不会变糊。
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisoMax);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    let dirty = null;

    function paint(t, video) {
      const cam = poseAt(camera, t);
      const M = cameraMatrix(cam, W, H, fit, persp);

      // 只有屏幕那一层会变：2D 里重画外壳+视频帧（+ 反光），然后整张贴图传上去
      paintScreen(tex, cfg, video);
      if (cfg.glare) paintGlare(tex, cfg);
      gl.bindTexture(gl.TEXTURE_2D, devTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex.cv);

      const bounds = quadBounds(M, bw, bh, SHADOW_PAD * fit + 24, W, H);
      const area = dirty ? unionRect(dirty, bounds) : { x: 0, y: 0, w: W, h: H };
      dirty = bounds;

      // 脏区以外的像素不用重新画：背景是静态贴图，省下的都是纯填充率
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(area.x, H - area.y - area.h, area.w, area.h);

      gl.disable(gl.BLEND);
      draw(bgTex, screenQuad, false);

      gl.enable(gl.BLEND);
      const shift = bh * 0.06 * fit;
      draw(shTex, corners(M, -shadow.cw / 2, -shadow.ch / 2, shadow.cw / 2, shadow.ch / 2, shift), false);

      // 机身贴图恒定开 mip。
      // 曾经用「最长边 / 贴图宽」当开关，但那在「z 推近 + 大 scale」时会算成 1.18（>0.7），
      // 于是 mip 被关掉 —— 而这时远侧其实已经压到 0.3 倍，细横线全被抽成虚线。
      // 透视下的缩放范围本来就跨一个数量级，全局开关没有意义，交给 GPU 逐片元选 LOD。
      const devPts = corners(M, -bw / 2, -bh / 2, bw / 2, bh / 2, 0);
      draw(devTex, devPts, true);

      gl.disable(gl.SCISSOR_TEST);
      return canvas;
    }

    // 页面上同时存活的 WebGL 上下文数量有上限（十几个），逐帧渲染每次都会新建一个；
    // 渲染完主动 lose，避免连续导出几次之后老上下文被浏览器强行丢掉。
    const lose = gl.getExtension('WEBGL_lose_context');
    function dispose() {
      try { if (lose) lose.loseContext(); } catch (_) {}
    }

    return { out: canvas, paint, backend: 'webgl2', dispose };
  }

  /** canvas 2D 兜底：逐格仿射（网格比旧版更密，撕裂轻一些但仍然只是近似） */
  function createCanvasPainter(a) {
    const { W, H, bw, bh, fit, persp, camera, cfg, bgCanvas, tex, shadow, gridHint } = a;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = ctx2d(out);
    ctx.imageSmoothingQuality = 'low';

    let dirty = null;

    function paint(t, video) {
      const cam = poseAt(camera, t);
      const M = cameraMatrix(cam, W, H, fit, persp);

      const bounds = quadBounds(M, bw, bh, SHADOW_PAD * fit + 24, W, H);
      const area = dirty ? unionRect(dirty, bounds) : { x: 0, y: 0, w: W, h: H };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(bgCanvas, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
      dirty = bounds;

      paintScreen(tex, cfg, video);
      if (cfg.glare) paintGlare(tex, cfg);
      drawShadow(ctx, shadow, M, bw, bh, fit);
      const grid = gridHint || gridFor(M, bw, bh);
      warpTexture(ctx, tex, bw, bh, M, grid);
      return out;
    }

    function dispose() {
      out.width = 0;
      out.height = 0;
    }

    return { out, paint, backend: 'canvas2d', dispose };
  }

  /* ───────────── 场景（一次渲染 = 一个场景） ───────────── */

  function createScene({ W, H, camera, bg, color, model, autoSize, duration, preferGL = true, gridHint = 0, persp = PERSP, glare = false }) {
    // auto 机型必须由调用方给出输入分辨率：悄悄退回 phone 会让预览和成片机型都不一样
    if (model === 'auto' && !autoSize) throw new Error('auto 机型缺少输入分辨率（先选录屏视频）');
    const base = MODELS[model] || { dw: autoSize.w, dh: autoSize.h };
    const cfg = {
      model,
      pad: model === 'auto' ? 0 : base.pad,
      radius: model === 'auto' ? 16 : base.radius,
      color,
      glare: !!glare,
    };
    const bw = base.dw + cfg.pad * 2;
    const bh = base.dh + cfg.pad * 2;

    // 取景与舞台共用同一套规则（Stage.FIT_MARGIN），这是「预览 == 成片」的前提。
    const fit = (window.Stage && typeof Stage.fitOf === 'function')
      ? Stage.fitOf(model, bw, bh, W, H)
      : Math.min((W * 0.88) / bw, (H * 0.88) / bh);

    // 背景只画一次
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = W;
    bgCanvas.height = H;
    paintBg(ctx2d(bgCanvas), W, H, bg);

    // 贴图分辨率跟着「屏幕上实际有多大」走：
    // 旧实现按输出长边乘 1.35 再封顶 3×，手机机型直接 3× 超采样，
    // 视频要先画进 1242×2604 的贴图再被缩回 ~660px，纯属白算。
    let maxScale = 1;
    const samples = 9;
    for (let i = 0; i <= samples; i++) {
      const cam = poseAt(camera, (duration * i) / samples);
      const M = cameraMatrix(cam, W, H, fit, persp);
      project(M, -bw / 2, -bh / 2);
      const x0 = _px, y0 = _py;
      project(M, bw / 2, -bh / 2);
      const ew = Math.hypot(_px - x0, _py - y0) / bw;
      project(M, -bw / 2, bh / 2);
      const eh = Math.hypot(_px - x0, _py - y0) / bh;
      maxScale = Math.max(maxScale, ew, eh);
    }
    const kArea = Math.sqrt(3.4e6 / (bw * bh)); // 贴图像素上限，防止巨型画布
    const k = Math.max(1, Math.min(2.6, kArea, maxScale * 1.08));

    const tex = makeTexture(bw, bh, k);
    tex.screenPath = roundRectPath(cfg.pad, cfg.pad, bw - cfg.pad * 2, bh - cfg.pad * 2, screenRadius(cfg));
    paintShell(tex.ctx, bw, bh, cfg);

    const shadow = makeShadowSprite(bw, bh, cfg);

    const assets = { W, H, bw, bh, fit, persp, camera, cfg, bgCanvas, tex, shadow, gridHint };
    // 先试 WebGL；任何一步失败（没有 webgl2、着色器编译不过）都退回 canvas 2D
    const painter = (preferGL ? createGLPainter(assets) : null) || createCanvasPainter(assets);

    return {
      out: painter.out,
      paint: painter.paint,
      backend: painter.backend,
      dispose: () => { try { painter.dispose(); } catch (_) {} },
      cfg, bw, bh, fit,
      get textureScale() { return tex.k; },
    };
  }

  /* ───────────── 像素源：把 video 精确定位到某一帧 ───────────── */

  function onceSeek(v, t) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', fin);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(fin, 1200);
      v.addEventListener('seeked', fin);
      try { v.currentTime = t; } catch (_) { fin(); }
    });
  }

  /**
   * 等一帧「真的已经呈现」再画。
   *
   * 为什么需要：硬件解码的 4K 源，`seeked` 只是说「目标帧解出来了」，
   * 但这一帧被拷进合成器用的是纹理 / 共享内存的**异步**路径，
   * 紧接着 drawImage 有可能读到「上半截是新帧、下半截还是上一帧」——
   * 这就是导出里才会出现的「撕裂」：预览是顺序播放，根本不走 seek 这条路。
   * 让出一个合成帧（rAF + 一个 0ms 宏任务）就够了，页面被节流时用 80ms 兜底。
   */
  function nextPresent() {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      setTimeout(fin, 80);
      requestAnimationFrame(() => setTimeout(fin, 0));
    });
  }

  function seekVideo(v, t) {
    const target = Math.max(0, t);
    if (Math.abs((v.currentTime || 0) - target) < 0.004 && v.readyState >= 2) return Promise.resolve(false);
    if (!v.paused) { try { v.pause(); } catch (_) {} }
    return onceSeek(v, target).then(nextPresent).then(() => true);
  }

  /* ───────────── 编码 ───────────── */

  const CODECS = [
    { codec: 'vp09.00.10.08', container: 'V_VP9', label: 'VP9' },
    { codec: 'vp09.00.41.08', container: 'V_VP9', label: 'VP9' },
    { codec: 'vp8', container: 'V_VP8', label: 'VP8' },
  ];

  async function pickCodec(cfg) {
    if (typeof VideoEncoder !== 'function') return null;
    // 先要硬件编码（跟随 GPU 适配器），拿不到再退回不指定偏好。
    // 注意：某些环境里 isConfigSupported 对 prefer-hardware 会直接报 unsupported，
    // 所以必须留着第二档，不然会整段掉进 MediaRecorder 兜底（那玩意儿没有时长元数据）。
    for (const acc of ['prefer-hardware', 'no-preference']) {
      for (const c of CODECS) {
        try {
          const r = await VideoEncoder.isConfigSupported({
            ...cfg, ...c, codec: c.codec, hardwareAcceleration: acc,
          });
          if (r && r.supported) return { ...c, hardwareAcceleration: acc };
        } catch (_) { /* 继续试下一个 */ }
      }
    }
    return null;
  }

  function webcodecsSink(codec, cfg, mux) {
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        try { mux.addChunk(chunk); } catch (e) { failure = failure || e; }
      },
      error: (e) => { failure = failure || e; },
    });
    encoder.configure({ ...cfg, codec: codec.codec, hardwareAcceleration: codec.hardwareAcceleration || 'no-preference' });
    gpu.hwEncode = codec.hardwareAcceleration === 'prefer-hardware';
    notifyGpu();
    const gop = Math.max(1, Math.round(cfg.framerate));
    return {
      kind: 'webcodecs',
      label: codec.label,
      encode(canvas, i) {
        if (failure) throw failure;
        const t1 = performance.now();
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((i * 1e6) / cfg.framerate),
          duration: Math.round(1e6 / cfg.framerate),
        });
        const t2 = performance.now();
        encoder.encode(frame, { keyFrame: i % gop === 0 });
        const t3 = performance.now();
        frame.close();
        stats.frameMake += t2 - t1;
        stats.encCall += t3 - t2;
      },
      get backpressure() { return encoder.encodeQueueSize; },
      async finish() {
        await encoder.flush();
        if (failure) throw failure;
        try { encoder.close(); } catch (_) {}
        return mux.finish();
      },
      dispose() { try { encoder.close(); } catch (_) {} },
    };
  }

  function pickMime() {
    const list = [
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

  /** 兜底：WebCodecs 不可用（非安全上下文等）时退回实时录制，行为和旧版一致 */
  /**
   * 客户端原生解码：ffmpeg 顺序吐原始帧，绕开 <video>.currentTime 的 seek 开销。
   *
   * 每帧一次 IPC（Uint8Array）→ ImageData（零拷贝视图）→ createImageBitmap。
   * 帧是「按输出帧率重采样好」的，所以和第 i 个输出帧一一对应，不需要时间换算。
   */
  function nativeDecoder(api, opts) {
    let begun = null;
    let W = 0;
    let H = 0;
    let transport = 'raw';
    return {
      async start() {
        if (!begun) {
          begun = api.decode.begin(opts).then((r) => {
            if (!r || r.ok === false) throw new Error((r && r.error) || '原生解码启动失败');
            W = r.width;
            H = r.height;
            transport = r.transport || 'raw';
            return r;
          });
        }
        return begun;
      },
      async next() {
        await this.start();
        const r = await api.decode.frame();
        if (!r || r.ok === false) throw new Error((r && r.error) || '读帧失败');
        const u8 = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
        // jpeg：一帧只有 ~100KB，解出来就是目标尺寸；raw：RGBA 直通（零拷贝视图）
        const bitmap = transport === 'jpeg'
          ? await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }))
          : await createImageBitmap(new ImageData(
            new Uint8ClampedArray(u8.buffer, u8.byteOffset, u8.byteLength), W, H));
        return { videoWidth: bitmap.width, videoHeight: bitmap.height, __frame: bitmap };
      },
      dispose() {
        try { api.decode.end(); } catch (_) {}
      },
    };
  }

  /**
   * 客户端原生编码：每帧原始像素直接写进 ffmpeg 的 stdin，出 H.264 / MP4。
   *
   * 为什么要它：浏览器里只有 WebCodecs（VP9/WebM，码率有上限、容器受限），
   * 而客户端里编码器是我们自己的进程 —— 想要 CRF 质量、想要 MP4、想要
   * 任意码率都可以。帧走的是「2D 画布取像素 → IPC → ffmpeg」，不经过 WebCodecs。
   */
  function nativeSink(cfg, opts) {
    const api = window.LM;
    const cv = document.createElement('canvas');
    cv.width = cfg.width;
    cv.height = cfg.height;
    const ctx = cv.getContext('2d', { alpha: false, willReadFrequently: true });
    const crf = opts.crf == null ? 16 : opts.crf;
    let begun = null;
    let path = '';
    let frames = 0;

    const begin = async () => {
      const r = await api.job.begin({
        width: cfg.width,
        height: cfg.height,
        fps: cfg.framerate,
        crf,
        preset: opts.preset || 'veryfast',
        defaultName: opts.defaultName || 'livemockup.mp4',
        // 指定了输出路径就跳过保存对话框（脚本 / 测试 / 批量导出用）
        outPath: opts.outPath || '',
      });
      if (!r || r.ok === false) throw new Error((r && r.error) || '原生编码启动失败');
      if (r.canceled) { const e = new Error('已取消'); e.aborted = true; throw e; }
      path = r.path;
      return r;
    };

    return {
      kind: 'native',
      label: 'FFmpeg · H.264',
      get backpressure() { return 0; },
      async encode(src) {
        if (!begun) begun = begin();
        await begun;
        // 先落到 2D 画布：WebGL 画布上不能直接 getImageData
        ctx.drawImage(src, 0, 0);
        const img = ctx.getImageData(0, 0, cfg.width, cfg.height);
        const r = await api.job.frame(img.data);
        if (!r || r.ok === false) throw new Error((r && r.error) || '写帧失败');
        frames += 1;
      },
      async finish() {
        const r = await api.job.end();
        if (!r || r.ok === false) throw new Error((r && r.error) || '收尾失败');
        return {
          native: true,
          path: r.path || path,
          size: r.size || 0,
          frames: r.frames || frames,
          codec: 'H.264',
          crf,
        };
      },
      dispose() { try { api.job.abort(); } catch (_) {} },
    };
  }

  function recorderSink(canvas, { fps, bitrate }) {
    const stream = canvas.captureStream(fps);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: bitrate,
    });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(200);
    return {
      kind: 'recorder',
      label: 'MediaRecorder',
      stream,
      async finish() {
        const blob = await new Promise((resolve) => {
          const done = () => resolve(new Blob(chunks, { type: chunks[0]?.type || 'video/webm' }));
          if (rec.state !== 'inactive') {
            rec.onstop = done;
            try { rec.stop(); } catch (_) { done(); }
          } else {
            done();
          }
        });
        stream.getTracks().forEach((t) => t.stop());
        return blob;
      },
      dispose() {
        try { rec.stop(); } catch (_) {}
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  /* ───────────── 主流程 ───────────── */

  const state = {
    active: false,
    aborted: false,
    sink: null,
    video: null,
    phase: 'idle',
    // 空 = 还没渲染过（真正的后端在第一次 createScene 时才定下来）
    backend: '',
    // 最近一次用到的编码通道：native / webcodecs / recorder
    lastSink: '',
    // 最近一次用到的取帧方式：ffmpeg / ''（<video> seek）
    lastDecoder: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 分阶段累计耗时（ms）：定位「为什么慢」用，也顺手暴露给测试 */
  const stats = { seek: 0, paint: 0, submit: 0, wait: 0, frameMake: 0, encCall: 0, frames: 0 };
  function resetStats() {
    stats.seek = 0; stats.paint = 0; stats.submit = 0; stats.wait = 0; stats.frameMake = 0; stats.encCall = 0; stats.frames = 0;
  }

  function abortError() {
    const e = new Error('已取消');
    e.aborted = true;
    return e;
  }

  /**
   * @param {object} o
   * @param {HTMLVideoElement} o.video    要播放的录屏（不要求可见）
   * @param {string} o.aspect             输出画幅 '16:9' / '9:16' / '1280:720'
   * @param {Array}  o.camera             镜头关键帧
   * @param {string} o.bg                 背景预设
   * @param {string} o.color              机身颜色
   * @param {string} o.model              phone / tablet / browser / auto
   * @param {{w:number,h:number}} o.autoSize  auto 机型对应视频分辨率
   * @param {number} o.duration           导出时长（秒）
   * @param {number} [o.fps=30]
   * @param {(p:object)=>void} [o.onProgress] 逐帧进度
   * @param {(phase:string)=>void} [o.onPhase] 'prepare' | 'render' | 'encode'
   * @param {boolean} [o.glare=false] 是否画玻璃反光（和编辑器 .device__glare 一致）
   * @param {boolean} [o.preferGL=true] 是否优先用 WebGL2 合成（false 强制走 canvas2D 兜底）
   * @param {boolean|object} [o.native=false] 客户端里走原生 ffmpeg 编码：
   *        true 或 { crf, preset, defaultName }。返回 { native:true, path, size, frames } 而不是 Blob
   * @param {number} [o.gridHint=0] 强制指定 canvas2D 的网格数（测试做精确参考用）
   * @returns {Promise<Blob>}
   */
  async function render(o) {
    if (state.active) throw new Error('已经有一个渲染任务在跑');
    const {
      video, aspect = '9:16', camera = [], bg = 'aurora', color = 'midnight',
      model = 'auto', autoSize = null, duration = 5, fps: fpsIn = 30,
      onProgress, onPhase, preferGL = true, gridHint = 0, glare = false,
      native = false, decode = null,
    } = o;

    if (!video) throw new Error('没有可渲染的视频');
    if (!video.videoWidth) throw new Error('视频还没就绪（拿不到画面尺寸）');

    const fps = Math.max(1, Math.min(60, Math.round(fpsIn)));
    const total = Math.max(1, Math.round(Math.max(0.1, duration) * fps));
    const { w: W, h: H } = canvasSize(aspect);

    // ── 镜头单位（v2）：x = 画框宽的比例，y = 画框高的比例，z = 透视距离的比例 ──
    // 全部相对**输出画布**，所以成片构图和编辑器窗口多大、浏览器缩放多少都无关；
    // 编辑器那边（Stage.apply）用同一套公式换到舞台像素上。
    const persp = perspOf(H);
    const cam = camera.map((k) => ({
      ...k,
      x: (Number.isFinite(k.x) ? k.x : 0) * W,
      y: (Number.isFinite(k.y) ? k.y : 0) * H,
      z: (Number.isFinite(k.z) ? k.z : 0) * persp,
    }));

    state.active = true;
    state.aborted = false;
    state.video = video;
    state.phase = 'prepare';
    if (onPhase) { try { onPhase('prepare'); } catch (_) {} }

    let scene;
    let sink;
    let dec = null;
    let lastDecodeInfo = null;
    try {
      scene = createScene({
        W, H, camera: cam, bg, color, model, autoSize, duration: Math.max(0.1, duration),
        preferGL, gridHint, persp, glare,
      });
      state.backend = scene.backend;
      notifyGpu();

      const bitrate = Math.round(Math.min(24e6, Math.max(4e6, W * H * fps * 0.18)));
      // prefer-hardware：明确要求硬件编码板（有独显时跟随 GPU 进程的适配器）。
      // 拿不到就由浏览器回退软件编码，不会失败。
      const cfg = {
        width: W, height: H, bitrate, framerate: fps,
        latencyMode: 'quality', hardwareAcceleration: 'prefer-hardware',
      };
      // 客户端：优先走原生 ffmpeg（H.264/MP4，不受 WebCodecs 限制）
      const useNative = !!(native && window.LM && window.LM.job && window.LM.isClient);
      const codec = useNative ? null : await pickCodec(cfg);
      if (useNative) {
        sink = nativeSink(cfg, typeof native === 'object' ? native : {});
        gpu.nativeEncode = true;
      } else if (codec) {
        const mux = window.WebmMuxer.create({
          width: W, height: H, codec: codec.container, fps, frames: total,
        });
        sink = webcodecsSink(codec, cfg, mux);
      } else {
        sink = recorderSink(scene.out, { fps, bitrate });
      }
      state.sink = sink;
      state.lastSink = sink.kind;

      // 原生解码：有真实文件路径 + 客户端解码能力才启用
      if (decode && decode.path && window.LM && window.LM.decode && window.LM.isClient) {
        const src = decode.source || {};
        dec = nativeDecoder(window.LM, {
          path: decode.path,
          fps,
          width: src.width || 0,
          height: src.height || 0,
          // jpeg：每帧 ~100KB，实测 1080p 比 raw 快 10 倍（IPC 才是瓶颈）
          transport: decode.transport || 'jpeg',
          quality: decode.quality == null ? 2 : decode.quality,
        });
        const info = await dec.start();
        state.decoder = 'ffmpeg';
        state.lastDecoder = 'ffmpeg';
        notifyGpu();
        lastDecodeInfo = { width: info.width, height: info.height, fps: info.fps };
      }
    } catch (err) {
      // 准备阶段就失败（画布建不出来 / 编码器配置不被接受）也要把锁放掉
      state.active = false;
      state.phase = 'idle';
      state.video = null;
      throw err;
    }

    const srcDuration = (() => {
      const d = Number(video.duration);
      return Number.isFinite(d) && d > 0 ? d : 0;
    })();

    // 实时兜底：帧率由 MediaRecorder 的墙钟决定，只能边播边画
    const realtime = sink.kind === 'recorder';
    if (realtime) {
      try {
        video.pause();
        if (Math.abs(video.currentTime) > 0.02) video.currentTime = 0;
        await sleep(120);
        video.muted = true;
        await video.play();
      } catch (err) {
        state.active = false;
        sink.dispose();
        throw new Error('视频无法播放：' + (err?.message || err));
      }
    } else {
      try { video.pause(); } catch (_) {}
      video.muted = true;
    }

    const t0 = performance.now();
    resetStats();
    let done = 0;
    let lastReport = 0;
    state.phase = 'render';
    if (onPhase) { try { onPhase('render'); } catch (_) {} }

    const report = (force) => {
      if (!onProgress) return;
      const elapsed = (performance.now() - t0) / 1000;
      const now = performance.now();
      if (!force && now - lastReport < 90) return;
      lastReport = now;
      const speed = elapsed > 0.05 ? done / elapsed : 0;
      try {
        onProgress({
          frame: done,
          total,
          fps: speed,
          pct: Math.min(100, Math.round((done / total) * 100)),
          elapsed,
          eta: speed > 0.2 ? Math.max(0, (total - done) / speed) : 0,
          width: W,
          height: H,
          targetFps: fps,
          label: sink.label,
          backend: scene.backend,
          realtime,
          canvas: scene.out,
        });
      } catch (_) {}
    };

    try {
      report(true);
      if (realtime) {
        await new Promise((resolve) => {
          const step = () => {
            if (state.aborted) return resolve();
            const elapsed = (performance.now() - t0) / 1000;
            const t = Math.min(Math.max(0.1, duration), video.ended ? duration : video.currentTime);
            scene.paint(t, video);
            done = Math.min(total, Math.round((elapsed / Math.max(0.1, duration)) * total));
            report(false);
            if (elapsed >= Math.max(0.1, duration)) return resolve();
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      } else {
        for (let i = 0; i < total; i++) {
          if (state.aborted) throw abortError();
          // 取该输出帧覆盖区间的中点：视频帧边界上不会因为四舍五入取错一帧
          let t = (i + 0.5) / fps;
          if (srcDuration) t = Math.min(t, Math.max(0, srcDuration - 1 / (fps * 2)));
          const ts = performance.now();
          let paintSrc = video;
          if (dec) {
            // 原生解码：顺序拿一帧，不 seek、不等合成器
            paintSrc = await dec.next();
          } else {
            await seekVideo(video, t);
          }
          if (state.aborted) throw abortError();
          const tp = performance.now();
          scene.paint(i / fps, paintSrc);
          const te = performance.now();
          await sink.encode(scene.out, i);
          const tc = performance.now();
          done = i + 1;
          stats.seek += tp - ts;
          stats.paint += te - tp;
          stats.submit += tc - te;
          stats.frames++;
          report(false);
          // 编码器背压：堆太多内存会炸，等它消化一点
          let waited = 0;
          while (sink.backpressure > 6) {
            if (state.aborted) throw abortError();
            const w0 = performance.now();
            await sleep(4);
            waited += performance.now() - w0;
          }
          stats.wait += waited;
          // 让出主线程，弹窗才能刷新数字（4ms 定时器下限，所以别每帧都让）
          if ((i & 1) === 1) await sleep(0);
        }
      }

      if (state.aborted) throw abortError();
      state.phase = 'encode';
      if (onPhase) { try { onPhase('encode'); } catch (_) {} }
      const result = await sink.finish();
      done = total;
      report(true);
      if (!result) throw new Error('渲染没有产出画面');
      if (result.native) {
        if (!result.size) throw new Error('原生编码没有产出文件');
        return result;
      }
      if (!result.size) throw new Error('渲染没有产出画面');
      return result;
    } catch (err) {
      try { sink.dispose(); } catch (_) {}
      throw err;
    } finally {
      if (dec) { try { dec.dispose(); } catch (_) {} }
      // 保留最后一次用过的解码方式，界面/测试要读（只在下次渲染开始时覆盖）
      scene.dispose();
      state.sink = null;
      state.active = false;
      state.phase = 'idle';
      state.video = null;
      try { video.pause(); } catch (_) {}
    }
  }

  function abort() {
    if (!state.active) return;
    state.aborted = true;
    try { if (state.video) state.video.pause(); } catch (_) {}
  }

  window.Render = {
    render, abort, canvasSize,
    /** 是否具备离线逐帧编码能力（WebCodecs）。没有就退回实时录制。 */
    get offline() { return typeof window.VideoEncoder === 'function' && !!window.WebmMuxer; },
    get active() { return state.active; },
    get phase() { return state.phase; },
    /** 合成后端：'webgl2'（精确透视） 或 'canvas2d'（逐格仿射兜底） */
    get backend() { return state.backend; },
    /** 最近一次导出用的编码通道：'native'（客户端 ffmpeg）/ 'webcodecs' / 'recorder' */
    get lastSink() { return state.lastSink; },
    /** 最近一次导出用的取帧方式：'ffmpeg'（顺序解码）/ ''（<video> seek） */
    get decoder() { return state.decoder; },
    /**
     * 实际用的 GPU 适配器。`discrete` 为 true 表示落在独显上；
     * 为 null 表示读不到名字（部分浏览器屏蔽了 WEBGL_debug_renderer_info），
     * 此时「已请求高性能适配器」这一步仍然是生效的。
     */
    get gpu() {
      return {
        adapter: gpu.adapter || null,
        kind: gpu.kind,
        discrete: gpu.adapter ? gpu.discrete : null,
        source: gpu.source,
        requested: HP,
        hwEncode: gpu.hwEncode,
        backend: state.backend || gpu.backend,
      };
    },
    /** 显卡结论（面板/徽标用） */
    gpuReport,
    /** 订阅显卡状态变化，返回取消订阅函数 */
    onGpuChange(fn) {
      gpuListeners.add(fn);
      try { fn(gpuReport()); } catch (_) {}
      return () => gpuListeners.delete(fn);
    },
    /** 只给测速用：拿一帧要走多少个毫秒（内部正常流程不受影响） */
    __seekForTest: (v, t) => seekVideo(v, t),
    /** 手动再探一次（页面加载后设备热切换、或想读最新名字时用） */
    probeGPU,
    /** 分阶段平均耗时（ms/帧）：seek 解码定位、paint 合成、submit 交给编码器、wait 编码排队 */
    get stats() {
      const n = Math.max(1, stats.frames);
      return {
        frames: stats.frames,
        seek: +(stats.seek / n).toFixed(1),
        paint: +(stats.paint / n).toFixed(1),
        submit: +(stats.submit / n).toFixed(1),
        frameMake: +(stats.frameMake / n).toFixed(1),
        encCall: +(stats.encCall / n).toFixed(1),
        wait: +(stats.wait / n).toFixed(1),
      };
    },
  };

  /*
   * 脚本加载时就把「高性能适配器」唤醒一次。
   * WebGPU 的 requestAdapter 会按偏好去挑适配器，顺带把 dGPU 拉起来；
   * 再建一个一次性的 WebGL2 高性能上下文兜底（没有 WebGPU 的浏览器走这条）。
   * 两者都失败也没关系：真正渲染时上下文仍然带 high-performance 请求。
   */
  (function warmUpGPU() {
    probeGPU();
    try {
      const cv = document.createElement('canvas');
      cv.width = 2;
      cv.height = 2;
      const gl = glCtx(cv, { alpha: false, antialias: false, depth: false, stencil: false });
      if (gl) {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (_) { /* 忽略：不影响正常渲染 */ }
  })();

  if (typeof console === 'object' && console.info) {
    // 一行自检：用户能直接在控制台看到这次到底落在哪个适配器上
    setTimeout(() => {
      const g = window.Render.gpu;
      console.info(
        '[LiveMockup] GPU 请求 = %s · 实际适配器 = %s · 判定 = %s',
        g.requested,
        g.adapter || '（浏览器未公开名字）',
        { discrete: '独显', integrated: '集显', software: '软件渲染', unknown: '未知' }[g.kind] || '未知',
      );
    }, 1200);
  }
})();
