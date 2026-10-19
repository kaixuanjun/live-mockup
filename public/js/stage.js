/**
 * LiveMockup · 舞台
 * 负责：画幅自适应、样机切换、3D 镜头变换、拖拽环绕、关键帧插值。
 */
(() => {
  const DEFAULT_CAM = { x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 };

  /**
   * 缓动一律用 CSS 同款 cubic-bezier 描述（预设也是一组控制点），
   * 这样曲线编辑器里拖手柄、下拉里选预设、读出来的数字是同一套东西。
   */
  const BEZIER_PRESETS = {
    linear: [0, 0, 1, 1],
    easeInOut: [0.65, 0, 0.35, 1],
    easeOut: [0.33, 1, 0.68, 1],
    easeIn: [0.32, 0, 0.67, 0],
    easeOutBack: [0.34, 1.56, 0.64, 1],
    easeInOutQuart: [0.76, 0, 0.24, 1],
    snap: [0.85, 0, 0.15, 1],
  };

  const PRESET_LABEL = {
    linear: '线性',
    easeInOut: '缓入缓出',
    easeOut: '缓出',
    easeIn: '缓入',
    easeOutBack: '回弹',
    easeInOutQuart: '强缓动',
    snap: '快切',
  };

  /** CSS cubic-bezier 求值：先用牛顿法由 x 反解参数 t，再算 y */
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const fx = (t) => ((ax * t + bx) * t + cx) * t;
    const fy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 6; i++) {
        const d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        const err = fx(t) - x;
        if (Math.abs(err) < 1e-6) break;
        t -= err / d;
      }
      return fy(Math.min(1, Math.max(0, t)));
    };
  }

  const easeCache = new Map();

  /** 一个关键帧（或一段）实际使用的缓动函数：hold > bezier > 预设名 */
  function easeFn(key) {
    if (!key) return easeForName('easeInOut');
    if (key.hold) return (t) => (t >= 1 ? 1 : 0);
    const b = key.bezier;
    if (Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n))) {
      const id = b.join(',');
      let fn = easeCache.get(id);
      if (!fn) { fn = cubicBezier(b[0], b[1], b[2], b[3]); easeCache.set(id, fn); }
      return fn;
    }
    return easeForName(key.ease);
  }

  function easeForName(name) {
    const b = BEZIER_PRESETS[name] || BEZIER_PRESETS.easeInOut;
    return easeFn({ bezier: b });
  }

  /** 兼容旧接口：EASE[name](t) */
  const EASE = new Proxy({}, {
    get: (_, name) => (typeof name === 'string' ? easeForName(name) : undefined),
  });

  const lerp = (a, b, e) => a + (b - a) * e;

  const POSE_KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'];

  /**
   * 只取姿态字段。关键帧对象上还挂着 t / ease / bezier / hold，
   * 这些东西绝不能跟着「当前机位」回流进 Stage.state.cam，
   * 否则下一次插帧会把旧的 t 一起带进去（曾经因此把所有帧写到了 0s）。
   */
  function poseOf(key) {
    const c = { ...DEFAULT_CAM, ...key };
    const out = {};
    for (const f of POSE_KEYS) out[f] = Number.isFinite(Number(c[f])) ? Number(c[f]) : DEFAULT_CAM[f];
    return out;
  }

  const el = {
    wrap: document.querySelector('.stagewrap'),
    stage: document.getElementById('stage'),
    world: document.getElementById('world'),
    device: document.getElementById('device'),
    frame: document.getElementById('frame'),
    island: document.getElementById('island'),
    glare: document.getElementById('glare'),
    sbTime: document.getElementById('sbTime'),
  };

  const state = {
    aspect: '9:16',
    autoSize: null,     // {w,h}：录屏模式下由视频分辨率决定的机型尺寸
    cam: { ...DEFAULT_CAM },
    shield: false,
    onCamInput: null,
    onShieldToggle: null,
  };

  /* ───────────── 尺寸自适应 ───────────── */

  /** 画幅比例。aspect === 'auto' 时跟着输入视频走。 */
  function aspectRatio() {
    if (state.aspect === 'auto') {
      if (state.autoSize) return state.autoSize.w / state.autoSize.h;
      return 9 / 16;
    }
    const [aw, ah] = String(state.aspect).split(':').map(Number);
    return aw && ah ? aw / ah : 9 / 16;
  }

  function stageBox() {
    const cs = getComputedStyle(el.wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const footH = document.querySelector('.stage__foot')?.offsetHeight || 0;
    const availW = el.wrap.clientWidth - padX;
    const availH = el.wrap.clientHeight - padY - footH - 2;
    const ar = aspectRatio();
    let w = availW;
    let h = w / ar;
    if (h > availH) {
      h = availH;
      w = h * ar;
    }
    return { w: Math.max(120, Math.floor(w)), h: Math.max(120, Math.floor(h)) };
  }

  /**
   * 场景取景边距：整段视频固定，**预览和渲染共用同一张表**。
   * 以前渲染那边自己写了一套 0.78/0.78/0.72，于是同一个机位在编辑器里和成片里
   * 机身大小差 10% 以上，x/y 位移的比例也对不上 —— 这就是「编辑器画面和渲染不一致」。
   */
  const FIT_MARGIN = { phone: 0.84, tablet: 0.84, browser: 0.9, auto: 0.88 };

  /**
   * 参考画框：一个「标准编辑器窗口」（1600×1000）里舞台的可用区域。
   * 它是**固定常量**，和当前窗口无关 —— 透视强度和旧工程换算都以此为准，
   * 所以同一工程在任何机器上算出来的构图一致。
   */
  const REF_STAGE = { w: 1036, h: 582 };

  /**
   * 透视距离（CSS perspective）必须是**画面尺寸的函数**，不能写死成 1700px。
   * 写死的话，窗口拉大一点、换个系统缩放，透视强度就变了。
   * 取参考画框高度作为基准：582 高的舞台仍是 1700px（观感和以前完全一致），
   * 1080 高的成片画布对应 3155px —— 正好等于以前「1700 按舞台等比放大」的结果。
   */
  const PERSP_REF = 1700;
  const PERSP_K = PERSP_REF / REF_STAGE.h;
  function perspOf(h) {
    return Math.max(1, PERSP_K * Math.max(1, h));
  }

  /** 按长宽比推参考画框（宽高比照舞台的取景规则，宽优先、超出就按高收） */
  function refBox(ar) {
    const ratio = ar > 0 ? ar : 9 / 16;
    let w = REF_STAGE.w;
    let h = w / ratio;
    if (h > REF_STAGE.h) { h = REF_STAGE.h; w = h * ratio; }
    return { w: Math.max(120, Math.floor(w)), h: Math.max(120, Math.floor(h)) };
  }

  /**
   * 设备在画框里的缩放比。devW/devH 是设备的设计尺寸（auto 机型=输入视频分辨率），
   * frameW/frameH 是画框尺寸（编辑器里是舞台 CSS 尺寸，渲染时是输出画布尺寸）。
   * 只要两边画框长宽比一致，结果就成比例，取景完全一致。
   */
  function fitOf(model, devW, devH, frameW, frameH) {
    const m = FIT_MARGIN[model] || FIT_MARGIN.phone;
    const s = Math.min((frameW * m) / devW, (frameH * m) / devH);
    return Math.max(0.05, s);
  }

  function fit() {
    const { w, h } = stageBox();
    el.stage.style.width = w + 'px';
    el.stage.style.height = h + 'px';
    // 透视距离跟着画面走（与渲染器同一个 perspOf），并且把原点摆正到中心
    el.stage.style.perspective = perspOf(h) + 'px';
    el.stage.style.perspectiveOrigin = '50% 50%';

    const devW = el.device.offsetWidth || 414;
    const devH = el.device.offsetHeight || 868;
    const s = fitOf(el.device.dataset.model, devW, devH, w, h);
    el.device.style.setProperty('--fit', String(s));
    // 舞台尺寸变了，机位的像素值必须跟着重算 —— 否则窗口一缩，位移还是按旧尺寸算的，
    // 预览看上去就会「漂」一下（渲染那边只认画面比例，不受影响）。
    if (state.cam) apply(state.cam);
  }

  /* ───────────── 镜头 ───────────── */

  /**
   * 机位单位（v2 起，整段视频、任何机器都一样）：
   *   x = 画框**宽度**的比例，y = 画框**高度**的比例，z = **透视距离**的比例，
   *   scale = 倍数，rx/ry/rz = 角度。
   * 以前 x/y/z 存的是「编辑器舞台的 CSS 像素」，窗口一宽一窄，同一个 341 就变成
   * 画面里 33% 和 20% 两种位置 —— 那正是「同工程换台电脑就错位」的根因。
   */
  function apply(cam) {
    const c = poseOf(cam);
    state.cam = { ...c };
    const w = el.stage.clientWidth || 1;
    const h = el.stage.clientHeight || 1;
    const persp = perspOf(h);
    el.world.style.transform =
      `translate3d(${(c.x * w).toFixed(2)}px, ${(c.y * h).toFixed(2)}px, ${(c.z * persp).toFixed(2)}px) ` +
      `rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) rotateZ(${c.rz.toFixed(2)}deg) ` +
      `scale(${c.scale.toFixed(4)})`;
  }

  function sample(keys, t) {
    if (!keys || !keys.length) return { ...DEFAULT_CAM };
    const sorted = keys;
    if (t <= sorted[0].t) return poseOf(sorted[0]);
    const last = sorted[sorted.length - 1];
    if (t >= last.t) return poseOf(last);
    let i = 0;
    while (i < sorted.length - 1 && sorted[i + 1].t <= t) i++;
    const a = poseOf(sorted[i]);
    const b = poseOf(sorted[i + 1]);
    const span = sorted[i + 1].t - sorted[i].t || 1;
    const raw = Math.min(1, Math.max(0, (t - sorted[i].t) / span));
    const e = easeFn(sorted[i])(raw);
    return {
      x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), z: lerp(a.z, b.z, e),
      rx: lerp(a.rx, b.rx, e), ry: lerp(a.ry, b.ry, e), rz: lerp(a.rz, b.rz, e),
      scale: lerp(a.scale, b.scale, e),
    };
  }

  /** 某时刻所处「段」的信息，检视器用来显示进度与两端关键帧 */
  function segmentAt(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].t) return { from: null, to: keys[0], span: 0, raw: 0 };
    const last = keys[keys.length - 1];
    if (t >= last.t) return { from: last, to: null, span: 0, raw: 1 };
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const from = keys[i];
    const to = keys[i + 1];
    const span = to.t - from.t;
    return { from, to, span, raw: span ? (t - from.t) / span : 0 };
  }

  /* ───────────── 交互：环绕 / 推拉 ───────────── */

  let drag = null;

  function shieldEl() {
    let s = el.stage.querySelector('.camshield');
    if (!s) {
      s = document.createElement('div');
      s.className = 'camshield';
      Object.assign(s.style, {
        position: 'absolute', inset: '0', zIndex: 4, display: 'none',
        cursor: 'grab', touchAction: 'none',
      });
      el.stage.appendChild(s);
      s.addEventListener('pointerdown', onDown);
      s.addEventListener('wheel', onWheel, { passive: false });
    }
    return s;
  }

  function setShield(on) {
    state.shield = on;
    const s = shieldEl();
    s.style.display = on ? 'block' : 'none';
    s.style.cursor = 'grab';
    const btn = el.stage.querySelector('.camtoggle');
    if (btn) btn.classList.toggle('is-on', on);
    if (state.onShieldToggle) state.onShieldToggle(on);
  }

  function onDown(e) {
    e.preventDefault();
    const s = e.currentTarget;
    s.setPointerCapture(e.pointerId);
    s.style.cursor = 'grabbing';
    drag = { startX: e.clientX, startY: e.clientY, cam: { ...state.cam } };
  }

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const cam = {
      ...drag.cam,
      ry: Math.max(-62, Math.min(62, drag.cam.ry + dx * 0.28)),
      rx: Math.max(-42, Math.min(42, drag.cam.rx - dy * 0.2)),
    };
    apply(cam);
    if (state.onCamInput) state.onCamInput(cam, 'drag');
  }

  function onUp(e) {
    if (!drag) return;
    drag = null;
    const s = shieldEl();
    s.style.cursor = 'grab';
    if (state.onCamInput) state.onCamInput(state.cam, 'dragend');
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.055 : 0.055;
    const cam = {
      ...state.cam,
      scale: Math.max(0.45, Math.min(2.2, state.cam.scale + delta)),
    };
    apply(cam);
    if (state.onCamInput) state.onCamInput(cam, 'wheel');
  }

  function toggleButton() {
    let b = el.stage.querySelector('.camtoggle');
    if (b) return b;
    b = document.createElement('button');
    b.className = 'camtoggle';
    b.type = 'button';
    b.innerHTML = '<span>🖐</span>镜头';
    b.title = '开启后可在样机上拖动旋转（也可按住 Alt 临时开启）';
    Object.assign(b.style, {
      position: 'absolute', right: '10px', top: '10px', zIndex: 7,
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      background: 'rgba(12,13,18,.72)', color: '#c9ccd8',
      border: '1px solid rgba(255,255,255,.14)', borderRadius: '8px',
      padding: '5px 9px', fontSize: '11px', cursor: 'pointer',
      backdropFilter: 'blur(8px)',
    });
    b.addEventListener('click', () => setShield(!state.shield));
    el.stage.appendChild(b);
    return b;
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);

  window.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('is-frozen')) return; // 导出渲染中不接管按键
    if (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'Space') {
      if (!state.shield) {
        state._tempShield = true;
        setShield(true);
      }
    }
    if (e.key === 'Escape' && state._tempShield) {
      state._tempShield = false;
      setShield(false);
    }
  });
  window.addEventListener('keyup', (e) => {
    if ((e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'Space') && state._tempShield) {
      state._tempShield = false;
      setShield(false);
    }
  });

  el.stage.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.camtoggle') && !e.target.closest('iframe')) {
      apply({ ...DEFAULT_CAM });
      if (state.onCamInput) state.onCamInput(state.cam, 'reset');
    }
  });

  /* ───────────── 样机 / 场景 ───────────── */

  function ensureBrowserBar(model) {
    const bezel = el.stage.querySelector('.device__bezel');
    let bar = bezel.querySelector('.browserbar');
    if (model === 'browser') {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'browserbar';
        bar.innerHTML =
          '<div class="lights"><i></i><i></i><i></i></div>' +
          '<div class="url" id="browserUrl">localhost</div>' +
          '<div style="width:46px"></div>';
        bezel.insertBefore(bar, bezel.firstChild);
      }
    } else if (bar) {
      bar.remove();
    }
  }

  function setDevice(model) {
    el.device.dataset.model = model;
    if (el.island) el.island.style.display = model === 'phone' ? '' : 'none';
    ensureBrowserBar(model);
    requestAnimationFrame(() => {
      fit();
      apply(state.cam);
    });
  }

  /**
   * 录屏模式：把机型尺寸直接绑到输入视频的像素尺寸上。
   * 只写 CSS 变量，让样式表决定边框与圆角，JS 不碰布局细节。
   */
  function setAutoSize(w, h) {
    const W = Math.max(80, Math.round(w || 0));
    const H = Math.max(80, Math.round(h || 0));
    state.autoSize = { w: W, h: H };
    el.device.style.setProperty('--auto-w', W + 'px');
    el.device.style.setProperty('--auto-h', H + 'px');
    if (el.device.dataset.model === 'auto') requestAnimationFrame(() => fit());
  }

  function setColor(color) {
    el.device.dataset.color = color;
  }

  function setBg(bg) {
    el.stage.dataset.bg = bg;
  }

  function setAspect(a) {
    state.aspect = a;
    fit();
    apply(state.cam);
  }

  function setBrowserUrl(u) {
    const b = el.stage.querySelector('#browserUrl');
    if (b) b.textContent = u || 'localhost';
  }

  function setStatusTime(t) {
    if (el.sbTime) el.sbTime.textContent = t;
  }

  /* ───────────── 初始化 ───────────── */

  function init() {
    toggleButton();
    shieldEl();
    setDevice(el.device.dataset.model || 'phone');
    setBg('aurora');
    apply(state.cam);

    const ro = new ResizeObserver(() => fit());
    ro.observe(el.wrap);

    // 时钟
    const tick = () => {
      const d = new Date();
      setStatusTime(`9:41`);
    };
    tick();

    // 拖拽手柄的 shield 需要覆盖整个 stage
    const mo = new MutationObserver(() => fit());
    mo.observe(el.stage, { attributes: true, attributeFilter: ['style'] });
  }

  window.Stage = {
    el, state, EASE, DEFAULT_CAM,
    FIT_MARGIN, fitOf, stageBox, PERSP_K, PERSP_REF, perspOf, refBox, REF_STAGE,
    BEZIER_PRESETS, PRESET_LABEL, cubicBezier, easeFn, sample, segmentAt,
    init, fit, apply, setDevice, setColor, setBg, setAspect, setAutoSize, aspectRatio,
    setShield, setBrowserUrl, setStatusTime,
    get cam() { return state.cam; },
    get autoSize() { return state.autoSize; },
    onCamInput(cb) { state.onCamInput = cb; },
    onShieldToggle(cb) { state.onShieldToggle = cb; },
  };
})();
