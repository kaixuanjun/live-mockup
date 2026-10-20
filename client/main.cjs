/**
 * LiveMockup · Windows 桌面客户端（Electron 主进程）
 *
 * 为什么要有客户端：浏览器里三个硬限制绕不过去 ——
 *   1. 导出只能走 WebCodecs（VP9/WebM，码率有上限），慢且容器受限；
 *   2. 视频取帧靠 <video>.currentTime seek，4K 源每帧上百毫秒；
 *   3. 用哪块 GPU 由系统和浏览器决定，页面只能「请求」。
 * 客户端里这些都是我们自己的代码：ffmpeg 直接吃原始帧出 H.264/MP4，
 * 窗口可以关掉后台节流，GPU 偏好可以写进系统。
 *
 * 边界：这一层只做「壳 + 原生能力」，界面和业务逻辑仍然复用 public/，
 * 所以浏览器版和客户端版是同一套 UI，不会分叉。
 */
const { app, BrowserWindow, protocol, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { pathToFileURL } = require('node:url');
const pathToUrl = (p) => pathToFileURL(p).href;
/**
 * 打包后（electron-builder）资源被放到 process.resourcesPath：
 *   resources/public  ← 编辑器 UI
 *   resources/bin     ← ffmpeg.exe
 * 开发时仍然用仓库里的 ../public 和 client/bin。
 */
const RESOURCES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const PUBLIC = app.isPackaged
  ? path.join(RESOURCES, 'public')
  : path.join(__dirname, '..', 'public');
const SMOKE = process.argv.includes('--smoke');
const SMOKE_ENCODE = process.argv.includes('--encode');

/* ───────────── 启动前的开关 ───────────── */

// 显卡：不要让浏览器因为驱动黑名单把用户踢到软件渲染
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// 导出跑在渲染进程里：窗口在后面或被挡住时不能被降频
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 导出时长按目标帧率推进，不要被显示刷新率牵着走
app.commandLine.appendSwitch('disable-frame-rate-limit');

// 允许把 Chromium 的数据目录挪走：自动化环境里 %APPDATA% 常常不可写，
// 缓存建不出来会刷一屏错误（不影响功能，但很吵）
if (process.env.LM_USER_DATA) {
  try {
    require('node:fs').mkdirSync(process.env.LM_USER_DATA, { recursive: true });
    app.setPath('userData', process.env.LM_USER_DATA);
  } catch (_) {}
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

/* ───────────── 静态资源（app://lm/...） ───────────── */

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
};

async function serveStatic(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const target = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC)) return new Response('forbidden', { status: 403 });

  let stat = null;
  try { stat = await fsp.stat(target); } catch (_) {}
  if (!stat || !stat.isFile()) return new Response('not found', { status: 404 });

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const baseHeaders = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    // 自定义协议默认不支持断点/拖动；<video> 播 mp4 需要 Range，否则直接报「不支持」
    'Accept-Ranges': 'bytes',
  };

  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let startByte = m[1] ? Number(m[1]) : 0;
      let endByte = m[2] ? Number(m[2]) : stat.size - 1;
      if (!m[1] && m[2]) { startByte = Math.max(0, stat.size - Number(m[2])); endByte = stat.size - 1; }
      if (startByte >= stat.size || startByte > endByte) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': 'bytes */' + stat.size },
        });
      }
      endByte = Math.min(endByte, stat.size - 1);
      const len = endByte - startByte + 1;
      const fh = await fsp.open(target, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, startByte);
        return new Response(buf, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': 'bytes ' + startByte + '-' + endByte + '/' + stat.size,
            'Content-Length': String(len),
          },
        });
      } finally {
        await fh.close().catch(() => {});
      }
    }
  }

  const buf = await fsp.readFile(target);
  return new Response(buf, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(buf.length) },
  });
}

/* ───────────── ffmpeg ───────────── */

let ffmpegPath = '';

