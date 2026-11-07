/*
 * 只为了「看清卡片排版」的截图脚本：mock 模式下把几张卡灌进 hc.edit，再截图。
 * 用法：node tools\shot-foot.js [http://127.0.0.1:8788/]
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9355;
const OUT = process.argv[3] || path.join(ROOT, 'build', 'foot.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num4 = (v) => { const n = parseInt(v, 10); return isFinite(n) ? n : 0; };

function httpGet(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve(b)); }).on('error', reject);
  });
}

class WS {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.frames = []; this.waiters = []; }
  static async connect(wsUrl) {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
      crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let head = Buffer.alloc(0);
    while (true) {
      const chunk = await new Promise((r) => sock.once('data', r));
      head = Buffer.concat([head, chunk]);
      if (head.indexOf('\r\n\r\n') >= 0) break;
    }
    return new WS(sock);
  }
  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) { head = Buffer.alloc(6); head[1] = 0x80 | payload.length; }
    else if (payload.length < 65536) { head = Buffer.alloc(8); head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(14); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    head[0] = 0x81;
    mask.copy(head, head.length - 4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, body]));
  }
  onData(cb) { this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(cb); }); }
  drain(cb) {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if ((b0 & 0x0f) === 1) { try { cb(JSON.parse(payload.toString('utf8'))); } catch (e) { } }
    }
  }
  call(method, params) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000);
      this.waiters.push({ id, resolve: (v) => { clearTimeout(t); resolve(v); }, reject });
      this.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

(async () => {
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=' + PORT_CDP,
    '--user-data-dir=' + path.join(ROOT, 'build', 'cdp-foot'),
    '--window-size=1024,768', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + PORT_CDP + '/json/list'));
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { }
  }
  if (!target) { console.log('FAIL no cdp'); edge.kill(); process.exit(1); }
  const ws = await WS.connect(target.webSocketDebuggerUrl);
  ws.msgId = 0;
  ws.onData((m) => {
    if (!m.id) return;
    const w = ws.waiters.find((x) => x.id === m.id);
    if (!w) return;
    ws.waiters = ws.waiters.filter((x) => x !== w);
    if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result || {});
  });
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result ? r.result.value : undefined;
  };

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1500);
  const seed = {
    guide: 1, hint: 1,
    edit: {
      added: { 'light.living_main': 1, 'light.living_strip': 1, 'cover.living_curtain': 1, 'climate.living_ac': 1, 'binary_sensor.living_motion': 1 },
      order: ['light.living_main', 'light.living_strip', 'cover.living_curtain', 'climate.living_ac', 'binary_sensor.living_motion'],
      span: { 'light.living_main': 2 }, rows: {}
    }
  };
  var colArg = num4(process.argv[4]);
  var prefStr = colArg ? JSON.stringify({ cols: colArg }) : '';
  await evalJs('(function(){try{localStorage.setItem("hc.guide.v1","1");localStorage.setItem("hc.hint.v1","1");localStorage.setItem("hc.edit",' + JSON.stringify(JSON.stringify(seed.edit)) + ');var ps=' + JSON.stringify(prefStr) + ';if(ps){localStorage.setItem("hc.prefs",ps);}}catch(e){}})()');
  await ws.call('Page.reload', {});
  await sleep(2600);
  const info = await evalJs('(function(){var c=[].map.call(document.querySelectorAll(".tile"),function(t){var n=t.querySelector(".t-name"),s=t.querySelector(".t-sub");return (n?n.textContent.trim():"?")+" | "+(s?s.textContent.trim():"");});return {n:c.length,cards:c,status:(document.getElementById("statusText")||{}).textContent||""};})()');
  console.log('status=' + info.status + ' tiles=' + info.n);
  console.log(info.cards.join('\n'));
  var dbg = await evalJs('(function(){var g=document.getElementById("grid")||document.querySelector(".grid");return {prefs:localStorage.getItem("hc.prefs"),cls:g?g.className:"?",colsInline:g?(g.style.gridTemplateColumns||""):""};})()');
  console.log('debug ' + JSON.stringify(dbg));
  /* 进度条几何：改条高/钮大小时先看这里，比肉眼看截图准 */
  var geo = await evalJs('(function(){var b=document.querySelector(".t-bar");if(!b)return null;var f=b.querySelector("i"),k=b.querySelector("b");var rb=b.getBoundingClientRect(),rf=f?f.getBoundingClientRect():null,rk=k?k.getBoundingClientRect():null;var cs=getComputedStyle(b);return {bar:[Math.round(rb.width),Math.round(rb.height)],barCss:[cs.height,cs.borderRadius,cs.marginTop],fill:rf?[Math.round(rf.width),Math.round(rf.height)]:null,knob:rk?[Math.round(rk.width),Math.round(rk.height)]:null};})()');
  console.log('geo ' + JSON.stringify(geo));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const shot = await ws.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot=' + OUT);
  edge.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
