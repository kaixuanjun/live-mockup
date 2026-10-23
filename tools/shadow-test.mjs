/**
 * LiveMockup · 阴影贴图数值测试（纯 Node，不需要浏览器）
 *
 * 为什么要有这一组：
 *   「导出比预览硬」这个 bug 的根因是**参数语义**算错，不是渲染管线 ——
 *   CSS box-shadow 的 blur-radius r 对应高斯 σ = r/2，而 CSS filter:blur(r) 的 r 本身就是 σ。
 *   这类错误肉眼能看出来，但说不清差多少、也不好回归。所以这里直接把
 *   public/js/render.js 里的阴影数学切出来，在 Node 里量：
 *
 *     1) 盒式模糊逼近出来的 σ 是否真的是配置的那个 σ（对阶跃边缘比 erfc）
 *     2) 机身侧边的 alpha 剖面是否等于 CSS box-shadow 的解析解（逐点比）
 *     3) 贴图四边是否被裁（裁了就会出现一条直边 —— 也就是「割裂」）
 *     4) 接触阴影 / 地面阴影这两层是不是真的在（旧实现整层漏掉地面阴影）
 *
 * 无法在这里验证的是「浏览器实际怎么把这张贴图贴上去」（需要 GPU/合成器），
 * 那部分靠 tools/parity-test.mjs 在真浏览器里比像素。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

/* ── 把阴影那一段纯函数从 render.js 里切出来 ─────────────────────────── */

const src = readFileSync(path.join(ROOT, 'public/js/render.js'), 'utf8');
const from = src.indexOf('function shadowRecipe');
const to = src.indexOf('function cameraMatrix');
if (from < 0 || to < 0 || to <= from) {
  console.log('✗ 在 render.js 里找不到阴影那一段（shadowRecipe…cameraMatrix）');
  process.exit(1);
}

// 只要 canvas 的最小接口：makeShadowSprite 用 createImageData + putImageData 出 alpha
function stubDocument() {
  return {
    createElement() {
      const cv = { width: 0, height: 0, data: null };
      cv.getContext = () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { cv.data = img.data; },
      });
      return cv;
    },
  };
}

const code = src.slice(from, to);
const SH = new Function('RAD', 'document', `${code}
  return { shadowRecipe, shadowSigma, GAUSS_CUT, boxRadii, gaussBlur, bodyCoverage, groundField, shiftDown, makeShadowSprite };`)(Math.PI / 180, stubDocument());

const { shadowRecipe, shadowSigma, GAUSS_CUT, boxRadii, gaussBlur, groundField, makeShadowSprite } = SH;

/* ── 数学小工具：标准正态分布 / 互补误差函数 ──────────────────────── */

/** 数值食谱 erfcc：分数误差 < 1.2e-7，够判定到 1/255 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
    -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];
  let d = 0, dd = 0;
  for (let j = cof.length - 1; j > 0; j--) { const tmp = d; d = ty * d - dd + cof[j]; dd = tmp; }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}
const Phi = (u) => 0.5 * erfc(-u / Math.SQRT2);

/** 一条 box-shadow 在「离阴影矩形边缘 d 像素（正=在矩形外）」处留下的 alpha */
const layerAlpha = (d, dy, blur, a) => a * 0.5 * erfc((d - dy) / (shadowSigma(blur) * Math.SQRT2));

/**
 * 机身上缘外侧 d 像素处的 alpha。阴影矩形整体下移了 dy，
 * 它的上边比机身上边低 dy —— 所以这里是「远了 dy」，符号与下边相反。
 */
const layerAlphaTop = (d, dy, blur, a) => a * 0.5 * erfc((d + dy) / (shadowSigma(blur) * Math.SQRT2));

/** 同色多层 source-over：alpha 合成与顺序无关 */
const compose = (...as) => as.reduce((acc, a) => a + acc * (1 - a), 0);

/* ── 1. 盒式模糊的 σ 是否真的等于要求的 σ ─────────────────────────── */

for (const sigma of [7, 16, 30, 35]) {
  // 三次盒宽的方差之和应该等于 σ²（这就是「3 次盒式 ≈ 高斯」的定义式）
  let v = 0;
  for (const r of boxRadii(sigma)) { const W = Math.round(r) * 2 + 1; v += (W * W - 1) / 12; }
  const got = Math.sqrt(v);
  check(Math.abs(got - sigma) / sigma < 0.04, `σ=${sigma} 的盒宽组合方差对得上`, `实测 σ=${got.toFixed(2)}`);
}

