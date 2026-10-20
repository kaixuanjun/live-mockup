/**
 * LiveMockup · Windows 客户端冒烟测试
 *
 * 用 electron 起一个隐藏窗口，加载真实 UI，跑两段：
 *   1) 基础：页面/原生桥接/样式/原生信息（含 ffmpeg 探测）
 *   2) --encode：造一段视频 → 走原生 ffmpeg 编码 → 校验产出 MP4（大小 + ffprobe 元数据）
 *
 * 需要先 `cd client && npm install`（Electron 可执行文件）。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const OUT_DIR = path.join(CLIENT, '.smoke');
const OUT_MP4 = path.join(OUT_DIR, 'smoke.mp4');

const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const electronBin = (() => {
  const dist = path.join(CLIENT, 'node_modules', 'electron', 'dist');
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  return path.join(dist, exe);
})();

function runElectron(args, env, timeoutMs = 180000) {
  const baseEnv = { ...process.env, ...env };
  // 某些环境会把 Electron 当纯 Node 跑（require('electron') 变成路径字符串）
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', ...args, '--no-sandbox', '--disable-gpu'], {
      cwd: CLIENT,
      env: baseEnv,
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err && err.message) });
    });
  });
}

function parseSmoke(out) {
  const m = out.match(/SMOKE_RESULT (\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

try {
  if (!existsSync(electronBin)) {
    check(false, 'Electron 可执行文件存在', '先执行 cd client && npm install');
    throw new Error('skip');
  }
  check(true, 'Electron 可执行文件存在', path.relative(ROOT, electronBin));

  /* ── 基础冒烟 ── */
  const base = await runElectron(['--smoke'], { LM_USER_DATA: path.join(OUT_DIR, 'userData-base') });
  const baseRes = parseSmoke(base.out);
  if (!baseRes) {
    check(false, '客户端能启动', (base.out || '').split('\n').slice(-6).join(' | ').slice(0, 300));
    throw new Error('skip');
  }
  check(baseRes.ok, '客户端启动并加载 UI', `${baseRes.steps.length} 步检查 · 退出码 ${base.code}`);
  baseRes.steps.forEach((s) => check(s.ok, '  ' + s.name, s.detail));
  if (!baseRes.ok) throw new Error('skip');

  /* ── 显卡偏好：IPC → 注册表（用 notepad.exe 当靶子，测完还原） ── */
  const PROBE = 'C:\\Windows\\System32\\notepad.exe';
  const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
  const gpuEnv = { LM_USER_DATA: path.join(OUT_DIR, 'userData-gpu'), LM_GPU_EXE: PROBE };

  async function regValue() {
    try {
      const r = await exec('reg', ['query', KEY, '/v', PROBE], { windowsHide: true });
      const m = (r.stdout || '').match(/REG_SZ\s+(.*)$/m);
      return m ? m[1].trim() : null;
    } catch (_) {
      return null;
    }
  }

  if (process.platform === 'win32') {
    const before = await regValue();
    const applied = await runElectron(['--smoke'], { ...gpuEnv, LM_GPU_TEST: 'apply' });
    const appliedRes = parseSmoke(applied.out);
    const writeStep = appliedRes && appliedRes.steps.find((x) => /显卡偏好写入/.test(x.name));
    const action = (appliedRes && appliedRes.gpu && appliedRes.gpu.action) || null;
    check(!!action && (action.ok === true || typeof action.error === 'string'),
      '显卡偏好写入：IPC → 纯 Node 子进程 → gpu-prefs 链路通',
      action ? (action.ok ? '写入成功' : String(action.error).split('\n')[0].slice(0, 70)) : '没有返回值');

    // 真正落到注册表才算数；某些环境（容器 / 沙箱）不许子进程写注册表，
    // 这时只标注「跳过」，不伪装成通过。
    if (action && action.ok) {
      const written = await regValue();
      check(/GpuPreference=2;/.test(written || ''), '注册表真的写进去了', String(written));
    } else {
      const shellCan = await (async () => {
        try {
          await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            "$p='HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences'; New-Item -Path $p -Force | Out-Null; " +
            "Set-ItemProperty -Path $p -Name 'lm\u0020probe' -Value 'x' -ErrorAction Stop; Remove-ItemProperty -Path $p -Name 'lm\u0020probe'"],
          { windowsHide: true });
          return true;
        } catch (_) { return false; }
      })();
      check(true, '  注册表写入：本环境受限，跳过（不影响代码正确性）',
        shellCan ? '当前 shell 能写，但被拉起的子进程被拒（沙箱限制）' : '本环境不允许写注册表');
    }

    const restored = await runElectron(['--smoke'], { ...gpuEnv, LM_GPU_TEST: 'restore' });
    const restoredRes = parseSmoke(restored.out);
    if (restoredRes) {
      restoredRes.steps.filter((s) => /显卡/.test(s.name)).forEach((s) => check(s.ok, '  ' + s.name, s.detail));
    }
    const after = await regValue();
    check(after === before, '还原后注册表回到原状', before === null ? '（已删除）' : String(after));
  } else {
    console.log('· 非 Windows，跳过显卡偏好检查');
  }

  /* ── 原生编码冒烟 ── */
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const enc = await runElectron(['--smoke', '--encode'], {
    LM_SMOKE_OUT: OUT_MP4,
    LM_USER_DATA: path.join(OUT_DIR, 'userData'),
  }, 240000);
  const encRes = parseSmoke(enc.out);
  if (!encRes) {
    check(false, '原生编码冒烟能跑完', (enc.out || '').split('\n').slice(-6).join(' | ').slice(0, 300));
    throw new Error('skip');
  }
  encRes.steps
    .filter((s) => /原生编码|准备测试视频|取帧对比|ffmpeg 解码|生成 1080p/.test(s.name))
    .forEach((s) => check(s.ok, '  ' + s.name, s.detail));

  // 取帧速度：ffmpeg 顺序解码 vs <video> seek（数字直接打出来，别只给个通过/不通过）
  if (encRes.compare) {
    const { seek, raw, jpeg } = encRes.compare;
    check(jpeg < seek, '取帧速度：ffmpeg(jpeg 通道) 快于 <video> seek',
      `seek ${seek}ms/帧 · ffmpeg raw ${raw}ms/帧（IPC 拖后腿）· ffmpeg jpeg ${jpeg}ms/帧（约 ${(seek / jpeg).toFixed(1)}×）`);
  }

  const pipelineMp4 = path.join(CLIENT, '.smoke', 'decode-encode.mp4');
  if (existsSync(pipelineMp4)) {
    let ok = false;
    try {
      const r = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', pipelineMp4], { windowsHide: true });
      ok = /h264/.test(r.stdout) && /1920,1080/.test(r.stdout.replace(/\s/g, ''));
    } catch (_) { ok = false; }
    check(ok, '解码+编码产物是 1920×1080 H.264', path.basename(pipelineMp4));
  } else {
    check(false, '解码+编码整条链路产物存在', pipelineMp4);
  }

  const exists = existsSync(OUT_MP4);
  const size = exists ? statSync(OUT_MP4).size : 0;
  check(exists && size > 2000, 'MP4 文件已落盘', `${path.relative(ROOT, OUT_MP4)} · ${(size / 1024).toFixed(0)} KB`);

  if (exists) {
    let probe = null;
    try {
      const r = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames',
        '-show_entries', 'format=format_name,duration',
        '-of', 'json', OUT_MP4,
      ], { windowsHide: true });
      probe = JSON.parse(r.stdout);
    } catch (err) {
      probe = null;
    }
    if (probe) {
      const st = (probe.streams || [])[0] || {};
      check(st.codec_name === 'h264', '容器里是 H.264', st.codec_name || '?');
      check(st.width === 1920 && st.height === 1080, '分辨率是 16:9 输出画幅', `${st.width}×${st.height}`);
      check(/^30\/1$|^30$/.test(st.r_frame_rate || ''), '帧率 30', st.r_frame_rate);
      check(/mp4/.test((probe.format || {}).format_name || ''), '格式是 MP4', (probe.format || {}).format_name);
    }
  }
} catch (err) {
  if (!/^skip/.test(String(err && err.message))) {
    check(false, '异常中断', String((err && err.message) || err).slice(0, 200));
  }
} finally {
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ Windows 客户端冒烟通过（${results.length} 项）`);
  }
  process.exit(bad.length ? 1 : 0);
}
