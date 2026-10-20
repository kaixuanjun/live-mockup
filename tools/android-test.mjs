/**
 * LiveMockup · Android 客户端检查
 *
 * 不启动模拟器，只验证「装到手机上能跑」必须成立的东西：
 *   1. APK 存在且体积合理
 *   2. 包名 / 标签 / minSdk 正确（aapt2 dump badging）
 *   3. web 资源真的被打进原生工程（capacitor sync 的结果）
 *   4. UI 入口和客户端能力标记在源码里都在
 *
 * 没构建过就跳过（不算失败）—— 先跑 scripts\android-build.ps1。
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ANDROID = path.join(ROOT, 'client-android', 'android');
const APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const SDK = process.env.ANDROID_HOME || 'C:\\android-sdk';
const AAPT = path.join(SDK, 'build-tools', '34.0.0', 'aapt2.exe');
const SYNCED = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'public', 'index.html');

const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '') + (stderr || '') });
    });
  });
}

try {
  if (!existsSync(APK)) {
    console.log('· 还没构建过 APK，跳过（先跑 scripts\\android-build.ps1）');
    console.log('✓ Android 检查跳过');
    process.exit(0);
  }

  const size = statSync(APK).size / 1024 / 1024;
  check(size > 1 && size < 200, 'APK 存在且体积合理', `${size.toFixed(2)} MB`);

  if (existsSync(AAPT)) {
    const { out } = await run(AAPT, ['dump', 'badging', APK]);
    const pkg = (out.match(/package: name='([^']+)'/) || [])[1] || '';
    const label = (out.match(/application-label:'([^']+)'/) || [])[1] || '';
    const minSdk = (out.match(/sdkVersion:'(\d+)'/) || [])[1] || '';
    const target = (out.match(/targetSdkVersion:'(\d+)'/) || [])[1] || '';
    check(pkg === 'com.livemockup.app', '包名正确', pkg);
    check(label === 'LiveMockup', '应用名正确', label);
    check(Number(minSdk) >= 22 && Number(target) >= 30, 'SDK 版本可装（≥ Android 5.1）', `min ${minSdk} / target ${target}`);
  } else {
    console.log('· 没找到 aapt2，跳过 badging 检查');
  }

  check(existsSync(SYNCED), 'web 资源已同步进原生工程', path.relative(ROOT, SYNCED));

  // 打包进 APK 的那份 exporter.js 必须带安卓保存分支，否则手机上导出会静默失败
  const syncedExporter = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'public', 'js', 'exporter.js');
  if (existsSync(syncedExporter)) {
    const src = readFileSync(syncedExporter, 'utf8');
    check(/Capacitor/.test(src) && /saveOnAndroid/.test(src),
      '打包进 APK 的 UI 带安卓保存分支（Capacitor Filesystem）');
  }
  if (existsSync(SYNCED)) {
    const html = readFileSync(SYNCED, 'utf8');
    check(/js\/app\.js/.test(html) && /js\/render\.js/.test(html), '入口页引用了编辑器脚本');
  }

  // 客户端能力标记：Capacitor 注入 window.Capacitor；页面里不硬依赖它
  const cfg = path.join(ROOT, 'client-android', 'capacitor.config.json');
  if (existsSync(cfg)) {
    const c = JSON.parse(readFileSync(cfg, 'utf8'));
    check(c.appId === 'com.livemockup.app', 'capacitor 配置的 appId 一致', c.appId);
    check(/public$/.test(String(c.webDir)), 'webDir 指向共用 UI 目录', c.webDir);
  }
} catch (err) {
  check(false, '异常中断', String((err && err.message) || err).slice(0, 160));
} finally {
  const bad = results.filter((r) => !r.ok);
  console.log('\n═══ 结果 ═══');
  if (bad.length) {
    console.log(`✗ ${bad.length}/${results.length} 项失败`);
    bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
  } else {
    console.log(`✓ Android 客户端检查通过（${results.length} 项）`);
  }
  process.exit(bad.length ? 1 : 0);
}
