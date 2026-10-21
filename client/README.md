# LiveMockup 客户端（Windows 先行）

同一个 `public/` UI + Electron 壳。壳只加「浏览器做不到的能力」，界面和核心逻辑不复制第二份 ——
浏览器里打开 `node server.mjs` 仍然照旧可用。

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

## 取帧：ffmpeg 顺序解码（不再 `<video>` seek）

浏览器版每帧都要 `video.currentTime = t` 再等 `seeked`，1080p 实测 **68ms/帧**。
客户端里让 ffmpeg 一次性顺序解码、按输出帧率出帧，实测 **13ms/帧（约 5 倍）**。

中间踩了一个反直觉的坑：瓶颈不在解码，在**进程间传帧**。

| 传输方式 | 每帧体积 | 实测 | 说明 |
| --- | --- | --- | --- |
| `raw`（RGBA 原始像素） | 7.9 MB | **182 ms/帧** | 解码很快，但传 8MB 成了瓶颈 |
| `jpeg`（q=2 的 mjpeg） | 94 KB | **13 ms/帧** | 体积小两个数量级，IPC 不再拖后腿 |

所以默认走 jpeg 通道（`decode.transport = "jpeg"`、`quality = 2`）。对「UI 录屏」肉眼基本无损，
最终还要过一次 H.264；要绝对无损可把 `render.js` 里 `dec` 的 `transport` 改成 `"raw"`（会慢）。

前提：得拿到**磁盘上的真实路径**（`webUtils.getPathForFile`）。从 `<input type=file>` / 拖拽进来
的文件可以；合成 Blob 不行，会自动退回 `<video>` seek。

## 保存到哪

原生保存对话框默认落在系统「视频」目录，不再用项目目录（OneDrive / 受保护目录会被 Windows 反过来要管理员权限）。
写失败会提示换目录，而不是丢一个 `EACCES`。

> 从**受限环境**（沙箱 / 容器 / 某些远程会话）启动 exe 时，系统和 Chromium 会挡掉工作区外的写入 ——
> 那不是程序的权限问题，用普通桌面会话（双击）启动即可。

## 打包 exe

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
# 产物：
#   dist/LiveMockup-<版本>-x64.exe        NSIS 安装包（可选安装目录、建桌面快捷方式）
#   dist/LiveMockup-<版本>-portable.exe   便携版单文件
```

脚本会把 `ffmpeg.exe` 放进 `client/bin/`（随包发布，用户不用自己装 ffmpeg），并把
Electron / NSIS 的下载指向国内镜像。两个环境限制写死在配置里：

- `signAndEditExecutable: false`：不签名也不改 exe 元数据。electron-builder 默认要下 `winCodeSign`，
  那个包带 macOS 符号链接，普通 Windows 账户没有「创建符号链接」特权，解不开。代价是没有自定义图标/版本信息。
- 缓存目录指到仓库内（`ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` / `TMP`）：受限环境只允许写工作区。

## 冒烟测试

```bash
node tools/client-test.mjs        # 从仓库根目录跑
```

会在隐藏窗口里：加载真实 UI → 检查原生桥接/样式/ffmpeg → 造一段视频 →
**走一次原生编码 → 用 ffprobe 校验产出是 H.264 / 640×360 / 30fps / MP4**。

## 还没做的（下一步）

- **Windows 打包**：目前 `signAndEditExecutable: false`（不签名、不改 exe 元数据），要图标/签名需另配证书。
- **取帧**：已经从 `<video>` seek 换成 ffmpeg 顺序解码；下一步可以让 ffmpeg 直接在 GPU 上做色彩转换。
- **跨平台**：Linux / macOS 的壳还没做（UI 和业务逻辑是现成的）。
