#!/usr/bin/env node
/**
 * LiveMockup — 本地服务器
 *
 *  1. 静态服务 public/（编辑器本身）
 *  2. /p/<绝对URL> 反向代理：破解 X-Frame-Options / CSP，注入页面运行时，
 *     让任意网站在样机 iframe 里"可交互 + 可脚本驱动"。
 *
 * 零依赖，只用 Node 内置模块。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot as gpuSnapshot, setLevel as gpuSetLevel, clearLevel as gpuClearLevel, isWindows as gpuIsWindows } from './client/lib/gpu-prefs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4321;
const ORIGIN = `http://localhost:${PORT}`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* ───────────────────────── 工具 ───────────────────────── */

const HOP_REQ = new Set([
  'host', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'accept-encoding', 'content-length', 'proxy-authorization',
  'proxy-connection', 'http2-settings',
]);

const STRIP_RES = new Set([
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'strict-transport-security', 'permissions-policy', 'report-to', 'nel', 'alt-svc',
  'expect-ct', 'referrer-policy',
]);

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}

function sniffCharset(buf, contentTypeHeader) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentTypeHeader || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  return 'utf-8';
}

function decodeText(buf, contentTypeHeader) {
  const label = sniffCharset(buf, contentTypeHeader);
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * 把页面里的任意 URL 变成可在 iframe 内解析的代理路径。
 * 相对路径保持原样（iframe 路径结构镜像了目标站点，天然可解析）。
 */
function proxify(u, base) {
  if (u == null) return u;
  let s = String(u).trim();
  if (!s) return s;
  if (/^(data:|blob:|javascript:|mailto:|tel:|sms:|about:|file:|#|\{|\$)/i.test(s)) return s;

  let abs;
  try {
    abs = new URL(s, base).href;
  } catch {
    return s;
  }
  if (!/^https?:/i.test(abs)) return s;
  return '/p/' + abs;
}

const TEXT_ATTRS =
  /\s(src|href|action|formaction|poster|data-src|data-href|data-original)\s*=\s*(["'])([^"']*)\2/gi;

/** 没加引号的属性值，如 <script src=/s.js> —— 不处理会漏掉一整类根相对资源 */
const BARE_ATTRS =
  /\s(src|href|action|formaction|poster)\s*=\s*([^\s"'>`]+)/gi;

function rewriteCss(css, base) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => {
    const p = proxify(u, base);
    return `url(${q}${p}${q})`;
  }).replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => {
    return `@import ${q}${proxify(u, base)}${q}`;
  });
}

function rewriteHtml(html, base) {
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
  // 页面自带 <base> 会让相对路径指向远端，直接去掉，用代理路径结构代替
  html = html.replace(/<base\b[^>]*>/gi, '');
  // SRI / CORS / nonce 在代理后一定不匹配，全部剥掉
  html = html.replace(/\s\b(integrity|nonce)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s\bcrossorigin(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, '');

  html = html.replace(TEXT_ATTRS, (m, attr, q, val) => {
    return ` ${attr}=${q}${proxify(val, base)}${q}`;
  });

  html = html.replace(BARE_ATTRS, (m, attr, val) => {
    return ` ${attr}=${proxify(val, base)}`;
  });

  html = html.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, val) => {
    const out = val
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        bits[0] = proxify(bits[0], base);
        return bits.join(' ');
      })
      .join(', ');
    return `${pre}${q}${out}${q}`;
  });

  // 内联 style / <style> / 内联脚本里的字面量 URL
  html = html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => {
    return `url(${q}${proxify(u, base)}${q})`;
  });

  return html;
}

function injectRuntime(html) {
  const tag = '<script src="/js/agent.js" data-livemockup-runtime></script>';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + tag);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  }
  return tag + html;
}

/* ───────────────────────── 代理 ───────────────────────── */

