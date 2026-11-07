/*
 * 进度条手感探针：在 mock 面板里真的拖一次卡片进度条，然后采样松手后 2 秒内
 * 白色钮（.t-bar b）的位置，用来确认「松手后不会自己往回弹」。
 *
 * 用法：node tools\probe-pbar.js [http://127.0.0.1:8788/]
 * 前置：node tools\sim.js --mock --port 8788
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    '--user-data-dir=' + path.join(ROOT, 'build', 'cdp-pbar'),
    '--window-size=1024,768', '--hide-scrollbars', '--disable-gpu', 'about:blank'
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
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result ? r.result.value : undefined;
  };

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1500);

  /* 只放一张可调光的灯卡，进度条好找 */
  const edit = {
    added: { 'light.living_main': 1 },
    order: ['light.living_main'],
    span: {}, rows: {}
  };
  await evalJs('(function(){try{localStorage.setItem("hc.guide.v1","1");localStorage.setItem("hc.hint.v1","1");' +
    'localStorage.setItem("hc.edit",' + JSON.stringify(JSON.stringify(edit)) + ');' +
    'localStorage.removeItem("hc.prefs");}catch(e){}})()');
  await ws.call('Page.reload', {});
  await sleep(2600);

  const geo = await evalJs('(function(){var b=document.querySelector(".t-bar");if(!b)return null;var k=b.querySelector("b");var rb=b.getBoundingClientRect(),rk=k.getBoundingClientRect();return {x:rb.left,y:rb.top,w:rb.width,h:rb.height,knobW:rk.width,knobH:rk.height,knobMidL:rk.left+rk.width/2};})()');
  if (!geo) { console.log('FAIL no .t-bar'); edge.kill(); process.exit(1); }
  console.log('bar=' + JSON.stringify([Math.round(geo.w), Math.round(geo.h)]) + ' knob=' + JSON.stringify([Math.round(geo.knobW), Math.round(geo.knobH)]));

  const sample = async (tag) => {
    const v = await evalJs('(function(){var b=document.querySelector(".t-bar b");if(!b)return null;var rb=b.getBoundingClientRect();var bar=b.parentNode.getBoundingClientRect();return Math.round((rb.left+rb.width/2-bar.left)/bar.width*1000)/10;})()');
    return tag + '=' + v;
  };

  const y = Math.round(geo.y + geo.h / 2);
  const x0 = Math.round(geo.x + geo.w * 0.28);
  const x1 = Math.round(geo.x + geo.w * 0.72);

  /* 用 CDP 派发真实触摸序列：按下 → 分几步移动 → 抬手 */
  const touch = async (type, x, y2) => {
    await ws.call('Input.dispatchTouchEvent', {
      type: type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y2, radiusX: 3, radiusY: 3, force: 1, id: 1 }]
    });
  };

  await touch('touchStart', x0, y);
  await sleep(60);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', Math.round(x0 + (x1 - x0) * i / 6), y);
    await sleep(70);
  }
  console.log(await sample('during'));
  await touch('touchEnd', x1, y);

  const seq = [];
  for (let i = 0; i < 14; i++) {
    await sleep(150);
    seq.push(await sample('t+' + ((i + 1) * 150) + 'ms'));
  }
  console.log('after ' + seq.join(' '));

  const nums = seq.map((s) => parseFloat(s.split('=')[1]));
  const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
  console.log('spread=' + (Math.round((max - min) * 10) / 10) + '%  (越小越稳，明显回弹会 >2)');

  /* 静默窗口过后，服务器值仍要能刷新钮：等 1.6s 再读一次 */
  await sleep(1600);
  console.log(await sample('after-hold'));

  edge.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.log('ERR ' + (e && e.message)); process.exit(1); });
