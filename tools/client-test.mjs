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
  encRes.steps.filter((s) => /原生编码|准备测试视频/.test(s.name)).forEach((s) => check(s.ok, '  ' + s.name, s.detail));

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
