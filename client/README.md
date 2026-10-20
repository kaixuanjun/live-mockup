# LiveMockup 客户端（Windows 先行）

同一个 `public/` UI，两套壳：Windows 用 Electron，Android 用 Capacitor。
壳只加「浏览器做不到的能力」，界面和核心逻辑不复制第二份 —— 浏览器里打开
`node server.mjs` 仍然照旧可用。

## 为什么值得做成客户端

| 浏览器里的限制 | 客户端里怎么解决 |
| --- | --- |
| 导出只能走 WebCodecs（VP9/WebM，码率有上限） | 每帧原始像素直接喂 **ffmpeg**，出 **H.264 / MP4，CRF 可控** |
| 视频取帧靠 `currentTime` seek，4K 源每帧上百毫秒 | 仍是 seek，但编码不再排队压测浏览器编码器；后续可换成 ffmpeg 直解 |
| 用哪块 GPU 由系统和浏览器决定 | 主进程带 `--ignore-gpu-blocklist` / 零拷贝等开关；`gpu-prefs.mjs` 仍可一键写系统偏好 |
| 窗口在后台会被降频 | `disable-background-timer-throttling` / `disable-renderer-backgrounding` |
| 导出只能落到「下载」目录 | 原生保存对话框，导出完直接定位到文件 |

## 跑起来

```bash
cd client
npm install        # 首次；GitHub 不通时用镜像见下
npm start          # 打开客户端窗口
```

国内网络装 Electron 二进制（GitHub 常被墙）：

```powershell
cd client
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

## 目录

```
client/
├── main.mjs        # 主进程：app:// 静态服务、原生保存/打开、ffmpeg 任务、GPU 开关
├── preload.mjs     # contextBridge → window.LM（页面只多这一个对象）
├── package.json
└── .smoke/         # 冒烟测试产物（已 gitignore）
public/             # 与浏览器版共用的全部 UI 与业务逻辑
```

页面侧靠能力检测：`window.LM && window.LM.isClient` 才走原生路径，
否则自动退回浏览器行为（`Exporter.download` 用 `a[download]`、导出用 WebCodecs）。

## 显卡面板（客户端里不需要 HTTP 服务器）

浏览器版是「页面 → fetch /api/gpu/* → localhost 服务器 → 注册表」；
客户端里没有那个服务器，所以改走 IPC：

```
gpu-panel.js  ──window.LM.gpu.*──▶  主进程  ──spawn(ELECTRON_RUN_AS_NODE)──▶  gpu-prefs.mjs
                                     │                                        │
                                     └──── reg query（读） / PowerShell（写） ◀┘
```

踩过的两个坑，都写进代码注释了：

1. **`reg.exe add` 在 Electron 引起的进程树里会被拒**（0x5 拒绝访问），而 `reg query` 正常、
   同一个调用从普通 node 进程又没问题 —— 所以写入改用 PowerShell 的 `Set-ItemProperty`（.NET API），
   并且把写操作放到 `client/node/gpu-write.cjs`（纯 Node 子进程）里执行，减少变量。
2. **某些受限环境（容器 / 沙箱）连 PowerShell 都不给子进程写注册表**。这时冒烟测试会
   明确标注「本环境受限，跳过写入校验」，不会伪装成通过 —— 链路本身（IPC → 子进程 → 模块）照样验证。

## 原生导出怎么走

```
render.js  render()  ──每帧──▶  nativeSink
                                   │ 2D 画布取像素 (RGBA)
                                   ▼
                        window.LM.job.frame(Uint8ClampedArray)
                                   │ IPC
                                   ▼
                    主进程 ffmpeg  stdin ← rawvideo
                                   │
                                   ▼
                      out.mp4  (libx264, CRF 16, faststart)
```

返回的是 `{ native: true, path, size, frames, crf }` 而不是 Blob —— 文件已经落盘，
界面只负责提示和「在文件夹中显示」。

## 冒烟测试

```bash
node tools/client-test.mjs        # 从仓库根目录跑
```

会在隐藏窗口里：加载真实 UI → 检查原生桥接/样式/ffmpeg → 造一段视频 →
**走一次原生编码 → 用 ffprobe 校验产出是 H.264 / 640×360 / 30fps / MP4**。

## 还没做的（下一步）

- **Android**：Capacitor 容器 + 同一套 UI；导出先走 WebView 的 WebCodecs，
  随后加 `MediaCodec` 插件把编码搬到原生（这才是安卓真正提速的地方）。
- **Windows 打包**：electron-builder 出安装包（需要一次 `npm i -D electron-builder`）。
- **取帧搬到原生**：用 ffmpeg 直接解视频帧，彻底绕开 `<video>` seek 的 100ms/帧。
