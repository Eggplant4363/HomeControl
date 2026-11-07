/*
 * 模拟器截图与自检：用 Edge 的 CDP 打开 tools\sim.js 起的模拟器页面，
 * 等真实 HA 数据到位后截图（1024x768，就是平板上的视口），并打印摘要。
 *
 * 前置：node tools\sim.js 已在跑（默认 8788）
 * 用法：node tools\sim-shot.js [http://127.0.0.1:8788/]
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve(b)); }).on('error', reject);
  });
}

/* ---- 极简 WS 客户端（CDP 用） ---- */
class WS {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.frames = []; this.waiters = []; }
  static async connect(wsUrl) {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
      crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let head = Buffer.alloc(0), rest = Buffer.alloc(0);
    while (true) {
      const chunk = await new Promise((r) => sock.once('data', r));
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i >= 0) { rest = head.slice(i + 4); break; }
    }
    const ws = new WS(sock);
    sock.on('data', (d) => ws._onData(d));
    if (rest.length) ws._onData(rest);
    return ws;
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1], masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const mlen = masked ? 4 : 0;
      if (this.buf.length < off + mlen + len) return;
      let payload = this.buf.slice(off + mlen, off + mlen + len);
      if (masked) { const m = this.buf.slice(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
      this.buf = this.buf.slice(off + mlen + len);
      this.frames.push(payload.toString('utf8'));
      while (this.waiters.length && this.frames.length) this.waiters.shift()(this.frames.shift());
    }
  }
  _send(text) {
    const payload = Buffer.from(text, 'utf8'), mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  recv() { return this.frames.length ? Promise.resolve(this.frames.shift()) : new Promise((r) => this.waiters.push(r)); }
  async call(method, params) {
    const id = ++this.msgId;
    this._send(JSON.stringify({ id, method, params: params || {} }));
    while (true) {
      const raw = await this.recv();
      const m = JSON.parse(raw);
      if (m.id === id) {
        if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
        return m.result;
      }
      if (this.onEvent) this.onEvent(m);
    }
  }
}

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 msedge.exe');
}

