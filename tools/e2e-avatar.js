/*
 * 重命名验收（不需要平板）：用 Edge CDP 真点击，验证
 *   长按卡片 → 铅笔 → 输入新名 → 保存 → 卡片改名 + localStorage["hc.names"]
 *   诊断页 → 面板设置 → 恢复默认名称 → 名字回滚
 * 跑法：node tools\E2E-AVATAR.js（前提：node tools\sim.js --mock --port 8793 已启动）
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8793/';
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
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\sim.js --mock --port 8793'); process.exit(1); }

  const profile = path.join(ROOT, 'build', 'edge-who');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9337', '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:9337/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8793') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-AVATAR FAIL（拿不到 CDP 目标）'); process.exit(1); }

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
  const text = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");return e?e.textContent.replace(/\\s+/g,' ').trim():'';})()");
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);
  /* ============ 住户头像 / 在家-离家 验收 ============ */
  await ws.call('Network.enable');
  await ws.call('Network.setCacheDisabled', { cacheDisabled: true });
  await evalJs("try{localStorage.clear();localStorage['hc.guide.v1']='1';localStorage['hc.hint.v1']='1';}catch(e){}; 1");
  await evalJs('location.reload(); 1');
  check(await waitFor("!!document.querySelector('#who .who-t')", 12000), '顶栏出现住户区');

  const cls = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");return e?e.className:'';})()");
  const rect = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(!e)return null;var r=e.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height,rr:r.right,b:r.bottom};})()");
  const shot = async (n) => { const r = await ws.call('Page.captureScreenshot', { format: 'png' }); if (r && r.data) fs.writeFileSync(path.join(ROOT, 'build', n), Buffer.from(r.data, 'base64')); };

  console.log('=== 1. 位置与内容 ===');
  check((await evalJs("typeof window.__PANEL_TEST__.whoState === 'function'")), '浏览器里跑的是新版 app.js（有 whoState）');
  check((await text('#who .who-t')) === '在家', '默认显示「在家」', 'got ' + await text('#who .who-t'));
  check((await cls('#who')).indexOf('home') >= 0, '顶栏住户区带 home 类');
  check((await evalJs("document.querySelectorAll('#who .who-av').length")) === 1, '只有一个住户头像');
  check((await evalJs("!!document.querySelector('#who .who-av img')")), '头像用 img 渲染（不是只有首字母）');
  check((await evalJs("(function(){var i=document.querySelector('#who .who-av img');return i&&i.naturalWidth>0;})()")), '头像图真的加载出来了');
  const rw = await rect('#who'), rs = await rect('#status'), rt = await rect('.topbar');
  check(rw && rs && rw.rr <= rs.l + 1, '住户区在「已连接」左边（不重叠）');
  check(rw && rs && Math.abs((rw.t + rw.h / 2) - (rs.t + rs.h / 2)) < 3, '与状态胶囊垂直居中对齐');
  check(rw && rs && (rs.l - rw.rr) >= 6 && (rs.l - rw.rr) <= 24, '和状态胶囊间距合理（' + (rs.l - rw.rr).toFixed(1) + 'px）');
  const sh = await evalJs("getComputedStyle(document.querySelector('#who .who-av')).boxShadow");
  check(/61,\s*220,\s*132/.test(sh || ''), '在家时头像描边是绿色', 'got ' + sh);
  await shot('shot-who-home.png');

  console.log('=== 2. 离家 / 未知 / 无住户 ===');
  await evalJs("window.__PANEL_TEST__.setStates({ 'person.mock_owner': { entity_id:'person.mock_owner', state:'not_home', attributes:{ friendly_name:'我' } } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await text('#who .who-t')) === '离家', 'not_home → 显示「离家」');
  check((await cls('#who')).indexOf('away') >= 0, '离家时顶栏带 away 类');
  const sh2 = await evalJs("getComputedStyle(document.querySelector('#who .who-av')).boxShadow");
  check(!/61,\s*220,\s*132/.test(sh2 || ''), '离家时描边不再是绿色', 'got ' + sh2);
  await shot('shot-who-away.png');

  await evalJs("window.__PANEL_TEST__.setStates({ 'person.mock_owner': { entity_id:'person.mock_owner', state:'unavailable', attributes:{} } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await text('#who .who-t')) === '状态未知', 'unavailable → 显示「状态未知」');

  await evalJs("window.__PANEL_TEST__.setStates({ 'light.kitchen_main': { entity_id:'light.kitchen_main', state:'on', attributes:{} } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await evalJs("getComputedStyle(document.querySelector('#who')).display")) === 'none', '没有 person 实体时住户区整个隐藏');

  console.log('=== 3. 多人 ===');
  await evalJs("window.__PANEL_TEST__.setStates({ 'person.a': { entity_id:'person.a', state:'home', attributes:{ friendly_name:'A' } }, 'person.b': { entity_id:'person.b', state:'not_home', attributes:{ friendly_name:'B' } } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await evalJs("document.querySelectorAll('#who .who-av').length")) === 2, '两个住户画出两个头像');
  check((await text('#who .who-t')) === '1/2 在家', '多人时显示「1/2 在家」', 'got ' + await text('#who .who-t'));

  ws.close();
  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-AVATAR PASS'); process.exit(0); }
  console.log('E2E-AVATAR FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-AVATAR 异常: ' + (e && e.message)); process.exit(1); });
