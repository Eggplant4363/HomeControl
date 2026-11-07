# 上墙验收：设备在线 -> 应用在 -> 默认桌面是面板 -> 重启后自动拉起 -> 无脚本错误
# 用法: powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
$ErrorActionPreference = 'Continue'
$adb = 'D:\Software\platform-tools\adb.exe'
$root = (Split-Path -Parent $PSScriptRoot)
$out = Join-Path $root 'docs\verify-report.md'
$results = @()
$started = Get-Date

function Adb([string]$a) {
  $o = & cmd /c ('"' + $adb + '" ' + $a + ' 2>nul')
  return (($o | Out-String).Trim())
}
function Add-Result([string]$name, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }
  $mark = 'FAIL'
  if ($ok) { $mark = 'PASS' }
  Write-Host ('[' + $mark + '] ' + $name + ' -- ' + $detail)
}
function Focus() {
  $w = Adb 'shell dumpsys window'
  foreach ($line in ($w -split "`n")) {
    if ($line -match 'mCurrentFocus=Window\{\S+ \S+ ([\w\.]+)/(\S+)\}') { return ($Matches[1] + '/' + $Matches[2]) }
  }
  return ''
}

Write-Host '=== 1. 设备在线 ==='
$model = Adb 'shell getprop ro.product.model'
Add-Result '设备在线' ($model.Length -gt 0) ($model)

Write-Host '=== 2. 应用已安装 ==='
$pkg = Adb 'shell dumpsys package com.homecontrol.panel'
$ver = ''
if ($pkg -match 'versionName=(\S+)') { $ver = $Matches[1] }
Add-Result '中控屏已安装' ($ver.Length -gt 0) ('versionName=' + $ver)

Write-Host '=== 3. 默认桌面 ==='
Adb 'shell input keyevent 3' | Out-Null
Start-Sleep -Seconds 3
$f = Focus
Add-Result '按 HOME 进入面板' ($f -like 'com.homecontrol.panel/*') $f

Write-Host '=== 4. 重启后自动拉起（约 40-70 秒）==='
$rebootAt = Get-Date
Adb 'reboot' | Out-Null
Start-Sleep -Seconds 5
& cmd /c ('"' + $adb + '" wait-for-device 2>nul') | Out-Null
$booted = $false
for ($i = 0; $i -lt 60; $i++) {
  $bc = Adb 'shell getprop sys.boot_completed'
  if ($bc -eq '1') { $booted = $true; break }
  Start-Sleep -Seconds 2
}
Add-Result '系统启动完成' $booted ('sys.boot_completed=' + $booted)

$f2 = ''
$waited = 0
while ($waited -lt 90) {
  $f2 = Focus
  if ($f2 -like 'com.homecontrol.panel/*') { break }
  Start-Sleep -Seconds 1
  $waited++
}
$toPanel = [int]((Get-Date) - $rebootAt).TotalSeconds
Add-Result '重启后自动拉起面板' ($f2 -like 'com.homecontrol.panel/*') ($f2 + '，重启后 ' + $toPanel + ' 秒出现')
$wake = Adb 'shell dumpsys power'
$awake = $wake -match 'mWakefulness=Awake'
Add-Result '屏幕保持唤醒' $awake 'mWakefulness'

$mem = Adb 'shell dumpsys meminfo com.homecontrol.panel'
$pss = ''
foreach ($line in ($mem -split "`n")) {
  if ($line -match 'TOTAL\s+(\d+)') { $pss = $Matches[1] }
}
$pssText = '未知'
if ($pss -ne '') { $pssText = ([int]$pss / 1024).ToString('0.0') + ' MB' }
Add-Result '面板内存占用' ($pss -ne '' -and [int]$pss -lt 200000) ('PSS ' + $pssText)

# 开机后 DHCP 要几秒到几十秒，轮询到拿到非 0.0.0.0 的地址为止
$ip = ''
for ($i = 0; $i -lt 30; $i++) {
  $nf = Adb 'shell netcfg'
  foreach ($line in ($nf -split "`n")) {
    if ($line -match 'wlan0\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/') {
      $cand = $Matches[1]
      if ($cand -ne '0.0.0.0') { $ip = $cand }
    }
  }
  if ($ip -ne '') { break }
  Start-Sleep -Seconds 2
}
Add-Result '设备已连网' ($ip.Length -gt 0) ('wlan0 ' + $ip)

Write-Host '=== 5. 运行期错误 ==='
$errs = Adb 'logcat -d'
$bad = @()
foreach ($line in ($errs -split "`n")) {
  if ($line -match 'JSBERR|Uncaught|SyntaxError|FATAL EXCEPTION') { $bad += $line.Trim() }
}
Add-Result '无脚本错误/崩溃' ($bad.Count -eq 0) ('命中 ' + $bad.Count + ' 条')

Write-Host '=== 6. 截图存档 ==='
Adb 'shell screencap -p /sdcard/verify.png' | Out-Null
& $adb pull /sdcard/verify.png (Join-Path $root 'build\verify.png') 2>$null | Out-Null
if (Test-Path (Join-Path $root 'build\verify.png')) {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile((Join-Path $root 'build\verify.png'))
  $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)
  $img.Save((Join-Path $root 'build\verify-rot.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  Copy-Item (Join-Path $root 'build\verify-rot.png') (Join-Path $root 'docs\screens\panel-verify.png') -Force
  Add-Result '截图存档' $true 'docs/screens/panel-verify.png'
} else {
  Add-Result '截图存档' $false 'pull failed'
}

$failed = @($results | Where-Object { -not $_.Ok })
$lines = @()
$lines += '# 上墙验收报告'
$lines += ''
$lines += ('- 时间：' + $started.ToString('yyyy-MM-dd HH:mm:ss'))
$lines += ('- 设备：' + $model)
$lines += ('- 应用：com.homecontrol.panel ' + $ver)
$lines += ''
$lines += '| 检查项 | 结果 | 详情 |'
$lines += '| --- | --- | --- |'
foreach ($r in $results) {
  $m = 'FAIL'
  if ($r.Ok) { $m = 'PASS' }
  $lines += ('| ' + $r.Name + ' | ' + $m + ' | ' + $r.Detail + ' |')
}
$lines += ''
if ($failed.Count -eq 0) { $lines += '**结论：全部通过**' } else { $lines += ('**结论：' + $failed.Count + ' 项未通过**') }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
[System.IO.File]::WriteAllLines($out, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($failed.Count -eq 0) { Write-Host 'VERIFY PASS'; exit 0 } else { Write-Host ('VERIFY FAIL (' + $failed.Count + ')'); exit 1 }