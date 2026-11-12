# 发一个 GitHub Release（应用内自升级的「服务端」）
#
#   $env:GITHUB_TOKEN = 'ghp_xxx'          # 只需 repo 权限（fine-grained: Contents: Read and write）
#   .\tools\release.ps1 -Version 0.7.15
#   .\tools\release.ps1 -Version 0.7.15 -Notes "修 xxx" -Draft
#
# 为什么需要它：面板的「检查更新」打的是
#   https://api.github.com/repos/<owner>/<repo>/releases/latest
# 仓库里没有 release 时 GitHub 回 404，面板只会显示「还没有发布任何版本」。
#
# 注意：tag 用 vX.Y.Z，升级逻辑按 tag_name 里的数字段比较版本；
# 附件必须是 .apk（多个 apk 会挑体积大的那个），文件名随意。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  [string]$Apk = '',
  [string]$Owner = 'Eggplant4363',
  [string]$Repo = 'HomeControl',
  [string]$Token = $env:GITHUB_TOKEN,
  [switch]$Draft,
  [switch]$Prerelease
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Token) {
  throw '需要 GitHub 令牌：先设置 $env:GITHUB_TOKEN（repo 权限），或用 -Token 传进来。'
}

$tag = 'v' + ($Version -replace '^[vV]', '')
if (-not $Apk) { $Apk = Join-Path $PSScriptRoot '..\dist\homecontrol.apk' }
if (-not (Test-Path $Apk)) {
  throw "找不到 APK：$Apk（先跑 .\tools\build.ps1 -VersionName $Version）"
}
$apkItem = Get-Item $Apk

if (-not $Notes) { $Notes = "中控屏 $tag" }

$api = "https://api.github.com/repos/$Owner/$Repo"
$headers = @{
  Authorization          = "token $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'HomeControl-release'
  'X-GitHub-Api-Version' = '2022-11-28'
}

# git 直连 github.com 会断（见 README 的网络说明），这里统一走系统代理；
# 想让脚本自己走代理就设置 $env:HTTPS_PROXY，否则用系统 IE 代理设置。
$proxy = $env:HTTPS_PROXY
if (-not $proxy) {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) { $proxy = 'http://' + ($ie.ProxyServer -replace '^https?://', '') }
}
$proxyParam = @{}
if ($proxy) { $proxyParam['Proxy'] = $proxy; Write-Host "==> 走代理 $proxy" }

Write-Host "==> 建 release $tag（$Owner/$Repo）"
$body = @{
  tag_name         = $tag
  name             = $tag
  body             = $Notes
  draft            = [bool]$Draft
  prerelease       = [bool]$Prerelease
  target_commitish = 'main'
} | ConvertTo-Json -Compress

try {
  $rel = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $headers -ContentType 'application/json' -Body $body @proxyParam
} catch {
  $msg = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
  throw "建 release 失败：$msg"
}
Write-Host "    已建：$($rel.html_url)"

$uploadUrl = ($rel.upload_url -replace '\{\?name,label\}', '') + '?name=' + [Uri]::EscapeDataString($apkItem.Name)
Write-Host "==> 上传 $($apkItem.Name)（$([math]::Round($apkItem.Length / 1KB)) KB）"
$uploadHeaders = @{
  Authorization        = "token $Token"
  'Content-Type'       = 'application/vnd.android.package-archive'
  'User-Agent'         = 'HomeControl-release'
  'X-GitHub-Api-Version' = '2022-11-28'
}
try {
  $asset = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $uploadHeaders -InFile $apkItem.FullName -ContentType 'application/vnd.android.package-archive' @proxyParam
} catch {
  $msg = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
  throw "上传失败：$msg"
}
Write-Host "    附件：$($asset.name)（$($asset.size) 字节）"

if ($Draft) { Write-Host '==> 是草稿，去 GitHub 页面点「Publish」之后面板才看得到' }
else { Write-Host "==> 完成：https://github.com/$Owner/$Repo/releases/tag/$tag" }
Write-Host '    面板设置页 →「升级」→ 检查更新，应该就能看到它了。'