async function findFfmpeg() {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env.LM_FFMPEG,
    // 打包后放在 resources/bin，随安装包一起发（用户不用自己装 ffmpeg）
    app.isPackaged ? path.join(RESOURCES, 'bin', exeName) : '',
    path.join(__dirname, 'bin', exeName),
    'ffmpeg',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const ver = await new Promise((resolve) => {
        const p = spawn(c, ['-version'], { windowsHide: true });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', () => resolve(''));
        p.on('close', (code) => resolve(code === 0 ? out.split('\n')[0] : ''));
      });
      if (ver) return { path: c, version: ver.trim() };
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

/* ───────────── 原生导出（帧流 → ffmpeg → MP4） ───────────── */

let job = null;   // 当前编码任务

async function startNativeJob(opts) {
  if (job) throw new Error('已有一个原生编码任务在跑');
  const info = await findFfmpeg();
  if (!info) throw new Error('找不到 ffmpeg：把 ffmpeg.exe 放到 client/bin/ 或加进 PATH');
  ffmpegPath = info.path;

  const { width, height, fps, crf = 16, preset = 'veryfast', defaultName = 'livemockup.mp4' } = opts;

  /**
   * 三档：
   *   1. 调用方给了 outPath / LM_SMOKE_OUT → 直接用（脚本、测试、批量导出，不弹窗）
   *   2. 冒烟模式却没给 → 直接报错。绝不弹对话框：自动化会被卡死，
   *      而且窗口是隐藏的，对话框会莫名弹到用户桌面上。
   *   3. 正常导出 → 原生保存框，默认落在「视频」目录（不是项目目录——
   *      OneDrive / 受保护目录会让 Windows 反过来要管理员权限）。
   */
  const wantPath = String(opts.outPath || process.env.LM_SMOKE_OUT || '').trim();
  let outPath;
  if (wantPath) {
    await fsp.mkdir(path.dirname(wantPath), { recursive: true });
    outPath = wantPath;
  } else if (SMOKE) {
    throw new Error('冒烟模式必须提供 outPath（避免弹出保存对话框）');
  } else {
    let videos = '';
    try { videos = app.getPath('videos'); } catch (_) {}
    const picked = await dialog.showSaveDialog({
      title: '导出视频',
      defaultPath: path.join(videos, defaultName),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    outPath = picked.filePath.toLowerCase().endsWith('.mp4') ? picked.filePath : picked.filePath + '.mp4';
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`, '-r', String(fps),
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ];

  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const exited = new Promise((resolve, reject) => {
    proc.on('error', (err) => reject(new Error('ffmpeg 起不来：' + err.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}\n${stderr.slice(-1200)}`));
    });
  });

  job = {
    proc,
    outPath,
    frames: 0,
    bytes: 0,
    async push(buffer) {
      const buf = Buffer.from(buffer);
      this.frames += 1;
      this.bytes += buf.length;
      if (this.proc.stdin.write(buf)) return { queued: true };
      await new Promise((resolve) => this.proc.stdin.once('drain', resolve));
      return { queued: true };
    },
    async finish() {
      try { this.proc.stdin.end(); } catch (_) {}
      try {
        await exited;
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (/permission|access is denied|拒绝访问|EACCES|EPERM/i.test(msg)) {
          throw new Error('没有权限写入「' + outPath + '」。换一个自己能写的目录（例如「视频」或桌面）再试。');
        }
        throw err;
      }
      const st = await fsp.stat(outPath).catch(() => null);
      const size = st ? st.size : 0;
      if (!size) throw new Error('导出没有写出内容：' + outPath);
      return { path: outPath, size, frames: this.frames };
    },
    abort() {
      try { this.proc.stdin.end(); } catch (_) {}
      try { this.proc.kill('SIGKILL'); } catch (_) {}
    },
  };
  return { canceled: false, path: outPath, ffmpeg: info.version };
}

