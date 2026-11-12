param(
  [switch]$Build,
  [switch]$Restart,
  [switch]$Mock,
  [switch]$Prod,
  [int]$VersionCode = 0,
  [string]$Serial = ''
)
# 用法：
#   .\tools\push.ps1                 # 只推面板文件（开发模式：url.txt + debug.flag 都开）
#   .\tools\push.ps1 -Restart        # 推完并重启 App
#   .\tools\push.ps1 -Build -Restart # 重编 APK、安装、推面板、重启
#   .\tools\push.ps1 -Mock           # 推完后删掉 ha.json，回到模拟数据模式
#   .\tools\push.ps1 -Prod           # 正式部署：不写 url.txt / debug.flag，面板走 APK 内置资源
#   .\tools\push.ps1 -Serial 10.10.1.78:5555   # 插着模拟器/多台设备时指定推给哪台
#
# 设备号：-Serial 优先，其次 $env:HC_DEVICE，最后 $env:ANDROID_SERIAL（adb 自己认这个变量）。
# SDK/JDK/adb 的位置全部来自 tools\env.ps1，别在这里写死绝对路径。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')
$adb = $Adb

if ($Serial) { $env:ANDROID_SERIAL = $Serial }
if (-not $env:ANDROID_SERIAL) {
  $devs = @(& $adb devices | Select-String -Pattern "\sdevice$" | ForEach-Object { ($_.Line -split "\s+")[0] })
  if ($devs.Count -gt 1) {
    throw ('connected ' + $devs.Count + ' devices: ' + ($devs -join ', ') + ' -- use -Serial or set $env:HC_DEVICE')
  }
}

if ($Build) {
  $buildArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build.ps1'))
  if ($VersionCode -gt 0) { $buildArgs += @('-VersionCode', $VersionCode) }
  & powershell @buildArgs
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  & $adb install -r (Join-Path $root 'dist\homecontrol.apk')
  # targetSdk 还是 22，Android 13 上存储权限必须手动给（安装后弹 MIUI 授权页容易漏）；
  # Android 5/6（SDK<23）没有运行时权限，pm grant 反而报错，所以按 SDK 分流
  $sdk = [int]((& $adb shell 'getprop ro.build.version.sdk') -join '')
  if ($sdk -ge 23) {
    & $adb shell 'pm grant com.homecontrol.panel android.permission.WRITE_EXTERNAL_STORAGE' 2>$null | Out-Null
    & $adb shell 'pm grant com.homecontrol.panel android.permission.READ_EXTERNAL_STORAGE' 2>$null | Out-Null
  }
}

if ($Prod) {
  # 正式部署：调试通道全部关掉（CDP 端口、url.txt 劫持、假 HA）
  & $adb shell 'rm -f /sdcard/HomeControl/debug.flag /sdcard/HomeControl/url.txt'
  Write-Host '==> prod mode (no debug.flag / url.txt)'
} else {
  Write-Host '==> push panel to /sdcard/HomeControl/panel'
  & $adb shell 'mkdir -p /sdcard/HomeControl/panel'
  & $adb push (Join-Path $root 'panel\.') '/sdcard/HomeControl/panel/' | Out-Null
  & $adb shell 'echo file:///sdcard/HomeControl/panel/index.html > /sdcard/HomeControl/url.txt'
  # 开发开关：CDP(:9222)、url.txt 覆盖、假 HA 都只在 debug.flag 存在时才生效
  $flag = Join-Path $env:TEMP 'homecontrol-debug.flag'
  [System.IO.File]::WriteAllText($flag, 'dev', (New-Object System.Text.UTF8Encoding($false)))
  & $adb push $flag '/sdcard/HomeControl/debug.flag' | Out-Null

  # 热更新信号：面板轮询这个文件的 mtime，变了就 reload（不用重启 App）
  $rev = Join-Path $env:TEMP 'homecontrol-panel-rev.txt'
  [System.IO.File]::WriteAllText($rev, [string][DateTime]::Now.Ticks, (New-Object System.Text.UTF8Encoding($false)))
  & $adb push $rev '/sdcard/HomeControl/panel/.rev' | Out-Null
  Write-Host '==> .rev pushed (panel will hot-reload within 2s)'
}

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
