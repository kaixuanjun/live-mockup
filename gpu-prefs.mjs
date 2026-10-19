/**
 * LiveMockup · Windows「每应用显卡偏好」
 *
 * 网页自己能做的只有 `powerPreference: 'high-performance'`（请求，不是命令）。
 * 真正决定用哪块卡的是系统和浏览器 —— Windows 上那个开关就是
 *   HKCU\Software\Microsoft\DirectX\UserGpuPreferences
 *    值名 = 可执行文件完整路径（UWP 用 AUMID）
 *    值   = "GpuPreference=2;"（0=让 Windows 决定 / 1=省电 / 2=高性能）
 * 它只影响当前用户、不需要管理员；同一个值里可能还有别的开关
 * （AutoHDREnable、SwapEffectUpgradeEnable…），所以改写时必须保留。
 * 浏览器要**完全退出重开**，GPU 进程才会按新的偏好重建。
 *
 * 只做这一件事，不做任何其他系统改动。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
export const LEVEL = Object.freeze({ auto: 0, powerSave: 1, highPerf: 2 });

export function isWindows() {
  return process.platform === 'win32';
}

/* ───────────── 找浏览器 ───────────── */

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || '';

function browserCandidates() {
  const make = (names) => names.filter(Boolean);
  return {
    edge: make([
      path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]),
    chrome: make([
      path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      LAD && path.join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]),
    brave: make([
      path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      LAD && path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]),
    vivaldi: make([
      LAD && path.join(LAD, 'Vivaldi', 'Application', 'vivaldi.exe'),
      path.join(PF, 'Vivaldi', 'Application', 'vivaldi.exe'),
    ]),
    opera: make([
      LAD && path.join(LAD, 'Programs', 'Opera', 'opera.exe'),
      path.join(PF, 'Opera', 'opera.exe'),
    ]),
    firefox: make([
      path.join(PF, 'Mozilla Firefox', 'firefox.exe'),
      PF86 && path.join(PF86, 'Mozilla Firefox', 'firefox.exe'),
    ]),
  };
}

/** 从 User-Agent 判断是哪个浏览器（顺序有讲究：Chromium 系都带 Chrome 字样） */
export function familyFromUA(ua = '') {
  const s = String(ua);
  if (/Edg\//.test(s)) return 'edge';
  if (/OPR\/|Opera/.test(s)) return 'opera';
  if (/Brave/.test(s)) return 'brave';
  if (/Vivaldi/.test(s)) return 'vivaldi';
  if (/Firefox\//.test(s)) return 'firefox';
  if (/Chrome\//.test(s)) return 'chrome';
  if (/Safari\//.test(s)) return 'safari';
  return 'unknown';
}

async function exists(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch (_) {
    return false;
  }
}

/** 探测本机装了哪些浏览器，并标出 UA 对应的那个 */
export async function detectBrowsers(ua) {
  const family = familyFromUA(ua);
  const all = browserCandidates();
  const out = [];
  for (const [name, list] of Object.entries(all)) {
    for (const exe of list) {
      if (await exists(exe)) {
        out.push({ name, exe, matchesUA: name === family });
      }
    }
  }
  return { family, browsers: out };
}

/* ───────────── 读写注册表 ───────────── */

/** reg query 解析成 { 路径: 数据 }；键不存在时返回 {} */
export async function readPrefs() {
  if (!isWindows()) return {};
  let stdout = '';
  try {
    const r = await exec('reg', ['query', KEY], { windowsHide: true });
    stdout = r.stdout || '';
  } catch (_) {
    return {};
  }
  const map = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s{4}(.+?)\s+REG_SZ\s+(.*)$/);
    if (!m) continue;
    map[m[1].trim()] = m[2].trim();
  }
  return map;
}

/** 在已有数据里只换 GpuPreference，其它开关原样保留 */
export function withLevel(data, level) {
  const n = Math.max(0, Math.min(2, Number(level) || 0));
  const src = String(data || '').trim();
  const token = `GpuPreference=${n};`;
  if (!src) return token;
  if (/GpuPreference=\d+;?/.test(src)) {
    return src.replace(/GpuPreference=\d+;?/, token);
  }
  return src.endsWith(';') ? src + token : src + ';' + token;
}

/** 只允许「绝对路径的 .exe」或「包名!AppId」，挡住注入和误写 */
export function validTarget(exe) {
  const s = String(exe || '').trim();
  if (!s || s.length > 260) return false;
  if (/["\r\n\0]/.test(s)) return false;
  if (/^[A-Za-z0-9._-]+_[a-z0-9]+![A-Za-z0-9._-]+$/.test(s)) return true; // UWP AUMID
  if (!/^[A-Za-z]:\\/.test(s)) return false;
  return /\.exe$/i.test(s);
}

/**
 * 把某个可执行文件设成指定档位。
 * @returns {{exe:string, before:string, after:string, changed:boolean}}
 */
export async function setLevel(exe, level) {
  if (!isWindows()) throw new Error('只支持 Windows');
  if (!validTarget(exe)) throw new Error('目标不可写：必须是可执行文件的绝对路径');
  const prefs = await readPrefs();
  const before = prefs[exe] || '';
  const after = withLevel(before, level);
  if (before === after) return { exe, before, after, changed: false };
  await exec('reg', ['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', after, '/f'], { windowsHide: true });
  const check = await readPrefs();
  if ((check[exe] || '') !== after) throw new Error('写入后读回不一致，可能被策略拦截');
  return { exe, before, after, changed: true };
}

/** 删掉某个可执行文件的偏好（回到「让 Windows 决定」） */
export async function clearLevel(exe) {
  if (!isWindows()) throw new Error('只支持 Windows');
  if (!validTarget(exe)) throw new Error('目标不可写');
  const prefs = await readPrefs();
  if (!(exe in prefs)) return { exe, removed: false };
  await exec('reg', ['delete', KEY, '/v', exe, '/f'], { windowsHide: true });
  const check = await readPrefs();
  return { exe, removed: !(exe in check) };
}

/** 汇总：探测结果 + 每个浏览器的当前偏好 */
export async function snapshot(ua) {
  const detected = await detectBrowsers(ua);
  const prefs = await readPrefs();
  const browsers = detected.browsers.map((b) => {
    const data = prefs[b.exe] || '';
    const m = data.match(/GpuPreference=(\d)/);
    return { ...b, pref: m ? Number(m[1]) : null, data };
  });
  return { platform: process.platform, family: detected.family, browsers };
}
