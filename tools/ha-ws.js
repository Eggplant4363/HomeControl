// 极简 HA WebSocket 客户端（不依赖 ws 模块）：握手 + auth + 发一条命令 + 打印结果
// 用法: node tools/ha-ws.js <type> ['{"json":"args"}']
//   例: node tools/ha-ws.js system_log/list
//       node tools/ha-ws.js config/entity_registry/list
// 环境: HA_URL(默认 http://10.10.1.7:8123) HA_TOKEN(默认读 /sdcard 那份的同一个长期令牌)
const http = require('http');
const crypto = require('crypto');

const HA_URL = process.env.HA_URL || 'http://10.10.1.7:8123';
const TOKEN = process.env.HA_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM';
const type = process.argv[2];
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const u = new URL(HA_URL);
const key = crypto.randomBytes(16).toString('base64');
const req = http.request({
  host: u.hostname, port: u.port || 80, path: '/api/websocket',
  headers: {
    Connection: 'Upgrade', Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key
  },
  timeout: 15000
});
let sock = null;
let buf = Buffer.alloc(0);

function maskFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const m = Buffer.alloc(len);
  for (let i = 0; i < len; i++) m[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, m]);
}

function send(obj) { sock.write(maskFrame(JSON.stringify(obj))); }

function onFrame(text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg.type === 'auth_required') { send({ type: 'auth', access_token: TOKEN }); return; }
  if (msg.type === 'auth_invalid') { console.log('AUTH INVALID: ' + msg.message); process.exit(2); }
  if (msg.type === 'auth_ok') { console.log('auth ok, ha=' + msg.ha_version); send({ id: 1, type, ...extra }); return; }
  if (msg.id === 1) {
    console.log(JSON.stringify(msg, null, 1));
    sock.end();
    setTimeout(() => process.exit(0), 100);
  }
}

req.on('upgrade', (res, socket) => {
  sock = socket;
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0F;
      let len = buf[1] & 0x7F;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf[1] & 0x80) off += 4;
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (opcode === 0x1) onFrame(payload.toString('utf8'));
      else if (opcode === 0x8) { console.log('ws closed code=' + (payload.length >= 2 ? payload.readUInt16BE(0) : -1) + ' reason=' + payload.slice(2).toString('utf8')); process.exit(0); }
      else if (opcode === 0x9) sock.write(Buffer.concat([Buffer.from([0x8A, len]), payload]));
    }
  });
  sock.on('error', (e) => { console.log('ws err ' + e.message); process.exit(1); });
});
req.on('error', (e) => { console.log('http err ' + e.message); process.exit(1); });
req.on('response', (res) => { console.log('no upgrade: ' + res.statusCode); process.exit(1); });
req.end();
setTimeout(() => { console.log('timeout'); process.exit(3); }, 25000);
