# 用本机 Edge 的 headless 模式把面板真渲染一遍，断言关键结构都在。
# 目的：平板不在手边时，也能确认真实浏览器里页面能跑起来、卡/房间/场景/引导都在。
# 用法：powershell -ExecutionPolicy Bypass -File tools\render-check.ps1 [-Url http://127.0.0.1:8787/] [-ExpectGuide]
[CmdletBinding()]
param(
    [string]$Url = "http://127.0.0.1:8787/",
    [int]$MinTiles = 8,
    [switch]$ExpectGuide
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edge)) { Write-Host "未找到 Edge，跳过渲染自检" -ForegroundColor Yellow; exit 0 }

$profileDir = Join-Path $root "build\edge-profile"
$domFile = Join-Path $root "build\render-dom.txt"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $domFile) | Out-Null
if (Test-Path $domFile) { Remove-Item $domFile -Force }

$server = $null
$probe = $null
try { $probe = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 } catch { }
if (-not $probe) {
    Write-Host "启动 dev server…"
    $server = Start-Process -FilePath "node" -ArgumentList "tools\devserver.js" -WorkingDirectory $root -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

$fails = 0
function Check($ok, $name, $extra) {
    if ($ok) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
    else {
        Write-Host ("  FAIL  " + $name) -ForegroundColor Red
        if ($extra) { Write-Host ("        " + $extra) -ForegroundColor DarkGray }
        $script:fails++
    }
}

Write-Host "=== 渲染（Edge headless）==="
& cmd /c "`"$edge`" --headless --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=`"$profileDir`" --virtual-time-budget=6000 --dump-dom $Url > `"$domFile`" 2>nul"
$dom = ""
if (Test-Path $domFile) { $dom = [System.IO.File]::ReadAllText($domFile) }
Check ($dom.Length -gt 5000) "拿到渲染后的 DOM（长度 $( $dom.Length )）"
if ($dom.Length -le 5000) {
    Write-Host "DOM 为空，后面的断言没有意义" -ForegroundColor Red
    exit 1
}

$tiles = ([regex]::Matches($dom, 'class="tile( on| off|"| )')).Count
Check ($tiles -ge $MinTiles) "卡片数量 >= $MinTiles（实际 $tiles）"
Check ($dom -match 'id="grid"') "网格容器存在"
Check ($dom -match 'class="tabs') "房间 tab 容器存在"
$tabs = ([regex]::Matches($dom, 'data-room="')).Count
Check ($tabs -ge 2) "房间 tab >= 2（实际 $tabs）"
Check (-not ($dom -match 'Uncaught|SyntaxError')) "页面没有脚本错误痕迹"
$st = [regex]::Match($dom, 'id="statusText"[^>]*>([^<]*)<')
Check ($st.Success -and $st.Groups[1].Value.Length -gt 0) ("状态胶囊有文案：" + $st.Groups[1].Value)
Check ($dom -match 'id="dim"') "调暗遮罩已渲染"

if ($ExpectGuide) {
    $steps = ([regex]::Matches($dom, 'g-step')).Count
    Check ($steps -ge 3) "首次引导三步都在（实际 $steps）"
    Check ($dom -match 'data-act="guide-config"') "引导页有「填地址和令牌」按钮"
}

Write-Host "=== 结果 ==="
if ($fails -eq 0) { Write-Host "RENDER PASS" -ForegroundColor Green; exit 0 }
Write-Host ("RENDER FAIL " + $fails) -ForegroundColor Red
exit 1