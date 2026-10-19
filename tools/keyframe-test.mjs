/**
 * LiveMockup · 关键帧系统测试
 *
 * 覆盖：
 *  1. autoKey 只在播放头附近就地更新，离得远就插新帧（不悄悄改掉别的帧）
 *  2. 曲线编辑器拖手柄 → 自定义 cubic-bezier 真的改变插值结果
 *  3. 「保持到下一帧」（阶梯）→ 段内采样恒等于起始帧，且刷新后不丢
 *  4. 缓动预设 chips → 写回标准控制点
 *  5. Ctrl+D 复制帧 / Alt+方向键微调 / Shift 加选后删除
 *  6. 拖动关键帧吸附到 0.05s 网格
 *  7. 时间轴缩放（按钮 / 标签 / 窗口外标记不渲染）
 *  8. 框选多帧 + 拖其中一帧整批平移 + 整批删除
 */
import { launch, sleep } from './cdp.mjs';

const DUR = 6;
const results = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const b = await launch({ port: 9331 });

const proj = async () => {
  await sleep(780);
  return b.evaluate(`JSON.parse(localStorage.getItem('livemockup:project:v1'))`);
};
const midRy = async () =>
  b.evaluate(`(() => {
    const p = JSON.parse(localStorage.getItem('livemockup:project:v1'));
    const c = p.camera; const t = (c[1].t + c[2].t) / 2;
    return { ry: Stage.sample(c, t).ry, mid: t, from: c[1].ry };
  })()`);

