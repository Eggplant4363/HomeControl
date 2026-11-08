// tools/cdp57.js — Chrome 57 WebView 的 DevTools 通道（Node 的 WebSocket 会带 Origin 头，
// 老 devtools 会拒绝；这里手写握手，不带 Origin）。
// 用法：node tools/cdp57.js <表达式文件> [端口]
var net = require('net');
var fs = require('fs');

var exprPath = process.argv[2];
var port = process.argv[3] || '9222';
var expr = fs.readFileSync(exprPath, 'utf8');

function httpGet(path, cb) {
  var sock = net.connect(Number(port), '127.0.0.1');
  var buf = '';
  var done = false;
  function tryParse() {
    if (done) return;
    var i = buf.indexOf('\r\n\r\n');
    if (i === -1) return;
    var body = buf.slice(i + 4);
    try {
      var o = JSON.parse(body);
      done = true;
      sock.destroy();
      cb(null, body);
    } catch (e) { /* body 还没收全 */ }
  }
  sock.on('data', function (d) { buf += d.toString('utf8'); tryParse(); });
  sock.on('end', function () { if (!done) { done = true; cb(null, buf.slice(buf.indexOf('\r\n\r\n') + 4)); } });
  sock.on('error', function (e) { if (!done) { done = true; cb(e); } });
  sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
}

function wsFrame(str) {
  var payload = Buffer.from(str, 'utf8');
  var len = payload.length;
  if (len < 100) {
    return Buffer.concat([Buffer.from([0x81, 0x80 | len]), payload]);
  }
  if (len < 65536) {
    var h2 = Buffer.alloc(4);
    h2[0] = 0x81; h2[1] = 0x80 | 126; h2.writeUInt16BE(len, 2);
    return Buffer.concat([h2, payload]);
  }
  var h8 = Buffer.alloc(10);
  h8[0] = 0x81; h8[1] = 0x80 | 127; h8.writeUInt32BE(len, 6);
  return Buffer.concat([h8, payload]);
}

function mask(buf) {
  var key = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
  var out = Buffer.from(buf);
  for (var i = 0; i < out.length; i++) out[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(key), out]);
}

httpGet('/json/list', function (err, body) {
  if (err) { console.error('list fail: ' + err.message); process.exit(1); }
  var pages;
  try { pages = JSON.parse(body); } catch (e) { console.error('bad list json'); process.exit(1); }
  if (!pages.length) { console.error('no pages'); process.exit(1); }
  var id = pages[0].id;

  var sock = net.connect(Number(port), '127.0.0.1');
  var key = Buffer.from(Math.random().toString(36).slice(2, 14) + '0000', 'utf8').toString('base64').slice(0, 24);
  var hand = 'GET /devtools/page/' + id + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
    '\r\nSec-WebSocket-Version: 13\r\n\r\n';
  sock.write(hand);

  var buf = Buffer.alloc(0);
  var upped = false;
  var idCounter = 1;
  var result = null;
  var timer = setTimeout(function () { console.error('timeout'); sock.destroy(); process.exit(1); }, 12000);

  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!upped) {
      var i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      var hdr = buf.slice(0, i).toString('utf8');
      if (hdr.indexOf('101') === -1) { console.error('handshake refused:\n' + hdr); process.exit(1); }
      upped = true;
      buf = buf.slice(i + 4);
      var cmd = JSON.stringify({ id: idCounter, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
      sock.write(mask(wsFrame(cmd)));
    }
    // 解帧（服务端帧不掩码）
    while (buf.length >= 2) {
      var len = buf[1] & 127;
      var off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      var payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      try {
        var msg = JSON.parse(payload);
        if (msg.id === idCounter) {
          result = msg.result && msg.result.result ? msg.result.result.value : msg;
          clearTimeout(timer);
          console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
          sock.destroy();
          process.exit(0);
        }
      } catch (e) { }
    }
  });
  sock.on('error', function (e) { console.error('sock error: ' + e.message); process.exit(1); });
});
