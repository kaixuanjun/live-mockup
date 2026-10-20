/**
 * LiveMockup 客户端 · 渲染进程 ↔ 主进程的桥
 *
 * 只暴露具体能力，不暴露 Node —— 页面代码仍然当自己是浏览器环境，
 * 只是多了一个 window.LM，能力检测不到就自动退回浏览器路径。
 */
const { contextBridge, ipcRenderer } = require('electron');

const toBytes = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
};

contextBridge.exposeInMainWorld('LM', {
  /** 客户端标记：页面用它判断要不要走原生路径 */
  isClient: true,
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** 主进程信息：显卡、ffmpeg、路径 */
  info: () => ipcRenderer.invoke('lm:info'),

  /** 保存（原生对话框） */
  save: (data, name, filters) => ipcRenderer.invoke('lm:save', { data: toBytes(data), name, filters }),

  /** 打开（原生对话框 + 读回文本） */
  open: (filters) => ipcRenderer.invoke('lm:open', { filters }),

  /** 在文件管理器里定位 */
  reveal: (p) => ipcRenderer.invoke('lm:reveal', p),

  /* ── 原生导出：把原始帧交给 ffmpeg ── */
  job: {
    begin: (opts) => ipcRenderer.invoke('lm:job:begin', opts),
    frame: (pixels) => ipcRenderer.invoke('lm:job:frame', pixels),
    end: () => ipcRenderer.invoke('lm:job:end'),
    abort: () => ipcRenderer.invoke('lm:job:abort'),
  },

  /** 显卡偏好（客户端直接写系统设置，不需要 HTTP 服务器） */
  gpu: {
    status: () => ipcRenderer.invoke('lm:gpu:status'),
    apply: (exe, level) => ipcRenderer.invoke('lm:gpu:apply', { exe, level }),
    restore: (exe) => ipcRenderer.invoke('lm:gpu:restore', { exe }),
  },

  /** 主进程消息（订阅） */
  onMessage: (fn) => {
    const handler = (_e, payload) => { try { fn(payload); } catch (_) {} };
    ipcRenderer.on('lm:message', handler);
    return () => ipcRenderer.removeListener('lm:message', handler);
  },
});
