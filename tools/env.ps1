# 共享的环境探测：SDK / JDK / adb 的位置都集中在这一处。
# 以前 build.ps1、deploy.ps1、push.ps1、verify.ps1、smoke.ps1 各自写死 D:\Software\...，
# 换一台机器就全挂。现在：环境变量优先，没有就按常见位置探测，找不到直接报清楚。
#
# 用法（脚本开头）：  . "$PSScriptRoot\env.ps1"
# 之后可用： $AndroidSdk、$BuildTools、$AndroidJar、$JavaHome、$Javac、$Keytool、$Adb、$Fastboot
# 可用环境变量：HC_ANDROID_SDK、HC_JAVA_HOME、HC_ADB、HC_BUILD_TOOLS

$ErrorActionPreference = "Stop"

function HCFirstExisting([string[]]$paths) {
    foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

function HCNewestBuildTools([string]$sdk) {
    $dir = Join-Path $sdk "build-tools"
    if (-not (Test-Path $dir)) { return $null }
    $cands = Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    if (-not $cands) { return $null }
    return $cands[0].FullName
}

$AndroidSdk = HCFirstExisting @($env:HC_ANDROID_SDK, "D:\Software\android-sdk",
    (Join-Path $env:LOCALAPPDATA "Android\Sdk"), "C:\android-sdk")
if (-not $AndroidSdk) { throw "找不到 Android SDK（设 HC_ANDROID_SDK 环境变量）" }

$BuildTools = HCFirstExisting @($env:HC_BUILD_TOOLS, (HCNewestBuildTools $AndroidSdk))
if (-not $BuildTools) { throw "找不到 build-tools（在 $AndroidSdk\build-tools 下）" }

$AndroidJar = Join-Path $AndroidSdk "platforms\android-34\android.jar"
if (-not (Test-Path $AndroidJar)) {
    $any = Get-ChildItem (Join-Path $AndroidSdk "platforms") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $any) { throw "找不到 platforms（在 $AndroidSdk\platforms 下）" }
    $AndroidJar = Join-Path $any.FullName "android.jar"
}

$JavaHome = HCFirstExisting @($env:HC_JAVA_HOME,
    "C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot",
    "C:\Program Files\Java\jdk-17",
    "C:\Program Files\Eclipse Adoptium\jdk-17.0.21.0-hotspot")
if (-not $JavaHome) { throw "找不到 JDK 17（设 HC_JAVA_HOME 环境变量）" }
$Javac = Join-Path $JavaHome "bin\javac.exe"
$Keytool = Join-Path $JavaHome "bin\keytool.exe"

$Adb = HCFirstExisting @($env:HC_ADB, "D:\Software\platform-tools\adb.exe",
    (Join-Path $AndroidSdk "platform-tools\adb.exe"))
if (-not $Adb) { throw "找不到 adb（设 HC_ADB 环境变量）" }
$Fastboot = HCFirstExisting @((Join-Path $AndroidSdk "platform-tools\fastboot.exe"),
    "D:\Software\platform-tools\fastboot.exe")

# 平板设备号：deploy/push/verify/smoke 都读同一个环境变量，默认走模拟器
$Device = if ($env:HC_DEVICE) { $env:HC_DEVICE } else { "emulator-5554" }
