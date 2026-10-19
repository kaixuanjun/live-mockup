/**
 * LiveMockup · 显卡面板
 *
 * 这里要说清一件事实：**网页不能指定用哪块显卡**。
 * 页面能做的是向浏览器「请求高性能适配器」（powerPreference: 'high-performance'），
 * 真正决定用独显还是集显的是浏览器和系统。所以这个面板做三件事：
 *
 *   1. 把请求做到位（render.js 里每个上下文都带 high-performance）；
 *   2. 打开页面后就探测实际落在哪块卡上，顶栏一直显示；
 *   3. 落错卡时给出能真正落地的办法 —— Windows 上一键写「每应用显卡偏好」
 *      （等同 设置 → 系统 → 显示 → 显卡 里那个开关），其它系统给手动步骤。
 */
(() => {
  'use strict';

  const VERDICT_META = {
    ok: { label: '独显', cls: 'is-ok', dot: '#37d67a' },
    integrated: { label: '集显', cls: 'is-warn', dot: '#f2b23c' },
    software: { label: '软件', cls: 'is-bad', dot: '#ef5b5b' },
    unknown: { label: '显卡?', cls: 'is-dim', dot: '#8b90a3' },
  };

  const LEVEL_TEXT = { 2: '高性能', 1: '省电', 0: '让 Windows 决定' };

  let btn = null;
  let mask = null;
  let api = null;
  let token = '';
  let windows = null;
  let status = null;

  function chipHtml(report) {
    const m = VERDICT_META[report.verdict] || VERDICT_META.unknown;
    return `<span class="gpubtn__dot" style="background:${m.dot}"></span>${m.label}`;
  }

  function applyReport(report) {
    if (!btn) return;
    const m = VERDICT_META[report.verdict] || VERDICT_META.unknown;
    btn.className = 'btn btn--ghost gpubtn ' + m.cls;
    btn.innerHTML = chipHtml(report);
    btn.title = [
      report.headline,
      report.adapter ? `适配器：${report.adapter}` : '（浏览器没有暴露适配器名称）',
      report.backend ? `合成后端：${report.backend}` : '',
      report.hwEncode === true ? '编码：硬件' : report.hwEncode === false ? '编码：软件（no-preference）' : '',
      '点开看详情与「换到独显」的方法',
    ].filter(Boolean).join('\n');
    if (mask && mask.classList.contains('is-open')) renderBody(report);
  }

  /* ───────────── 面板 ───────────── */

  function shell() {
    if (mask) return mask;
    mask = document.createElement('div');
    mask.className = 'gpumask';
    mask.id = 'gpuMask';
    mask.innerHTML = `
      <div class="gpucard" role="dialog" aria-modal="true" aria-label="显卡">
        <div class="gpucard__head">
          <h3>显卡</h3>
          <button class="gpucard__x" type="button" title="关闭（Esc）">✕</button>
        </div>
        <div class="gpucard__body" id="gpuBody"></div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.querySelector('.gpucard__x').addEventListener('click', close);
    return mask;
  }

  function bodyHtml() {
    const r = (api && api.gpuReport()) || { verdict: 'unknown', headline: '', adapter: '', backend: '', source: '', hwEncode: null };
    const m = VERDICT_META[r.verdict] || VERDICT_META.unknown;
    const rows = [
      ['适配器', r.adapter || '（浏览器没有暴露名称，不代表没请求）'],
      ['来源', r.source === 'webgpu' ? 'WebGPU 适配器' : r.source === 'webgl' ? 'WebGL 上下文' : '未探测到'],
      ['合成后端', r.backend || '还没渲染过'],
      ['硬件编码', r.hwEncode === true ? '已启用' : r.hwEncode === false ? '不可用（走软件编码）' : '还没导出过'],
      ['页面请求', 'powerPreference: high-performance'],
    ];

    const winBlock = windows === true
      ? `<div class="gpu-sec">
          <div class="gpu-sec__t">换成独显（Windows，一键）</div>
          <div id="gpuBrowsers" class="gpu-browsers"><p class="gpu-dim">读取中…</p></div>
          <p class="gpu-dim gpu-note">改动只影响当前用户（等同系统设置里那个开关），<b>完全退出浏览器（所有窗口）后再打开本页</b>才生效。</p>
        </div>`
      : `<div class="gpu-sec">
          <div class="gpu-sec__t">换成独显</div>
          <p class="gpu-dim">一键切换只在 Windows 上可用。当前系统（${windows === false ? (status && status.platform) || '非 Windows' : '未知'}）请按下面的手动步骤。</p>
        </div>`;

    return `
      <div class="gpu-head ${m.cls}">
        <span class="gpu-head__dot" style="background:${m.dot}"></span>
        <span class="gpu-head__t">${r.headline || m.label}</span>
      </div>
      <dl class="gpu-kv">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      <p class="gpu-fact">网页只能<b>请求</b>高性能显卡，最终由浏览器和系统决定；这里的按钮是把系统里那个开关替你打开。</p>
      ${winBlock}
      <details class="gpu-sec gpu-manual">
        <summary>手动设置（Windows / macOS / Linux）</summary>
        <ul>
          <li><b>Windows</b>：设置 → 系统 → 显示 → 显卡 →「添加桌面应用」选浏览器 → 选项 → <b>高性能</b> → 重启浏览器。</li>
          <li><b>NVIDIA</b>：NVIDIA 控制面板 → 管理 3D 设置 → 程序设置 → 添加浏览器 → 首选用「高性能 NVIDIA 处理器」。</li>
          <li><b>AMD</b>：AMD Software → 游戏 → 图形 → 添加浏览器 → 「高性能」。</li>
          <li><b>macOS</b>：接上电源适配器；系统设置 → 电池 → 关闭「自动切换图形卡」；Chrome / Edge 在双显卡机器上默认请求独显。</li>
          <li><b>Linux</b>：<code>DRI_PRIME=1 google-chrome</code> 或 <code>__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia google-chrome</code>。</li>
          <li><b>笔记本省电模式</b>：电源计划设成「最佳性能」，省电模式下系统会强行用集显。</li>
        </ul>
      </details>`;
  }

  function renderBody(report) {
    const body = mask.querySelector('#gpuBody');
    if (!body) return;
    body.innerHTML = bodyHtml();
    wireBrowserRows(report);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function wireBrowserRows() {
    const box = mask.querySelector('#gpuBrowsers');
    if (!box) return;
    const list = (status && status.browsers) || [];
    if (!list.length) {
      box.innerHTML = '<p class="gpu-dim">没找到浏览器可执行文件。可以手动按下面的步骤设置。</p>';
      return;
    }
    box.innerHTML = list.map((b, i) => `
      <div class="gpu-row">
        <div class="gpu-row__name">
          <span class="gpu-row__title">${esc(b.name)}${b.matchesUA ? '<em>当前</em>' : ''}</span>
          <span class="gpu-dim">${esc(b.exe)}</span>
        </div>
        <div class="gpu-row__act">
          <span class="gpu-pill ${b.pref === 2 ? 'is-ok' : b.pref === 1 ? 'is-warn' : ''}">${b.pref == null ? '未设置' : LEVEL_TEXT[b.pref]}</span>
          <button class="mini" data-gpu-apply="${i}" ${b.pref === 2 ? 'disabled' : ''}>设为高性能</button>
          <button class="mini" data-gpu-reset="${i}" ${b.pref == null ? 'disabled' : ''}>还原</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-gpu-apply]').forEach((b) => {
      b.addEventListener('click', () => act('apply', list[Number(b.dataset.gpuApply)].exe, b));
    });
    box.querySelectorAll('[data-gpu-reset]').forEach((b) => {
      b.addEventListener('click', () => act('restore', list[Number(b.dataset.gpuReset)].exe, b));
    });
  }

  async function act(kind, exe, el) {
    const row = el.closest('.gpu-row');
    const note = document.createElement('p');
    note.className = 'gpu-dim gpu-inline';
    el.disabled = true;
    note.textContent = kind === 'apply' ? '正在写入…' : '正在还原…';
    (row || mask.querySelector('#gpuBrowsers')).appendChild(note);
    try {
      const res = await fetch('/api/gpu/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lm-token': token },
        body: JSON.stringify({ exe }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      note.textContent = kind === 'apply'
        ? '已设为高性能 —— 请完全退出浏览器（所有窗口）再打开本页。'
        : '已还原成「让 Windows 决定」—— 同样需要重启浏览器。';
      note.className = 'gpu-dim gpu-inline gpu-inline--ok';
      await loadStatus();
    } catch (err) {
      note.textContent = '失败：' + (err && err.message ? err.message : err);
      note.className = 'gpu-dim gpu-inline gpu-inline--bad';
      el.disabled = false;
    }
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/gpu/status', { headers: { Accept: 'application/json' } });
      status = await res.json();
      windows = status.windows === true;
    } catch (_) {
      status = null;
      windows = null;
    }
    if (mask && mask.classList.contains('is-open')) renderBody((api && api.gpuReport()) || { verdict: 'unknown' });
  }

  async function open() {
    shell().classList.add('is-open');
    renderBody((api && api.gpuReport()) || { verdict: 'unknown' });
    try {
      const res = await fetch('/api/gpu/session', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      token = data.token || '';
      windows = data.windows === true;
    } catch (_) {
      token = '';
      windows = null;
    }
    await loadStatus();
    if (api && api.probeGPU) api.probeGPU().then(() => renderBody(api.gpuReport())).catch(() => {});
  }

  function close() {
    if (mask) mask.classList.remove('is-open');
  }

  /* ───────────── 启动 ───────────── */

  function boot() {
    btn = document.getElementById('gpuBtn');
    if (!btn) return;
    btn.addEventListener('click', open);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mask && mask.classList.contains('is-open')) {
        e.stopPropagation();
        close();
      }
    }, true);
    if (window.Render && window.Render.onGpuChange) {
      api = window.Render;
      api.onGpuChange(applyReport);
      if (api.probeGPU) api.probeGPU().catch(() => {});
    } else {
      btn.classList.add('is-dim');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 给测试用的最小接口
  window.GpuPanel = { open, close, get status() { return status; }, get token() { return token; } };
})();
