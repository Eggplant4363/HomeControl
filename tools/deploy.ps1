# 一条命令把面板装到平板上：校验设备 -> 装 APK -> 推面板 -> 写 url.txt -> 重启 -> 收尾检查。
# 用法：powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 [-Build] [-Mock] [-SkipApk]
[CmdletBinding()]
param(
    [switch]$Build,     # 先重新构建 APK
    [switch]$Mock,      # 部署成模拟数据模式（删掉 HA 配置）
    [switch]$SkipApk    # 面板改动不必重装 APK 时用
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$adb = "D:\Software\platform-tools\adb.exe"
$apk = Join-Path $root "dist\homecontrol.apk"
$pkg = "com.homecontrol.panel"

function Adb {
    $argList = @($args)
    $out = cmd /c ('"' + $adb + '" ' + ($argList -join ' ') + ' 2>nul')
    return $out
}

$fails = 0
function Step($ok, $name, $extra) {
    if ($ok) { Write-Host ("  OK    " + $name) -ForegroundColor Green }
    else {
        Write-Host ("  FAIL  " + $name) -ForegroundColor Red
        if ($extra) { Write-Host ("        " + $extra) -ForegroundColor DarkGray }
        $script:fails++
    }
}

Write-Host "=== 1. 设备 ==="
$devices = (Adb devices) -join "`n"
$online = $devices -match 'device$' -or $devices -match "`tdevice"
Step $online "adb 能看到在线设备" ($devices -replace "`n", ' | ')
if (-not $online) {
    Write-Host ""
    Write-Host "平板不在线。常见原因与处理：" -ForegroundColor Yellow
    Write-Host "  · 显示 offline：长按电源键 10 秒强制重启，或拔插 USB"
    Write-Host "  · 完全没有设备：检查 USB 线/口，确认已开 USB 调试"
    exit 1
}

if ($Build) {
    Write-Host "=== 2. 构建 ==="
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build.ps1") | Out-Null
    Step (Test-Path $apk) "APK 已生成（$([math]::Round((Get-Item $apk).Length/1KB)) KB）"
}

if (-not $SkipApk) {
    Write-Host "=== 3. 安装 APK ==="
    $r = (Adb install -r $apk) -join "`n"
    Step ($r -match 'Success') "安装成功" $r
}

Write-Host "=== 4. 推送面板 ==="
$panel = Join-Path $root "panel"
$r = (Adb shell "mkdir -p /sdcard/HomeControl/panel") -join ''
Adb push ($panel + "\.") "/sdcard/HomeControl/panel/" | Out-Null
Adb shell "echo file:///sdcard/HomeControl/panel/index.html > /sdcard/HomeControl/url.txt" | Out-Null
$url = (Adb shell "cat /sdcard/HomeControl/url.txt") -join ''
Step ($url -match 'file:///sdcard/HomeControl/panel/index.html') "url.txt 指向面板" $url

if ($Mock) {
    Adb shell "rm -f /sdcard/HomeControl/ha.json /sdcard/HomeControl/mockha.enabled /sdcard/HomeControl/mockha.nows" | Out-Null
    Write-Host "  （已切到模拟数据模式）" -ForegroundColor DarkGray
} else {
    # 根目录有 ha.json 就一起推上去：里面是 HA 地址与长期访问令牌
    $haFile = Join-Path $root "ha.json"
    if (Test-Path $haFile) {
        Adb push $haFile "/sdcard/HomeControl/ha.json" | Out-Null
        $ha = (Adb shell "cat /sdcard/HomeControl/ha.json") -join ''
        $script:haPushed = $true
        Step ($ha -match '"url"') "ha.json 已推送（真实 HA 模式）" $ha
    } else {
        Write-Host "  （根目录没有 ha.json，保持面板当前配置）" -ForegroundColor DarkGray
    }
}

Write-Host "=== 5. 重启面板 ==="
Adb logcat -c | Out-Null
Adb shell "am force-stop $pkg" | Out-Null
Adb shell "am start -n $pkg/.MainActivity" | Out-Null
# 轮询：重启后 WiFi 可能比面板晚到，最多等 40 秒再判定
$nStates = -1
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $log = (Adb logcat -d) -join "`n"
    $mStates = [regex]::Match($log, 'first states .*?实体 (\d+)')
    if ($mStates.Success) { $nStates = [int]$mStates.Groups[1].Value; break }
}
if ($nStates -lt 0) { $log = (Adb logcat -d) -join "`n"; $mStates = [regex]::Match($log, 'first states .*?实体 (\d+)') }
Step ($mStates.Success) "面板已收到 HA 状态（实体 $nStates）"
if ($script:haPushed) {
    # 编辑模式默认一张卡都不加，所以这里判「收到了多少实体」，不再要求卡片数
    Step ($nStates -ge 100) "真实 HA 数据已加载（$nStates 个实体）"
} else {
    Step ($nStates -gt 0 -and $nStates -lt 100) "模拟数据已加载（$nStates 个实体）"
}
Step ($log -match 'page finished:') "面板页面加载完成" (($log -split "`n" | Select-String 'JSBERR|Uncaught|SyntaxError' | Select-Object -First 2) -join ' | ')
Step (-not ($log -match 'Uncaught|SyntaxError|JSBERR')) "无脚本错误"
$focus = (Adb shell "dumpsys window") -join "`n"
Step ($focus -match "mCurrentFocus=.*$pkg") "前台是壳 App"

Write-Host "=== 结果 ==="
if ($fails -eq 0) {
    Write-Host "DEPLOY OK" -ForegroundColor Green
    Write-Host "下一步：长按右上角胶囊填 HA 地址与令牌（或长按左上角时间看诊断）" -ForegroundColor DarkGray
    exit 0
}
Write-Host ("DEPLOY FAIL " + $fails) -ForegroundColor Red
exit 1