async function handleProxy(req, res) {
  const raw = req.url.slice('/p/'.length);
  if (!raw) return send(res, 400, 'missing target url');

  let target;
  try {
    target = new URL(raw);
  } catch {
    try {
      target = new URL(decodeURIComponent(raw));
    } catch {
      return send(res, 400, 'bad url: ' + raw);
    }
  }
  if (!/^https?:$/.test(target.protocol)) {
    return send(res, 400, 'only http/https');
  }
  // 站点根目录补斜杠，保证相对路径解析与源站一致
  if (target.pathname === '' ) target.pathname = '/';

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_REQ.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['user-agent'] = UA;
  headers['accept-language'] = headers['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8';
  const cookieJar = headers.cookie;
  if (cookieJar) headers.cookie = cookieJar;
  if (headers.referer && headers.referer.includes('/p/')) {
    headers.referer = headers.referer.split('/p/')[1] || '';
    if (!headers.referer) delete headers.referer;
  }
  if (headers.origin && headers.origin.startsWith(ORIGIN)) {
    headers.origin = target.origin;
  }
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  delete headers['sec-fetch-user'];

  let bodyBuf = null;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    bodyBuf = Buffer.concat(chunks);
    if (bodyBuf.length) headers['content-length'] = String(bodyBuf.length);
  }

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: req.method,
      headers,
      body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return send(
      res,
      502,
      `<body style="font:14px/1.7 system-ui;padding:40px;color:#e8e8ef;background:#14151b">
        <h2 style="color:#ff8a8a">无法连接目标站点</h2>
        <p>${String(err.message).slice(0, 300)}</p>
        <p style="color:#8b8d99">目标：${target.href}</p>
        <p style="color:#8b8d99">检查网络 / 代理 / 该站点是否禁止服务端抓取。</p>
      </body>`,
      { 'Content-Type': 'text/html; charset=utf-8' }
    );
  }

  // 重定向：把 Location 改写成代理路径，保证 iframe 地址栏语义正确
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    if (loc) {
      let abs;
      try {
        abs = new URL(loc, target.href).href;
      } catch {
        abs = loc;
      }
      if (!/^https?:/i.test(abs)) return send(res, 302, '', { Location: abs });
      return send(res, 302, '', { Location: '/p/' + abs });
    }
  }

  const outHeaders = {};
  for (const [k, v] of upstream.headers.entries()) {
    if (STRIP_RES.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'set-cookie') continue;
    outHeaders[k] = v;
  }
  const rawCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (rawCookies.length) {
    outHeaders['set-cookie'] = rawCookies.map((c) =>
      c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax')
    );
  }
  outHeaders['cache-control'] = 'no-store';

  const ct = upstream.headers.get('content-type') || '';
  const ctLower = ct.toLowerCase();

  const isHtml = ctLower.includes('text/html');
  const isCss = ctLower.includes('text/css');

  if (isHtml || isCss) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    let text = decodeText(buf, ct);
    text = isHtml ? rewriteHtml(text, target.href) : rewriteCss(text, target.href);
    if (isHtml) text = injectRuntime(text);
    outHeaders['content-type'] = isHtml
      ? 'text/html; charset=utf-8'
      : 'text/css; charset=utf-8';
    return send(res, upstream.status, text, outHeaders);
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  return send(res, upstream.status, buf, outHeaders);
}

/* ────────────────── 根相对请求的兜底（dev server 关键） ────────────────── */

/**
 * 被代理页面里的 JS 常常自己发根相对请求：`fetch('/api/x')`、`new Image().src = '/a.png'`、
 * `import('/src/x.js')`。这些请求由浏览器发出，HTML 里重写不到，于是打到了编辑器自己的
 * origin 上 —— 这就是「localhost 的站点贴进来后数据、图片、接口全没了」的主因。
 *
 * 兜底：静态目录里没有这个路径时，看 Referer 里有没有 /p/<目标地址>，有就把这个请求
 * 也转发到目标站点（GET/HEAD 才转发，避免把编辑器的 POST 误发出去）。
 */
function proxyTargetFromReferer(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return null;
  const ref = req.headers.referer || req.headers.referrer || '';
  const at = ref.indexOf('/p/');
  if (at < 0) return null;
  try {
    const target = new URL(ref.slice(at + 3));
    return /^https?:$/.test(target.protocol) ? target : null;
  } catch {
    return null;
  }
}

/* ───────────────────────── 静态 ───────────────────────── */

async function handleStatic(req, res) {
  let parsed;
  try {
    parsed = new URL(req.url, ORIGIN);
  } catch {
    return send(res, 400, 'bad path');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return send(res, 400, 'bad path');
  }

  // 目录请求补 index.html 只是为了找文件，真正转发给目标站点时要用原路径
  const served = pathname.endsWith('/') ? pathname + 'index.html' : pathname;

  const filePath = path.join(PUBLIC, served);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC))) {
    return send(res, 403, 'forbidden');
  }

  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      return handleStatic({ ...req, url: served + '/' }, res);
    }
    const ext = path.extname(resolved).toLowerCase();
    const data = await fsp.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    const target = proxyTargetFromReferer(req);
    if (target) {
      req.url = '/p/' + target.origin + pathname + (parsed.search || '');
      return handleProxy(req, res);
    }
    const notFound = `<body style="font:14px/1.7 system-ui;padding:40px;color:#e8e8ef;background:#14151b">
      <h2>404</h2><p>${pathname}</p>
      <p><a style="color:#7c5cff" href="/">返回编辑器</a></p></body>`;
    send(res, 404, notFound, { 'Content-Type': 'text/html; charset=utf-8' });
  }
}

