/*
 * PC 侧交互验收（不需要平板）：用 Edge 的 CDP 真正点面板，验证「点了会不会变」。
 * 跑法：node tools\e2e-pc.js        依赖：本机 Edge，node 内置模块，无 npm 依赖
 */
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8787/';
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));

let failed = 0;
const check = (ok, name, extra) => {
  if (ok) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); if (extra) console.log('        ' + extra); failed++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const httpGet = url => new Promise((resolve, reject) => {
  http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b)); }).on('error', reject);
});

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
      const chunk = await new Promise(r => sock.once('data', r));
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i >= 0) { if (!/101/.test(head.slice(0, i).toString())) throw new Error('WS 握手失败'); rest = head.slice(i + 4); break; }
    }
    const ws = new WS(sock);
    sock.on('data', d => ws._onData(d));
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
  recv() { return this.frames.length ? Promise.resolve(this.frames.shift()) : new Promise(r => this.waiters.push(r)); }
  async call(method, params) {
    const id = ++WS.seq;
    this._send(JSON.stringify({ id, method, params: params || {} }));
    for (;;) {
      let msg; try { msg = JSON.parse(await this.recv()); } catch (e) { continue; }
      if (msg.id === id) return msg.result;
    }
  }
  close() { try { this.sock.destroy(); } catch (e) { } }
}
WS.seq = 0;

(async () => {
  if (!EDGE) { console.log('未找到 Edge，跳过'); process.exit(0); }

  let server = null;
  try { await httpGet(PANEL_URL); } catch (e) {
    server = spawn('node', [path.join(ROOT, 'tools', 'devserver.js')], { cwd: ROOT, stdio: 'ignore' });
    await sleep(1500);
  }

  const profile = path.join(ROOT, 'build', 'edge-e2e');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9333', '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:9333/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8787') >= 0);
    } catch (e) { }
  }
  if (!target) { check(false, '拿到 CDP 页面目标'); console.log('E2E FAIL'); process.exit(1); }
  check(true, '拿到 CDP 页面目标');

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r && r.exceptionDetails) return undefined;
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(200); }
    return false;
  };
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const text = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.replace(/\\s+/g,' ').trim():'';})()`);
  const count = sel => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);

  /* 干净起点：清掉上一轮留下的 localStorage，让首次引导一定出现 */
  await evalJs('try{localStorage.clear()}catch(e){}; location.reload(); 1');
  await sleep(2500);

  console.log('=== 1. 启动 ===');
  check(await waitFor(`document.querySelectorAll('.tile').length > 6`), '面板渲染出卡片');
  const tiles = await count('.tile');
  check(tiles >= 8, '卡片数量 >= 8（实际 ' + tiles + '）');

  console.log('=== 2. 首次引导 ===');
  check(await waitFor(`!!document.querySelector('.sheet.show .g-step')`), '自动弹出三步引导');
  check((await count('.sheet.show .g-step')) === 3, '引导三步');
  check(await click('[data-act="guide-demo"]'), '点「先看模拟数据」');
  await sleep(700);
  check(!(await evalJs(`!!document.querySelector('.sheet.show')`)), '弹层关闭');

  console.log('=== 3. 开关灯 + 撤销 ===');
  await click('.tile[data-entity="light.living_strip"]');
  await sleep(600);
  let cls = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  check(String(cls).indexOf('on') >= 0, '点灯带后卡片变 on（' + cls + '）');
  let tst = await text('#toast');
  check(/已开启/.test(tst), 'toast 提示已开启（' + tst + '）');
  await click('#toast .toast-act');
  await sleep(800);
  cls = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  check(String(cls).indexOf('on') < 0, '点撤销后回到 off（' + cls + '）');

  console.log('=== 4. 灯详情 + 换色 ===');
  check((await longPress('.tile[data-entity="light.living_main"]', 700)) === 1, '对灯卡长按 700ms');
  check(await waitFor(`!!document.querySelector('.sheet.show .sw-row')`), '打开灯弹层且有换色块');
  check((await count('.sheet.show .sw')) === 8, '8 个预设颜色');
  await click('.sheet.show .sw:nth-child(5)');
  await sleep(700);
  check((await count('.sheet.show .sw.on')) === 1, '只有选中的色块高亮');
  await click('#mask');
  await sleep(500);

  console.log('=== 5. 场景执行 ===');
  check((await count('.chip[data-scene]')) > 0, '有场景键');
  await click('.chip[data-scene]');
  await sleep(600);
  tst = await text('#toast');
  check(/已执行|已触发/.test(tst), '点场景有反馈（' + tst + '）');

  console.log('=== 6. 诊断页 + 面板设置 ===');
  check((await longPress('#time', 900)) === 1, '对时间长按 900ms');
  check(await waitFor(`!!document.querySelector('.sheet.show .diag')`), '打开诊断页');
  const diag = await text('.sheet.show .diag');
  check(/版本/.test(diag), '诊断页有版本行');
  check(/内存/.test(diag), '诊断页有内存行');
  await click('[data-act="diag-panel"]');
  await sleep(600);
  const rows = await count('.sheet.show .p-row');
  check(rows >= 6, '面板设置列出房间（' + rows + ' 行）');
  const before = await count('.tab[data-room]');
  await click('.sheet.show .p-sw');
  await sleep(600);
  const after = await count('.tab[data-room]');
  check(after === before - 1, '隐藏一个房间后 tab 少一个（' + before + '→' + after + '）');
  await click('[data-act="room-reset"]');
  await sleep(500);
  check((await count('.tab[data-room]')) === before, '恢复默认后 tab 复原');

  ws.close();
  try { edge.kill(); } catch (e) { }
  if (server) { try { server.kill(); } catch (e) { } }

  console.log('');
  if (failed === 0) { console.log('E2E PASS'); process.exit(0); }
  console.log('E2E FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E 异常: ' + (e && e.message)); process.exit(1); });