{
  // 横竖两个 σ 分开给：CSS filter 作用在 transform 之前，rotateX 把纵向压扁之后
  // 有效 σ 只剩 σx·cosθ。用单点脉冲量两个方向的标准差最直接。
  const W = 300, H = 200, cx = 150, cy = 100;
  const f = new Float32Array(W * H);
  f[cy * W + cx] = 1;
  const tmp = new Float32Array(W * H);
  const syWant = 30 * Math.cos(72 * Math.PI / 180);
  gaussBlur(f, W, H, 30, tmp, syWant);
  let sx = 0, sy = 0, tot = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = f[y * W + x];
      if (!v) continue;
      tot += v; sx += v * (x - cx) ** 2; sy += v * (y - cy) ** 2;
    }
  }
  const gx = Math.sqrt(sx / tot), gy = Math.sqrt(sy / tot);
  check(Math.abs(gx - 30) / 30 < 0.05 && Math.abs(gy - syWant) / syWant < 0.05,
    '横向 σ / 纵向 σ 分别生效（rotateX 压扁那一路）',
    `横向 ${gx.toFixed(2)}/30 · 纵向 ${gy.toFixed(2)}/${syWant.toFixed(2)}`);
}

{
  // 直接量：对阶跃边缘做模糊，剖面应该就是 Φ(d/σ)
  const W = 400, H = 6, cx = 200;
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = cx; x < W; x++) f[y * W + x] = 1;
  const tmp = new Float32Array(W * H);
  gaussBlur(f, W, H, 30, tmp);
  let worst = 0;
  const at = [];
  for (const d of [-60, -30, 0, 30, 60]) {
    const got = f[2 * W + cx + d];
    const want = Phi(d / 30);
    worst = Math.max(worst, Math.abs(got - want));
    at.push(`${d}:${got.toFixed(3)}/${want.toFixed(3)}`);
  }
  // 3 次盒式模糊只能逼近高斯：尾部偏差 ~0.01 是这套近似的固有误差，不是 bug
  check(worst < 0.015, '阶跃边缘的模糊剖面 = Φ(d/σ)（σ=30）', `最大偏差 ${worst.toFixed(4)} · ${at.join(' ')}`);
}

/* ── 2. 手机样机的贴图：尺寸、留白、四边不裁 ──────────────────────── */

const PHONE = { model: 'phone', pad: 12, radius: 54 };
const bw = 390 + PHONE.pad * 2;   // 与 render.js 的 MODELS 一致：414 × 868
const bh = 844 + PHONE.pad * 2;

const rec = shadowRecipe(bw, bh, PHONE);
check(rec.layers.length === 2 && rec.layers[0].blur === 60 && rec.layers[1].blur === 14,
  '机身投影两层，参数照抄 CSS（0 30px 60px / 0 6px 14px）',
  rec.layers.map((l) => `${l.dy}px ${l.blur}px α${l.a}`).join(' + '));
check(Math.abs(rec.ground.rx - 0.39 * bw) < 0.01 && Math.abs(rec.ground.ry - 45 * Math.cos(72 * Math.PI / 180)) < 0.01,
  '地面阴影几何照抄 CSS（78% 宽 / 90px 高 × cos72°）',
  `rx=${rec.ground.rx.toFixed(1)} ry=${rec.ground.ry.toFixed(1)} cy=${rec.ground.cy}`);

const sprite = makeShadowSprite(bw, bh, PHONE);
const W = sprite.cv.width;
const H = sprite.cv.height;
const A = (x, y) => sprite.cv.data[(y * W + x) * 4 + 3] / 255;

check(W === bw + sprite.pad * 2 && H === bh + sprite.pad * 2,
  '贴图 = 机身 + 四周留白', `${W}×${H}（机身 ${bw}×${bh}，留白 ${sprite.pad}）`);
check(sprite.pad >= 30 + GAUSS_CUT * 30,
  '留白容得下「下坠 + 3.5σ」', `需要 ≥ ${Math.ceil(30 + GAUSS_CUT * 30)}，实际 ${sprite.pad}`);

{
  // 四边必须是 0：留白不够时高斯被贴图边界截断，阴影外缘会出现一条直边（这就是「割裂」）
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    for (let x = 0; x < W; x++) worst = Math.max(worst, A(x, k), A(x, H - 1 - k));
    for (let y = 0; y < H; y++) worst = Math.max(worst, A(k, y), A(W - 1 - k, y));
  }
  check(worst === 0, '贴图四边 alpha = 0（阴影没被裁出直边）', `边缘最大 alpha ${worst}`);
}

/* ── 3. 侧边 alpha 剖面 == CSS box-shadow 的解析解 ────────────────── */

{
  // 在机身左边缘的一半高度处量（那里竖直方向远离上/下边，等价于一维半平面；
  // 地面阴影在 x≈0 处离它有 3.3σ 以上，贡献 < 0.001，可以忽略）
  const y = sprite.pad + Math.round(bh / 2);
  const rows = [];
  let worst = 0;
  for (const d of [0, 10, 20, 30, 60]) {
    const got = A(sprite.pad - d, y);
    const want = compose(layerAlpha(d, 0, 60, 0.5), layerAlpha(d, 0, 14, 0.4));
    worst = Math.max(worst, Math.abs(got - want));
    rows.push(`${d}px:${got.toFixed(3)}/${want.toFixed(3)}`);
  }
  check(worst < 0.02, '机身侧边阴影剖面 = CSS 解析解（两层都在）',
    `最大偏差 ${worst.toFixed(4)} · 实测/理论 ${rows.join(' ')}`);

  // 对照：旧实现只有一层 σ=18 的 blur(18px)，同一个位置薄了 3 倍多 —— 这就是「导出很锐」的量化
  const oldAt30 = 0.5 * 0.5 * erfc(30 / (18 * Math.SQRT2));
  const newAt30 = A(sprite.pad - 30, y);
  check(newAt30 > oldAt30 * 2.5, '离机身边缘 30px 处的阴影比旧实现厚实得多',
    `旧 ${oldAt30.toFixed(3)} → 新 ${newAt30.toFixed(3)}（×${(newAt30 / oldAt30).toFixed(1)}）`);
}

