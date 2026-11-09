// tools/cdp-shot.js — 用 CDP Page.captureScreenshot 抓 WebView 自己的画面（比 adb screencap 可靠）
// 用法: node tools/cdp-shot.js <port> <outPath>
const net = require('net');
const fs = require('fs');
const port = process.argv[2] || '9223';
const out = process.argv[3] || 'build/cdp-shot.png';

function frames(buf) {
  const s = buf.toString('utf8');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf('\r\n\r\n', i);
    if (j < 0) break;
    const head = s.slice(i, j);
    const m = head.match(/"id":(\d+)/);
    if (m) out.push({ id: +m[1], head });
    i = j + 4;
  }
  return out;
}

function send(sock, obj) {
  const body = JSON.stringify(obj);
  sock.write(Buffer.from('GET /devtools/relay/cdp?json=' + encodeURIComponent(body) + ' HTTP/1.1\r\nHost: localhost\r\nAccept: */*\r\n\r\n'));
}

const sock = net.connect(Number(port), '127.0.0.1');
let buf = Buffer.alloc(0);
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
sock.on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });
sock.on('close', () => {
  const parts = buf.toString('utf8').split('\r\n\r\n');
  let result = null;
  for (const p of parts) {
    try { const o = JSON.parse(p); if (o.result) result = o.result; } catch (e) {}
  }
  if (!result || !result.data) { console.log('NO SCREENSHOT: ' + buf.toString('utf8').slice(0, 400)); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(result.data, 'base64'));
  console.log('written ' + out + ' ' + fs.statSync(out).size + ' bytes');
  process.exit(0);
});
setTimeout(() => {
  send(sock, { id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } });
}, 2500);
setTimeout(() => { console.log('TIMEOUT'); sock.destroy(); }, 20000);
