# 一条命令把面板装到平板上：校验设备 -> 装 APK -> 授权 -> 推送（复用 push.ps1）-> 重启 -> 收尾检查。
# 用法：powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 [-Build] [-Mock] [-SkipApk] [-Prod] [-Serial <设备号>]
#   -Build    先重新构建 APK（版本号要升就单独跑 tools\build.ps1 -VersionCode 48）
#   -SkipApk  只改面板时不重装 APK
#   -Mock     部署成模拟数据模式（删掉 HA 配置）
#   -Prod     正式部署：不写 url.txt / debug.flag，CDP 与假 HA 都关着
#   -Serial   多台设备时指定目标；不设则用 $env:HC_DEVICE（默认 emulator-5554）
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$Mock,
    [switch]$SkipApk,
    [switch]$Prod,
    [string]$Serial = ''
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "env.ps1")
$adb = $Adb
$apk = Join-Path $root "dist\homecontrol.apk"
$pkg = "com.homecontrol.panel"
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
if (-not $env:ANDROID_SERIAL) { $env:ANDROID_SERIAL = $Device }

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
Step $online "adb 能看到在线设备（$env:ANDROID_SERIAL）" ($devices -replace "`n", ' | ')
if (-not $online) {
    Write-Host ""
    Write-Host "平板不在线。常见原因与处理：" -ForegroundColor Yellow
    Write-Host "  · 显示 offline：长按电源键 10 秒强制重启，或拔插 USB"
    Write-Host "  · 完全没有设备：检查 USB 线/口，确认已开 USB 调试"
    Write-Host "  · 无线调试：tools\wireless.ps1（Android 11+）或平板上 adb tcpip 5555"
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
    # targetSdk 还是 22：Android 13 上存储权限必须手动给，MIUI 的授权弹窗很容易漏。
    # Android 5/6（SDK<23）没有运行时权限，安装时就给了，pm grant 反而会报错。
    $sdk = [int]((Adb shell "getprop ro.build.version.sdk") -join '')
    if ($sdk -ge 23) {
        Adb shell "pm grant $pkg android.permission.WRITE_EXTERNAL_STORAGE" | Out-Null
        Adb shell "pm grant $pkg android.permission.READ_EXTERNAL_STORAGE" | Out-Null
        Step ((Adb shell "dumpsys package $pkg") -join "`n" -match 'android\.permission\.WRITE_EXTERNAL_STORAGE.*granted=true') "存储权限已授予（SDK $sdk）"
    } else {
        Step $true "SDK $sdk 无运行时权限，安装时已授予存储权限"
    }
}

Write-Host "=== 4. 推送面板与配置（push.ps1） ==="
$pushArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot "push.ps1"))
if ($Mock) { $pushArgs += '-Mock' }
if ($Prod) { $pushArgs += '-Prod' }
& powershell @pushArgs | Out-Null
Step ($LASTEXITCODE -eq 0) "push.ps1 完成"

if ($Prod) {
    $dbg = (Adb shell "ls /sdcard/HomeControl/debug.flag") -join ''
    Step ($dbg -match 'No such file|not found') "debug.flag 不存在（正式包不开调试）" $dbg
} else {
    $url = (Adb shell "cat /sdcard/HomeControl/url.txt") -join ''
    Step ($url -match 'file:///sdcard/HomeControl/panel/index.html') "url.txt 指向面板" $url
    Step ((Adb shell "ls /sdcard/HomeControl/debug.flag") -join '' -notmatch 'No such file') "debug.flag 已写（CDP/url.txt/假 HA 可用）"
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
$real = (Adb shell "cat /sdcard/HomeControl/ha.json") -join ''
if ($real -match '"url"') {
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
