/**
 * LiveMockup · 输入 / 滚动录制回放测试
 * 验证「打字」和「滚动」也能变成关键帧，并且回放时能真的把网页状态还原出来。
 */
import { launch, sleep } from './cdp.mjs';

const browser = await launch({ port: 9361, width: 1600, height: 1000 });
const { evaluate } = browser;
const problems = [];
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) problems.push(msg); };
const log = (...a) => console.log('·', ...a);

const inFrame = (js) => `(() => { const f = document.querySelector('#frame'); const d = f.contentDocument; ${js} })()`;

try {
  await browser.goto('http://localhost:4321/', 3400);
  await evaluate(`document.querySelector('#recordBtn').click()`);
  await sleep(2200);

  // ── 滚动（先滚，之后打字会把列表筛短就没得滚了）──────
  const readY = `(() => { const d = document.querySelector('#frame').contentDocument;
    return Math.round((d.querySelector('#main') || d.scrollingElement).scrollTop); })()`;
  const c0 = await evaluate(readY);
  const fb = await browser.frameBox();
  const cx = fb.left + fb.w / 2;
  const cy = fb.top + fb.h * 0.62;
  await browser.wheel(cx, cy, 420);
  await sleep(500);
  await browser.wheel(cx, cy, 300);
  await sleep(900);
  const c1 = await evaluate(readY);
  log(`滚动 ${c0} → ${c1}`);
  ok(c1 > c0, '滚动生效');

  // ── 打字 ──────────────────────────────────────────
  const box = await evaluate(`(() => {
    const f = document.querySelector('#frame');
    const el = f.contentDocument.querySelector('[data-testid="search"]');
    if (!el) return null;
    const b = el.getBoundingClientRect(), r = f.getBoundingClientRect();
    return { x: r.left + (b.left + b.width / 2) * (r.width / f.clientWidth),
             y: r.top + (b.top + b.height / 2) * (r.height / f.clientHeight) };
  })()`);
  if (!box) throw new Error('找不到搜索框');
  await browser.mouse(box.x, box.y);
  await sleep(500);
  await browser.type('冷萃');
  await sleep(1100);
  const typed = await evaluate(inFrame(`return d.querySelector('[data-testid="search"]').value;`));
  log('搜索框内容:', JSON.stringify(typed));
  ok(typed === '冷萃', '打字进入输入框');

  // ── 停止录制，看动作 ──────────────────────────────
  await evaluate(`document.querySelector('#recordBtn').click()`);
  await sleep(1400);
  const acts = await evaluate(`(() => {
    const raw = localStorage.getItem('livemockup:project:v1');
    if (!raw) return [];
    try { return JSON.parse(raw).actions || []; } catch { return []; }
  })()`);
  const summary = await evaluate(`document.querySelector('#tlCount').textContent`);
  log('动作统计:', summary);
  log('动作明细:', JSON.stringify(acts.map((a) => ({ t: +a.t.toFixed(2), type: a.type, label: a.label, value: a.value }))));
  ok(acts.some((a) => a.type === 'type'), '记录了 type 动作');
  ok(acts.some((a) => a.type === 'scroll'), '记录了 scroll 动作');
  await browser.shot('11-typed');

  // ── 回放：先跳回 0 让它重建页面，再播 ─────────────
  await evaluate(`document.querySelector('#playBtn').click()`);
  // 边播边采样，确认「滚动」这一帧真的被执行过（录制的最后一条又滚回了 0，
  // 只看终态是看不出来的）
  let maxY = 0;
  let sawType = false;
  for (let i = 0; i < 60; i++) {
    const s = await evaluate(inFrame(`return {
      y: Math.round((d.querySelector('#main') || d.scrollingElement).scrollTop),
      v: d.querySelector('[data-testid="search"]').value,
      playing: document.querySelector('#playBtn').textContent.includes('❚❚'),
    };`));
    maxY = Math.max(maxY, s.y);
    if (s.v === '冷萃') sawType = true;
    if (!s.playing && i > 6) break;
    await sleep(220);
  }
  log(`回放中最大滚动量: ${maxY}px`);
  ok(maxY >= 300, `回放执行了滚动动作（峰值 ${maxY}px）`);
  ok(sawType, '回放过程中搜索框被重新打字');

  const after = await evaluate(inFrame(`return {
    v: d.querySelector('[data-testid="search"]').value,
    y: Math.round((d.querySelector('#main') || d.scrollingElement).scrollTop),
  };`));
  log('回放结束状态:', JSON.stringify(after));
  ok(after.v === '冷萃', '回放后搜索框仍是「冷萃」');
  ok(after.y === 0, `回放后滚动位置与录制结束时一致 (${after.y})`);
  await browser.shot('13-typed-done');
} finally {
  const errs = browser.problems.filter((p) => !/favicon/.test(p));
  if (errs.length) { console.log('控制台问题:'); errs.forEach((p) => console.log('  ' + p)); }
  await browser.close();
  console.log('\n═══ 结果 ═══');
  if (problems.length) { console.log('✗ 失败:'); problems.forEach((p) => console.log('  ' + p)); process.exitCode = 1; }
  else console.log('✓ 输入 / 滚动链路通过');
}