(async () => {
  /* 0) 模拟器在跑吗 */
  try { await httpGet(URL_PAGE); } catch (e) {
    console.log('FAIL  ' + URL_PAGE + ' 打不开，先运行  node tools\\sim.js');
    process.exit(1);
  }

  const profile = path.join(ROOT, 'build', 'sim-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const edge = spawn(findEdge(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + profile,
    '--window-size=1024,768', 'about:blank'
  ], { stdio: 'ignore' });

  /* 1) 等 CDP 起来 */
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + PORT_CDP + '/json/list'));
      target = list.find((t) => t.type === 'page');
    } catch (e) { }
  }
  if (!target) { console.log('FAIL  拿不到 CDP 页面'); edge.kill(); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  ws.msgId = 0;
  const errors = [];
  ws.onEvent = (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push((d.exception && d.exception.description) || d.text || 'exception');
    }
  };
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result ? r.result.value : undefined;
  };

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1200);

  /* 先把「首次引导」标记成看过，免得遮住要截的界面（模拟模式下它会自己弹） */
  try {
    await evalJs("(function(){try{localStorage.setItem('hc.guide.v1','1');localStorage.setItem('hc.hint.v1','1');}catch(e){}})()");
    await ws.call('Page.reload', {});
    await sleep(1600);
  } catch (e) { }
  await sleep(300);

  /* 2) 等面板连上真实 HA：卡片出现 + 状态胶囊不是「连接中/未配置」 */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      ready = await evalJs('(function(){var n=document.querySelectorAll(".tile").length;' +
        'var s=(document.getElementById("statusText")||{}).textContent||"";' +
        'return n>0 && !/连接中|未配置|失败|重试/.test(s);})()');
    } catch (e) { }
    if (ready) break;
  }

  const info = await evalJs('(function(){' +
    'var tabs=[].map.call(document.querySelectorAll(".tab"),function(t){return t.textContent.trim();});' +
    'var cards=[].map.call(document.querySelectorAll(".tile"),function(t){' +
    'var n=t.querySelector(".t-name"),v=t.querySelector(".t-val");' +
    'return (n?n.textContent.trim():"?")+"="+(v?v.textContent.trim():"");});' +
    'return {status:(document.getElementById("statusText")||{}).textContent||"",' +
    'tabs:tabs, cards:cards.length, sample:cards.slice(0,8),' +
    'title:document.title, err:(window.__err||"")};})()');

  console.log('=== 模拟器摘要 ===');
  console.log('页面      ' + URL_PAGE + '  (1024x768)');
  console.log('状态胶囊  ' + info.status);
  console.log('房间 tab  ' + info.tabs.join(' / '));
  console.log('卡片数    ' + info.cards);
  console.log('前 8 张   ' + info.sample.join(' | '));
  console.log('连上 HA   ' + (ready ? '是' : '否'));
  if (errors.length) console.log('JS 异常   ' + errors.slice(0, 3).join(' | '));

  /* 3) 截图：首页 */
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  const shot1 = path.join(ROOT, 'build', 'sim-home.png');
  const s1 = await ws.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot1, Buffer.from(s1.data, 'base64'));
  console.log('截图      build\\sim-home.png');

  /* 4) 切到一个房间再截一张 */
  const wantRoom = process.argv[3] || '';
  const room = (wantRoom && info.tabs.indexOf(wantRoom) >= 0) ? wantRoom : (info.tabs.find((t) => t && t !== '全部') || null);
  if (room) {
    await evalJs('(function(){var ts=document.querySelectorAll(".tab");' +
      'for(var i=0;i<ts.length;i++){if(ts[i].textContent.trim()===' + JSON.stringify(room) + '){ts[i].click();return true;}}return false;})()');
    await sleep(900);
    const shot2 = path.join(ROOT, 'build', 'sim-room.png');
    const s2 = await ws.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot2, Buffer.from(s2.data, 'base64'));
    console.log('截图      build\\sim-room.png（房间：' + room + '）');
  }

  /* 5) 打开一张卡的详情（长按 -> 弹层），验证 REST 曲线也在真实 HA 下工作 */
  const wantName = process.argv[4] || '';
  const opened = await evalJs('(function(){' +
    'var t=null;' +
    'if(' + JSON.stringify(wantName) + '){var all=document.querySelectorAll(".tile");' +
    'for(var i=0;i<all.length;i++){var n=all[i].querySelector(".t-name");' +
    'if(n&&n.textContent.trim()===' + JSON.stringify(wantName) + '){t=all[i];break;}}}' +
    'if(!t) t=document.querySelector(".tile");' +
    'if(!t) return false;' +
    'function ev(n){return new Event(n,{bubbles:true});}' +
    't.dispatchEvent(ev("touchstart"));return true;})()');
  if (opened) {
    await sleep(800);
    const sheet = await evalJs('(function(){var m=document.getElementById("mask");' +
      'var s=document.getElementById("sheet");' +
      'return {mask:!!(m&&m.className.indexOf("show")>=0), title:(document.querySelector(".sheet-title, .sheet h3, .hero-name")||{}).textContent||"",' +
      'hasSpark:!!document.querySelector(".spark-slot, .spark-wrap")};})()');
    console.log('长按弹层  ' + (sheet.mask ? '已打开' : '未打开') + (sheet.hasSpark ? ' · 有曲线区' : ''));
    const shot3 = path.join(ROOT, 'build', 'sim-sheet.png');
    const s3 = await ws.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot3, Buffer.from(s3.data, 'base64'));
    console.log('截图      build\\sim-sheet.png');
    await evalJs('(function(){var m=document.getElementById("mask");if(m)m.click();return true;})()');
  }

  ws.sock.destroy();
  edge.kill();
  console.log('');
  console.log(ready ? 'SIM OK（真实 HA 数据渲染正常）' : 'SIM WARN（页面起来了但没连上 HA）');
  process.exit(ready ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
