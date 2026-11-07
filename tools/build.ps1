# Manual APK build: aapt2 -> javac -> d8 -> zip -> zipalign -> apksigner.
# No Gradle, no dependencies beyond the Android SDK build-tools and a JDK 17.
[CmdletBinding()]
param(
    [string]$OutName = "homecontrol.apk"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sdk = "D:\Software\android-sdk"
$bt = Join-Path $sdk "build-tools\34.0.0"
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"
# 上一次的产物先删掉：apksigner 会就地重写，残留的旧 APK 可能带上不一致的 v2 摘要
$staleApk = Join-Path $root ("dist\" + $OutName)
if (Test-Path $staleApk) { Remove-Item $staleApk -Force -ErrorAction SilentlyContinue }
$javaHome = "C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot"
$javac = Join-Path $javaHome "bin\javac.exe"
$keytool = Join-Path $javaHome "bin\keytool.exe"
$env:JAVA_HOME = $javaHome
$env:PATH = "$javaHome\bin;$bt;$env:PATH"

foreach ($p in @($bt, $androidJar, $javac)) {
    if (-not (Test-Path $p)) { throw "missing build dependency: $p" }
}

$b = Join-Path $root "build"
$dist = Join-Path $root "dist"
Remove-Item $b -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$b\res", "$b\classes", "$b\dex", "$b\gen", $dist | Out-Null

# 1. bundle the web panel into assets/panel
$assets = Join-Path $root "app\assets"
if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $assets "panel") | Out-Null
Copy-Item (Join-Path $root "panel\*") (Join-Path $assets "panel") -Recurse -Force
Write-Host "[1/7] panel copied into assets"

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
    --version-code 36 `
    --version-name "0.6.0" `
    $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }
Write-Host "[3/7] aapt2 link ok"

# 4. java
$srcs = @()
$srcs += (Get-ChildItem (Join-Path $root "app\src") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
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
