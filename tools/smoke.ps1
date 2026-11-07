# 设备端冒烟测试：推面板 → 重启 App → 点一个灯 → 检查日志
# 用法： powershell -ExecutionPolicy Bypass -File .\tools\smoke.ps1 [-KeepShot]
# 退出码 0 = 全部通过。截图存到 build\smoke-*.png（-KeepShot 时保留）
param([switch]$KeepShot)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$adb = 'D:\Software\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { Write-Host '找不到 adb：' $adb -ForegroundColor Red; exit 2 }

$fails = 0
function Check($ok, $name, $extra) {
  if ($ok) { Write-Host ('  PASS  ' + $name) -ForegroundColor Green }
  else { Write-Host ('  FAIL  ' + $name + $(if ($extra) { '  -> ' + $extra } else { '' })) -ForegroundColor Red; $script:fails++ }
}

function Adb([string[]]$argList) {
  # 经 cmd 调用并把 stderr 丢给 nul：adb 的进度都走 stderr，直接调会被 PowerShell 当错误记录
  $line = '"' + $adb + '" ' + ($argList -join ' ') + ' 2>nul'
  return (cmd /c $line)
}

function Shot($name) {
  $p = Join-Path $root ("build\smoke-$name.png")
  Adb @('shell', 'screencap', '-p', "/sdcard/smoke-$name.png") | Out-Null
  Adb @('pull', "/sdcard/smoke-$name.png", $p) | Out-Null
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($p)
  $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)
  $out = Join-Path $root ("build\smoke-$name-rot.png")
  $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  if (-not $KeepShot) { Remove-Item $p -ErrorAction SilentlyContinue }
  return $out
}

Write-Host '=== 1. 设备在线 ==='
$dev = (Adb @('devices')) -join "`n"
Check ($dev -match 'device\s*$') 'adb 能看到设备' $dev

Write-Host '=== 2. 推面板并重启 App ==='
# push.ps1 会把 adb 的进度写到 stderr，这里整体静音，成败由后面的日志判断
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'tools\push.ps1') -Restart *> $null
$ErrorActionPreference = $prevEap
Adb @('logcat', '-c') | Out-Null
Adb @('shell', 'am', 'force-stop', 'com.homecontrol.panel') | Out-Null
Adb @('shell', 'am', 'start', '-n', 'com.homecontrol.panel/.MainActivity') | Out-Null
Start-Sleep -Seconds 6

$log = (Adb @('logcat', '-d')) -join "`n"
Check ($log -match 'page finished:') '面板页面加载完成' 
Check ($log -notmatch 'Uncaught|SyntaxError|JSBERR') '无 JS 语法/运行错误' (($log -split "`n" | Select-String 'JSBERR|Uncaught|SyntaxError' | Select-Object -First 2) -join ' | ')

$focus = (Adb @('shell', 'dumpsys', 'window')) -join "`n"
Check ($focus -match 'mCurrentFocus=.*com\.homecontrol\.panel') '前台是壳 App' 

Write-Host '=== 3. 点卡片（灯带）===' 
# 熄屏保护：先确认屏幕亮着
Adb @('shell', 'input', 'keyevent', '224') | Out-Null
Start-Sleep -Milliseconds 600
# 首次启动可能弹出「接入引导」遮罩：先点一下关掉，避免挡住卡片
Adb @('shell', 'input', 'swipe', '1024', '300', '1026', '302', '120') | Out-Null
Start-Sleep -Milliseconds 700
Adb @('logcat', '-c') | Out-Null
Adb @('shell', 'input', 'swipe', '779', '788', '781', '790', '150') | Out-Null
Start-Sleep -Milliseconds 1500
$log2 = (Adb @('logcat', '-d')) -join "`n"
Check ($log2 -match 'ACT toggle ') '点击触发了一次操作（logcat: ACT toggle …）' (($log2 -split "`n" | Select-String 'ACT |JSBERR' | Select-Object -First 3) -join ' | ')
Check ($log2 -notmatch 'JSBERR') '点击后无 JS 报错'

Write-Host '=== 4. 截图存档 ==='
$shot = Shot 'home'
Write-Host ('  build\smoke-home-rot.png  ' + $shot)

if ($fails -eq 0) { Write-Host "`nSMOKE PASS" -ForegroundColor Green; exit 0 }
else { Write-Host "`n$fails 项失败" -ForegroundColor Red; exit 1 }
