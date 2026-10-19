/**
 * LiveMockup · 时间轴
 * 双轨渲染（镜头关键帧 / 页面动作）、刻度、播放头、拖拽与选择。
 */
(() => {
  const dom = {
    ruler: document.getElementById('ruler'),
    tracks: document.querySelector('.tracks'),
    laneCam: document.getElementById('laneCamera'),
    laneAct: document.getElementById('laneActions'),
    playhead: document.getElementById('playhead'),
    time: document.getElementById('tlTime'),
    count: document.getElementById('tlCount'),
    zoomIn: document.getElementById('zoomIn'),
    zoomOut: document.getElementById('zoomOut'),
    zoomFit: document.getElementById('zoomFit'),
  };

  const S = {
    duration: 12,
    t: 0,
    camera: [],
    actions: [],
    selection: null, // {kind:'cam'|'act', index, extra:[...]}
    onSeek: null,
    onSelect: null,
    onDrag: null,
    onDragGroup: null,
  };

  let ticksEl = null;
  let drag = null;
  let laneW = 1;

  /**
   * 可见时间窗：zoom=1 时 [0, duration] 全览；
   * zoom 越大窗口越窄，viewStart 是窗口起点（秒）。
   */
  const view = { zoom: 1, start: 0 };
  const MAX_ZOOM = 24;
  const span = () => Math.max(0.15, S.duration / view.zoom);
  const maxStart = () => Math.max(0, S.duration - span());
  function clampView() {
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    view.start = Math.min(maxStart(), Math.max(0, view.start));
  }

  const fmt = (t) => {
    const s = Math.max(0, t);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
  };

  const pxOf = (t) => ((t - view.start) / span()) * laneW;
  const tOf = (px) => view.start + (px / laneW) * span();
  const onScreen = (x, pad = 40) => x >= -pad && x <= laneW + pad;

  function niceStep(dur) {
    if (dur <= 0.4) return 0.05;
    if (dur <= 0.9) return 0.1;
    if (dur <= 2) return 0.25;
    if (dur <= 5) return 0.5;
    if (dur <= 12) return 1;
    if (dur <= 25) return 2;
    if (dur <= 60) return 5;
    return 10;
  }

  function renderTicks() {
    if (!ticksEl) {
      ticksEl = document.createElement('div');
      ticksEl.className = 'ruler-ticks';
      ticksEl.style.cssText = 'position:absolute;left:0;top:0;height:12px;pointer-events:none;';
      dom.tracks.appendChild(ticksEl);
    }
    ticksEl.style.width = laneW + 'px';
    const step = niceStep(span());
    const end = view.start + span();
    const parts = [];
    for (let t = Math.ceil(view.start / step) * step; t <= end + 1e-6; t += step) {
      const x = pxOf(t);
      if (!onScreen(x, 0)) continue;
      const label = step < 0.1 ? t.toFixed(2) : step < 1 ? t.toFixed(1) : `${Math.round(t)}s`;
      parts.push(`<span style="left:${x}px">${label}</span>`);
    }
    ticksEl.innerHTML = parts.join('');
    const tickPx = (step / span()) * laneW;
    dom.laneCam.style.setProperty('--tick', tickPx + 'px');
    dom.laneAct.style.setProperty('--tick', tickPx + 'px');
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (!dom.zoomFit) return;
    dom.zoomFit.textContent = view.zoom <= 1.001
      ? '全览'
      : `${view.zoom >= 10 ? Math.round(view.zoom * 10) / 10 : Math.round(view.zoom * 100) / 100}×`;
    if (dom.zoomIn) dom.zoomIn.disabled = view.zoom >= MAX_ZOOM - 1e-6;
    if (dom.zoomOut) dom.zoomOut.disabled = view.zoom <= 1.001;
  }

  const GLYPH = { tap: '⊙', type: '⌨', scroll: '↕', select: '▾', check: '☑', navigate: '↗' };

  /** 选中判断：index 是主选，extra 是按住 Shift 加选的其余项 */
  function isSel(kind, i) {
    const s = S.selection;
    if (!s || s.kind !== kind) return false;
    return s.index === i || (Array.isArray(s.extra) && s.extra.includes(i));
  }

  function guideEl() {
    let g = dom.tracks.querySelector('.snapguide');
    if (!g) {
      g = document.createElement('div');
      g.className = 'snapguide';
      dom.tracks.appendChild(g);
    }
    return g;
  }

  function showGuide(t) {
    const g = guideEl();
    if (t == null) { g.classList.remove('is-on'); return; }
    g.style.left = 76 + pxOf(t) + 'px';
    g.classList.add('is-on');
  }

  /* ───────── 缩放 / 平移 ───────── */

  function setZoom(z, anchorT) {
    const a = anchorT == null ? S.t : anchorT;
    const before = (a - view.start) / span();
    const prevZoom = view.zoom;
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, z));
    if (view.zoom === prevZoom) { updateZoomLabel(); return; }
    // 围绕锚点时间缩放：锚点在屏幕上的相对位置保持不变
    view.start = a - before * span();
    clampView();
    render();
  }

  function nudgeZoom(dir, anchorT) {
    const factor = dir > 0 ? 1.6 : 1 / 1.6;
    setZoom(view.zoom * factor, anchorT);
  }

  function panBy(dtSeconds) {
    if (view.zoom <= 1.001) return;
    view.start += dtSeconds;
    clampView();
    render();
  }

  /**
   * 拖动时的时间吸附：优先吸到其它关键帧 / 播放头（磁性），
   * 否则落到 0.05s 网格上，避免出现 3.2871 这种脏数字。
   */
  function snapT(rawT, kind, index) {
    const tol = (7 / Math.max(1, laneW)) * span();
    const grid = view.zoom >= 4 ? 0.01 : 0.05;
    const cands = [S.t];
    if (kind === 'cam') S.camera.forEach((k, i) => { if (i !== index) cands.push(k.t); });
    else S.actions.forEach((a, i) => { if (i !== index) cands.push(a.t); });
    let best = null;
    let bd = tol;
    for (const c of cands) {
      const d = Math.abs(c - rawT);
      if (d <= bd) { bd = d; best = c; }
    }
    if (best != null) return { t: best, magnet: true };
    return { t: Math.round(rawT / grid) * grid, magnet: false };
  }

  function renderMarkers() {
    dom.laneCam.querySelectorAll('.key').forEach((n) => n.remove());
    dom.laneAct.querySelectorAll('.act').forEach((n) => n.remove());

    S.camera.forEach((k, i) => {
      const x = pxOf(k.t);
      if (!onScreen(x, 24)) return; // 缩放后窗口外的标记不渲染
      const d = document.createElement('div');
      d.className = 'key';
      d.dataset.index = i;
      d.style.left = x + 'px';
      if (k.hold) d.classList.add('is-hold');
      d.title = `关键帧 ${i + 1} · ${k.t.toFixed(2)}s\n${easeLabel(k)}\n双击跳到这一帧`;
      if (isSel('cam', i)) d.classList.add('is-sel');
      d.addEventListener('pointerdown', (e) => startDrag(e, 'cam', i, d));
      d.addEventListener('dblclick', (e) => { e.stopPropagation(); if (S.onSeek) S.onSeek(k.t, false); });
      dom.laneCam.appendChild(d);
    });

    // 挤在一起的动作交错排到第二行，时间靠得再近也不会完全叠住
    const rowEnd = [-1e9, -1e9];
    S.actions.forEach((a, i) => {
      const x = pxOf(a.t);
      const d = document.createElement('div');
      d.className = 'act';
      d.dataset.index = i;
      d.style.left = x + 'px';
      const label = a.label || a.value || a.selector || a.type;
      d.innerHTML = `<span class="glyph">${GLYPH[a.type] || '•'}</span><span>${escapeHtml(String(label)).slice(0, 22)}</span>`;
      d.title = `${a.type} · ${a.t.toFixed(2)}s\n${a.selector || a.url || ''}`;
      if (a._failed) d.classList.add('is-fail');
      if (isSel('act', i)) d.classList.add('is-sel');
      d.addEventListener('pointerdown', (e) => startDrag(e, 'act', i, d));
      d.addEventListener('dblclick', (e) => { e.stopPropagation(); if (S.onSeek) S.onSeek(a.t, true); });
      dom.laneAct.appendChild(d);

      const w = d.getBoundingClientRect().width || 22;
      const left = x - w / 2;
      const row = left < rowEnd[0] + 3 ? 1 : 0;
      d.style.top = (row ? 34 : 13) + 'px';
      rowEnd[row] = Math.max(rowEnd[row], left + w);

      if (!onScreen(x, w)) d.style.display = 'none';
    });
  }

  function easeLabel(k) {
    if (k.hold) return '保持（不插值）';
    if (Array.isArray(k.bezier)) return `cubic-bezier(${k.bezier.map((n) => +n.toFixed(2)).join(', ')})`;
    return k.ease || 'easeInOut';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function paintPlayhead() {
    const x = pxOf(S.t);
    dom.playhead.style.left = x + 'px';
    dom.playhead.classList.toggle('is-off', !onScreen(x, 0));
    dom.time.textContent = fmt(S.t);
  }

  function render(model) {
    if (model) Object.assign(S, model);
    laneW = Math.max(40, dom.laneCam.clientWidth || dom.tracks.clientWidth - 76);
    laneW = Math.max(40, dom.laneCam.clientWidth);
    renderTicks();
    renderMarkers();
    paintPlayhead();
    dom.count.textContent = `${S.actions.length} 个动作 · ${S.camera.length} 个关键帧`;
    dom.ruler.classList.toggle('recording', !!S.recording);
  }

  function posInLane(clientX) {
    const r = dom.laneCam.getBoundingClientRect();
    return Math.min(laneW, Math.max(0, clientX - r.left));
  }

  function laneOf(kind) {
    return kind === 'cam' ? dom.laneCam : dom.laneAct;
  }

  function startDrag(e, kind, index, node) {
    e.preventDefault();
    e.stopPropagation();
    // Shift 点击 = 加选 / 取消加选，不进入拖拽
    if (e.shiftKey) {
      if (S.onSelect) S.onSelect(kind, index, { shift: true });
      return;
    }
    try { node.setPointerCapture?.(e.pointerId); } catch { /* 合成事件没有活跃指针 */ }
    node.classList.add('dragging');
    const list = kind === 'cam' ? S.camera : S.actions;
    // 拖的是「已选中的一员」就整批移动，否则只移动这一个
    const sel = S.selection;
    const selIdx = sel && sel.kind === kind ? [sel.index, ...(sel.extra || [])] : [];
    const group = selIdx.includes(index) ? [...new Set(selIdx)].filter((i) => list[i]) : [];
    drag = {
      kind, index, node,
      startT: kind === 'cam' ? S.camera[index].t : S.actions[index].t,
      startX: e.clientX,
      moved: false,
      group: group.length > 1 ? group.map((i) => ({ index: i, t: list[i].t })) : null,
      lastMoves: null,
    };
    if (S.onSelect) S.onSelect(kind, index);
    if (S.onDrag) S.onDrag(kind, index, drag.startT, 'start');
  }

  function onMove(e) {
    if (drag) {
      const dt = tOf(e.clientX - drag.startX) - tOf(0);
      const raw = Math.min(S.duration, Math.max(0, drag.startT + dt));
      const { t, magnet } = snapT(raw, drag.kind, drag.index);
      drag.node.style.left = pxOf(t) + 'px';
      drag.moved = true;
      showGuide(magnet ? t : null);
      if (drag.group) {
        // 整批平移：以被拖这一帧的位移量为准，其它帧同步走
        const delta = t - drag.startT;
        const lane = laneOf(drag.kind);
        drag.lastMoves = drag.group.map((g) => {
          const nt = Math.min(S.duration, Math.max(0, g.t + delta));
          const node = lane.querySelector(`[data-index="${g.index}"]`);
          if (node) node.style.left = pxOf(nt) + 'px';
          return { index: g.index, t: nt };
        });
        if (S.onDragGroup) S.onDragGroup(drag.kind, drag.lastMoves, 'move');
      } else if (S.onDrag) {
        S.onDrag(drag.kind, drag.index, t, 'move');
      }
      return;
    }
    if (box) { updateBox(e); return; }
    if (scrubbing) {
      const t = Math.min(S.duration, Math.max(0, tOf(posInLane(e.clientX))));
      S.t = t;
      paintPlayhead();
      if (S.onSeek) S.onSeek(t, true);
    }
  }

  function onUp(e) {
    if (drag) {
      drag.node?.classList.remove('dragging');
      showGuide(null);
      if (drag.group && S.onDragGroup) {
        S.onDragGroup(drag.kind, drag.lastMoves || drag.group.map((g) => ({ index: g.index, t: g.t })), 'end');
      } else if (S.onDrag) {
        S.onDrag(drag.kind, drag.index, null, 'end');
      }
      drag = null;
      return;
    }
    if (box) { endBox(); return; }
    if (scrubbing) {
      scrubbing = false;
    }
  }

  /* ───────── 框选 ───────── */

  function boxEl() {
    let b = dom.tracks.querySelector('.boxsel');
    if (!b) {
      b = document.createElement('div');
      b.className = 'boxsel';
      dom.tracks.appendChild(b);
    }
    return b;
  }

  /** 矩形与标记的相交判断，返回被框中的 index 列表 */
  function hitsIn(kind, x1, x2, y1, y2) {
    const lane = kind === 'cam' ? dom.laneCam : dom.laneAct;
    const lr = lane.getBoundingClientRect();
    const sel = [];
    const nodes = lane.querySelectorAll(kind === 'cam' ? '.key' : '.act');
    nodes.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.right < x1 || r.left > x2) return;
      if (r.bottom < y1 || r.top > y2) return;
      sel.push(Number(n.dataset.index));
    });
    if (!nodes.length) {
      // 退化情况：用时间轴范围判断
      const list = kind === 'cam' ? S.camera : S.actions;
      const t1 = tOf(Math.min(x1, x2) - lr.left);
      const t2 = tOf(Math.max(x1, x2) - lr.left);
      list.forEach((k, i) => { if (k.t >= t1 && k.t <= t2) sel.push(i); });
    }
    return sel.sort((a, b) => a - b);
  }

  function startBox(e, kind) {
    const r = dom.tracks.getBoundingClientRect();
    box = {
      kind,
      x0: e.clientX, y0: e.clientY,
      x1: e.clientX, y1: e.clientY,
      add: !!e.shiftKey,
      active: false,
      origin: r,
    };
  }

  function updateBox(e) {
    if (!box) return;
    box.x1 = e.clientX;
    box.y1 = e.clientY;
    if (!box.active) {
      if (Math.abs(box.x1 - box.x0) < 4 && Math.abs(box.y1 - box.y0) < 4) return;
      box.active = true;
    }
    const el = boxEl();
    const { origin } = box;
    const left = Math.min(box.x0, box.x1) - origin.left;
    const top = Math.min(box.y0, box.y1) - origin.top;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = Math.abs(box.x1 - box.x0) + 'px';
    el.style.height = Math.abs(box.y1 - box.y0) + 'px';
    el.classList.add('is-on');

    // 实时高亮：把框中的标记先点亮
    const hits = hitsIn(box.kind, Math.min(box.x0, box.x1), Math.max(box.x0, box.x1),
      Math.min(box.y0, box.y1), Math.max(box.y0, box.y1));
    const lane = box.kind === 'cam' ? dom.laneCam : dom.laneAct;
    lane.querySelectorAll('.key,.act').forEach((n) => {
      const on = hits.includes(Number(n.dataset.index));
      n.classList.toggle('is-boxpreview', on);
    });
  }

  function endBox() {
    if (!box) return;
    const b = box;
    box = null;
    const el = boxEl();
    el.classList.remove('is-on');
    (b.kind === 'cam' ? dom.laneCam : dom.laneAct).querySelectorAll('.is-boxpreview')
      .forEach((n) => n.classList.remove('is-boxpreview'));
    if (!b.active) {
      // 没有拖动 = 点一下：把播放头移到这里
      const t = Math.min(S.duration, Math.max(0, tOf(posInLane(b.x0))));
      S.t = t;
      paintPlayhead();
      if (S.onSeek) S.onSeek(t, true);
      if (S.onSelect) S.onSelect(null, null);
      return;
    }
    const hits = hitsIn(b.kind, Math.min(b.x0, b.x1), Math.max(b.x0, b.x1),
      Math.min(b.y0, b.y1), Math.max(b.y0, b.y1));
    if (S.onSelect) S.onSelect(b.kind, hits.length ? hits[0] : null, { box: hits, shift: b.add });
    if (hits.length) {
      const list = b.kind === 'cam' ? S.camera : S.actions;
      const first = list[hits[0]];
      if (first && S.onSeek) S.onSeek(first.t, b.kind === 'act');
    }
  }

  let box = null;
  let scrubbing = false;

  /* 两条轨道的空白处按下 = 框选起点（拖动）或点击定位播放头（不拖动） */
  [dom.laneCam, dom.laneAct].forEach((lane) => {
    const kind = lane === dom.laneCam ? 'cam' : 'act';
    lane.addEventListener('pointerdown', (e) => {
      if (e.target !== lane) return; // 点在标记上交给 startDrag
      e.preventDefault();
      startBox(e, kind);
      // Shift 框选是「加选」，别先把已有选择清掉
      if (!e.shiftKey && S.onSelect) S.onSelect(null, null);
    });
  });

  /* 刻度尺 = 拖拽播放头（原来在轨道上拖，现在让给框选） */
  dom.ruler.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.track__lane, .key, .act, .playhead')) return;
    e.preventDefault();
    try { dom.ruler.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活跃指针 */ }
    scrubbing = true;
    const t = Math.min(S.duration, Math.max(0, tOf(posInLane(e.clientX))));
    S.t = t;
    paintPlayhead();
    if (S.onSeek) S.onSeek(t, true);
  });

  /* 滚轮：Ctrl/Cmd 缩放（围绕指针），普通滚轮平移 */
  dom.ruler.addEventListener('wheel', (e) => {
    const anchor = Math.min(S.duration, Math.max(0, tOf(posInLane(e.clientX))));
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      nudgeZoom(e.deltaY < 0 ? 1 : -1, anchor);
      return;
    }
    if (view.zoom > 1.001) {
      e.preventDefault();
      const dt = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / laneW * span();
      panBy(dt);
    }
  }, { passive: false });

  if (dom.zoomIn) dom.zoomIn.addEventListener('click', () => nudgeZoom(1, S.t));
  if (dom.zoomOut) dom.zoomOut.addEventListener('click', () => nudgeZoom(-1, S.t));
  if (dom.zoomFit) dom.zoomFit.addEventListener('click', () => { view.zoom = 1; view.start = 0; render(); });

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  new ResizeObserver(() => {
    const w = dom.laneCam.clientWidth;
    if (Math.abs(w - laneW) > 1) render();
  }).observe(dom.laneCam);

  window.Timeline = {
    S, render, fmt,
    /** 当前视图：{ zoom, start, span } */
    view() { return { zoom: view.zoom, start: view.start, span: span() }; },
    setZoom(z, anchorT) { setZoom(z, anchorT); },
    resetZoom() { view.zoom = 1; view.start = 0; render(); },
    setTime(t) { S.t = t; paintPlayhead(); },
    /** 只切换选中态，不重建 marker（重建会打断正在进行的拖拽） */
    setSelection(sel) {
      S.selection = sel;
      dom.laneCam.querySelectorAll('.key').forEach((n) => {
        n.classList.toggle('is-sel', isSel('cam', Number(n.dataset.index)));
      });
      dom.laneAct.querySelectorAll('.act').forEach((n) => {
        n.classList.toggle('is-sel', isSel('act', Number(n.dataset.index)));
      });
    },
    onSeek(cb) { S.onSeek = cb; },
    onSelect(cb) { S.onSelect = cb; },
    onDrag(cb) { S.onDrag = cb; },
    onDragGroup(cb) { S.onDragGroup = cb; },
  };
})();
