# 删除 HA 里探针残留的 MQTT 实体：config/entity_registry/remove（走 WebSocket，参数 -Entity 逗号分隔）
# 用法: powershell -ExecutionPolicy Bypass -File tools\ha-clean.ps1 -Entity sensor.xxx,button.yyy
param(
  [Parameter(Mandatory = $true)][string]$Entity,
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
Receive-Text | Out-Null
Send-Text (@{ type = 'auth'; access_token = $Token } | ConvertTo-Json -Compress)
if ((Receive-Text) -notmatch 'auth_ok') { 'auth failed'; exit 2 }

$i = 1
foreach ($e in ($Entity -split ',')) {
  $id = $e.Trim()
  if (-not $id) { continue }
  Send-Text (@{ id = $i; type = 'config/entity_registry/remove'; entity_id = $id } | ConvertTo-Json -Compress)
  $i++
  while ($true) {
    $t = Receive-Text
    if (-not $t) { break }
    if ($t -match ('"id":' + ($i - 1) + ',')) { Write-Output ("$id -> " + $t); break }
  }
}
$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', $ct).Wait(3000) | Out-Null
