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

const PUBLIC = path.join(__dirname, '..', 'public');
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
  try {
    const buf = await fsp.readFile(target);
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': String(buf.length),
      },
    });
  } catch (_) {
    return new Response('not found', { status: 404 });
  }
}

/* ───────────── ffmpeg ───────────── */

let ffmpegPath = '';

async function findFfmpeg() {
  const candidates = [
    process.env.LM_FFMPEG,
    path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
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
  // 冒烟测试里没有人工点「保存」：用环境变量直接给目标路径
  const smokeOut = process.env.LM_SMOKE_OUT;
  let outPath;
  if (smokeOut) {
    await fsp.mkdir(path.dirname(smokeOut), { recursive: true });
    outPath = smokeOut;
  } else {
    const picked = await dialog.showSaveDialog({
      title: '导出视频',
      defaultPath: defaultName,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    outPath = picked.filePath.endsWith('.mp4') ? picked.filePath : picked.filePath + '.mp4';
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
      await exited;
      const st = await fsp.stat(outPath).catch(() => null);
      return { path: outPath, size: st ? st.size : 0, frames: this.frames };
    },
    abort() {
      try { this.proc.stdin.end(); } catch (_) {}
      try { this.proc.kill('SIGKILL'); } catch (_) {}
    },
  };
  return { canceled: false, path: outPath, ffmpeg: info.version };
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
  try {
    await win.webContents.executeJavaScript('1');
    // 页面基本可用
    const basic = await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      hasApp: typeof window.App === 'object',
      hasRender: typeof window.Render === 'object',
      hasMove: typeof window.MoveTrack === 'object',
      hasLM: typeof window.LM === 'object',
      platform: window.LM && window.LM.platform,
      url: location.href,
      styleOk: !!getComputedStyle(document.body).backgroundColor,
      gpuBadge: (document.querySelector('#gpuBtn') || {}).textContent,
    }))()`);
    step('页面加载', basic.hasApp && basic.hasRender && basic.hasMove, JSON.stringify(basic));
    step('原生桥接可见', basic.hasLM === true && basic.platform === process.platform, `LM.platform=${basic.platform}`);
    step('样式生效', basic.styleOk === true);

    const info = await win.webContents.executeJavaScript('window.LM.info()');
    step('原生信息', !!info && !!info.electron, `electron ${info && info.electron} · chrome ${info && info.chrome} · ffmpeg ${info && info.ffmpeg && info.ffmpeg.version}`);

    if (SMOKE_ENCODE) {
      // 造一段视频 → 用原生编码导 0.6 秒 → 校验文件
      const enc = await win.webContents.executeJavaScript(`(async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 360;
        const g = c.getContext('2d');
        const t0 = performance.now();
        let step = -1;
        const paint = () => {
          const s = Math.floor((performance.now() - t0) / 100);
          if (s === step) return;
          step = s;
          g.fillStyle = '#101820'; g.fillRect(0, 0, 640, 360);
          g.fillStyle = '#e11'; g.fillRect((s * 37) % 500, 60, 120, 120);
          g.fillStyle = '#fff'; g.font = '700 48px system-ui'; g.fillText(String(s), 40, 320);
        };
        paint();
        const stream = c.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.start(100);
        await new Promise((r) => { const t = () => { paint(); if (performance.now() - t0 < 1500) requestAnimationFrame(t); else r(); }; t(); });
        rec.stop();
        const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
        stream.getTracks().forEach((t) => t.stop());
        window.__u = URL.createObjectURL(blob);
        await App.loadVideoSrc(window.__u);
        return { ok: !!document.querySelector('#videoEl').videoWidth };
      })()`);
      step('准备测试视频', enc && enc.ok);

      const result = await win.webContents.executeJavaScript(`(async () => {
        const t0 = performance.now();
        const out = await Render.render({
          video: document.querySelector('#videoEl'),
          aspect: '16:9',
          camera: [{ t: 0, x: 0, y: 0, z: 0, rx: 2, ry: -12, rz: 0, scale: 1 }],
          bg: 'paper', color: 'sand', model: 'browser',
          duration: 0.6, fps: 30,
          native: { crf: 18, defaultName: 'smoke.mp4' },
        });
        return { out, ms: Math.round(performance.now() - t0), kind: Render.lastSink };
      })()`);
      const ok = result && result.out && result.out.native === true && result.out.size > 2000;
      step('原生编码产出 MP4', ok, JSON.stringify(result && result.out).slice(0, 220) + ` · ${result && result.ms}ms`);
      if (ok) {
        out.mp4 = result.out.path;
        out.encodeMs = result.ms;
      }
    }
  } catch (err) {
    out.ok = false;
    out.errors.push(String((err && err.message) || err));
  }
  process.stdout.write('SMOKE_RESULT ' + JSON.stringify(out) + '\n');
  return out;
}

/* ───────────── 生命周期 ───────────── */

const STAGE = process.argv.includes('--smoke-main')
  ? 'main'
  : process.argv.includes('--smoke-win') ? 'win' : 'full';

app.whenReady().then(async () => {
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

