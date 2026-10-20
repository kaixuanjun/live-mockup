# LiveMockup Android 客户端

和 Windows 客户端共用同一份 `public/`（界面 + 业务逻辑），用 **Capacitor** 包成原生 Android 应用。

## 为什么是 Capacitor（而不是 Flutter / 纯 Kotlin）

| 目标 | 说明 |
| --- | --- |
| 代码不分叉 | `public/` 一份，三端（浏览器 / Windows Electron / Android）都跑它 |
| 马上能用 | WebView 就是系统 Chrome，WebCodecs / WebGL2 / MediaRecorder 都在 |
| 后续提速 | 加一个原生插件把编码搬到 `MediaCodec`、解码搬到 `MediaExtractor` 即可，UI 不用动 |

真正的性能上限还是要靠原生那一段（`MediaCodec` 硬编 / `MediaExtractor` 快速抽帧），
Capacitor 只是把壳先立住 —— 这一步先保证「能装到手机上、能编辑、能导出」，
下一轮再把导出搬到原生。

## 首次准备

```powershell
# 1) Android SDK（装到 ASCII 路径，本仓库路径带中文）
powershell -ExecutionPolicy Bypass -File scripts\android-sdk-setup.ps1

# 2) 依赖
cd client-android
npm install

# 3) 生成原生工程（只需一次）
$env:ANDROID_HOME='C:\android-sdk'
npx cap add android
```

## 日常构建

```powershell
cd client-android
$env:ANDROID_HOME='C:\android-sdk'
npm run sync                     # 把 public/ 同步进 android/app/src/main/assets/public
cd android
.\gradlew.bat assembleDebug
```

产物：`client-android/android/app/build/outputs/apk/debug/app-debug.apk`

装到手机（开 USB 调试）：

```powershell
C:\android-sdk\platform-tools\adb.exe install -r app\build\outputs\apk\debug\app-debug.apk
```

## 网络受限时

- Gradle 分发包在 `android/gradle/wrapper/gradle-wrapper.properties` 里，
  默认已指向腾讯云镜像（官方源 `services.gradle.org` 在国内基本下不动）。
  想换回官方：把 `distributionUrl` 改回
  `https\://services.gradle.org/distributions/gradle-8.2.1-all.zip`。
- Maven 依赖走 `google()` + `mavenCentral()`，这两个在国内可达；如果卡住，
  在 `android/build.gradle` 的 `repositories` 前面加阿里云镜像。

## 和 Windows 版的差别

| 能力 | Windows | Android |
| --- | --- | --- |
| 原生 ffmpeg 编码 | ✅ H.264/MP4，CRF 可控 | ⏳ 先走 WebView 的 WebCodecs，下一轮换 `MediaCodec` |
| 原生保存对话框 | ✅ | 系统文件选择器 / `@capacitor/filesystem` |
| GPU 选择 | ✅ 可写系统偏好 | 系统决定（无法干预） |
| 窗口节流 | ✅ 已关闭 | 切后台会暂停（系统限制） |
