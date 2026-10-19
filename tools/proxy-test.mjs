/**
 * LiveMockup · 反代 + 注入测试
 * 用一个真实外部站点验证：/p/ 反代能载入第三方页面，运行时脚本注入成功，录制可用。
 */
import { launch, sleep } from './cdp.mjs';

const TARGET = process.argv[2] || 'https://example.com';
const browser = await launch({ port: 9351, width: 1600, height: 1000 });
const log = (...a) => console.log('·', ...a);

try {
  const { evaluate } = browser;
  await browser.goto('http://localhost:4321/', 3200);

  const src = await evaluate(`(async () => {
    const input = document.querySelector('#urlInput');
    input.value = ${JSON.stringify(TARGET)};
    document.querySelector('#loadBtn').click();
    return 1;
  })()`);
  log('已请求载入', TARGET);
  await sleep(6000);

  const info = await evaluate(`(() => {
    const f = document.querySelector('#frame');
    return {
      src: f.getAttribute('src'),
      ready: !!f.contentDocument,
      injected: !!f.contentDocument?.querySelector('script[data-livemockup-runtime]'),
      title: f.contentDocument?.title || '',
      text: (f.contentDocument?.body?.innerText || '').slice(0, 60),
      info: document.querySelector('#frameInfo')?.textContent || '',
    };
  })()`);
  log('结果:', JSON.stringify(info));

  const okProxy = /^\/p\//.test(info.src || '');
  const okInject = info.injected === true;
  const okText = (info.text || '').length > 0;
  console.log(`${okProxy ? '✓' : '✗'} 走反代 (/p/)`);
  console.log(`${okInject ? '✓' : '✗'} 运行时已注入`);
  console.log(`${okText ? '✓' : '✗'} 第三方页面有内容: ${JSON.stringify(info.text)}`);
  await browser.shot('09-proxy');

  // 录制一次真实点击，确认第三方页面的操作也能进时间轴
  await evaluate(`document.querySelector('#recordBtn').click()`);
  await sleep(2600);
  const p = await evaluate(`(() => { const f = document.querySelector('#frame');
    const a = f.contentDocument.querySelector('a, button, h1, h2, p');
    if (!a) return null;
    const b = a.getBoundingClientRect(); const r = f.getBoundingClientRect();
    return { x: r.left + (b.left + b.width / 2) * (r.width / f.clientWidth),
             y: r.top + (b.top + b.height / 2) * (r.height / f.clientHeight) }; })()`);
  if (p) { await browser.mouse(p.x, p.y); await sleep(400); }
  await evaluate(`document.querySelector('#recordBtn').click()`);
  await sleep(500);
  const count = await evaluate(`document.querySelector('#tlCount').textContent`);
  log('第三方页录制结果:', count);
  console.log(`${/0 个动作/.test(count) ? '·' : '✓'} 第三方页动作进时间轴`);
  await browser.shot('10-proxy-recorded');

  if (browser.problems.length) {
    console.log('控制台问题:');
    browser.problems.forEach((p2) => console.log('  ' + p2));
  }
} finally {
  await browser.close();
}
