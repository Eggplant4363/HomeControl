# Manual APK build: aapt2 -> javac -> d8 -> zip -> zipalign -> apksigner.
# No Gradle, no dependencies beyond the Android SDK build-tools and a JDK 17.
# 版本号和变体走参数（以前每次升版本都要复制一个 patch-version-NN.js，那种仪式已经终结）。
#   tools\build.ps1                    → debug 包（带假 HA、当前版本 49）
#   tools\build.ps1 -VersionCode 50    → 升版本（装到已装更高 versionCode 的设备上会
#                                    INSTALL_FAILED_VERSION_DOWNGRADE，所以发新包就 +1，并同步改 README 的版本行）
#   tools\build.ps1 -Variant release   → 正式包：不含 MockHaServer
[CmdletBinding()]
param(
    [string]$OutName = "homecontrol.apk",
    [int]$VersionCode = 57,
    [string]$VersionName = "0.7.20",
    [string]$Variant = "debug"          # debug | release
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "env.ps1")
$sdk = $AndroidSdk
$bt = $BuildTools
$androidJar = $AndroidJar
# 上一次的产物先删掉：apksigner 会就地重写，残留的旧 APK 可能带上不一致的 v2 摘要
$staleApk = Join-Path $root ("dist\" + $OutName)
if (Test-Path $staleApk) { Remove-Item $staleApk -Force -ErrorAction SilentlyContinue }
$javaHome = $JavaHome
$javac = $Javac
$keytool = $Keytool
$env:JAVA_HOME = $javaHome
$env:PATH = "$javaHome\bin;$bt;$env:PATH"

if ($Variant -ne "debug" -and $Variant -ne "release") { throw "variant must be debug or release" }
foreach ($p in @($bt, $androidJar, $javac)) {
    if (-not (Test-Path $p)) { throw "missing build dependency: $p" }
}

# 变体各自一套中间产物目录：debug 与 release 的 javac 源集不同（debug 多 app/src_debug），
# 共用 build\classes 会让 release 把上一轮 debug 的 MockHaServer.class 一起 dex 进去
# （沙箱把 build\classes 做成 reparse point，逐项删也删不掉里面的旧 class）。
$b = Join-Path $root $(if ($Variant -eq "release") { "build-release" } else { "build" })
$dist = Join-Path $root "dist"
# 逐项删，跳过 reparse point：DSH 文件沙箱会把写进 build/ 的临时文件做成符号链接
# （Attributes 带 ReparsePoint、Target 为空），Remove-Item -Recurse 碰到它们的空目标
# 会报「Cannot bind argument to parameter 'Path' because it is null」直接中断构建。
if (Test-Path $b) {
    foreach ($e in Get-ChildItem $b -Force) {
        if (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        Remove-Item $e.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Force "$b\res", "$b\classes", "$b\dex", "$b\gen", $dist | Out-Null

# 1. bundle the web panel + TLS 信任锚 into assets/（assets 是构建产物，不进 git）
$assets = Join-Path $root "app\assets"
if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $assets "panel") | Out-Null
Copy-Item (Join-Path $root "panel\*") (Join-Path $assets "panel") -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $assets "certs") | Out-Null
Copy-Item (Join-Path $root "app\certs\*.pem") (Join-Path $assets "certs") -Force
Write-Host "[1/7] panel + certs copied into assets"

# 2. resources
$resZip = Join-Path $b "res.zip"
& (Join-Path $bt "aapt2.exe") compile --dir (Join-Path $root "app\res") -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }
Write-Host "[2/7] aapt2 compile ok"

# 3. link -> base.apk (+ R.java)
$baseApk = Join-Path $b "base.apk"
& (Join-Path $bt "aapt2.exe") link `
    -o $baseApk `
    -I $androidJar `
    --manifest (Join-Path $root "app\AndroidManifest.xml") `
    -A $assets `
    --java (Join-Path $b "gen") `
    --min-sdk-version 21 `
    --target-sdk-version 22 `
    --version-code $VersionCode `
    --version-name $VersionName `
    $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }
