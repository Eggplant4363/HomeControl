'use strict';
// 共享的 CDP 客户端（CommonJS，供 tools/*.js 直接 require）。
// 以前每个 e2e/shot/probe 都手抄一遍 WebSocket 握手（14 份），改一处要改十四处。
// 现在只有一份实现：WS 帧编解码 + Edge 启动 + WebView 目标发现 + 常用动作。
//
// 用法示例：
//   const cdp = require('./lib/cdp');
//   const { ws, edge } = await cdp.connectWebView({ serial: 'emulator-5554' });
//   await cdp.evaluate(ws, 'document.querySelectorAll(".tile").length');
//   await cdp.screenshot(ws, 'build/shot.png');
//   cdp.closeAll(ws, edge);
//
// 注意：WebView 的 CDP 端口只有在 debug.flag 存在时才开（MainActivity 里门控）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ADB = process.env.HC_ADB || 'D:\\Software\\platform-tools\\adb.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(url, timeoutMs) {
  return new Promise((res, rej) => {
    const req = http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); });
    req.setTimeout(timeoutMs || 4000, () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
  });
}

/** adb 调用（经 cmd 调用，stderr 丢给 nul：adb 的进度都走 stderr）
 *  注意：带空格时才加引号——cmd 在 node spawn 下「引号包住的可执行路径」会静默不出输出 */
function adb(serial, args) {
  const exe = /\s/.test(ADB) ? '"' + ADB + '"' : ADB;
  const line = exe + ' ' + (serial ? '-s ' + serial + ' ' : '') + args.join(' ') + ' 2>nul';
  spawnSync('cmd', ['/c', line], { stdio: 'ignore' });
}

/** 需要拿到输出时用临时文件中转——沙箱里管道式 stdio 会 EPERM，工作区内的文件方式没问题 */
function adbOut(serial, args) {
  const dir = path.join(ROOT, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'hc-adb-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
  adb(serial, args.concat(['>', tmp]));
  let s = '';
  try { s = fs.readFileSync(tmp, 'utf8'); } catch (e) { }
  try { fs.unlinkSync(tmp); } catch (e) { }
  return s.replace(/\r/g, '').trim();
}

function findEdge() {
  return ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p)) || null;
}

/** 起一个无头 Edge，返回进程与它的 CDP 目标列表轮询函数 */
async function openEdge(opts) {
  const exe = opts.exe || findEdge();
  if (!exe) throw new Error('找不到 Edge/Chrome（设 opts.exe）');
  const port = opts.port || 9340;
  const userDir = opts.userDir || path.join(ROOT, 'build', 'edge-' + port);
  fs.mkdirSync(userDir, { recursive: true });
  const proc = spawn(exe, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
    '--window-size=' + (opts.windowSize || '1024,768'), opts.url || 'about:blank'], { stdio: 'ignore' });
  const target = await waitTarget(port, opts.urlMatch, opts.timeoutMs || 16000);
  if (!target) throw new Error('没拿到 CDP 目标（端口 ' + port + ' 没响应）');
  return { proc, target, port };
}

async function waitTarget(port, urlMatch, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 16000)) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + port + '/json/list'));
      // 旧内核（Android 5.1 / Chromium 57）的 /json/list 不给 webSocketDebuggerUrl，只给 id
      const t = list.find(x => x.type === 'page' && (x.webSocketDebuggerUrl || x.id) && (!urlMatch || x.url.indexOf(urlMatch) >= 0));
      if (t) return t;
    } catch (e) { }
  }
  return null;
}

/** 把 adb 的 WebView devtools socket 转发到本地 TCP，再连过去 */
async function connectWebView(opts) {
  const serial = opts.serial || process.env.HC_DEVICE || '';
  const port = opts.port || 9222;
  // Android 5.1 没有 pidof（Android 7+ 才有），所以两条路都试
  let pid = adbOut(serial, ['shell', 'pidof', '-s', 'com.homecontrol.panel']);
  if (!/^\d+$/.test(pid)) {
    const ps = adbOut(serial, ['shell', 'ps']);
    const line = ps.split('\n').find(l => l.indexOf('com.homecontrol.panel') >= 0);
    pid = line ? (line.trim().split(/\s+/)[1] || '') : '';
  }
  if (!/^\d+$/.test(pid)) throw new Error('com.homecontrol.panel 没在跑（先 tools\\push.ps1 -Restart）');
  adb(serial, ['forward', 'tcp:' + port, 'localabstract:webview_devtools_remote_' + pid]);
  await sleep(250);
  const edge = null;                     // 直接连设备上的 WebView，不需要 Edge
  const target = await waitTarget(port, opts.urlMatch, opts.timeoutMs || 8000);
  if (!target) throw new Error('WebView CDP 没响应——平板上是否有 /sdcard/HomeControl/debug.flag？（正式版不开调试端口）');
  // Android 5.1 的 Chromium 57 不给 webSocketDebuggerUrl，按约定拼一个
  const wsUrl = target.webSocketDebuggerUrl || ('ws://127.0.0.1:' + port + '/devtools/page/' + target.id);
  const ws = await WS.connect(wsUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');
  return { ws, edge, target, pid };
}

class WS {
  constructor(s) { this.sock = s; this.buf = Buffer.alloc(0); this.frames = []; this.waiters = []; }
  static async connect(u0) {
    const u = new URL(u0), sock = net.connect(Number(u.port), u.hostname);
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
      crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let head = Buffer.alloc(0), rest = Buffer.alloc(0);
    for (;;) {
      const c = await new Promise(r => sock.once('data', r));
      head = Buffer.concat([head, c]);
      const i = head.indexOf('\r\n\r\n');
      if (i >= 0) { rest = head.slice(i + 4); break; }
    }
    const ws = new WS(sock); sock.on('data', d => ws._onData(d)); if (rest.length) ws._onData(rest);
    return ws;
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
  async call(method, params, timeoutMs) {
    const id = ++WS.seq;
    const limit = timeoutMs || 20000;
    this._send(JSON.stringify({ id, method, params: params || {} }));
    for (;;) {
      let m;
      // 设备重启过（pid 变了）时旧 socket 不会再回任何帧，没有超时就永远挂住
      let frame;
      try {
        frame = await Promise.race([this.recv(), new Promise((_, rej) => setTimeout(() => rej(new Error(method + ': CDP 超时 ' + limit + 'ms（平板上的面板进程可能已重启，重连一次）')), limit))]);
      } catch (e) { throw e; }
      try { m = JSON.parse(frame); } catch (e) { continue; }
      if (m.id === id) return m.result;
      if (m.error) throw new Error(method + ': ' + m.error.message);
    }
  }
  close() { try { this.sock.destroy(); } catch (e) { } }
}
WS.seq = 0;

async function evaluate(ws, expr, awaitPromise) {
  const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
  if (r && r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.message) || r.exceptionDetails.text);
  return r && r.result ? r.result.value : undefined;
}

async function wait(ws, expr, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await evaluate(ws, expr)) return true;
    await sleep(200);
  }
  return false;
}

async function screenshot(ws, file) {
  const r = await ws.call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

function closeAll(ws, edge) {
  if (ws) ws.close();
  if (edge) { try { edge.kill(); } catch (e) { } }
}

module.exports = { WS, adb, adbOut, httpGet, sleep, findEdge, openEdge, waitTarget, connectWebView, evaluate, wait, screenshot, closeAll, ROOT, ADB };
