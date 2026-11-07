/*
 * 面板模拟器：不接平板，直接在电脑上用真实的 Home Assistant 数据跑面板。
 *
 *   node tools\sim.js                 # 默认 8788 端口，只读（禁止控制真实设备）
 *   node tools\sim.js --port 9000
 *   node tools\sim.js --allow-control # 允许真的去开关你家里的灯（默认禁止）
 *   node tools\sim.js --mock          # 不连 HA，用面板自带的模拟数据
 *   node tools\sim.js --host 0.0.0.0  # 让同局域网的手机/平板也能打开
 *
 * 它做的事：
 *   1) 静态托管 panel/，并把 js/config.js 在内存里改写为「真实 HA 模式」
 *      （mock:false + 你的地址与令牌），所以浏览器里跑的是和装置上同一份代码
 *   2) /api/* 反向代理到 HA（普通 HTTP）—— 这样没有 CORS 问题
 *   3) /api/websocket 做 WebSocket 隧道转发到 HA —— 实时状态和装置上一样
 *   4) 默认拦掉 POST /api/services/*：模拟器不该在你不在家时动真设备
 *
 * 打开 http://127.0.0.1:8788/ 即可；窗口调到 1024x768 = 平板上看到的样子。
 */
var http = require('http');
var https = require('https');
var net = require('net');
var fs = require('fs');
var path = require('path');
var urlmod = require('url');

var ROOT = path.resolve(__dirname, '..');
var PANEL = path.join(ROOT, 'panel');