/* ───────────────────── 显卡偏好接口 ───────────────────── */
/*
 * 网页只能「请求」高性能适配器，不能指定用哪块卡；真正说了算的是系统和浏览器。
 * Windows 上那个开关（设置 → 系统 → 显示 → 显卡）就是写 HKCU 里的
 * UserGpuPreferences，所以这里提供一个**本机、需同源、需令牌**的接口替用户写一次。
 *
 * 防滥用：
 *   · 令牌在进程启动时生成，只能通过同源 GET /api/gpu/session 读到（跨域读不到响应体）
 *   · POST 必须带 x-lm-token，且 Origin 必须是本服务自己的来源
 *   · 只接受「绝对路径的 .exe」或 UWP AUMID，写之前校验、写之后读回校验
 */
const GPU_TOKEN = crypto.randomBytes(16).toString('hex');
const GPU_ORIGINS = new Set([ORIGIN, `http://127.0.0.1:${PORT}`]);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 只允许本机回环：局域网里的其它机器不该能改写这台机器的显卡设置 */
function isLoopback(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./.test(ip);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && !GPU_ORIGINS.has(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

async function handleGpuApi(req, res) {
  const route = new URL(req.url, ORIGIN).pathname.replace(/\/+$/, '');
  const ua = req.headers['user-agent'] || '';

  // 会话令牌只发给本机：远程拿到令牌也改写不了这台机器的注册表
  if (!isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: '显卡设置只允许在本机操作' });
  }

  if (route === '/api/gpu/session' && req.method === 'GET') {
    return sendJson(res, 200, { token: GPU_TOKEN, platform: process.platform, windows: gpuIsWindows() });
  }

  if (route === '/api/gpu/status' && req.method === 'GET') {
    try {
      const snap = await gpuSnapshot(ua);
      return sendJson(res, 200, { ok: true, windows: gpuIsWindows(), ...snap });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  const isWrite = route === '/api/gpu/apply' || route === '/api/gpu/restore';
  if (!isWrite) return sendJson(res, 404, { ok: false, error: 'unknown route' });
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin refused' });
  if (req.headers['x-lm-token'] !== GPU_TOKEN) {
    return sendJson(res, 403, { ok: false, error: '缺少或错误的会话令牌（刷新页面再试）' });
  }
  if (!gpuIsWindows()) {
    return sendJson(res, 501, { ok: false, error: '一键切换只支持 Windows；其它系统请按面板里的手动步骤' });
  }

  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
  }

  try {
    const snap = await gpuSnapshot(ua);
    const targets = body.exe
      ? [String(body.exe)]
      : snap.browsers.filter((b) => b.matchesUA).map((b) => b.exe);
    if (!targets.length) {
      return sendJson(res, 409, {
        ok: false,
        error: '没找到正在使用的浏览器路径',
        browsers: snap.browsers,
      });
    }
    const results = [];
    for (const exe of targets) {
      if (route === '/api/gpu/apply') {
        const lvl = Number.isFinite(Number(body.level)) ? Number(body.level) : 2;
        results.push(await gpuSetLevel(exe, lvl));
      } else {
        results.push(await gpuClearLevel(exe));
      }
    }
    return sendJson(res, 200, {
      ok: true,
      action: route === '/api/gpu/apply' ? 'apply' : 'restore',
      results,
      needsRestart: true,
    });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    if (req.url.startsWith('/api/gpu/')) return await handleGpuApi(req, res);
    if (req.url.startsWith('/p/')) return await handleProxy(req, res);
    // 只有编辑器自己的请求才应答 /api/ping：被代理页面也可能有同名接口，不能抢
    if (req.url === '/api/ping' && !(req.headers.referer || '').includes('/p/')) {
      return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    }
    return await handleStatic(req, res);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) send(res, 500, 'internal error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  \x1b[38;5;99m▛▀▖▞▀▖▌ ▌▛▀▖\x1b[0m  LiveMockup');
  console.log('  \x1b[2m在样机里跑真实网页，把操作录成关键帧\x1b[0m');
  console.log('');
  console.log(`  ➜  编辑器   \x1b[4mhttp://localhost:${PORT}/\x1b[0m`);
  console.log(`  ➜  内置演示 \x1b[4mhttp://localhost:${PORT}/demo/coffee/\x1b[0m`);
  console.log('');
});