/* ───────────── 原生解码（ffmpeg 顺序出帧） ───────────── */
/*
 * 为什么换掉 <video> seek：浏览器取帧要 currentTime=... 再等 seeked，
 * 4K 源每帧 100ms 上下，整段视频就是几十秒到几分钟的纯等待。
 * 这里让 ffmpeg 一次性顺序解码、按输出帧率出帧，每帧只花「读管道 + 拷贝」的时间。
 */
let decoder = null;

async function startDecode(opts) {
  if (decoder) throw new Error('已经有一个解码任务在跑');
  const info = await findFfmpeg();
  if (!info) throw new Error('找不到 ffmpeg：把 ffmpeg.exe 放到 client/bin/ 或加进 PATH');

  const file = String(opts.path || '');
  if (!file) throw new Error('没有视频文件路径');
  const fps = Math.max(1, Math.min(120, Math.round(Number(opts.fps) || 30)));
  const width = Math.max(2, Math.round(Number(opts.width) || 0));
  const height = Math.max(2, Math.round(Number(opts.height) || 0));
  if (!width || !height) throw new Error('缺少目标尺寸');

  // 传输方式：
  //   raw  —— 每帧 RGBA 原始像素（无损，1080p 一帧 8MB，IPC 很贵）
  //   jpeg —— 每帧一张高质量 JPEG（体积小两个数量级，IPC 便宜；屏幕内容基本看不出来）
  const transport = opts.transport === 'jpeg' ? 'jpeg' : 'raw';
  const quality = Number.isFinite(Number(opts.quality)) ? Math.max(1, Math.min(8, Number(opts.quality))) : 3;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:flags=bicubic`,
  ];
  if (transport === 'jpeg') {
    args.push('-c:v', 'mjpeg', '-q:v', String(quality), '-pix_fmt', 'yuvj420p', '-f', 'image2pipe');
  } else {
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgba');
  }
  args.push('pipe:1');

  const proc = spawn(info.path, args, { windowsHide: true });
  const frameSize = transport === 'raw' ? width * height * 4 : 0;
  let buf = Buffer.alloc(0);
  let eof = false;
  let lastFrame = null;
  let stderr = '';
  const waiters = [];

  /** 从缓冲区里切出下一帧；切不出来返回 null */
  const takeFrame = () => {
    if (transport === 'raw') {
      if (buf.length < frameSize) return null;
      const frame = Buffer.from(buf.subarray(0, frameSize));
      buf = buf.subarray(frameSize);
      return frame;
    }
    // JPEG：一帧 = SOI(FFD8) … 下一帧的 SOI 之前（含 EOI）。没有 SOI 就认为还不完整。
    const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) return null;
    const next = buf.indexOf(Buffer.from([0xff, 0xd8]), soi + 2);
    if (next < 0) return null;
    const frame = Buffer.from(buf.subarray(soi, next));
    buf = buf.subarray(next);
    return frame;
  };

  const pump = () => {
    for (;;) {
      const frame = waiters.length ? takeFrame() : null;
      if (!frame) break;
      lastFrame = frame;
      waiters.shift().resolve(frame);
    }
    if (eof) {
      while (waiters.length) waiters.shift().resolve(lastFrame);
    }
  };

  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    pump();
  });
  proc.stdout.on('end', () => { eof = true; pump(); });
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.on('error', (err) => {
    eof = true;
    while (waiters.length) waiters.shift().reject(new Error('ffmpeg 起不来：' + err.message));
  });
  proc.on('close', () => { eof = true; pump(); });

  decoder = {
    width, height, fps, frameSize, transport,
    frames: 0,
    next() {
      const ready = waiters.length ? null : takeFrame();
      if (ready) {
        lastFrame = ready;
        this.frames += 1;
        return Promise.resolve(ready);
      }
      if (eof) {
        // 源比时间轴短：重复最后一帧，别让整段导出失败
        if (lastFrame) { this.frames += 1; return Promise.resolve(lastFrame); }
        return Promise.reject(new Error('ffmpeg 没有输出任何帧' + (stderr ? '：' + stderr.slice(-300) : '')));
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    stop() {
      try { proc.stdout.destroy(); } catch (_) {}
      try { proc.stdin && proc.stdin.destroy(); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
    },
  };

  return { ok: true, width, height, fps, transport, frameBytes: frameSize || null, ffmpeg: info.version };
}

/* ───────────── 窗口 ───────────── */

let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0b0c11',
    title: 'LiveMockup',
    show: !SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webgl: true,
      offscreen: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL('app://lm/index.html');
  return win;
}

/* ───────────── IPC ───────────── */

function registerIpc() {
  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // 保存文件（原生对话框，不经过「下载」目录）
  ipcMain.handle('lm:save', async (_e, { data, name, filters }) => {
    const picked = await dialog.showSaveDialog({
      title: '保存',
      defaultPath: name || 'livemockup',
      filters: filters || undefined,
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    await fsp.writeFile(picked.filePath, Buffer.from(data));
    return { canceled: false, path: picked.filePath };
  });

  // 打开文件
  ipcMain.handle('lm:open', async (_e, { filters, encoding = 'utf8' } = {}) => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const file = picked.filePaths[0];
    const buf = await fsp.readFile(file);
    return {
      canceled: false,
      path: file,
      name: path.basename(file),
      text: encoding === 'utf8' ? buf.toString('utf8') : undefined,
      size: buf.length,
    };
  });

  // 在文件管理器里显示
  ipcMain.handle('lm:reveal', async (_e, p) => {
    if (p) shell.showItemInFolder(p);
    return true;
  });

  // 运行时信息（显卡、ffmpeg、版本）
  ipcMain.handle('lm:info', async () => {
    const ff = await findFfmpeg();
    let gpuInfo = null;
    try { gpuInfo = await app.getGPUInfo('basic'); } catch (_) {}
    return {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      userData: app.getPath('userData'),
      ffmpeg: ff ? { path: ff.path, version: ff.version } : null,
      gpu: gpuInfo,
    };
  });

  // 原生导出：开任务 / 推帧 / 收尾 / 取消
  ipcMain.handle('lm:job:begin', async (_e, opts) => {
    try {
      return { ok: true, ...(await startNativeJob(opts)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lm:job:frame', async (_e, buffer) => {
    if (!job) return { ok: false, error: '没有进行中的任务' };
    try {
      await job.push(buffer);
      return { ok: true, frames: job.frames };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lm:job:end', async () => {
    if (!job) return { ok: false, error: '没有进行中的任务' };
    const current = job;
    job = null;
    try {
      return { ok: true, ...(await current.finish()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lm:job:abort', async () => {
    if (job) { job.abort(); job = null; }
    return { ok: true };
  });

  /* ── 显卡偏好：客户端里没有 HTTP 服务器，直接在主进程写注册表 ── */
  // gpu-prefs.mjs 是 ESM，CJS 主进程用动态 import 取
  let gpuMod = null;
  const loadGpu = async () => {
    if (!gpuMod) gpuMod = await import(pathToUrl(path.join(__dirname, 'lib', 'gpu-prefs.mjs')));
    return gpuMod;
  };

  ipcMain.handle('lm:gpu:status', async () => {
    try {
      const mod = await loadGpu();
      const snap = await mod.snapshot(win && win.webContents ? win.webContents.getUserAgent() : '');
      return { ok: true, windows: mod.isWindows(), ...snap };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 写注册表交给「纯 Node 子进程」：同样的 electron.exe 加 ELECTRON_RUN_AS_NODE=1，
   * 这样跑的就是普通 Node，不会碰上浏览器进程里 reg add 被拒的怪问题。
   */
  function runGpuWrite(action, exe, level) {
    return new Promise((resolve) => {
      const script = path.join(__dirname, 'node', 'gpu-write.cjs');
      const child = spawn(process.execPath, [script, action, String(exe || ''), String(level || 2)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => resolve({ ok: false, error: '拉起写入进程失败：' + e.message }));
      child.on('close', () => {
        const line = out.trim().split('\n').pop() || '';
        try {
          resolve(JSON.parse(line));
        } catch (_) {
          resolve({ ok: false, error: err.trim().slice(-300) || out.trim().slice(-300) || '写入进程没有返回结果' });
        }
      });
    });
  }

  ipcMain.handle('lm:gpu:apply', async (_e, { exe, level } = {}) => {
    const lvl = Number.isFinite(Number(level)) ? Number(level) : 2;
    return runGpuWrite('apply', exe, lvl);
  });

  ipcMain.handle('lm:gpu:restore', async (_e, { exe } = {}) => runGpuWrite('clear', exe, 2));

  /* ── 原生解码：顺序取帧 ── */
  ipcMain.handle('lm:decode:begin', async (_e, opts) => {
    try {
      return await startDecode(opts || {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lm:decode:frame', async () => {
    if (!decoder) return { ok: false, error: '没有进行中的解码任务' };
    try {
      const frame = await decoder.next();
      // 直接回 Buffer（结构化克隆成 Uint8Array），不再包一层 base64
      return { ok: true, data: frame, frames: decoder.frames };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lm:decode:end', async () => {
    if (decoder) {
      const d = decoder;
      decoder = null;
      d.stop();
    }
    return { ok: true };
  });

  // 主进程主动通知（导出完成等）
  ipcMain.handle('lm:notify', async (_e, { title, body }) => {
    send('lm:message', { title, body });
    return true;
  });
}

/* ───────────── 冒烟测试 ───────────── */

async function runSmoke() {
  const out = { ok: true, steps: [], errors: [] };
  const step = (name, ok, detail) => {
    out.steps.push({ name, ok: !!ok, detail });
    if (!ok) out.ok = false;
  };
  const exec = (code) => win.webContents.executeJavaScript(code);

  try {
    await exec('1');

    /* ── 1. 页面基本可用 ── */
    const basic = await exec(`(() => ({
      title: document.title,
      hasApp: typeof window.App === 'object',
      hasRender: typeof window.Render === 'object',
      hasMove: typeof window.MoveTrack === 'object',
      hasLM: typeof window.LM === 'object',
      platform: window.LM && window.LM.platform,
      url: location.href,
      styleOk: !!getComputedStyle(document.body).backgroundColor,
    }))()`);
    step('页面加载', basic.hasApp && basic.hasRender && basic.hasMove, JSON.stringify(basic).slice(0, 220));
    step('原生桥接可见', basic.hasLM === true && basic.platform === process.platform, 'LM.platform=' + basic.platform);
    step('样式生效', basic.styleOk === true);

    /* ── 2. 显卡面板（客户端里必须走 IPC） ── */
    const panel = await exec(`(async () => {
      document.querySelector('#gpuBtn').click();
      await new Promise((r) => setTimeout(r, 700));
      const mask = document.querySelector('#gpuMask');
      const open = !!mask && mask.classList.contains('is-open');
      const rows = document.querySelectorAll('#gpuMask .gpu-row').length;
      const token = (window.GpuPanel || {}).token;
      const status = (window.GpuPanel || {}).status;
      const close = mask && mask.querySelector('.gpucard__x');
      if (close) close.click();
      return { open, rows, token, source: status && status.family, browsers: ((status && status.browsers) || []).length };
    })()`);
    step('显卡面板走客户端 IPC', panel.open === true && panel.token === 'client' && panel.rows > 0,
      `rows=${panel.rows} · 来源=${panel.source} · 浏览器 ${panel.browsers} 个`);

    /* ── 3. 显卡偏好（本环境可能禁止子进程写注册表，只验证链路） ── */
    const gpuExe = process.env.LM_GPU_EXE || 'C:\\Windows\\System32\\notepad.exe';
    if (process.env.LM_GPU_TEST) {
      const gp = await exec(`(async () => {
        const st = await window.LM.gpu.status();
        const act = ${JSON.stringify(process.env.LM_GPU_TEST)} === 'apply'
          ? await window.LM.gpu.apply(${JSON.stringify(gpuExe)}, 2)
          : await window.LM.gpu.restore(${JSON.stringify(gpuExe)});
        return { status: st, action: act };
      })()`);
      step('显卡状态可读', !!(gp.status && gp.status.ok && gp.status.windows === true),
        `来源=客户端IPC · 浏览器 ${((gp.status && gp.status.browsers) || []).length} 个`);
      step(process.env.LM_GPU_TEST === 'apply' ? '显卡偏好写入' : '显卡偏好还原',
        !!(gp.action && gp.action.ok),
        JSON.stringify(gp.action && (gp.action.after || gp.action.error)).slice(0, 90));
      out.gpu = { exe: gpuExe, action: gp.action };
    }

    const info = await exec('window.LM.info()');
    step('原生信息', !!info && !!info.electron,
      `electron ${info && info.electron} · chrome ${info && info.chrome} · ffmpeg ${info && info.ffmpeg && info.ffmpeg.version}`);

    /* ── 4. 编码 / 解码（--encode） ── */
    if (SMOKE_ENCODE) {
      const ff = await findFfmpeg();
      const smokeDir = path.join(__dirname, '.smoke');
      await fsp.mkdir(smokeDir, { recursive: true });
      const pubDir = path.join(__dirname, '..', 'public', '.smoke');
      await fsp.mkdir(pubDir, { recursive: true });

      // 造一个 1080p 文件：两条取帧路径共用同一个源
      const srcFile = path.join(pubDir, 'src.mp4');
      const made = await new Promise((resolve) => {
        const child = spawn(ff.path, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2',
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          srcFile,
        ], { windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
      step('生成 1080p 测试文件', made, path.relative(path.join(__dirname, '..'), srcFile));

      // 先准备一个 Blob 视频，保证 Render.render 的 video 参数合法
      await exec(`(async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 360;
        const g = c.getContext('2d');
        const t0 = performance.now();
        let last = -1;
        const paint = () => {
          const s = Math.floor((performance.now() - t0) / 100);
          if (s === last) return;
          last = s;
          g.fillStyle = '#101820'; g.fillRect(0, 0, 640, 360);
          g.fillStyle = '#e11'; g.fillRect((s * 37) % 500, 60, 120, 120);
        };
        paint();
        const stream = c.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.start(100);
        await new Promise((r) => { const t = () => { paint(); if (performance.now() - t0 < 1200) requestAnimationFrame(t); else r(); }; t(); });
        rec.stop();
        const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
        stream.getTracks().forEach((t) => t.stop());
        window.__u = URL.createObjectURL(blob);
        await App.loadVideoSrc(window.__u);
        return !!document.querySelector('#videoEl').videoWidth;
      })()`);
      step('准备测试视频', true);

      // 4.1 客户端原生编码（帧 → ffmpeg → MP4）
      const encOut = path.join(smokeDir, 'smoke.mp4');
      const encoded = await exec(`(async () => {
        const t0 = performance.now();
        const out = await Render.render({
          video: document.querySelector('#videoEl'), aspect: '16:9',
          camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
          bg: 'paper', color: 'sand', model: 'browser',
          duration: 0.6, fps: 30,
          native: { outPath: ${JSON.stringify(encOut)}, crf: 18 },
        });
        return { out, ms: Math.round(performance.now() - t0), sink: Render.lastSink };
      })()`);
      const encOk = encoded && encoded.out && encoded.out.native === true && encoded.out.size > 2000;
      step('原生编码产出 MP4', encOk, JSON.stringify(encoded && encoded.out).slice(0, 200) + ` · ${encoded && encoded.ms}ms`);
      if (encOk) { out.mp4 = encoded.out.path; out.encodeMs = encoded.ms; }

      // 4.2 取帧对比：seek 基准 + 两种 ffmpeg 传输
      const bench = await exec(`(async () => {
        const N = 30;
        const fps = 30;
        const v = document.querySelector('#videoEl');
        v.src = 'app://lm/.smoke/src.mp4';
        await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 8000); });
        v.pause();
        if (!v.videoWidth) return { error: '视频没有加载' };
        const out = { size: [v.videoWidth, v.videoHeight], n: N };

        // A: <video> seek
        let t = performance.now();
        for (let i = 0; i < N; i++) await Render.__seekForTest(v, (i + 0.5) / fps);
        out.seek = Math.round(performance.now() - t);

        // B: ffmpeg raw / jpeg
        for (const lane of ['raw', 'jpeg']) {
          const t0 = performance.now();
          const beg = await window.LM.decode.begin({
            path: ${JSON.stringify(srcFile)}, fps, width: 1920, height: 1080, transport: lane,
          });
          if (!beg || beg.ok === false) return { error: lane + ' 启动失败：' + (beg && beg.error) };
          let bytes = 0;
          for (let i = 0; i < N; i++) {
            const fr = await window.LM.decode.frame();
            if (!fr || fr.ok === false) { await window.LM.decode.end(); return { error: lane + ' 读帧失败：' + (fr && fr.error) }; }
            bytes += fr.data.length;
            if (lane === 'jpeg' && i === 0) {
              const bmp = await createImageBitmap(new Blob([fr.data], { type: 'image/jpeg' }));
              out.jpegBitmap = [bmp.width, bmp.height];
              bmp.close && bmp.close();
            }
          }
          await window.LM.decode.end();
          out[lane] = { ms: Math.round(performance.now() - t0), bytesPerFrame: Math.round(bytes / N) };
        }
        return out;
      })()`);

      if (bench && !bench.error) {
        const per = (ms) => +(ms / bench.n).toFixed(1);
        step('取帧对比可用', !!bench.seek && !!bench.raw && !!bench.jpeg,
          `源 ${bench.size.join('×')} · 每帧 raw ${(bench.raw.bytesPerFrame / 1048576).toFixed(1)}MB / jpeg ${(bench.jpeg.bytesPerFrame / 1024).toFixed(0)}KB`);
        const best = Math.min(bench.raw.ms, bench.jpeg.ms);
        step('ffmpeg 解码比 <video> seek 快（取最优传输）', best < bench.seek,
          `seek ${per(bench.seek)}ms/帧 → raw ${per(bench.raw.ms)}ms · jpeg ${per(bench.jpeg.ms)}ms`);
        out.compare = {
          seek: per(bench.seek), raw: per(bench.raw.ms), jpeg: per(bench.jpeg.ms),
          jpegBytes: bench.jpeg.bytesPerFrame, rawBytes: bench.raw.bytesPerFrame,
        };
      } else {
        step('取帧对比可用', false, (bench && bench.error) || '没有结果');
      }

      // 4.3 整条链路：ffmpeg 解码 + ffmpeg 编码（真导出一次，验证 render() 里的接线）
      const integOut = path.join(smokeDir, 'decode-encode.mp4');
      const integ = await exec(`(async () => {
        const v = document.querySelector('#videoEl');
        v.src = 'app://lm/.smoke/src.mp4';
        await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 8000); });
        v.pause();
        const t0 = performance.now();
        const out = await Render.render({
          video: v, aspect: '16:9',
          camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
          bg: 'paper', color: 'sand', model: 'browser',
          duration: 0.5, fps: 30,
          decode: { path: ${JSON.stringify(srcFile)}, source: { width: 1920, height: 1080 }, transport: 'jpeg', quality: 2 },
          native: { outPath: ${JSON.stringify(integOut)}, crf: 20 },
        });
        return { out, ms: Math.round(performance.now() - t0), decoder: Render.decoder, sink: Render.lastSink, stats: Render.stats };
      })()`);

      const integOk = integ && integ.out && integ.out.size > 5000 && integ.decoder === 'ffmpeg';
      step('ffmpeg 解码 + 编码整条链路', integOk,
        `${integ && integ.decoder} + ${integ && integ.sink} · ${integ && (integ.out && integ.out.frames)} 帧 · ${integ && integ.ms}ms`);
      if (integOk) out.pipeline = { decode: integ.decoder, sink: integ.sink, ms: integ.ms };

    }
  } catch (err) {
    out.ok = false;
    out.errors.push(String((err && err.message) || err));
  }
  process.stdout.write('SMOKE_RESULT ' + JSON.stringify(out) + '\n');
  return out;
}

/* ───────────── 生命周期 ───────────── */

const REG_PROBE = process.argv.includes('--reg-probe');

const STAGE = process.argv.includes('--smoke-main')
  ? 'main'
  : process.argv.includes('--smoke-win') ? 'win' : 'full';

app.whenReady().then(async () => {
  if (REG_PROBE) {
    const { execFile } = require('node:child_process');
    const REG = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
    const run = (args) => new Promise((r) => {
      execFile(REG, args, { windowsHide: true }, (err, stdout, stderr) => {
        r({ err: err ? { message: err.message, code: err.code, killed: err.killed, signal: err.signal } : null, stdout, stderr });
      });
    });
    console.log('PROBE env PATH=' + String(process.env.PATH).slice(0, 120));
    console.log('PROBE cwd=' + process.cwd());
    console.log('PROBE query=' + JSON.stringify(await run(['query', KEY])).slice(0, 200));
    // A) 简单值名
    console.log('PROBE add-simple=' + JSON.stringify(await run(['add', KEY, '/v', 'lmtest', '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'])));
    console.log('PROBE del-simple=' + JSON.stringify(await run(['delete', KEY, '/v', 'lmtest', '/f'])));
    // B) .reg 导入（值名带反斜杠）
    const fsp2 = require('node:fs/promises');
    const regWrite = path.join(require('node:os').tmpdir(), 'lm-set.reg');
    const regDel = path.join(require('node:os').tmpdir(), 'lm-del.reg');
    await fsp2.writeFile(regWrite, 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences]\r\n"C:\\\\Windows\\\\System32\\\\notepad.exe"="GpuPreference=2;"\r\n', 'utf16le');
    await fsp2.writeFile(regDel, 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences]\r\n"C:\\\\Windows\\\\System32\\\\notepad.exe"=-\r\n', 'utf16le');
    console.log('PROBE import-set=' + JSON.stringify(await run(['import', regWrite])));
    console.log('PROBE after-set=' + JSON.stringify(await run(['query', KEY, '/v', 'C:\\Windows\\System32\\notepad.exe'])).slice(0, 160));
    console.log('PROBE import-del=' + JSON.stringify(await run(['import', regDel])));
    console.log('PROBE after-del=' + JSON.stringify(await run(['query', KEY, '/v', 'C:\\Windows\\System32\\notepad.exe'])).slice(0, 160));
    console.log('PROBE add=' + JSON.stringify(await run(['add', KEY, '/v', 'C:\\Windows\\System32\\notepad.exe', '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'])));
    console.log('PROBE del=' + JSON.stringify(await run(['delete', KEY, '/v', 'C:\\Windows\\System32\\notepad.exe', '/f'])));
    app.exit(0);
    return;
  }

  if (STAGE === 'main') {
    console.log('MAIN_OK version=' + process.versions.electron + ' platform=' + process.platform);
    const ff = await findFfmpeg();
    console.log('MAIN_FFMPEG ' + (ff ? ff.version : '缺失'));
    app.exit(0);
    return;
  }

  protocol.handle('app', serveStatic);
  registerIpc();

  if (STAGE === 'win') {
    const w = await createWindow();
    const title = await w.webContents.executeJavaScript('document.title');
    const hasLM = await w.webContents.executeJavaScript('typeof window.LM');
    console.log('WIN_OK title=' + title + ' LM=' + hasLM);
    app.exit(0);
    return;
  }

  await createWindow();

  if (SMOKE) {
    const res = await runSmoke();
    setTimeout(() => app.exit(res.ok ? 0 : 1), 200);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

