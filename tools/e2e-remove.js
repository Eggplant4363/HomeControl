/*
 * 「编辑模式移除卡片」验收（不需要平板）：Edge CDP 真点击。
 * 覆盖两种显示模式：
 *   ① 显示全部设备（allCards=true）——以前这里点「✕ 移除」是空操作，
 *      因为卡是从「全部设备」来的，删 added 等于没删；现在靠 hc.edit.hidden 生效
 *   ② 手动添加（allCards=false）—— 移除照旧删 added
 * 另验证：移除后能再加回来、全部清空真的清空、恢复默认是空屏。
 * 跑法：node tools\sim.js --mock --port 8794 然后 node tools\e2e-remove.js
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8794/';
const CDP_PORT = 9341;
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
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\\sim.js --mock --port 8794'); process.exit(1); }

  const profile = path.join(ROOT, 'build', 'edge-remove');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8794') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-REMOVE FAIL（拿不到 CDP 目标）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');
  await ws.call('Network.enable');
  await ws.call('Network.setCacheDisabled', { cacheDisabled: true });

  const evalJs = async (expr, awaitPromise) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r && r.exceptionDetails) { console.log('  eval error: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return undefined; }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(150); }
    return false;
  };
  const tileCount = () => evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  const clickAt = async (x, y) => {
    await ws.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await ws.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const centerOf = async (sel) => {
    const s = await evalJs(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return '';var r=n.getBoundingClientRect();return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()`);
    return s ? s.split(',').map(Number) : null;
  };
  const shot = async (name) => {
    const r = await ws.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };
  const setMode = async (allCards, added) => {
    await evalJs(`(function(){
      localStorage.setItem('hc.guide.v1','1'); localStorage.setItem('hc.hint.v1','1');
      localStorage.setItem('hc.prefs', JSON.stringify({cols:4,allCards:${allCards},size:'md',sensors:true,offline:false,tap:'toggle',undo:5,autoDim:true,bright:100,night:true,burn:true,theme:'dark'}));
      localStorage.setItem('hc.edit', JSON.stringify(${JSON.stringify(added || { added: {}, hidden: {}, order: [], span: {}, rows: {} })}));
      location.reload(); return 1;})()`);
    await sleep(2600);
    await waitFor(`document.querySelectorAll('.tile[data-entity]').length > 0`, 8000);
  };
  const enterEdit = async () => { await evalJs(`document.querySelector('#editBtn').click(); 1`); await sleep(500); };
  const pickFirstTile = async () => {
    const c = await centerOf('.tile[data-entity]');
    if (!c) return null;
    const ent = await evalJs(`document.querySelectorAll('.tile[data-entity]')[0].getAttribute('data-entity')`);
    await clickAt(c[0], c[1]);
    await sleep(500);
    return ent;
  };
  const barShown = () => evalJs(`(function(){var b=document.getElementById('tileBar');return !!b && /show/.test(b.className) && !!b.querySelector('[data-act="card-remove"]');})()`);
  const clickRemove = async () => {
    const c = await centerOf('#tileBar [data-act="card-remove"]');
    if (!c) return false;
    await clickAt(c[0], c[1]);
    await sleep(700);
    return true;
  };
  const hiddenOf = async () => evalJs(`(function(){try{var e=JSON.parse(localStorage.getItem('hc.edit')||'{}');return Object.keys(e.hidden||{});}catch(err){return []}})()`);

  /* ============ ① 显示全部设备：移除必须真的消失 ============ */
  console.log('=== 1. 显示全部设备时移除一张卡 ===');
  await setMode(true);
  const n0 = await tileCount();
  check(n0 > 3, '「显示全部设备」下有一屏卡（' + n0 + ' 张）');
  await enterEdit();
  check(await evalJs(`document.querySelector('#editBtn').getAttribute('data-editing') === '1'`), '进入编辑模式');
  const ent = await pickFirstTile();
  check(!!ent, '点卡片选中了「' + ent + '」');
  check(await barShown(), '浮出工具条，里面有「✕ 移除」');
  await shot('remove-1-selected.png');
  check(await clickRemove(), '点了「✕ 移除」');
  const n1 = await tileCount();
  check(n1 === n0 - 1, '卡片真的少了一张（' + n0 + ' → ' + n1 + '）', '还是 ' + n1 + ' 张');
  check(!(await evalJs(`!!document.querySelector('.tile[data-entity="${ent}"]')`)), '被移除的那张不在网格里了');
  const hid = await hiddenOf();
  check(hid.indexOf(ent) >= 0, 'hc.edit.hidden 记住了这张卡（' + JSON.stringify(hid) + '）');
  check(!(await evalJs(`/show/.test((document.getElementById('tileBar')||{}).className||'')`)), '移除后工具条收起');
  await shot('remove-2-after.png');

  /* 刷新后依然不在（持久化） */
  await evalJs(`location.reload(); 1`);
  await sleep(2600);
  check(!(await evalJs(`!!document.querySelector('.tile[data-entity="${ent}"]')`)), '刷新页面后仍是移除状态');

  /* ============ ② 从「添加卡片」列表加回来 ============ */
  console.log('=== 2. 从添加列表把它加回来 ===');
  await enterEdit();
  /* 添加格子在一屏卡的最末尾（多半在屏幕外），直接点节点即可 */
  await evalJs(`(function(){var n=document.querySelector('.tile.t-empty');if(n){n.click();return 'cell';}var b=document.querySelector('[data-act="edit-add"]');if(b){b.click();return 'btn';}return 'none';})()`);
  await sleep(600);
  check(await evalJs(`!!document.querySelector('.sheet.show')`), '添加卡片列表打开了');
  const rowOn = await evalJs(`(function(){var r=document.querySelector('[data-act="add-toggle:${ent}"]');return r ? /(^|\\s)on(\\s|$)/.test(r.className) : null;})()`);
  check(rowOn === false, '被移除的那一行在列表里是未勾选状态');
  const rowC = await centerOf('[data-act="add-toggle:' + ent + '"]');
  if (rowC) await clickAt(rowC[0], rowC[1]);
  await sleep(700);
  check((await hiddenOf()).indexOf(ent) < 0, '加回来时清掉了 hidden');
  check(await evalJs(`!!document.querySelector('.tile[data-entity="${ent}"]')`), '卡片回到网格里了');
  await shot('remove-3-readd.png');

  /* ============ ③ 全部清空 / 恢复默认：显示全部设备时也要真的空 ============ */
  console.log('=== 3. 显示全部设备时「全部清空」真的要空 ===');
  await evalJs(`(function(){var b=document.querySelector('[data-act="add-done"]');if(b)b.click();})()`);
  await sleep(400);
  await evalJs(`(function(){var b=document.querySelector('#editBtn');b.click();})()`); /* 退出编辑 */
  await sleep(400);
  await evalJs(`(function(){var b=document.querySelector('#gear');b.click();})()`);
  await sleep(700);
  const resetBtn = await evalJs(`(function(){
    var ns = document.querySelectorAll('[data-act]');
    for (var i=0;i<ns.length;i++){ var a=ns[i].getAttribute('data-act'); if (a==='edit-reset') return 'yes'; }
    return 'no';})()`);
  check(resetBtn === 'yes', '设置里能找到「清空/恢复默认」入口');
  await evalJs(`(function(){var ns=document.querySelectorAll('[data-act="edit-reset"]');for(var i=0;i<ns.length;i++){ns[i].click();return 'clicked';}return 'none';})()`);
  await sleep(900);
  const n2 = await tileCount();
  check(n2 === 0, '恢复默认后网格是空的（' + n2 + ' 张）');
  await evalJs(`location.reload(); 1`);
  await sleep(2600);
  check((await tileCount()) === 0, '刷新后依然是空屏');

  /* ============ ④ 手动添加模式（allCards=false）移除照旧 ============ */
  console.log('=== 4. 手动添加模式：移除照旧可用 ===');
  await setMode(false, { added: { 'light.living_main': 1, 'light.master_main': 1, 'switch.master_plug': 1 }, hidden: {}, order: ['light.living_main', 'light.master_main', 'switch.master_plug'], span: {}, rows: {} });
  const m0 = await tileCount();
  check(m0 === 3, '手动添加的 3 张卡都在（' + m0 + '）');
  await enterEdit();
  await pickFirstTile();
  check(await barShown(), '工具条 + 移除按钮在');
  await clickRemove();
  const m1 = await tileCount();
  check(m1 === m0 - 1, '移除后少一张（' + m0 + ' → ' + m1 + '）');

  const trail = await evalJs(`(function(){try{var e=JSON.parse(localStorage.getItem('hc.edit')||'{}');return JSON.stringify({added:Object.keys(e.added||{}),hidden:Object.keys(e.hidden||{})});}catch(err){return ''}})()`);
  console.log('  hc.edit = ' + trail);

  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-REMOVE PASS'); process.exit(0); }
  console.log('E2E-REMOVE FAIL (' + failed + ')');
  process.exit(1);
})();
