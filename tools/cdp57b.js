// tools/cdp57b.js — 同 cdp57.js，但每帧都打日志（CDP57_DEBUG=1 时）
var net = require('net');
var fs = require('fs');

var exprPath = process.argv[2];
var port = process.argv[3] || '9222';
var expr = fs.readFileSync(exprPath, 'utf8');
var DEBUG = process.env.CDP57_DEBUG === '1';

function httpGet(path, cb) {
  var sock = net.connect(Number(port), '127.0.0.1');
  var buf = '';
  var done = false;
  function tryParse() {
    if (done) return;
    var i = buf.indexOf('\r\n\r\n');
    if (i === -1) return;
    var body = buf.slice(i + 4);
    try { JSON.parse(body); done = true; sock.destroy(); cb(null, body); } catch (e) { }
  }
  sock.on('data', function (d) { buf += d.toString('utf8'); tryParse(); });
  sock.on('end', function () {
    if (done) return;
    done = true;
    var i = buf.indexOf('\r\n\r\n');
    cb(null, i > -1 ? buf.slice(i + 4) : buf);
  });
  sock.on('error', function (e) { if (!done) { done = true; cb(e); } });
  sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
}

function frame(str) {
  var payload = Buffer.from(str, 'utf8');
  var len = payload.length;
  var head;
  if (len < 100) head = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeUInt32BE(len, 6); }
  var key = Buffer.alloc(4);
  for (var i = 0; i < 4; i++) key[i] = Math.floor(Math.random() * 256);
  var masked = Buffer.from(payload);
  for (var j = 0; j < masked.length; j++) masked[j] ^= key[j % 4];
  return Buffer.concat([head, key, masked]);
}

httpGet('/json/list', function (err, body) {
  if (err) { console.error('list fail: ' + err.message); process.exit(1); }
  var pages;
  try { pages = JSON.parse(body); } catch (e) { console.error('bad list json: ' + body.slice(0, 80)); process.exit(1); }
  if (!pages.length) { console.error('no pages'); process.exit(1); }
  var id = pages[0].id;
  if (DEBUG) console.error('page id ' + id);

  var sock = net.connect(Number(port), '127.0.0.1');
  var wsKey = Buffer.alloc(16);
  for (var k = 0; k < 16; k++) wsKey[k] = Math.floor(Math.random() * 256);
  sock.write('GET /devtools/page/' + id + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + wsKey.toString('base64') +
    '\r\nSec-WebSocket-Version: 13\r\n\r\n');

  var buf = Buffer.alloc(0);
  var upped = false;
  var cmdId = 1;
  var timer = setTimeout(function () { console.error('timeout'); sock.destroy(); process.exit(1); }, 12000);

  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!upped) {
      var h = buf.indexOf('\r\n\r\n');
      if (h === -1) return;
      var hdr = buf.slice(0, h).toString('utf8');
      if (DEBUG) console.error('handshake hdr:\n' + hdr);
      if (hdr.indexOf('101') === -1) { console.error('handshake refused'); process.exit(1); }
      upped = true;
      buf = buf.slice(h + 4);
      var cmd = JSON.stringify({ id: cmdId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: false } });
      sock.write(frame(cmd));
      if (DEBUG) console.error('sent cmd ' + cmd.length + ' bytes');
    }
    while (buf.length >= 2) {
      var len = buf[1] & 127;
      var off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      var payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      if (DEBUG) console.error('recv ' + len + ': ' + payload.slice(0, 200));
      try {
        var msg = JSON.parse(payload);
        if (msg.id === cmdId) {
          var res = msg.result && msg.result.result ? msg.result.result.value : msg;
          clearTimeout(timer);
          console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 1));
          sock.destroy();
          process.exit(0);
        }
      } catch (e) { }
    }
  });
  sock.on('error', function (e) { console.error('sock error: ' + e.message); process.exit(1); });
});
