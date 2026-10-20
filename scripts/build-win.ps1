param([switch]$Dir)

# LiveMockup -> Windows 安装包 / 便携版
#
# 做什么：
#   1. 把 ffmpeg.exe 放进 client/bin（随包发布，用户不用自己装）
#   2. 装依赖（首次）
#   3. electron-builder 出 NSIS 安装包 + 便携版单文件 exe
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1 -Dir   # 只解包，不压缩（快）

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$client = Join-Path $repo 'client'

function Log($m) { Write-Host "[build] $m" }

# 1) ffmpeg
$binDir = Join-Path $client 'bin'
$ffmpeg = Join-Path $binDir 'ffmpeg.exe'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
if (-not (Test-Path $ffmpeg)) {
  $sys = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
  if (-not $sys) { throw 'ffmpeg.exe not found: put it at client\bin\ffmpeg.exe or add it to PATH' }
  Copy-Item $sys $ffmpeg
  Log "ffmpeg bundled: $ffmpeg"
} else {
  Log 'ffmpeg already bundled'
}

# 2) 依赖
if (-not (Test-Path (Join-Path $client 'node_modules\electron-builder'))) {
  Log 'installing dependencies…'
  Push-Location $client
  npm install --no-audit --no-fund
  Pop-Location
}

# 3) 镜像（GitHub 不可达时 electron / NSIS 都从这里下）
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

Log 'building…'
Push-Location $client
try {
  if ($Dir) { npx electron-builder --win --x64 --dir } else { npx electron-builder --win --x64 }
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) { throw "electron-builder failed, exit code $code" }

$dist = Join-Path $repo 'dist'
Log 'artifacts:'
Get-ChildItem $dist -Filter '*.exe' | ForEach-Object {
  Log ("  " + $_.Name + "  (" + [math]::Round($_.Length / 1MB, 1) + " MB)")
}
$unpacked = Join-Path $dist 'win-unpacked\LiveMockup.exe'
if (Test-Path $unpacked) { Log ("  unpacked: " + $unpacked) }