try {
  await b.goto('http://localhost:4321/', 3000);
  await b.evaluate('localStorage.clear()');
  await b.goto('http://localhost:4321/', 4500);

  await b.evaluate(`(() => {
    const i = document.querySelector('#durationInput');
    i.value = '${DUR}';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);

  const lane = await b.evaluate(`(() => {
    const l = document.querySelector('#laneCamera'); const r = l.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width };
  })()`);
  const seekTo = async (t) => {
    await b.mouse(lane.left + (t / DUR) * lane.w, lane.top + 15);
    await sleep(280);
  };

  const stage = await b.rect('#stage');
  const camDrag = async (dx, dy) => {
    await b.drag(stage.x, stage.y, stage.x + dx, stage.y + dy);
    await sleep(200);
  };

  // ── 1. 开镜头模式，在 1.0s / 3.5s 各拖一次 ──
  await b.click('.camtoggle');
  await sleep(320);
  await seekTo(1.0);
  await camDrag(-80, -34);
  await seekTo(3.5);
  await camDrag(64, 42);
  await sleep(320);

  let p = await proj();
  ok('拖动后自动插帧（0 + 1.0 + 3.5）', p.camera.length === 3,
    `${p.camera.length} 帧 @ ${p.camera.map((k) => k.t.toFixed(2)).join(', ')}`);
  ok('首帧（t=0）没有被拖动悄悄改掉',
    Math.abs(p.camera[0].ry + 12) < 0.01 && Math.abs(p.camera[0].rx - 2) < 0.01,
    `ry=${p.camera[0].ry} rx=${p.camera[0].rx}`);

  // ── 2. 检视器：曲线编辑器 / 预设 / 关键帧列表 ──
  await b.click('.key[data-index="1"]');
  await sleep(360);
  const ui = await b.evaluate(`(() => ({
    curve: !!document.querySelector('.curve'),
    handles: document.querySelectorAll('.curve__handle').length,
    chips: document.querySelectorAll('.chip').length,
    rows: document.querySelectorAll('.krow').length,
    readout: document.querySelector('.curve__readout')?.textContent || '',
  }))()`);
  ok('检视器出现曲线编辑器', ui.curve && ui.handles === 2, `${ui.handles} 个手柄`);
  ok('缓动预设 7 个 chip', ui.chips === 7, `${ui.chips} 个`);
  ok('关键帧列表列出全部帧', ui.rows === 3, `${ui.rows} 行`);
  ok('曲线参数显示为 cubic-bezier', /cubic-bezier/.test(ui.readout), ui.readout.trim());

  // ── 3. 拖手柄 → 自定义曲线改变插值 ──
  const before = await midRy();
  const h1 = await b.rect('.curve__handle.h1');
  await b.drag(h1.x, h1.y, h1.x + 40, h1.y - 46);
  await sleep(520);
  p = await proj();
  const after = await midRy();
  ok('拖手柄写入了自定义贝塞尔',
    Array.isArray(p.camera[1].bezier) && p.camera[1].bezier.length === 4,
    JSON.stringify(p.camera[1].bezier?.map((n) => +n.toFixed(2))));
  ok('曲线改变后中点采样变了', Math.abs(after.ry - before.ry) > 2,
    `${before.ry.toFixed(2)}° → ${after.ry.toFixed(2)}° @ ${after.mid.toFixed(2)}s`);

  // ── 4. 保持（阶梯）──
  await b.click('.insp-check input');
  await sleep(460);
  p = await proj();
  const step = await midRy();
  ok('勾选「保持」写进关键帧', p.camera[1].hold === true);
  ok('阶梯段内采样恒等于起始帧', Math.abs(step.ry - p.camera[1].ry) < 1e-9,
    `段内 ${step.ry.toFixed(2)}° vs 起始 ${p.camera[1].ry.toFixed(2)}°`);

  // ── 4.5 刷新后自定义曲线 / 保持标记不丢 ──
  await b.evaluate('location.reload()');
  await sleep(4800);
  p = await proj();
  ok('刷新后自定义贝塞尔仍在',
    Array.isArray(p.camera[1].bezier) && p.camera[1].bezier.length === 4,
    JSON.stringify(p.camera[1].bezier?.map((n) => +n.toFixed(2))));
  ok('刷新后「保持」标记仍在', p.camera[1].hold === true, String(p.camera[1].hold));
  const stepAfter = await midRy();
  ok('刷新后阶梯仍然生效', Math.abs(stepAfter.ry - p.camera[1].ry) < 1e-9,
    `段内 ${stepAfter.ry.toFixed(2)}° vs 起始 ${p.camera[1].ry.toFixed(2)}°`);
  await b.click('.key[data-index="1"]');
  await sleep(340);

  // ── 5. 预设 chip 清掉自定义曲线与保持 ──
  await b.click('.chip[data-preset="snap"]');
  await sleep(460);
  p = await proj();
  ok('选预设后取消「保持」', p.camera[1].hold === false);
  ok('预设写回标准控制点',
    p.camera[1].bezier && Math.abs(p.camera[1].bezier[0] - 0.85) < 0.001
    && Math.abs(p.camera[1].bezier[3] - 1) < 0.001,
    JSON.stringify(p.camera[1].bezier));

  // ── 6. Ctrl+D 复制帧 ──
  await b.click('.key[data-index="1"]');
  await sleep(240);
  const t1 = (await proj()).camera[1].t;
  await b.hotkey('d', 'KeyD', 68, ['ctrl']);
  await sleep(460);
  p = await proj();
  ok('Ctrl+D 复制出一帧', p.camera.length === 4, `${p.camera.length} 帧`);
  ok('副本落在 +0.2s', p.camera.some((k) => Math.abs(k.t - (t1 + 0.2)) < 0.06),
    p.camera.map((k) => k.t.toFixed(2)).join(', '));

  // ── 7. Alt+方向键微调选中帧 ──
  await b.evaluate(`document.querySelectorAll('.key')[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await b.evaluate(`document.querySelectorAll('.key')[1].dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
  await sleep(280);
  p = await proj();
  const beforeNudge = p.camera[1].t;
  await b.hotkey('ArrowRight', 'ArrowRight', 39, ['alt']);
  await sleep(460);
  p = await proj();
  ok('Alt+→ 把选中帧右移 0.05s', Math.abs(p.camera[1].t - (beforeNudge + 0.05)) < 0.011,
    `${beforeNudge.toFixed(2)} → ${p.camera[1].t.toFixed(2)}`);

  // ── 8. 拖动吸附到 0.05s 网格 ──
  const k2 = await b.rect('.key[data-index="2"]');
  await b.drag(k2.x, k2.y, k2.x - 37, k2.y);
  await sleep(460);
  p = await proj();
  const t2 = p.camera[2].t;
  ok('拖动后吸附到 0.05s 网格', Math.abs(t2 / 0.05 - Math.round(t2 / 0.05)) < 1e-6, `t=${t2}`);

  // ── 9. Shift 加选 + 删除（用相隔很远的两帧，避免合成点击落到相邻标记上）──
  await b.click('.key[data-index="0"]');
  await sleep(240);
  const k3 = await b.rect('.key[data-index="2"]');
  await b.mouseShift(k3.x, k3.y);
  await sleep(300);
  const selCount = await b.evaluate(`document.querySelectorAll('.key.is-sel').length`);
  ok('Shift 点击可以加选', selCount === 2, `${selCount} 个选中`);
  const beforeDel = (await proj()).camera.length;
  await b.hotkey('Delete', 'Delete', 46);
  await sleep(480);
  p = await proj();
  ok('删除多选一次删掉两帧', p.camera.length === beforeDel - 2, `${beforeDel} → ${p.camera.length}`);

  // ── 10. 时间轴缩放 ──
  const v0 = await b.evaluate('Timeline.view()');
  await b.click('#zoomIn');
  await sleep(340);
  const v1 = await b.evaluate('Timeline.view()');
  ok('放大后 span 变窄、zoom 变大', v1.zoom > v0.zoom && v1.span < v0.span,
    `${v0.zoom}×/${v0.span.toFixed(2)}s → ${v1.zoom}×/${v1.span.toFixed(2)}s`);
  ok('缩放标签跟着更新',
    (await b.evaluate(`document.querySelector('#zoomFit').textContent`)) === '1.6×');
  await b.shot('14-timeline-zoom');
  console.log('· 截图 14-timeline-zoom');
  const visNow = await b.evaluate(`document.querySelectorAll('.key').length`);
  p = await proj();
  ok('窗口外的关键帧不再渲染', visNow <= p.camera.length, `${visNow} 个标记 / ${p.camera.length} 帧`);
  await b.click('#zoomFit');
  await sleep(340);
  const v2 = await b.evaluate('Timeline.view()');
  ok('点「全览」回到 1×', v2.zoom === 1 && v2.start === 0, JSON.stringify(v2));

  // ── 11. 框选（多帧场景：先补三帧，再框住左侧一部分）──
  for (const sec of [0.4, 0.8, 5.4]) {
    await seekTo(sec);
    await b.hotkey('k', 'KeyK', 75);
    await sleep(240);
  }
  p = await proj();
  const total = p.camera.length;
  ok('补帧后共 5 帧', total === 5, p.camera.map((k) => k.t.toFixed(2)).join(', '));
  const camLane = await b.evaluate(`(() => {
    const l = document.querySelector('#laneCamera'); const r = l.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  })()`);
  await b.drag(camLane.left + 2, camLane.top + 4,
    camLane.left + (1.2 / DUR) * camLane.w, camLane.top + camLane.h - 4);
  await sleep(460);
  const boxed = await b.evaluate(`document.querySelectorAll('.key.is-sel').length`);
  ok('框选一次选中多帧', boxed >= 2 && boxed < total, `${boxed} 个选中 / 共 ${total} 帧`);
  ok('框选后矩形已收起',
    (await b.evaluate(`!document.querySelector('.boxsel')?.classList.contains('is-on')`)) === true);

  // 11b. 拖选中的一员 → 整批平移，帧间距离不变
  const preT = (await proj()).camera.map((k) => +k.t.toFixed(3));
  const selNodes = await b.evaluate(`[...document.querySelectorAll('.key.is-sel')].map((n) => {
    const r = n.getBoundingClientRect();
    return { i: +n.dataset.index, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })`);
  ok('框选后选择没被收成单选', selNodes.length === boxed, `${selNodes.length} 个`);
  const grabNode = selNodes[selNodes.length - 1];
  await b.drag(grabNode.x, grabNode.y, grabNode.x + 80, grabNode.y);
  await sleep(560);
  const postT = (await proj()).camera.map((k) => +k.t.toFixed(3));
  const deltas = postT.map((t, i) => +(t - preT[i]).toFixed(3));
  const selIdx = selNodes.map((n) => n.i);
  const d0 = deltas[selIdx[0]];
  ok('多选整批平移（帧间距离不变）',
    selIdx.every((i) => Math.abs(deltas[i] - d0) < 0.02) && d0 > 0.2,
    `Δ=${deltas.map((d) => d.toFixed(2)).join(', ')}`);
  ok('未选中的帧没被带走',
    preT.every((t, i) => selIdx.includes(i) || Math.abs(postT[i] - t) < 1e-6),
    postT.join(', '));

  await b.shot('16-timeline-box');
  console.log('· 截图 16-timeline-box（框选态）');
  await b.hotkey('Delete', 'Delete', 46);
  await sleep(480);
  p = await proj();
  ok('框选后一次删除所选', p.camera.length === total - boxed, `${total} → ${p.camera.length}`);
  ok('框选只删了框内的帧', p.camera.every((k) => k.t > 1.2),
    p.camera.map((k) => k.t.toFixed(2)).join(', '));
} catch (e) {
  ok('测试未抛异常', false, e.message);
} finally {
  ok('无控制台错误', b.problems.length === 0, b.problems.join(' | '));
  await b.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n═══ 结果 ═══');
if (failed.length) {
  console.log(`✗ ${failed.length}/${results.length} 项失败：`);
  failed.forEach((f) => console.log('  · ' + f.name));
  process.exit(1);
}
console.log(`✓ 关键帧系统全部通过（${results.length} 项）`);
