/**
 * LiveMockup · 极简 WebM (Matroska) 封装器
 *
 * 为什么需要它：离线逐帧渲染必须给每一帧一个「确定的时间戳」。
 * MediaRecorder 只会用墙钟时间打时间戳 —— 渲染快了视频会被加速，渲染慢了会被拉长，
 * 所以那条路天生做不了离线渲染。WebCodecs 的 VideoEncoder 能给出精确的
 * timestamp，但只吐裸 VP8/VP9 码流，容器得自己封。
 *
 * 这里只实现「单条视频轨 + 已知帧率」这一种最小合法结构：
 *   EBML 头 → Segment{ Info, Tracks, Cluster×N, Cues }
 * 每个 keyframe 开一个新 Cluster（顺带让拖动进度条能精确落点），
 * 末尾补一份 Cues 索引。音频轨一律不管（导出的产品演示不要音轨）。
 *
 * 只依赖 Uint8Array / DataView / Blob，没有任何外部库。
 */
(() => {
  /* Matroska / WebM 元素 ID */
  const T = {
    EBML: 0x1a45dfa3,
    EBMLVersion: 0x4286,
    EBMLReadVersion: 0x42f7,
    EBMLMaxIDLength: 0x42f2,
    EBMLMaxSizeLength: 0x42f3,
    DocType: 0x4282,
    DocTypeVersion: 0x4287,
    DocTypeReadVersion: 0x4285,

    Segment: 0x18538067,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    MuxingApp: 0x4d80,
    WritingApp: 0x5741,
    Duration: 0x4489,

    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    FlagLacing: 0x9c,
    CodecID: 0x86,
    DefaultDuration: 0x23e383,
    Video: 0xe0,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,

    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,

    Cues: 0x1c53bb6b,
    CuePoint: 0xbb,
    CueTime: 0xb3,
    CueTrackPositions: 0xb7,
    CueTrack: 0xf7,
    CueClusterPosition: 0xf1,
  };

  const enc = new TextEncoder();

  function cat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** 元素 ID 本身自带长度标记，按有效字节写出去即可 */
  function idBytes(id) {
    const a = [];
    let v = id;
    while (v > 0) { a.unshift(v % 256); v = Math.floor(v / 256); }
    return new Uint8Array(a);
  }

  /** EBML 变长整数（用于元素长度） */
  function sizeBytes(n) {
    let L = 1;
    while (n >= 2 ** (7 * L) - 1) L++;
    const out = new Uint8Array(L);
    let v = n;
    for (let i = L - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    out[0] |= 0x80 >> (L - 1);
    return out;
  }

  function uintBytes(n) {
    if (n === 0) return new Uint8Array([0]);
    const a = [];
    let v = n;
    while (v > 0) { a.unshift(v % 256); v = Math.floor(v / 256); }
    return new Uint8Array(a);
  }

  const el = (id, payload) => cat([idBytes(id), sizeBytes(payload.length), payload]);
  const elUint = (id, n) => el(id, uintBytes(n));
  const elStr = (id, s) => el(id, enc.encode(s));
  function elFloat(id, x) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, x, false);
    return el(id, b);
  }

  function ebmlHeader() {
    return el(T.EBML, cat([
      elUint(T.EBMLVersion, 1),
      elUint(T.EBMLReadVersion, 1),
      elUint(T.EBMLMaxIDLength, 4),
      elUint(T.EBMLMaxSizeLength, 8),
      elStr(T.DocType, 'webm'),
      elUint(T.DocTypeVersion, 4),
      elUint(T.DocTypeReadVersion, 2),
    ]));
  }

  /**
   * @param {object} o
   * @param {number} o.width   像素宽
   * @param {number} o.height  像素高
   * @param {string} o.codec   'V_VP9' / 'V_VP8'
   * @param {number} o.fps     帧率（写进 DefaultDuration）
   * @param {number} o.frames  总帧数（算 Duration）
   */
  function create({ width, height, codec = 'V_VP9', fps = 30, frames = 0 }) {
    const clusters = [];
    let cur = null;
    let count = 0;
    let lastMs = 0;

    function startCluster(ms) {
      cur = { timecode: ms, parts: [], bytes: 0 };
      clusters.push(cur);
    }

    /**
     * @param {{timestamp:number, type:string, byteLength:number, copyTo:Function}} chunk
     */
    function addChunk(chunk) {
      // 时间码单位是 1ms（TimecodeScale=1000000ns）
      const ms = Math.max(0, Math.round(chunk.timestamp / 1000));
      const isKey = chunk.type === 'key';
      // keyframe 开新 Cluster；相对时间码超过 30s 也必须换（SimpleBlock 只有 int16）
      if (!cur || (isKey && cur.bytes > 0) || ms - cur.timecode > 30000) startCluster(ms);
      const rel = ms - cur.timecode;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const head = new Uint8Array(4);
      head[0] = 0x81; // 轨道号 1，不用 lacing
      head[1] = (rel >> 8) & 0xff;
      head[2] = rel & 0xff;
      head[3] = isKey ? 0x80 : 0x00;
      const block = el(T.SimpleBlock, cat([head, data]));
      cur.parts.push(block);
      cur.bytes += block.length;
      count++;
      lastMs = Math.max(lastMs, ms);
    }

    function finish() {
      if (!count) throw new Error('没有可封装的视频帧');

      const clusterParts = clusters.map((c) => el(T.Cluster, cat([
        elUint(T.Timecode, c.timecode),
        ...c.parts,
      ])));

      const info = el(T.Info, cat([
        elUint(T.TimecodeScale, 1000000),
        elStr(T.MuxingApp, 'LiveMockup'),
        elStr(T.WritingApp, 'LiveMockup'),
        // Duration 用时间码单位（ms）
        elFloat(T.Duration, Math.max(lastMs + Math.round(1000 / Math.max(1, fps)), Math.round((frames * 1000) / Math.max(1, fps)))),
      ]));

      const tracks = el(T.Tracks, el(T.TrackEntry, cat([
        elUint(T.TrackNumber, 1),
        elUint(T.TrackUID, 1),
        elUint(T.TrackType, 1),          // 1 = video
        elUint(T.FlagLacing, 0),
        elStr(T.CodecID, codec),
        elUint(T.DefaultDuration, Math.round(1e9 / Math.max(1, fps))),
        el(T.Video, cat([
          elUint(T.PixelWidth, Math.round(width)),
          elUint(T.PixelHeight, Math.round(height)),
        ])),
      ])));

      // CueClusterPosition 是相对 Segment 数据区起点的偏移
      let offset = info.length + tracks.length;
      const cuePoints = [];
      clusters.forEach((c, i) => {
        cuePoints.push(el(T.CuePoint, cat([
          elUint(T.CueTime, c.timecode),
          el(T.CueTrackPositions, cat([
            elUint(T.CueTrack, 1),
            elUint(T.CueClusterPosition, offset),
          ])),
        ])));
        offset += clusterParts[i].length;
      });
      const cues = el(T.Cues, cat(cuePoints));

      const payload = [info, tracks, ...clusterParts, cues];
      const payloadLen = payload.reduce((a, p) => a + p.length, 0);
      const segmentHead = cat([idBytes(T.Segment), sizeBytes(payloadLen)]);

      return new Blob([ebmlHeader(), segmentHead, ...payload], { type: 'video/webm' });
    }

    return { addChunk, finish, get count() { return count; } };
  }

  window.WebmMuxer = { create };
})();
