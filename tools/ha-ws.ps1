# HA WebSocket 客户端（.NET ClientWebSocket）：收 system_log/list 或任意命令的结果
# 用法: powershell -ExecutionPolicy Bypass -File tools\ha-ws.ps1 -Type system_log/list [-Json '{"x":1}'] [-Filter mqtt]
param(
  [Parameter(Mandatory = $true)][string]$Type,
  [string]$Json = '{}',
  [string]$Filter = '',
  [string]$Url = 'ws://10.10.1.7:8123/api/websocket',
  [string]$Token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM'
)

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$Url, $ct).Wait(10000) | Out-Null
if ($ws.State -ne 'Open') { "connect failed: $($ws.State)"; exit 1 }

$buf = New-Object byte[] 65536
function Receive-Text {
  $ms = New-Object System.IO.MemoryStream
  do {
    $seg = [System.ArraySegment[byte]]::new($buf)
    $r = $ws.ReceiveAsync($seg, $ct).Result
    $ms.Write($buf, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  $txt = [Text.Encoding]::UTF8.GetString($ms.ToArray())
  $ms.Dispose()
  return $txt
}
function Send-Text($s) {
  $b = [Text.Encoding]::UTF8.GetBytes($s)
  $seg = [System.ArraySegment[byte]]::new($b)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait(5000) | Out-Null
}

$m1 = Receive-Text
Write-Host "[rx] $m1"
Send-Text (@{ type = 'auth'; access_token = $Token } | ConvertTo-Json -Compress)
$m2 = Receive-Text
Write-Host "[rx] $m2"
if ($m2 -notmatch 'auth_ok') { exit 2 }
$cmd = @{ id = 1; type = $Type }
if ($Json -and $Json -ne '{}') {
  $extra = $Json | ConvertFrom-Json
  foreach ($p in $extra.PSObject.Properties) { $cmd[$p.Name] = $p.Value }
}
Send-Text ($cmd | ConvertTo-Json -Compress -Depth 10)

while ($true) {
  $t = Receive-Text
  if (-not $t) { break }
  if ($Filter -and ($t -notmatch $Filter)) { continue }
  Write-Output $t
  if ($t -match '"id":1') { break }
}
$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', $ct).Wait(3000) | Out-Null
