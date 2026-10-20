/**
 * LiveMockup · 运镜文件（movetrack）
 *
 * 运镜只描述「镜头怎么动」，和视频没有关系。这里把它单独存成一个文件：
 *
 *   { "kind": "livemockup-move", "version": 2,
 *     "duration": 12.4,                      // 这套运镜原本铺多长时间
 *     "keys": [ { "t": 0, "x": 0, "y": 0, "z": 0, "rx": 2, "ry": -12, "rz": 0, "scale": 1, "ease": "easeInOut" }, … ] }
 *
 * 关键点：从 v2 起镜头位移是**相对画面**的比例（x=画框宽、y=画框高、z=透视距离），
 * 所以同一份运镜套到任何分辨率、任何画幅的视频上，走的都是同一条轨迹。
 *
 * 时间：套用时默认按比例铺到当前时间轴长度；也可以保持原速，只把起点对到 0。
 */
(() => {
  'use strict';

  const KIND = 'livemockup-move';
  const VERSION = 2;
  const NUM = ['t', 'x', 'y', 'z', 'rx', 'ry', 'rz', 'scale', 'ease'];

  const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  /** 只留认识的字段、丢掉 NaN、按时间排序 */
  function clean(keys) {
    const out = [];
    (Array.isArray(keys) ? keys : []).forEach((src) => {
      if (!src || typeof src !== 'object') return;
      const k = {};
      NUM.forEach((f) => {
        if (f === 'ease') {
          if (typeof src.ease === 'string') k.ease = src.ease;
          return;
        }
        const v = Number(src[f]);
        if (f === 't') k.t = Math.max(0, Number.isFinite(v) ? v : 0);
        else if (Number.isFinite(v)) k[f] = v;
      });
      ['hold', 'bezier'].forEach((f) => {
        if (src[f] === true) k.hold = true;
        if (Array.isArray(src[f])) k.bezier = src[f].map(Number);
      });
      if (k.scale != null && k.scale <= 0) delete k.scale;
      out.push(k);
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** 这套运镜自己的长度（最后一个关键帧的时间，或显式 duration 里更长的那个） */
  function lengthOf(keys, duration) {
    const last = keys && keys.length ? keys[keys.length - 1].t : 0;
    return Math.max(last, Number(duration) || 0);
  }

  function aspectOf(o) {
    const a = String((o && o.scene && o.scene.aspect) || (o && o.aspect) || '9:16');
    if (a === 'auto') {
      const v = (o && o.video) || {};
      return v.w && v.h ? v.w / v.h : 9 / 16;
    }
    const [w, h] = a.split(':').map(Number);
    return w && h ? w / h : 9 / 16;
  }

  /** 导出成运镜文件 */
  function pack(camera, duration, meta = {}) {
    const keys = clean(camera);
    return {
      kind: KIND,
      version: VERSION,
      name: String(meta.name || '').slice(0, 80),
      duration: round(lengthOf(keys, duration), 3),
      createdAt: new Date().toISOString().slice(0, 19),
      // 只作参考：说明这套运镜是在什么场景下调的，套用时并不绑定它
      scene: { device: meta.device || '', aspect: meta.aspect || '' },
      keys,
    };
  }

  /** 读运镜文件；兼容 v1（那时候位移是编辑器舞台像素） */
  function parse(raw) {
    let o;
    if (typeof raw === 'string') {
      try { o = JSON.parse(raw); } catch (_) { throw new Error('不是合法的 JSON'); }
    } else o = raw;
    if (!o || typeof o !== 'object') throw new Error('文件内容不是对象');
    const list = Array.isArray(o.keys) ? o.keys : Array.isArray(o.camera) ? o.camera : null;
    if (!list) throw new Error('不是运镜文件（没有 keys 数组）');

    const version = Number(o.version) || 1;
    let keys = list;
    if (version < 2) {
      const box = (window.Stage && Stage.refBox) ? Stage.refBox(aspectOf(o)) : { w: 1035, h: 582 };
      const persp = (window.Stage && Stage.perspOf) ? Stage.perspOf(box.h) : 1700;
      keys = list.map((k) => ({
        ...k,
        x: (Number(k.x) || 0) / box.w,
        y: (Number(k.y) || 0) / box.h,
        z: (Number(k.z) || 0) / persp,
      }));
    }
    const cleaned = clean(keys);
    if (!cleaned.length) throw new Error('文件里没有关键帧');
    return {
      keys: cleaned,
      duration: lengthOf(cleaned, Number(o.duration) || 0),
      name: typeof o.name === 'string' ? o.name : '',
      version,
    };
  }

  /** 按比例铺到 targetDur（时间整体缩放，机位不变） */
  function rescale(keys, fromDur, targetDur) {
    const from = Number(fromDur) > 0 ? Number(fromDur) : lengthOf(keys, 0);
    const to = Number(targetDur);
    if (!from || !to || Math.abs(from - to) < 0.02) return clean(keys);
    const f = to / from;
    return clean(keys).map((k) => ({ ...k, t: round(Math.min(to, Math.max(0, k.t * f)), 3) }));
  }

  /** 保持原速：只把起点对齐到 0，超出 targetDur 的夹住 */
  function shiftToZero(keys, targetDur) {
    const list = clean(keys);
    if (!list.length) return list;
    const t0 = list[0].t;
    const cap = Number(targetDur) > 0 ? Number(targetDur) : Infinity;
    return list.map((k) => ({ ...k, t: round(Math.min(cap, Math.max(0, k.t - t0)), 3) }));
  }

  window.MoveTrack = {
    KIND, VERSION, clean, pack, parse, rescale, shiftToZero, lengthOf,
    /** 建议的文件名 */
    fileName(count) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `livemockup-move-${count}keys-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    },
  };
})();
