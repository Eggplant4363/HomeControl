'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8791/';
const OUT = path.join(ROOT, 'docs', 'screens');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpGet = url => new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej); });

class WS {
  constructor(s) { this.sock = s; this.buf = Buffer.alloc(0); this.frames = []; this.waiters = []; }
  static async connect(u0) {
    const u = new URL(u0), sock = net.connect(Number(u.port), u.hostname);
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let head = Buffer.alloc(0), rest = Buffer.alloc(0);
    for (;;) {
      const c = await new Promise(r => sock.once('data', r));
      head = Buffer.concat([head, c]);
      const i = head.indexOf('\r\n\r\n');
      if (i >= 0) { rest = head.slice(i + 4); break; }
    }
    const ws = new WS(sock); sock.on('data', d => ws._onData(d)); if (rest.length) ws._onData(rest); return ws;
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1], masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const ml = masked ? 4 : 0;
      if (this.buf.length < off + ml + len) return;
      let p = this.buf.slice(off + ml, off + ml + len);
      if (masked) { const m = this.buf.slice(off, off + 4); p = Buffer.from(p.map((v, i) => v ^ m[i % 4])); }
      this.buf = this.buf.slice(off + ml + len);
      this.frames.push(p.toString('utf8'));
      while (this.waiters.length && this.frames.length) this.waiters.shift()(this.frames.shift());
    }
  }
  _send(t) {
    const p = Buffer.from(t, 'utf8'), m = crypto.randomBytes(4);
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    this.sock.write(Buffer.concat([h, m, Buffer.from(p.map((v, i) => v ^ m[i % 4]))]));
  }
  recv() { return this.frames.length ? Promise.resolve(this.frames.shift()) : new Promise(r => this.waiters.push(r)); }
  async call(method, params) {
    const id = ++WS.seq; this._send(JSON.stringify({ id, method, params: params || {} }));
    for (;;) { let m; try { m = JSON.parse(await this.recv()); } catch (e) { continue; } if (m.id === id) return m.result; }
  }
  close() { try { this.sock.destroy(); } catch (e) { } }
}
WS.seq = 0;

(async () => {
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开'); process.exit(1); }
  const profile = path.join(ROOT, 'build', 'edge-shot');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9335', '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try { const l = JSON.parse(await httpGet('http://127.0.0.1:9335/json/list')); target = l.find(t => t.type === 'page' && t.url.indexOf('8791') >= 0); } catch (e) { }
  }
  if (!target) { console.log('没拿到 CDP'); process.exit(1); }
  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable'); await ws.call('Page.enable');
  const js = async (e, aw) => { const r = await ws.call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!aw, userGesture: true }); return r && r.result ? r.result.value : undefined; };
  const wait = async (e, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 6000)) { if (await js(e)) return true; await sleep(200); } return false; };
  const shot = async name => {
    const r = await ws.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('saved ' + name);
  };
  await js('try{localStorage.clear()}catch(e){}; location.reload(); 1');
  await sleep(2600);
  await wait("document.querySelectorAll('.tile').length > 6");
  await js("document.querySelector('.tile[data-entity=\"light.living_main\"] .t-more').click(); 1");
  await wait("!!document.querySelector('.sheet.show .sheet-rename')");
  await sleep(500);
  await shot('panel-rename-sheet.png');
  await js("document.querySelector('.sheet.show .sheet-rename').click(); 1");
  await wait("!!document.querySelector('#rnIn')");
  await sleep(400);
  await shot('panel-rename-input.png');
  ws.close(); try { edge.kill(); } catch (e) { }
})().catch(e => { console.log('异常: ' + e.message); process.exit(1); });
