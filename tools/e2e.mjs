/**
 * LiveMockup · 端到端自测（CDP 驱动真实 Edge）
 * 不用 Puppeteer：直接连 Edge 的 DevTools 协议，用真实鼠标事件点进 iframe，
 * 走一遍「载入 → 录制 → 回放 → 检查时间轴」的主链路并截图。
 *
 * 用法：node tools/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP = 'http://localhost:4321/';
const PORT = 9333;
const SHOTS = join(import.meta.dirname, '..', '.shots');
const PROFILE = join(tmpdir(), 'lm-e2e-' + Date.now());

mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);

/* ── 启动浏览器 ── */
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

async function waitVersion() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(150);
  }
  throw new Error('Edge 调试端口没有就绪');
}

/* ── 极简 CDP 客户端 ── */
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
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败')));
  });
}

/* ── 主流程 ── */
const problems = [];
let cdp;

try {
  const v = await waitVersion();
  log('Edge', v['Browser']);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  cdp = await connect(page.webSocketDebuggerUrl);

  cdp.on('Runtime.exceptionThrown', (p) => {
    problems.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      problems.push(`CONSOLE.${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') problems.push('LOG: ' + p.entry.text + ' ' + (p.entry.url || ''));
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = join(SHOTS, name + '.png');
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    log('截图', name);
    return f;
  };

  const mouse = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };

  const drag = async (x1, y1, x2, y2, steps = 12) => {
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
  };

  /** 在顶层文档里按选择器取屏坐标中心 */
  const rectTop = (sel) =>
    evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height, top: r.top, left: r.left }; })()`);

  /** 点击顶层文档元素 */
  const clickSel = async (sel, label = sel) => {
    const r = await rectTop(sel);
    if (!r) throw new Error('找不到元素: ' + label);
    await mouse(r.x, r.y);
    return r;
  };

  /** 在 iframe 内按选择器取坐标，并换算到顶层 */
  const framePoint = async (selInFrame) => {
    const fr = await evaluate(`(() => { const f = document.querySelector('#frame');
      const r = f.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height,
               vw: f.clientWidth, vh: f.clientHeight }; })()`);
    const r = await evaluate(`(() => {
      const f = document.querySelector('#frame');
      const d = f.contentDocument;
      if (!d) return null;
      const e = d.querySelector(${JSON.stringify(selInFrame)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width/2, y: b.top + b.height/2 };
    })()`).catch(() => null);
    if (!r) throw new Error('iframe 内找不到: ' + selInFrame);
    return {
      x: fr.left + r.x * (fr.w / fr.vw),
      y: fr.top + r.y * (fr.h / fr.vh),
    };
  };

  const clickInFrame = async (sel, label) => {
    const p = await framePoint(sel);
    await mouse(p.x, p.y);
    log('点击 iframe', label || sel);
    return p;
  };

  log('打开应用…');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(3200);
  const ready = await evaluate(`!!document.querySelector('#frame').contentDocument?.getElementById('search')`);
  log('iframe 内演示页就绪:', ready);

  // ── 1. 开始录制 ──
  await clickSel('#recordBtn', '录制');
  await sleep(900);

  // ── 2. 在演示页里真实操作 ──
  await clickInFrame('[data-testid="item-m2"]', '点击第 2 个商品');
  await sleep(700);
  await clickInFrame('[data-testid="qty-plus"]', '加数量');
  await sleep(500);
  await clickInFrame('[data-testid="sheet-add"]', '加入购物车');
  await sleep(800);
  await clickInFrame('[data-testid="add-m1"]', '列表加购');
  await sleep(700);
  await clickInFrame('.tab[data-tab="rewards"]', '切到奖励页');
  await sleep(600);

  const recCount = await evaluate(`document.querySelector('#tlCount').textContent`);
  log('录制中时间轴:', recCount);

  // ── 3. 停止录制 ──
  await clickSel('#recordBtn', '停止录制');
  await sleep(1400);
  const after = await evaluate(`document.querySelector('#tlCount').textContent`);
  log('录制结果:', after);
  await shot('01-recorded');

  // ── 4. 回放 ──
  await clickSel('#tlPlayBtn', '播放');
  await sleep(2600);
  await shot('02-playing');
  await sleep(4000);
  const t = await evaluate(`document.querySelector('#currentT').textContent`);
  log('播放到:', t);
  await shot('03-played');

  // ── 5. 时间轴选中一个动作 ──
  const actInfo = await evaluate(`(() => {
    const acts = document.querySelectorAll('#laneActions .act');
    if (!acts.length) return null;
    const r = acts[0].getBoundingClientRect();
    return { n: acts.length, x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (actInfo) {
    await mouse(actInfo.x, actInfo.y);
    await sleep(500);
    log('动作条数量:', actInfo.n, '检视器:', await evaluate(`document.querySelector('#inspectorBody').textContent.trim().slice(0,40)`));
    await shot('04-inspector');
  } else {
    problems.push('时间轴上没有动作条');
  }

  // ── 6. 切到桌面产品站演示 ──
  await evaluate(`document.querySelectorAll('.preset')[1].click()`);
  await sleep(2600);
  const siteOk = await evaluate(`!!document.querySelector('#frame').contentDocument?.querySelector('[data-testid="submit"]')`);
  log('Aurora 站点载入:', siteOk);
  await shot('05-site');

  // ── 7. 镜头：开启拍摄模式后拖动环绕 ──
  const beforeCam = await evaluate(`getComputedStyle(document.querySelector('#world')).transform`);
  await evaluate(`document.querySelector('.camtoggle').click()`);
  await sleep(300);
  const stage = await evaluate(`(() => { const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await drag(stage.x, stage.y, stage.x + 170, stage.y - 60, 14);
  await sleep(500);
  const afterCam = await evaluate(`getComputedStyle(document.querySelector('#world')).transform`);
  log('镜头拖动前:', beforeCam);
  log('镜头拖动后:', afterCam);
  if (beforeCam === afterCam) problems.push('拖动舞台没有改变镜头姿态');
  const keyCount = await evaluate(`document.querySelectorAll('#laneCamera .key').length`);
  log('镜头关键帧:', keyCount);
  if (keyCount < 1) problems.push('拖动后没有镜头关键帧');
  await shot('08-camera');
  await evaluate(`document.querySelector('.camtoggle').click()`);
  await sleep(200);

  // ── 8. 检查导出按钮不炸（headless 无 getDisplayMedia，预期报错文案） ──
  const exOk = await evaluate(`typeof window.Exporter === 'object' && typeof window.Exporter.start === 'function'`);
  log('Exporter 就绪:', exOk);
  if (!exOk) problems.push('Exporter 未就绪');

  // ── 9. 时长 / 画幅控件 ──
  await evaluate(`(() => { const el = document.querySelector('#durationInput'); el.value = '8';
    el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(400);
  log('时长改为:', await evaluate(`document.querySelector('#currentT').textContent`));

  await shot('06-final');
} catch (err) {
  problems.push('FATAL: ' + err.message);
  console.error('✗', err.message);
} finally {
  try { cdp?.ws.close(); } catch (_) {}
  try { edge.kill(); } catch (_) {}
  await sleep(400);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
}

console.log('\n═══ 结果 ═══');
if (problems.length) {
  console.log('发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else {
  console.log('✓ 全链路通过，无控制台错误');
}
