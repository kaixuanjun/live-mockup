/**
 * LiveMockup · 显卡测试
 *
 * 1. 每个图形上下文都真的请求了 powerPreference: 'high-performance'
 * 2. 徽标反映实际落在哪块卡上；面板能开、能关、能列出浏览器
 * 3. 本机接口的安全边界：无令牌 / 跨源一律 403；没装 Windows 时返回 501
 * 4. Windows 一键切独显：真的写进注册表（用 notepad.exe 当靶子，测完清理）
 */
import { launch, sleep } from './cdp.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASE = process.env.BASE || 'http://localhost:4321';
const WIN = process.platform === 'win32';
const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const PROBE_EXE = 'C:\\Windows\\System32\\notepad.exe';

const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

async function regValueAndCleanup(action, exe) {
  if (action === 'query') {
    try {
      const r = await exec('reg', ['query', KEY, '/v', exe], { windowsHide: true });
      const m = (r.stdout || '').match(/REG_SZ\s+(.*)$/m);
      return m ? m[1].trim() : null;
    } catch (_) {
      return null;
    }
  }
  try { await exec('reg', ['delete', KEY, '/v', exe, '/f'], { windowsHide: true }); } catch (_) {}
  return null;
}

/* ─────────── 1) HTTP 接口 ─────────── */
let token = '';
try {
  const r = await fetch(BASE + '/api/gpu/session');
  const data = await r.json();
  token = data.token || '';
  check(r.ok && /^[0-9a-f]{16,}$/.test(token), 'GET /api/gpu/session 返回会话令牌', `platform=${data.platform} windows=${data.windows}`);
  const s = await fetch(BASE + '/api/gpu/status');
  const st = await s.json();
  check(s.ok && Array.isArray(st.browsers), 'GET /api/gpu/status 列出浏览器',
    st.browsers && st.browsers.length ? st.browsers.map((b) => b.name + (b.matchesUA ? '*' : '')).join(', ') : '（本机没找到常见浏览器）');

  const noTok = await fetch(BASE + '/api/gpu/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check(noTok.status === 403, '无令牌的写请求被拒绝', '403');

  const cross = await fetch(BASE + '/api/gpu/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lm-token': token, Origin: 'https://evil.example' },
    body: '{}',
  });
  check(cross.status === 403, '跨源写请求被拒绝', '403');

  const weird = await fetch(BASE + '/api/gpu/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lm-token': token },
    body: JSON.stringify({ exe: 'C:\\a.exe"; rm -rf' }),
  });
  const weirdBody = await weird.json();
  check(!weirdBody.ok, '非法路径被拒绝', String(weirdBody.error || weird.status).slice(0, 60));
} catch (err) {
  check(false, 'HTTP 接口', String(err.message || err));
}

/* ─────────── 2) 注册表真写真删 ─────────── */
if (WIN && token) {
  const before = await regValueAndCleanup('query', PROBE_EXE);
  await regValueAndCleanup('delete', PROBE_EXE);
  try {
    const r = await fetch(BASE + '/api/gpu/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lm-token': token },
      body: JSON.stringify({ exe: PROBE_EXE }),
    });
    const data = await r.json();
    const written = await regValueAndCleanup('query', PROBE_EXE);
    check(r.ok && data.ok && /GpuPreference=2;/.test(written || ''), '一键设为高性能：注册表真的写进去了',
      `${PROBE_EXE} → ${written}`);

    const again = await (await fetch(BASE + '/api/gpu/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lm-token': token },
      body: JSON.stringify({ exe: PROBE_EXE }),
    })).json();
    check(again.ok && again.results[0].changed === false, '重复设置是幂等的（不会重复写）');

    const rest = await (await fetch(BASE + '/api/gpu/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lm-token': token },
      body: JSON.stringify({ exe: PROBE_EXE }),
    })).json();
    const gone = await regValueAndCleanup('query', PROBE_EXE);
    check(rest.ok && rest.results[0].removed === true && gone === null, '还原：注册表项被删掉');
  } finally {
    if (before != null) {
      try {
        await exec('reg', ['add', KEY, '/v', PROBE_EXE, '/t', 'REG_SZ', '/d', before, '/f'], { windowsHide: true });
      } catch (_) {}
    } else {
      await regValueAndCleanup('delete', PROBE_EXE);
    }
  }
} else {
  check(true, '注册表测试跳过（非 Windows 或没拿到令牌）');
}

