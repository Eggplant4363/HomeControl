/* 本地假 Release 服务（给真机跑升级链路用，不依赖 GitHub）
 *   node tools\dev-release.js [port] [version]
 * 目录：<repo>/build/mirror/（release.json + homecontrol.apk），build 被 wipe 就重新跑一次
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || 8795);
const VER = process.argv[3] || '0.7.15';
/* 设备要能下载到 APK，JSON 里的地址必须是本机在局域网里的 IP，不能是 127.0.0.1 */
const BASE = process.env.MIRROR_BASE || (function () {
  const nets = os.networkInterfaces();
  const cands = [];
  Object.keys(nets).forEach((k) => nets[k].forEach((a) => { if (a.family === 'IPv4' && !a.internal) cands.push(a.address); }));
  const lan = cands.find((a) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)) || cands[0] || '127.0.0.1';
  return 'http://' + lan + ':' + PORT;
})();
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'build', 'mirror');
const APK_SRC = path.join(ROOT, 'dist', 'homecontrol.apk');

fs.mkdirSync(DIR, { recursive: true });
const apk = path.join(DIR, 'homecontrol.apk');
fs.copyFileSync(APK_SRC, apk);
const st = fs.statSync(apk);

const rel = {
  tag_name: 'v' + VER,
  name: 'v' + VER,
  draft: false,
  prerelease: false,
  html_url: BASE + '/release',
  assets: [
    { name: 'source.zip', size: 12000, browser_download_url: BASE + '/source.zip' },
    { name: 'homecontrol.apk', size: st.size, browser_download_url: BASE + '/homecontrol.apk' }
  ]
};
fs.writeFileSync(path.join(DIR, 'release.json'), JSON.stringify(rel, null, 2));

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/release.json') return send(res, 200, 'application/json', fs.readFileSync(path.join(DIR, 'release.json')));
  if (url === '/homecontrol.apk') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size });
    return fs.createReadStream(apk).pipe(res);
  }
  if (url === '/source.zip') return send(res, 200, 'application/zip', 'PK-not-really');
  return send(res, 404, 'text/plain', 'nope');
}).listen(PORT, () => console.log('mirror on ' + BASE + '/release.json  v' + VER + '  ' + st.size + ' bytes'));