var argv = process.argv.slice(2);
function flag(name) { return argv.indexOf('--' + name) >= 0; }
function opt(name, def) {
  var i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

var PORT = parseInt(opt('port', process.env.SIM_PORT || '8788'), 10);
var HOST = opt('host', '127.0.0.1');
var MOCK = flag('mock');
var ALLOW_CONTROL = flag('allow-control');

/* -------- 读根目录 ha.json（没有就退回 config.js 的默认值） -------- */
function readHa() {
  var f = path.join(ROOT, 'ha.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
var HA = readHa();
var HA_HTTP = null;
var HA_WS = null;
if (HA && HA.url) {
  var u = String(HA.url).trim()
    .replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
    .replace(/\/+$/, '').replace(/\/api\/websocket\/?$/i, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  HA_HTTP = u;
  HA_WS = u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/api/websocket';
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* 把 config.js 改写成“真实 HA 模式”，地址指向本代理（同源，无 CORS） */
function patchedConfig(text) {
  if (MOCK) {
    /* 模拟模式：把摄像头指向本机的 MJPEG 测试源，用来验证 Chromium 57 的直播播放 */
    return text.replace(/camStream:\s*\{\s*\}/, "camStream: { 'camera.mock_cam': '/mockcam/stream.mjpeg' }");
  }
  var wsLocal = 'ws://127.0.0.1:' + PORT + '/api/websocket';
  return text
    .replace(/mock:\s*true/, 'mock: false')
    .replace(/url:\s*'[^']*'/, "url: '" + wsLocal + "'")
    .replace(/token:\s*'[^']*'/, "token: '" + String((HA && HA.token) || '') + "'");
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  var u = urlmod.parse(req.url);
  var pathname = decodeURIComponent(u.pathname || '/');

  /* ---------- REST 反向代理 ---------- */
  if (pathname.indexOf('/api/') === 0) {
    if (!HA_HTTP) { sendJson(res, 503, { error: '没有 ha.json，先跑 node tools\\real-ha-check.js 或写一个 ha.json' }); return; }
    if (!ALLOW_CONTROL && req.method !== 'GET' && pathname.indexOf('/api/services') === 0) {
      console.log('[sim] 拦下控制请求 ' + req.method + ' ' + pathname + '（要允许请加 --allow-control）');
      sendJson(res, 403, { error: 'sim 默认只读：加 --allow-control 才能控制设备' });
      return;
    }
    var target = new URL(HA_HTTP + req.url);
    var lib = target.protocol === 'https:' ? https : http;
    var headers = {};
    for (var k in req.headers) {
      if (k === 'host' || k === 'connection' || k === 'content-length') continue;
      headers[k] = req.headers[k];
    }
    var pr = lib.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: req.method, headers: headers, timeout: 20000
    }, function (prRes) {
      var h = {};
      for (var kk in prRes.headers) { if (kk !== 'transfer-encoding' && kk !== 'connection') h[kk] = prRes.headers[kk]; }
      res.writeHead(prRes.statusCode || 502, h);
      prRes.pipe(res);
    });
    pr.on('timeout', function () { pr.destroy(new Error('timeout')); });
    pr.on('error', function (e) {
      if (!res.headersSent) sendJson(res, 502, { error: String(e.message || e) });
      else try { res.end(); } catch (e2) { }
    });
    req.pipe(pr);
    return;
  }

  /* ---------- 模拟 MJPEG 源（multipart/x-mixed-replace，证明能播“直播”画面） ---------- */
  if (pathname === '/mockcam/stream.mjpeg') {
    var frames = [];
    try {
      frames.push(fs.readFileSync(path.join(path.dirname(PANEL), 'tools', 'mock-cam.jpg')));
      frames.push(fs.readFileSync(path.join(path.dirname(PANEL), 'tools', 'mock-cam2.jpg')));
    } catch (e) { res.writeHead(500); res.end('no frames'); return; }
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Connection': 'close'
    });
    var fi = 0;
    var timer = setInterval(function () {
      var buf = frames[fi++ % frames.length];
      try {
        res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + buf.length + '\r\n\r\n');
        res.write(buf);
        res.write('\r\n');
      } catch (e) { clearInterval(timer); }
    }, 250);
    req.on('close', function () { clearInterval(timer); });
    return;
  }

  /* ---------- 静态文件 ---------- */
  var rel = pathname === '/' ? '/index.html' : pathname;
  var file = path.normalize(path.join(PANEL, rel));
  if (file.indexOf(PANEL) !== 0) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 ' + rel); return; }
    var ext = path.extname(file).toLowerCase();
    if (rel === '/js/config.js') buf = Buffer.from(patchedConfig(buf.toString('utf8')), 'utf8');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

/* ---------- WebSocket 隧道：/api/websocket -> HA ---------- */
server.on('upgrade', function (req, socket, head) {
  if (!HA_WS || (req.url || '').indexOf('/api/websocket') !== 0) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    return;
  }
  var u = new URL(HA_WS);
  var upstream = net.connect(Number(u.port || 8123), u.hostname, function () {
    var lines = ['GET ' + u.pathname + ' HTTP/1.1', 'Host: ' + u.host];
    for (var k in req.headers) {
      if (k === 'host' || k === 'upgrade' || k === 'connection') continue;
      lines.push(k + ': ' + req.headers[k]);
    }
    lines.push('Upgrade: websocket', 'Connection: Upgrade', '', '');
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', function () { try { socket.destroy(); } catch (e) { } });
  socket.on('error', function () { try { upstream.destroy(); } catch (e) { } });
  socket.setTimeout(0);
});

server.listen(PORT, HOST, function () {
  console.log('面板模拟器已启动');
  console.log('  打开     http://' + (HOST === '0.0.0.0' ? '本机IP' : HOST) + ':' + PORT + '/     （窗口 1024x768 = 平板上的样子）');
  console.log('  模式     ' + (MOCK ? '模拟数据（不连 HA）' : '真实 HA：' + (HA_HTTP || '（缺 ha.json）')));
  console.log('  控制     ' + (ALLOW_CONTROL ? '允许（会真的动设备）' : '只读（拦截 POST /api/services/*）'));
  if (!MOCK && HA_HTTP) console.log('  代理     /api/* -> ' + HA_HTTP + ' ，/api/websocket 走隧道');
  console.log('  提示     改完 panel/ 里的文件刷新页面即可；Ctrl+C 结束');
});