/* ─────────── 3) 页面：偏好 / 徽标 / 面板 ─────────── */
const browser = await launch({ port: 9422, width: 1600, height: 1000 });
const { evaluate, cdp } = browser;
try {
  // 在页面脚本运行前埋一个探针，记录每个上下文的参数
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__ctxOpts = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, opts) {
        try {
          if (type === 'webgl2' || type === 'webgl' || type === '2d' || type === 'webgpu') {
            window.__ctxOpts.push({ type, powerPreference: (opts && opts.powerPreference) || null });
          }
        } catch (_) {}
        return orig.call(this, type, opts);
      };
    `,
  });
  await browser.goto(BASE + '/', 3600);
  await evaluate('localStorage.clear()');
  await browser.goto(BASE + '/', 3600);
  await sleep(1500);

  /* 3.1 上下文参数：WebGL 必须全带 high-performance */
  await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 2880; c.height = 1800;
    const g = c.getContext('2d');
    g.fillStyle = '#123'; g.fillRect(0, 0, 2880, 1800);
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(100);
    await new Promise((r) => setTimeout(r, 700));
    rec.stop();
    const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
    stream.getTracks().forEach((t) => t.stop());
    window.__u = URL.createObjectURL(blob);
  })()`);
  await evaluate('App.loadVideoSrc(window.__u)');
  await sleep(1200);
  await evaluate(`Render.render({
    video: document.querySelector('#videoEl'), aspect: '9:16',
    camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
    bg: 'aurora', color: 'midnight', model: 'phone',
    duration: 0.2, fps: 30,
  })`);

  const opts = await evaluate('window.__ctxOpts');
  const gl = opts.filter((o) => o.type === 'webgl2' || o.type === 'webgl');
  const c2 = opts.filter((o) => o.type === '2d');
  check(gl.length > 0 && gl.every((o) => o.powerPreference === 'high-performance'),
    'WebGL 上下文全部请求高性能适配器',
    `${gl.length} 次（${gl.map((o) => o.powerPreference || 'null').join(', ')}）`);
  check(c2.length > 0, '2D 上下文也带上了同一偏好', `${c2.length} 次`);

  /* 3.2 徽标 */
  const badge = await evaluate(`(() => {
    const el = document.querySelector('#gpuBtn');
    const r = Render.gpuReport();
    return { text: el.textContent.trim(), cls: el.className, verdict: r.verdict, adapter: r.adapter, headline: r.headline };
  })()`);
  check(/独显|集显|软件|显卡\?/.test(badge.text) && /is-(ok|warn|bad|dim)/.test(badge.cls),
    '顶栏徽标显示当前显卡类型', `${badge.text} · ${badge.verdict} · ${badge.headline}`);
  check(typeof badge.adapter === 'string' && badge.adapter.length > 0,
    '徽标背后能读到适配器名称', badge.adapter.slice(0, 70));

  /* 3.3 面板 */
  await evaluate(`document.querySelector('#gpuBtn').click()`);
  await sleep(1200);
  const panel = await evaluate(`(() => {
    const m = document.querySelector('#gpuMask');
    if (!m) return { open: false };
    return {
      open: m.classList.contains('is-open'),
      head: (m.querySelector('.gpu-head__t') || {}).textContent || '',
      rows: m.querySelectorAll('.gpu-kv > div').length,
      browsers: m.querySelectorAll('.gpu-row').length,
      hasApply: !!m.querySelector('[data-gpu-apply]'),
      hasManual: !!m.querySelector('.gpu-manual'),
      token: (window.GpuPanel || {}).token || '',
    };
  })()`);
  check(panel.open && panel.rows >= 5, '面板能打开并列出显卡信息', `${panel.rows} 行 · ${panel.head}`);
  check(panel.hasManual, '面板里有手动设置步骤（非 Windows 也能用）');
  check(WIN ? (panel.browsers > 0 && panel.hasApply) : true,
    'Windows 下列出浏览器并给出「设为高性能」', `${panel.browsers} 个浏览器`);
  check(panel.token.length > 0, '面板拿到了会话令牌（写操作需要）');

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  const closed = await evaluate(`!document.querySelector('#gpuMask').classList.contains('is-open')`);
  check(closed, 'Esc 能关闭面板');
} catch (err) {
  check(false, '页面检查', String((err && err.message) || err).slice(0, 120));
} finally {
  const problems = (browser.problems || []).filter((p) => !/favicon/i.test(p));
  await browser.close();
  if (problems.length) {
    console.log('\n控制台问题:');
    problems.slice(0, 8).forEach((p) => console.log('  ' + p));
  }
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ 显卡链路通过（${results.length} 项）`);
  }
  process.exit(bad.length || problems.length ? 1 : 0);
}
