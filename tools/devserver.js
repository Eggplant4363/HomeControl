// Zero-dependency static server for the panel during development.
//   node tools/devserver.js
// The tablet reaches it through:  adb reverse tcp:8787 tcp:8787
// and then loads http://127.0.0.1:8787/index.html
var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = path.resolve(__dirname, '..', 'panel');
var PORT = parseInt(process.env.PORT || '8787', 10);

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

function newestMtime(dir) {
  var newest = 0;
  (function walk(d) {
    var entries;
    try { entries = fs.readdirSync(d); } catch (e) { return; }
    entries.forEach(function (name) {
      var fp = path.join(d, name);
      var st;
      try { st = fs.statSync(fp); } catch (e) { return; }
      if (st.isDirectory()) walk(fp);
      else if (st.mtimeMs > newest) newest = st.mtimeMs;
    });
  })(dir);
  return newest;
}

var server = http.createServer(function (req, res) {
  var pathname = url.parse(req.url).pathname;
  if (pathname === '/__ver') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(String(newestMtime(ROOT)));
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  var file = path.join(ROOT, decodeURIComponent(pathname));
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('panel dev server: http://127.0.0.1:' + PORT + '/  (root ' + ROOT + ')');
  console.log('LAN:             http://<this-pc>:' + PORT + '/');
});
