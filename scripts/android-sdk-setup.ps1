# Android 工具链安装（Windows 版，仅首次）
#
# 目标：装一套能 `gradlew assembleDebug` 的 Android SDK 到 ASCII 路径（默认 C:\android-sdk）。
# 为什么必须 ASCII：Electron / Gradle / aapt2 在中文路径上都有踩坑记录，
# 这个仓库的路径恰好带中文（桌面-凤纹方尊），所以 SDK 一律装到 C:\ 下。
#
# 用法（管理员或普通用户都行，装的是当前用户的 SDK）：
#   powershell -ExecutionPolicy Bypass -File scripts\android-sdk-setup.ps1

param(
  [string]$SdkRoot = 'C:\android-sdk',
  [string]$CmdToolsBuild = '11076708',
  [string]$Platform = 'android-34',
  [string]$BuildTools = '34.0.0'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Log($msg) { Write-Host "[android] $msg" }

if ($SdkRoot -match '[^\x00-\x7F]') {
  throw "SDK 路径必须是纯 ASCII：$SdkRoot"
}

New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null
$cmdDir = Join-Path $SdkRoot 'cmdline-tools'
$latest = Join-Path $cmdDir 'latest'
$sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'

if (-not (Test-Path $sdkmanager)) {
  $zip = Join-Path $env:TEMP "cmdline-tools-$CmdToolsBuild.zip"
  $url = "https://dl.google.com/android/repository/commandlinetools-win-${CmdToolsBuild}_latest.zip"
  Log "下载 cmdline-tools：$url"
  if (-not (Test-Path $zip)) {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
  Log ('解压 ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB')
  $tmp = Join-Path $env:TEMP 'cmdline-tools-extract'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Remove-Item $latest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') $latest
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot

Log '接受许可协议'
$yes = ("y`n" * 60)
$yes | & $sdkmanager --sdk_root=$SdkRoot --licenses | Out-Null

Log "安装 platform-tools / platforms;$Platform / build-tools;$BuildTools"
& $sdkmanager --sdk_root=$SdkRoot "platform-tools" "platforms;$Platform" "build-tools;$BuildTools"

# gradle 用得到的关键路径
$envFile = Join-Path $SdkRoot 'env.txt'
@"
ANDROID_HOME=$SdkRoot
ANDROID_SDK_ROOT=$SdkRoot
JAVA_HOME=$env:JAVA_HOME
"@ | Set-Content $envFile -Encoding ASCII

Log '完成。检查：'
& (Join-Path $SdkRoot 'platform-tools\adb.exe') version | Select-Object -First 1
Log ("SDK: " + $SdkRoot)
Log '后续构建前设置环境变量：$env:ANDROID_HOME / $env:ANDROID_SDK_ROOT'
