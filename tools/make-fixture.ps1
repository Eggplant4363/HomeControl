# 生成「真实模式」离线验收用的面板副本：build\panel-fixture
#   用途：没有可用 HA（或设备→PC 网络不通）时，在平板实机上验证
#   ha.json 读取 → 真实模式 → registry 自动布局 → 场景键/房间 tab → 卡片交互
#   做法：复制 panel\ → 覆盖 js\fixture-ha.js（把 window.HABackend 换成样例数据实现）
#                → 在 index.html 里 app.js 之前插入 fixture-ha.js
# 用法：powershell -ExecutionPolicy Bypass -File .\tools\make-fixture.ps1
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$panel = Join-Path $root 'panel'
$out = Join-Path $root 'build\panel-fixture'

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
Copy-Item (Join-Path $panel '*') $out -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'fixture-panel-ha.js') (Join-Path $out 'js\fixture-ha.js') -Force

$indexPath = Join-Path $out 'index.html'
$enc = New-Object System.Text.UTF8Encoding($false)
$html = [System.IO.File]::ReadAllText($indexPath, $enc)
$anchor = '  <script src="js/app.js"></script>'
if (-not $html.Contains($anchor)) { throw 'index.html 中找不到 js/app.js 的 script 标签' }
$html = $html.Replace($anchor, "  <script src=`"js/fixture-ha.js`"></script>`r`n" + $anchor)
[System.IO.File]::WriteAllText($indexPath, $html, $enc)

if (-not $Quiet) {
  Write-Output ("fixture panel: " + $out)
  Get-ChildItem $out -Recurse -File | ForEach-Object { "  " + $_.FullName.Replace($root + '\', '') }
}
