/**
 * LiveMockup · 测试用极简 CDP 驱动（无 Puppeteer 依赖）
 * 直接走 Edge / Chrome 的 DevTools 协议：真实鼠标事件、取 iframe 内坐标、截图。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

export async function launch({ port = 9333, width = 1600, height = 1000, shotsDir = '.shots' } = {}) {
  const profile = join(tmpdir(), 'lm-cdp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const shots = join(import.meta.dirname, '..', shotsDir);
  mkdirSync(shots, { recursive: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (_) {}
    await sleep(150);
  }
  if (!version) throw new Error('浏览器调试端口没有就绪');

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(target.webSocketDebuggerUrl);
    s.addEventListener('open', () => resolve(s));
    s.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });

  const cdp = new CDP(ws);
  const problems = [];

  cdp.on('Runtime.exceptionThrown', (p) => {
    problems.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      problems.push('CONSOLE: ' + p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' && !/favicon/.test(p.entry.url || p.entry.text)) {
      problems.push('LOG: ' + p.entry.text + ' ' + (p.entry.url || ''));
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  const api = {
    cdp,
    version,
    problems,
    async evaluate(expr) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
    async goto(url, wait = 3000) {
      await cdp.send('Page.navigate', { url });
      await sleep(wait);
    },
    async shot(name) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = join(shots, name + '.png');
      writeFileSync(f, Buffer.from(r.data, 'base64'));
      return f;
    },
    async mouse(x, y, { count = 1 } = {}) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
      await sleep(28);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
      await sleep(140);
    },
    async drag(x1, y1, x2, y2, steps = 12) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
          button: 'left', buttons: 1,
        });
        await sleep(16);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
      await sleep(160);
    },
    async wheel(x, y, deltaY) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
      await sleep(180);
    },
    async type(text) {
      await cdp.send('Input.insertText', { text });
      await sleep(60);
    },
    async key(key, code, vk) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
      await sleep(80);
    },
    /** 带修饰键的组合键：mods 用 'alt' | 'ctrl' | 'meta' | 'shift' */
    async hotkey(key, code, vk, mods = []) {
      let modifiers = 0;
      if (mods.includes('alt')) modifiers |= 1;
      if (mods.includes('ctrl')) modifiers |= 2;
      if (mods.includes('meta')) modifiers |= 4;
      if (mods.includes('shift')) modifiers |= 8;
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers,
      });
      await sleep(140);
    },
    /** 按住 Shift 点击（多选） */
    async mouseShift(x, y) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers: 8 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 8 });
      await sleep(30);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 8 });
      await sleep(180);
    },
    async rect(sel) {
      return api.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
    },
    async click(sel) {
      const r = await api.rect(sel);
      if (!r) throw new Error('找不到元素: ' + sel);
      await api.mouse(r.x, r.y);
      return r;
    },
    /** 顶层 iframe 几何信息 */
    async frameBox() {
      return api.evaluate(`(() => { const f = document.querySelector('#frame');
        const r = f.getBoundingClientRect();
        return { left: r.left, top: r.top, w: r.width, h: r.height, vw: f.clientWidth, vh: f.clientHeight }; })()`);
    },
    /** iframe 内选择器的顶层坐标 */
    async framePoint(selInFrame) {
      const fr = await api.frameBox();
      const p = await api.evaluate(`(() => {
        const f = document.querySelector('#frame');
        const d = f.contentDocument;
        if (!d) return null;
        const e = d.querySelector(${JSON.stringify(selInFrame)});
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.left + b.width/2, y: b.top + b.height/2, w: b.width, h: b.height };
      })()`);
      if (!p) throw new Error('iframe 内找不到: ' + selInFrame);
      return {
        x: fr.left + p.x * (fr.w / fr.vw),
        y: fr.top + p.y * (fr.h / fr.vh),
        w: p.w, h: p.h,
      };
    },
    async clickInFrame(sel) {
      const p = await api.framePoint(sel);
      await api.mouse(p.x, p.y);
      return p;
    },
    /** 在页面内模拟真实输入框输入（先点一下再插字） */
    async typeInFrame(sel, text) {
      const p = await api.framePoint(sel);
      await api.mouse(p.x, p.y);
      await sleep(120);
      await api.type(text);
    },
    async close() {
      api.cdp.close();
      try { edge.kill(); } catch (_) {}
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    },
  };

  return api;
}
