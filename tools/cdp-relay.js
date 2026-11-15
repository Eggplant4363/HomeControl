// tools/cdp-relay.js — 通过 Helper 的 HTTP relay（GET /devtools/relay/cdp?json=...）发一条任意 CDP 命令
// 用法: node tools/cdp-relay.js <expr-file> [port]
// 与 tools/cdp-shot.js 同一 transport，但跑 Runtime.evaluate 并打印 completion value。
const net = require('net');
const fs = require('fs');

const file = process.argv[2];
const port = Number(process.argv[3] || 9222);
if (!file) { console.error('usage: node tools/cdp-relay.js <expr-file> [port]'); process.exit(2); }
const expr = fs.readFileSync(file, 'utf8');

function send(sock, obj) {
  const body = JSON.stringify(obj);
  sock.write(Buffer.from('GET /devtools/relay/cdp?json=' + encodeURIComponent(body) + ' HTTP/1.1\r\nHost: localhost\r\nAccept */*\r\n\r\n'.replace('Accept */*', 'Accept: */*')));
}

const sock = net.connect(port, '127.0.0.1');
let buf = Buffer.alloc(0);
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
sock.on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });
sock.on('close', () => {
  const parts = buf.toString('utf8').split('\r\n\r\n');
  let reply = null;
  for (const p of parts) {
    try { const o = JSON.parse(p); if (o.id === 1) reply = o; } catch (e) {}
  }
  if (!reply) { console.log('NO REPLY: ' + buf.toString('utf8').slice(0, 400)); process.exit(1); }
  if (reply.error) { console.log('CDP ERROR: ' + JSON.stringify(reply.error)); process.exit(1); }
  const r = reply.result && reply.result.result;
  if (!r) { console.log('<no result>'); process.exit(0); }
  if (r.type === 'object') console.log(JSON.stringify(r.value, null, 1));
  else console.log(JSON.stringify(r.value));
});
send(sock, { id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
setTimeout(() => { sock.destroy(); }, 8000);
