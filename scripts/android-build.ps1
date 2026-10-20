# LiveMockup Android 构建（一条命令）
#
# 为什么要有这个脚本：这个仓库的路径带中文（桌面-凤纹方尊），
# Android Gradle Plugin 默认会对非 ASCII 路径直接报错。脚本负责：
#   1) 检查 SDK / JDK / 依赖
#   2) 把 public/ 同步进原生工程
#   3) 加 android.overridePathCheck=true 后构建
#   4) 把 APK 复制到 dist/ 便于分发
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\android-build.ps1

param(
  [string]$SdkRoot = 'C:\android-sdk',
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $repo 'client-android\android'
$apkRel = if ($Release) { 'app\build\outputs\apk\release\app-release-unsigned.apk' } else { 'app\build\outputs\apk\debug\app-debug.apk' }

function Log($m) { Write-Host "[android] $m" }

if (-not (Test-Path (Join-Path $SdkRoot 'platform-tools\adb.exe'))) {
  throw "没找到 Android SDK：$SdkRoot（先跑 scripts\android-sdk-setup.ps1）"
}
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot

if (-not (Test-Path 'C:\android-sdk\cmdline-tools\latest')) { throw 'SDK 不完整' }

# 1) 依赖装过没
if (-not (Test-Path (Join-Path $repo 'client-android\node_modules\@capacitor\cli'))) {
  Log '安装 Capacitor 依赖…'
  Push-Location (Join-Path $repo 'client-android')
  npm install --no-audit --no-fund
  Pop-Location
}

# 2) 原生工程在不在
if (-not (Test-Path $androidDir)) {
  Log '生成 Android 原生工程…'
  Push-Location (Join-Path $repo 'client-android')
  npx cap add android
  Pop-Location
}

# 3) 同步 web 资源（public/ → android/app/src/main/assets/public）
Log '同步 public/ 到原生工程'
Push-Location (Join-Path $repo 'client-android')
npx cap sync android
Pop-Location

# 4) 路径检查开关（AGP 对非 ASCII 路径会直接失败）
$gradleProps = Join-Path $androidDir 'gradle.properties'
$content = if (Test-Path $gradleProps) { Get-Content $gradleProps -Raw } else { '' }
if ($content -notmatch 'android\.overridePathCheck') {
  Add-Content -Path $gradleProps -Value "`nandroid.overridePathCheck=true" -Encoding ASCII
}
# local.properties：告诉 Gradle SDK 在哪
$sdkDir = $SdkRoot -replace '\\', '\\'
Set-Content -Path (Join-Path $androidDir 'local.properties') -Value "sdk.dir=$sdkDir" -Encoding ASCII

# 5) 构建
Log '开始构建（首次会下 Gradle / 依赖，几分钟）'
Push-Location $androidDir
$task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
& .\gradlew.bat $task --no-daemon
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "gradle build failed, exit code $code" }

$apk = Join-Path $androidDir $apkRel
if (-not (Test-Path $apk)) { throw "没找到产物：$apk" }

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$suffix = if ($Release) { 'release' } else { 'debug' }
$target = Join-Path $dist ('livemockup-android-' + $suffix + '.apk')
Copy-Item $apk $target -Force

$size = [math]::Round((Get-Item $target).Length / 1MB, 2)
Log "完成：$target ($size MB)"
Log '装到手机（开 USB 调试）：'
Log ("  " + (Join-Path $SdkRoot 'platform-tools\adb.exe') + " install -r `"$target`"")
