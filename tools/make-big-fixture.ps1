# 生成「压力测试」面板副本：build\panel-big
#   用途：验证房间多、实体多时的滚动与排版（8 房间 x 10 实体 + 6 场景）
#   做法：复制 panel\ → 注入 js\fixture-ha.js（tools\fixture-big-ha.js）
# 用法：powershell -ExecutionPolicy Bypass -File .\tools\make-big-fixture.ps1
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$panel = Join-Path $root 'panel'
$out = Join-Path $root 'build\panel-big'

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
Copy-Item (Join-Path $panel '*') $out -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'fixture-big-ha.js') (Join-Path $out 'js\fixture-ha.js') -Force

$indexPath = Join-Path $out 'index.html'
$enc = New-Object System.Text.UTF8Encoding($false)
$html = [System.IO.File]::ReadAllText($indexPath, $enc)
$anchor = '  <script src="js/app.js"></script>'
if (-not $html.Contains($anchor)) { throw 'index.html 中找不到 js/app.js 的 script 标签' }
$html = $html.Replace($anchor, "  <script src=`"js/fixture-ha.js`"></script>`r`n" + $anchor)
[System.IO.File]::WriteAllText($indexPath, $html, $enc)

if (-not $Quiet) { Write-Output ("big fixture panel: " + $out) }
