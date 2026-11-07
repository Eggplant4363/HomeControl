/*
 * 重命名验收（不需要平板）：用 Edge CDP 真点击，验证
 *   长按卡片 → 铅笔 → 输入新名 → 保存 → 卡片改名 + localStorage["hc.names"]
 *   诊断页 → 面板设置 → 恢复默认名称 → 名字回滚
 * 跑法：node tools\e2e-rename.js（前提：node tools\sim.js --mock --port 8791 已启动）
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8791/';
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
      if (i >= 0) { if (!/101/.test(head.slice(0, i).toString())) throw new Error('WS handshake failed'); rest = head.slice(i + 4); break; }
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
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\sim.js --mock --port 8791'); process.exit(1); }

  const profile = path.join(ROOT, 'build', 'edge-rn');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9334', '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:9334/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8791') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-RENAME FAIL（拿不到 CDP 目标）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r && r.exceptionDetails) { console.log('  eval error: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return undefined; }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(200); }
    return false;
  };
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const text = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.replace(/\\s+/g,' ').trim():'';})()`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);

  await evalJs('try{localStorage.clear()}catch(e){}; 1');
  /* 现在默认一张卡都不显示：先往 hc.edit 里写入要用的卡片，再刷新 */
  await evalJs(`localStorage.setItem('hc.edit', JSON.stringify({ added: { 'light.living_main': 1, 'light.living_strip': 1, 'switch.living_tv': 1, 'climate.living_ac': 1, 'cover.living_curtain': 1, 'sensor.living_temp': 1, 'sensor.living_humidity': 1, 'binary_sensor.living_motion': 1 }, order: ['light.living_main', 'light.living_strip', 'switch.living_tv', 'climate.living_ac', 'cover.living_curtain', 'sensor.living_temp', 'sensor.living_humidity', 'binary_sensor.living_motion'], span: {} })); 1`);
  await evalJs('location.reload(); 1');
  check(await waitFor(`document.querySelectorAll('.tile').length > 6`, 10000), '面板渲染出卡片');
  const before = await text('.tile[data-entity="light.living_main"] .t-name');

  console.log('=== 1. 打开弹层，铅笔可见 ===');
  await click('.tile[data-entity="light.living_main"] .t-more');
  check(await waitFor(`!!document.querySelector('.sheet.show .sheet-rename')`), '弹层头部有重命名铅笔');
  check((await text('.sheet.show .sheet-name')) === before, '弹层标题 = 卡片名（' + before + '）');

  console.log('=== 2. 重命名页 ===');
  await click('.sheet.show .sheet-rename');
  check(await waitFor(`!!document.querySelector('#rnIn')`), '打开重命名页');
  const pref = await evalJs(`document.querySelector('#rnIn') ? document.querySelector('#rnIn').value : ''`);
  check(pref === before, '输入框预填当前名（' + pref + '）');

  console.log('=== 3. 保存后卡片改名 ===');
  await evalJs(`(function(){var i=document.querySelector('#rnIn');i.value='测试灯';i.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
  await click('[data-act="rename-save"]');
  await sleep(900);
  const afterName = await text('.tile[data-entity="light.living_main"] .t-name');
  check(afterName === '测试灯', '卡片显示新名（' + afterName + '）');
  const store = await evalJs(`localStorage['hc.names'] || ''`);
  check(String(store).indexOf('light.living_main') >= 0 && String(store).indexOf('测试灯') >= 0, 'localStorage hc.names 已写入');

  console.log('=== 4. 恢复默认名称 ===');
  check((await longPress('#time', 900)) === 1, '对时间长按打开诊断页');
  check(await waitFor(`!!document.querySelector('[data-act="diag-panel"]')`), '诊断页有面板设置按钮');
  await click('[data-act="diag-panel"]');
  await sleep(600);
  check(await waitFor(`!!document.querySelector('[data-act="names-reset"]')`), '面板设置里有「恢复默认名称」');
  await click('[data-act="names-reset"]');
  await sleep(800);
  const resetName = await text('.tile[data-entity="light.living_main"] .t-name');
  const store2 = await evalJs(`localStorage['hc.names'] || ''`);
  check(resetName === before, '恢复默认后名字回滚（' + resetName + '）');
  check(String(store2) === '{}' || String(store2) === '', 'localStorage hc.names 已清空（' + store2 + '）');

  ws.close();
  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-RENAME PASS'); process.exit(0); }
  console.log('E2E-RENAME FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-RENAME 异常: ' + (e && e.message)); process.exit(1); });