{
  // 上边缘同样只能来自 box-shadow 两层（地面阴影在下方 3.5σ 之外）
  const x = sprite.pad + Math.round(bw / 2);
  const rows = [];
  let worst = 0;
  for (const d of [2, 15, 40]) {
    const got = A(x, sprite.pad - d);
    const want = compose(layerAlphaTop(d, 30, 60, 0.5), layerAlphaTop(d, 6, 14, 0.4));
    worst = Math.max(worst, Math.abs(got - want));
    rows.push(`${d}px:${got.toFixed(3)}/${want.toFixed(3)}`);
  }
  check(worst < 0.02, '机身上缘的淡阴影也在（不是只有下方有）', `最大偏差 ${worst.toFixed(4)} · ${rows.join(' ')}`);
}

/* ── 4. 接触阴影 + 地面阴影 ──────────────────────────────────────── */

{
  // 机身底边正下方 1px：两层 box-shadow 几乎全在（阴影矩形下坠 30 / 6），
  // 再加上地面阴影的中心 —— 必须明显高于「只算 box-shadow」的值，
  // 多出来的那一圈才是把机身压在地面上的接触阴影。
  const x = sprite.pad + Math.round(bw / 2);
  const got = A(x, sprite.pad + bh + 1);
  const boxOnly = compose(layerAlpha(1, 30, 60, 0.5), layerAlpha(1, 6, 14, 0.4));
  check(got > boxOnly + 0.04 && got < 0.85, '机身底边下方 1px 有接触阴影（含地面阴影）',
    `实测 ${got.toFixed(3)} · 只算 box-shadow 时 ${boxOnly.toFixed(3)}`);
}

{
  const f = new Float32Array(W * H);
  groundField(f, W, H, rec.ground, sprite.pad, sprite.pad);
  // 配方写的是设备坐标，贴图里必须落在 pad 之后；
  // 漏掉这个偏移就会画到机身腰部、被机身整个挡住 —— 等于地面阴影根本没画
  const cx = sprite.pad + Math.round(rec.ground.cx);
  const cy = sprite.pad + Math.round(rec.ground.cy);
  const peak = f[cy * W + cx];
  let outside = 0;
  for (let x = 0; x < W; x++) {
    if (Math.abs(x + 0.5 - cx) > rec.ground.rx) outside = Math.max(outside, f[cy * W + x]);
  }
  check(peak > 0.95 && outside === 0, '地面阴影落在机身正下方、中心≈1、横向半径外为 0',
    `中心 ${peak.toFixed(3)} · 半径外 ${outside}`);
}

/* ── 5. browser 机型（CSS 只有一层 0 30px 70px）────────────────── */

{
  const cfg = { model: 'browser', pad: 0, radius: 14 };
  const sbw = 1180, sbh = 736;
  const r2 = shadowRecipe(sbw, sbh, cfg);
  check(r2.layers.length === 1 && r2.layers[0].blur === 70 && r2.layers[0].a === 0.55,
    'browser 机型照抄它自己的那条 box-shadow', `${r2.layers[0].dy}px ${r2.layers[0].blur}px α${r2.layers[0].a}`);
  const sp2 = makeShadowSprite(sbw, sbh, cfg);
  const w2 = sp2.cv.width;
  const y2 = sp2.pad + Math.round(sbh / 2);
  let worst = 0;
  const rows = [];
  for (const d of [0, 20, 40]) {
    const got = sp2.cv.data[(y2 * w2 + (sp2.pad - d)) * 4 + 3] / 255;
    const want = layerAlpha(d, 0, 70, 0.55);
    worst = Math.max(worst, Math.abs(got - want));
    rows.push(`${d}px:${got.toFixed(3)}/${want.toFixed(3)}`);
  }
  check(worst < 0.02, 'browser 机型侧边阴影剖面也对得上', `最大偏差 ${worst.toFixed(4)} · ${rows.join(' ')}`);
}

/* ── 汇总 ──────────────────────────────────────────────────────── */

const bad = results.filter((r) => !r.ok);
console.log('\n═══ 结果 ═══');
if (bad.length) {
  console.log(`✗ ${bad.length}/${results.length} 项失败`);
  bad.forEach((r) => console.log(`   · ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
} else {
  console.log(`✓ 阴影贴图数值全部通过（${results.length} 项）`);
}
process.exit(bad.length ? 1 : 0);
