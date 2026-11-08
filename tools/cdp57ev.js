// tools/cdp57ev.js — 开 Runtime.enable，抓 Runtime.exceptionThrown 的详细信息（含 url/line）
var net = require('net');
var port = process.argv[2] || '9222';
var secs = Number(process.argv[3] || 6);

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
  sock.on('end', function () { if (!done) { done = true; cb(null, buf); } });
  sock.on('error', function (e) { if (!done) { done = true; cb(e); } });
  sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
}

httpGet('/json/list', function (err, body) {
  if (err) { console.error('list fail: ' + err.message); process.exit(1); }
  var pages;
  try { pages = JSON.parse(body); } catch (e) { console.error('bad list json'); process.exit(1); }
  if (!pages.length) { console.error('no pages'); process.exit(1); }
  var id = pages[0].id;

  var sock = net.connect(Number(port), '127.0.0.1');
  var wsKey = Buffer.alloc(16);
  for (var k = 0; k < 16; k++) wsKey[k] = Math.floor(Math.random() * 256);
  sock.write('GET /devtools/page/' + id + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + wsKey.toString('base64') +
    '\r\nSec-WebSocket-Version: 13\r\n\r\n');

  var buf = Buffer.alloc(0);
  var upped = false;
  var seen = [];
  var timer = setTimeout(function () {
    console.log(JSON.stringify({ exceptions: seen.slice(0, 6), count: seen.length }));
    sock.destroy();
    process.exit(0);
  }, secs * 1000);

  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!upped) {
      var h = buf.indexOf('\r\n\r\n');
      if (h === -1) return;
      var hdr = buf.slice(0, h).toString('utf8');
      if (hdr.indexOf('101') === -1) { console.error('handshake refused'); process.exit(1); }
      upped = true;
      buf = buf.slice(h + 4);
      sock.write(frame(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} })));
    }
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
        if (msg.method === 'Runtime.exceptionThrown') {
          var ex = msg.params && msg.params.exceptionDetails;
          if (ex) {
            seen.push({
              text: ex.text,
              line: ex.lineNumber, col: ex.columnNumber,
              url: ex.url,
              msg: ex.exception && ex.exception.value ? String(ex.exception.value) : null,
              stack: ex.exception && ex.exception.stack ? String(ex.exception.stack).slice(0, 220) : null
            });
          }
        }
      } catch (e) { }
    }
  });
  sock.on('error', function (e) { console.error('sock error: ' + e.message); process.exit(1); });
});
