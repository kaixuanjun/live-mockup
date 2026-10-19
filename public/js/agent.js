/**
 * LiveMockup · 页面运行时（注入到被演示的网页里运行）
 *
 * 双向职责：
 *   录制 —— 把用户在页面里的真实操作（点击 / 输入 / 选择 / 滚动 / 跳转）
 *           翻译成结构化动作，回传给编辑器成为时间轴关键帧。
 *   回放 —— 接收编辑器的动作指令，在真实 DOM 上重新执行，
 *           并绘制点击涟漪，让录屏看起来像一支产品演示片。
 *
 * 只在 iframe 里启用。
 */
(() => {
  if (window.__LM_AGENT__) return;
  if (window.top === window) return; // 顶层页面不启用
  window.__LM_AGENT__ = true;

  const K = '__live_mockup__';
  const post = (msg) => {
    try {
      window.parent.postMessage({ [K]: 1, ...msg }, '*');
    } catch (_) {}
  };

  let mode = 'idle'; // idle | record | play
  let readySent = false;
  let showRipple = true;

  /* ═════════ 网络垫片：把指向「本页站点自身」的绝对 URL 拉回代理 ═════════
   *
   * 页面被代理在 /p/<目标地址> 下，于是 location.origin 是编辑器的地址。
   * 前端代码里写死的 http://localhost:3000/api/x 就成了跨域请求，
   * 目标站点一般不发 CORS 头 —— 拿到的是失败 + 控制台报错，
   * 表现出来就是「页面在、数据没了」。这里改写回 /p/ 同源路径。
   */

  function pageOrigin() {
    try {
      if (!location.pathname.startsWith('/p/')) return null;
      const target = new URL(location.pathname.slice(3) + location.search);
      return /^https?:$/.test(target.protocol) ? target.origin : null;
    } catch (_) {
      return null;
    }
  }

  function patchNetwork() {
    const origin = pageOrigin();
    if (!origin) return;

    const toProxy = (u) => {
      try {
        const abs = new URL(String(u), location.href);
        if (abs.origin !== origin) return null;
        return '/p/' + abs.href;
      } catch (_) {
        return null;
      }
    };

    const realFetch = window.fetch;
    if (typeof realFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          if (typeof input === 'string' || input instanceof URL) {
            const p = toProxy(input);
            if (p) input = p;
          } else if (input && typeof input === 'object' && input.url) {
            const p = toProxy(input.url);
            if (p) input = new Request(p, input);
          }
        } catch (_) {}
        return realFetch.call(this, input, init);
      };
    }

    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      let next = url;
      try {
        const p = toProxy(url);
        if (p) next = p;
      } catch (_) {}
      return realOpen.call(this, method, next, ...rest);
    };

    // sendBeacon / EventSource 也常被打到绝对地址上
    const realBeacon = navigator.sendBeacon;
    if (typeof realBeacon === 'function') {
      navigator.sendBeacon = function (url, data) {
        return realBeacon.call(navigator, toProxy(url) || url, data);
      };
    }
  }

  patchNetwork();

  /* ───────────────── 样式（滚动条 / 光标 / 悬浮高亮） ───────────────── */

  function paintStyles() {
    let st = document.getElementById('__lm_style');
    if (!st) {
      st = document.createElement('style');
      st.id = '__lm_style';
      (document.head || document.documentElement).appendChild(st);
    }
    const base = `
      html { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      html { -webkit-tap-highlight-color: transparent; }
      #__lm_layer { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
        pointer-events: none !important; overflow: hidden !important; contain: strict !important; }
    `;
    const record = mode === 'record' ? `
      a:hover, button:hover, [role="button"]:hover, input:hover, textarea:hover, select:hover,
      [onclick]:hover, [data-testid]:hover, label:hover {
        outline: 2px solid rgba(124, 92, 255, .55) !important;
        outline-offset: 2px !important;
      }
    ` : '';
    const play = mode === 'play' ? `
      html, body, * { cursor: none !important; }
    ` : '';
    st.textContent = base + record + play;
  }

  function layer() {
    let el = document.getElementById('__lm_layer');
    if (!el) {
      el = document.createElement('div');
      el.id = '__lm_layer';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  /* ───────────────── 选择器 ───────────────── */

  const SAFE_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'id', 'name', 'aria-label'];

  /** 元素自身的稳定唯一选择器（没有则 null） */
  function uniqueSel(el) {
    if (!el || el.nodeType !== 1) return null;
    for (const attr of SAFE_ATTRS) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 80) continue;
      try {
        const sel = `[${attr}="${String(v).replace(/"/g, '\\"')}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (_) {}
    }
    return null;
  }

  function stepSel(node) {
    let sel = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    return sel;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return tag;

    const direct = uniqueSel(el);
    if (direct) return direct;

    // 往上找最近的稳定锚点，用「锚点 + 相对路径」描述，重放时更耐改版
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 8) {
      parts.unshift(stepSel(node));
      const parent = node.parentElement;
      if (!parent) break;
      const anchor = uniqueSel(parent);
      if (anchor) return [anchor, ...parts].join(' > ');
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) {}
      node = parent;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    if (!el) return '';
    const txt = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ')
      .trim();
    return txt.slice(0, 42);
  }

  function clickable(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.nodeType === 1; i++) {
      const t = node.tagName;
      if (t === 'A' || t === 'BUTTON' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'LABEL') return node;
      if (node.hasAttribute('onclick') || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'tab' ||
          node.getAttribute('role') === 'link' || node.getAttribute('role') === 'switch') return node;
      node = node.parentElement;
    }
    return el;
  }

  function normPoint(el, clientX, clientY) {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    let x = clientX;
    let y = clientY;
    if (!x && !y && el) {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    return { x: Math.min(1, Math.max(0, x / vw)), y: Math.min(1, Math.max(0, y / vh)) };
  }

  /* ───────────────── 点击涟漪 ───────────────── */

  function ripple(x, y) {
    if (!showRipple) return;
    const box = layer();
    const ring = document.createElement('div');
    const size = 72;
    Object.assign(ring.style, {
      position: 'absolute',
      left: `${x - size / 2}px`,
      top: `${y - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,.95)',
      boxShadow: '0 0 0 1px rgba(0,0,0,.22), 0 0 22px rgba(255,255,255,.45)',
      background: 'radial-gradient(circle, rgba(255,255,255,.55), rgba(255,255,255,.06) 62%, transparent 70%)',
      willChange: 'transform, opacity',
      pointerEvents: 'none',
    });
    box.appendChild(ring);
    const anim = ring.animate(
      [
        { transform: 'scale(.34)', opacity: 0.95 },
        { transform: 'scale(1)', opacity: 0.55, offset: 0.55 },
        { transform: 'scale(1.5)', opacity: 0 },
      ],
      { duration: 560, easing: 'cubic-bezier(.16,.84,.36,1)', fill: 'forwards' }
    );
    anim.onfinish = () => ring.remove();
    setTimeout(() => ring.remove(), 1200);
  }

  /* ───────────────── 录制 ───────────────── */

  let lastNavAt = 0;
  let reportedUrl = location.href;

  function emit(action, at) {
    if (mode !== 'record') return;
    action.at = at || Date.now();
    post({ type: 'event', action });
  }

  function onClickCapture(e) {
    if (mode !== 'record') return;
    const el0 = e.target;
    if (!el0 || el0.closest?.('#__lm_layer')) return;
    const el = clickable(el0);
    const sel = cssPath(el);
    if (!sel) return;
    const p = normPoint(el, e.clientX, e.clientY);
    ripple(
      (e.clientX || p.x * window.innerWidth),
      (e.clientY || p.y * window.innerHeight)
    );
    emit({
      type: 'tap',
      selector: sel,
      label: describe(el),
      nx: +p.x.toFixed(4),
      ny: +p.y.toFixed(4),
    });
  }

  function onPointerDownCapture(e) {
    if (mode !== 'record') return;
    lastPointerAt = Date.now();
  }
  let lastPointerAt = 0;

  const inputTimers = new Map();
  const inputAt = new Map();

  function valueOf(el) {
    if (el.isContentEditable) return el.innerText || '';
    if (el.tagName === 'SELECT') return el.value;
    return el.value ?? '';
  }

  function onInput(e) {
    if (mode !== 'record') return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const isField =
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    if (!isField) return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button'].includes(type)) {
      if (type === 'checkbox' || type === 'radio') {
        const sel = cssPath(el);
        if (sel) emit({ type: 'check', selector: sel, checked: !!el.checked, label: describe(el) });
      }
      return;
    }
    const sel = cssPath(el);
    if (!sel) return;
    const key = sel;
    if (!inputAt.has(key)) inputAt.set(key, Date.now());
    clearTimeout(inputTimers.get(key));
    inputTimers.set(
      key,
      setTimeout(() => {
        const at = inputAt.get(key) || Date.now();
        inputAt.delete(key);
        emit(
          {
            type: 'type',
            selector: sel,
            value: valueOf(el),
            secret: type === 'password',
            label: describe(el) || el.getAttribute('placeholder') || '输入',
          },
          at
        );
      }, 420)
    );
  }

  function onChange(e) {
    if (mode !== 'record') return;
    const el = e.target;
    if (!el || el.tagName !== 'SELECT') return;
    const sel = cssPath(el);
    if (sel) emit({ type: 'select', selector: sel, value: el.value, label: describe(el) });
  }

  let scrollTimer = 0;
  let scrollPending = null;
  let scrollLast = new WeakMap();
  let lastScroll = { x: 0, y: 0 };
  /**
   * 滚动要分两种：整页滚动（window）和内部滚动容器（手机 App / SPA 的 main 区域，
   * 这类滚动不会冒泡到 window，必须用 capture 才能收到）。
   */
  function onScroll(e) {
    if (mode !== 'record') return;
    const node = e.target;
    const box = node && node.nodeType === 1 ? node : null;
    scrollPending = {
      el: box,
      x: Math.round(box ? box.scrollLeft : window.scrollX),
      y: Math.round(box ? box.scrollTop : window.scrollY),
    };
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const p = scrollPending;
      scrollPending = null;
      if (!p) return;
      if (p.el) {
        // 容器被移除过就不记了
        if (!p.el.isConnected) return;
        const prev = scrollLast.get(p.el);
        if (prev && prev.x === p.x && prev.y === p.y) return;
        scrollLast.set(p.el, { x: p.x, y: p.y });
        const sel = cssPath(p.el);
        if (!sel) return;
        emit({ type: 'scroll', selector: sel, x: p.x, y: p.y, label: `滚动到 ${p.y}px` });
      } else {
        if (lastScroll.x === p.x && lastScroll.y === p.y) return;
        lastScroll = { x: p.x, y: p.y };
        emit({ type: 'scroll', nx: 0, ny: 0, x: p.x, y: p.y, label: `滚动到 ${p.y}px` });
      }
    }, 260);
  }

  function announceRoute(reason) {
    if (mode !== 'record') return;
    if (Date.now() - lastNavAt < 1200) return;
    if (location.href === reportedUrl) return;
    reportedUrl = location.href;
    lastNavAt = Date.now();
    post({ type: 'nav', url: location.href, reason });
  }

  function patchHistory() {
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      if (!orig || orig.__lm) continue;
      const wrapped = function (...args) {
        const r = orig.apply(this, args);
        setTimeout(() => announceRoute(m), 60);
        return r;
      };
      wrapped.__lm = true;
      history[m] = wrapped;
    }
    window.addEventListener('popstate', () => announceRoute('popstate'));
    window.addEventListener('hashchange', () => announceRoute('hashchange'));
  }

  function bindRecorder() {
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    patchHistory();
  }

  /* ───────────────── 回放执行 ───────────────── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function resolve(action) {
    if (action.selector) {
      try {
        const el = document.querySelector(action.selector);
        if (el) return el;
      } catch (_) {}
    }
    // 退化：按归一化坐标找元素，再向上找可点祖先
    if (typeof action.nx === 'number' && typeof action.ny === 'number') {
      const el = document.elementFromPoint(action.nx * window.innerWidth, action.ny * window.innerHeight);
      if (el) return clickable(el);
    }
    return null;
  }

  function ensureVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (_) {
        el.scrollIntoView();
      }
    }
  }

  function fire(el, type, init = {}) {
    const opts = { bubbles: true, cancelable: true, composed: true, ...init };
    let ev;
    try {
      ev = new MouseEvent(type, opts);
    } catch (_) {
      ev = document.createEvent('MouseEvents');
      ev.initMouseEvent(type, true, true, window, 1, 0, 0, opts.clientX || 0, opts.clientY || 0, false, false, false, false, 0, null);
    }
    el.dispatchEvent(ev);
  }

  async function execTap(a) {
    const el = resolve(a);
    if (!el) return { ok: false, error: '找不到元素：' + (a.selector || '') };
    ensureVisible(el);
    await sleep(24);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let px = cx;
    let py = cy;
    if (typeof a.nx === 'number' && typeof a.ny === 'number') {
      const ax = a.nx * window.innerWidth;
      const ay = a.ny * window.innerHeight;
      if (ax >= r.left - 2 && ax <= r.right + 2 && ay >= r.top - 2 && ay <= r.bottom + 2) {
        px = ax;
        py = ay;
      }
    }
    ripple(px, py);
    const base = { clientX: px, clientY: py, screenX: px, screenY: py, button: 0, buttons: 1, view: window, pointerId: 1, isPrimary: true };
    try {
      el.focus?.({ preventScroll: true });
    } catch (_) {}
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
      try { el.dispatchEvent(new PointerEvent(t, { bubbles: t !== 'pointerenter', ...base, pointerType: 'touch' })); } catch (_) {}
    }
    for (const t of ['pointerdown', 'mousedown']) {
      try { el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, ...base, pointerType: 'touch' })); } catch (_) { fire(el, 'mousedown', base); }
    }
    await sleep(40);
    for (const t of ['pointerup', 'mouseup', 'click']) {
      try {
        const Ctor = t === 'click' ? MouseEvent : PointerEvent;
        el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, ...base, pointerType: 'touch', buttons: 0 }));
      } catch (_) { fire(el, t, { ...base, buttons: 0 }); }
    }
    try {
      const Ctor = window.PointerEvent ? PointerEvent : MouseEvent;
      (el.closest('a') || el).dispatchEvent(new Ctor('click', { bubbles: true, cancelable: true, ...base, buttons: 0 }));
    } catch (_) {}
    return { ok: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function execType(a) {
    const el = resolve(a);
    if (!el) return { ok: false, error: '找不到输入框：' + (a.selector || '') };
    ensureVisible(el);
    try { el.focus({ preventScroll: true }); } catch (_) {}
    await sleep(30);
    if (el.isContentEditable) {
      el.innerText = a.value;
    } else {
      setNativeValue(el, a.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  async function execSelect(a) {
    const el = resolve(a);
    if (!el) return { ok: false, error: '找不到下拉框' };
    el.value = a.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }

  async function execCheck(a) {
    const el = resolve(a);
    if (!el) return { ok: false, error: '找不到勾选框' };
    if (el.checked !== a.checked) {
      el.click?.();
      if (el.checked !== a.checked) {
        el.checked = a.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return { ok: true };
  }

  async function execScroll(a) {
    // 内部滚动容器优先（selector 存在时），否则退回整页滚动
    if (a.selector) {
      const el = resolve(a);
      if (el) {
        el.scrollTop = a.y || 0;
        el.scrollLeft = a.x || 0;
        await sleep(24);
        if (Math.abs(el.scrollTop - (a.y || 0)) > 2) {
          // 懒加载 / 异步渲染会让高度变化，再补一次
          el.scrollTop = a.y || 0;
          await sleep(24);
        }
        return { ok: true };
      }
    }
    window.scrollTo({ left: a.x || 0, top: a.y || 0, behavior: 'instant' });
    await sleep(16);
    return { ok: true };
  }

  async function exec(action) {
    switch (action.type) {
      case 'tap': return execTap(action);
      case 'type': return execType(action);
      case 'select': return execSelect(action);
      case 'check': return execCheck(action);
      case 'scroll': return execScroll(action);
      default: return { ok: false, error: '未知动作 ' + action.type };
    }
  }

  /* ───────────────── 消息通道 ───────────────── */

  function hello() {
    if (readySent && mode === 'idle') return;
    readySent = true;
    reportedUrl = location.href;
    post({
      type: 'hello',
      url: location.href,
      title: document.title,
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollY: Math.round(window.scrollY),
    });
  }

  async function onMessage(e) {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d[K] !== 1) return;

    if (d.type === 'set-mode') {
      mode = d.mode;
      paintStyles();
      if (mode === 'record') {
        lastPointerAt = 0;
        lastScroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
        scrollLast = new WeakMap();
        scrollPending = null;
      }
      post({ type: 'ack', id: d.id, ok: true });
      return;
    }
    if (d.type === 'exec') {
      let result;
      try {
        result = await exec(d.action || {});
      } catch (err) {
        result = { ok: false, error: String(err && err.message ? err.message : err) };
      }
      post({ type: 'ack', id: d.id, ok: result.ok, error: result.error, rect: result.rect });
      return;
    }
    if (d.type === 'config') {
      if (typeof d.ripple === 'boolean') showRipple = d.ripple;
      post({ type: 'ack', id: d.id, ok: true });
      return;
    }
    if (d.type === 'ping') {
      post({ type: 'ack', id: d.id, ok: true, url: location.href });
      return;
    }
    if (d.type === 'hello') {
      hello();
      return;
    }
    if (d.type === 'clear-layer') {
      const l = document.getElementById('__lm_layer');
      if (l) l.textContent = '';
      post({ type: 'ack', id: d.id, ok: true });
      return;
    }
  }

  window.addEventListener('message', onMessage, false);
  document.addEventListener('DOMContentLoaded', () => {
    paintStyles();
    bindRecorder();
    layer();
    hello();
  });
  // 脚本可能在 DOMContentLoaded 之后才加载
  if (document.readyState !== 'loading') {
    paintStyles();
    bindRecorder();
    layer();
    hello();
  }
  window.addEventListener('load', hello);
  setTimeout(hello, 400);
})();
