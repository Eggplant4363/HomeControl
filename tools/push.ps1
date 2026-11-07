param(
  [switch]$Build,
  [switch]$Restart,
  [switch]$Mock,
  [string]$Serial = ''
)
# 用法：
#   .\tools\push.ps1                 # 只推面板文件
#   .\tools\push.ps1 -Restart        # 推完并重启 App
#   .\tools\push.ps1 -Build -Restart # 重编 APK、安装、推面板、重启
#   .\tools\push.ps1 -Mock           # 推完后删掉 ha.json，回到模拟数据模式
#   .\tools\push.ps1 -Serial 10.10.1.78:5555   # 插着模拟器/多台设备时指定推给哪台
$ErrorActionPreference = 'Stop'
$adb = 'D:\Software\platform-tools\adb.exe'
$root = Split-Path -Parent $PSScriptRoot

# 多台设备时 adb 会报 "more than one device/emulator"；-Serial 或已有的
# 环境变量 ANDROID_SERIAL 都能指定目标（adb 自己就认这个变量）。
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
if (-not $env:ANDROID_SERIAL) {
  $devs = @(& $adb devices | Select-String -Pattern "\sdevice$" | ForEach-Object { ($_.Line -split "\s+")[0] })
  if ($devs.Count -gt 1) {
    throw ('connected ' + $devs.Count + ' devices: ' + ($devs -join ', ') + ' -- use -Serial or set $env:ANDROID_SERIAL')
  }
}

if ($Build) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  & $adb install -r (Join-Path $root 'dist\homecontrol.apk')
}

Write-Host '==> push panel to /sdcard/HomeControl/panel'
& $adb shell 'mkdir -p /sdcard/HomeControl/panel'
& $adb push (Join-Path $root 'panel\.') '/sdcard/HomeControl/panel/' | Out-Null
& $adb shell 'echo file:///sdcard/HomeControl/panel/index.html > /sdcard/HomeControl/url.txt'

# 热更新信号：面板会轮询这个文件的 mtime，变了就 reload（不用重启 App）
$rev = Join-Path $env:TEMP 'homecontrol-panel-rev.txt'
[System.IO.File]::WriteAllText($rev, [string][DateTime]::Now.Ticks, (New-Object System.Text.UTF8Encoding($false)))
& $adb push $rev '/sdcard/HomeControl/panel/.rev' | Out-Null
Write-Host '==> .rev pushed (panel will hot-reload within 2s)'

# HA 配置：项目根目录有 ha.json 就一起推上去（面板启动时读它切到真实模式）
$haFile = Join-Path $root 'ha.json'
if ($Mock) {
  & $adb shell 'rm -f /sdcard/HomeControl/ha.json'
  Write-Host '==> ha.json removed (mock data mode)'
} elseif (Test-Path $haFile) {
  & $adb push $haFile '/sdcard/HomeControl/ha.json' | Out-Null
  Write-Host '==> ha.json pushed (real HA mode)'
} else {
  Write-Host '==> no ha.json in project root, keep whatever is on device'
}

if ($Restart) {
  & $adb shell 'am force-stop com.homecontrol.panel'
  Start-Sleep -Milliseconds 400
  & $adb shell 'am start -n com.homecontrol.panel/.MainActivity' | Out-Null
  Start-Sleep -Seconds 3
  & $adb logcat -d -s HomePanel:* | Select-Object -Last 8
}

Write-Host '==> done'