Write-Host "[3/7] aapt2 link ok"

# 3b. aapt2 (Windows) writes asset entry names with '\'; Android needs '/'
#     otherwise file:///android_asset/... 无法打开（ERR_FILE_NOT_FOUND）
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$tmpApk = Join-Path $b "base-fixed.apk"
$srcStream = [System.IO.File]::OpenRead($baseApk)
$srcZip = New-Object System.IO.Compression.ZipArchive($srcStream, [System.IO.Compression.ZipArchiveMode]::Read)
$dstStream = [System.IO.File]::Create($tmpApk)
$dstZip = New-Object System.IO.Compression.ZipArchive($dstStream, [System.IO.Compression.ZipArchiveMode]::Create)
$fixed = 0
foreach ($e in $srcZip.Entries) {
    $name = $e.FullName -replace '\\', '/'
    if ($name -ne $e.FullName) { $fixed++ }
    $ne = $dstZip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $s = $e.Open()
    $d = $ne.Open()
    $s.CopyTo($d)
    $d.Dispose()
    $s.Dispose()
}
$dstZip.Dispose()
$dstStream.Dispose()
$srcZip.Dispose()
$srcStream.Dispose()
if ($fixed -gt 0) { Move-Item -Force $tmpApk $baseApk } else { Remove-Item -Force $tmpApk }
Write-Host "[3b/7] asset entry names normalized ($fixed)"

# 4. java（release 变体不含 app/src_debug：正式包里不该带一个假 HA 服务器）
$srcDirs = @(Join-Path $root "app\src")
if ($Variant -eq "debug") { $srcDirs += (Join-Path $root "app\src_debug") }
$srcs = @(Get-ChildItem $srcDirs -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$rjava = Join-Path $b "gen\com\homecontrol\panel\R.java"
if (Test-Path $rjava) { $srcs += $rjava }
& $javac -encoding UTF-8 -source 8 -target 8 -bootclasspath $androidJar -classpath $androidJar -d (Join-Path $b "classes") @srcs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
Write-Host "[4/7] javac ok"

# 5. dex
$classes = @(Get-ChildItem (Join-Path $b "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& (Join-Path $bt "d8.bat") --release --min-api 21 --lib $androidJar --output (Join-Path $b "dex") @classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }
Write-Host "[5/7] d8 ok"

# 6. classes.dex into the apk
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$unsigned = Join-Path $b "unsigned.apk"
$aligned = Join-Path $b "aligned.apk"
# 沙箱把上一次构建留下的文件做成 reparse point：Copy-Item -Force 覆盖它们会失败，
# ZipFile::Open(Update) 报「being used by another process」。先删再拷。
foreach ($stale in @($unsigned, $aligned)) {
    if (Test-Path $stale) { Remove-Item $stale -Force -ErrorAction SilentlyContinue }
}
Copy-Item $baseApk $unsigned -Force
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, [System.IO.Compression.ZipArchiveMode]"Update")
$null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $b "dex\classes.dex"), "classes.dex", [System.IO.Compression.CompressionLevel]"Optimal")
$zip.Dispose()
Write-Host "[6/7] classes.dex packed"

# 7. align + sign
$aligned = Join-Path $b "aligned.apk"
& (Join-Path $bt "zipalign.exe") -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

$ks = Join-Path $root "tools\debug.keystore"
if (-not (Test-Path $ks)) {
    & $keytool -genkeypair -keystore $ks -storepass android -keypass android `
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=Android Debug,O=Android,C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
$out = Join-Path $dist $OutName
& (Join-Path $bt "apksigner.bat") sign --ks $ks --ks-pass pass:android --key-pass pass:android `
    --min-sdk-version 21 --out $out $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

$size = (Get-Item $out).Length / 1KB
Write-Host ("[7/7] signed: {0} ({1:N0} KB)" -f $out, $size)
