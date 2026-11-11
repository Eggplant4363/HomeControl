/*
 * 「编辑态图标一致 + 批量选择」验收（不需要平板）：Edge CDP 真点击。
 *   ① 图标一致：1×1 卡在编辑态仍是圆钮/大字读数模板，宽卡仍是 .t-icon，不再出现 .t-edit-ico
 *   ② 批量选择：编辑态左下角「批量选择」→ 点卡片勾选 → 全选 / 取消选择 / 批量移除
 *   ③ 批量移除写进 hc.edit.hidden，刷新后仍生效；退出多选 / 退出编辑按钮复位
 * 跑法：node tools\sim.js --mock --port 8794 然后 node tools\e2e-bulk.js
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
const CDP_PORT = 9342;
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

  const profile = path.join(ROOT, 'build', 'edge-bulk');
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
  if (!target) { console.log('E2E-BULK FAIL（拿不到 CDP 目标）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');
  await ws.call('Network.enable');
  await ws.call('Network.setCacheDisabled', { cacheDisabled: true });

  const evalJs = async (expr) => {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r && r.exceptionDetails) { console.log('  eval error: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return undefined; }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(150); }
    return false;
  };
  const clickAt = async (x, y) => {
    await ws.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await ws.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const clickSel = async (sel) => {
    const c = await evalJs(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return '';var r=n.getBoundingClientRect();return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
    if (!c) return false;
    const p = c.split(',').map(Number);
    await clickAt(p[0], p[1]);
    await sleep(450);
    return true;
  };
  const shot = async (name) => {
    const r = await ws.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };
  const tileCount = () => evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  const pickedCount = () => evalJs(`document.querySelectorAll('.tile.picked').length`);
  const barText = () => evalJs(`(function(){var b=document.getElementById('tileBar');return b&&/show/.test(b.className)?b.textContent.replace(/\\s+/g,' '):'';})()`);
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

  /* ============ ① 编辑态与平时的卡片模板一致 ============ */
  console.log('=== 1. 编辑态图标/模板与平时一致 ===');
  await setMode(false, { added: { 'switch.master_plug': 1, 'light.living_main': 1, 'sensor.living_temp': 1 }, hidden: {},
    order: ['switch.master_plug', 'light.living_main', 'sensor.living_temp'], span: {}, rows: {} });
  const TINY = '.tile[data-entity="switch.master_plug"]';
  const WIDE = '.tile[data-entity="light.living_main"]';
  check((await tileCount()) === 3, '手动模式 3 张卡');
  check(await evalJs(`(function(){var n=document.querySelector('${TINY}');return !!n && /\\btiny\\b/.test(n.className) && !!n.querySelector('.t-round');})()`), '平时：1×1 是圆钮模板');
  check(await evalJs(`(function(){var n=document.querySelector('${WIDE}');return !!n && !!n.querySelector('.t-icon') && !/\\btiny\\b/.test(n.className);})()`), '平时：宽卡是 .t-icon 模板');
  const tinySig0 = await evalJs(`(function(){var n=document.querySelector('${TINY}');return n?n.innerHTML.replace(/<div class="t-(tools|grip)"[\\s\\S]*?<\\/div>/g,''):'';})()`);

  await enterEdit();
  check(await evalJs(`!!document.querySelector('#bulkBtn') && getComputedStyle(document.querySelector('#bulkBtn')).display !== 'none'`), '进编辑后出现「批量选择」按钮');
  check(await evalJs(`!document.querySelector('.t-edit-ico')`), '编辑态不再出现 .t-edit-ico 那套图标');
  check(await evalJs(`(function(){var n=document.querySelector('${TINY}');return !!n && /\\btiny\\b/.test(n.className) && !!n.querySelector('.t-round');})()`), '编辑态：1×1 仍是圆钮模板');
  check(await evalJs(`(function(){var n=document.querySelector('${WIDE}');return !!n && !!n.querySelector('.t-icon') && !/\\btiny\\b/.test(n.className);})()`), '编辑态：宽卡仍是 .t-icon 模板');
  const tinySig1 = await evalJs(`(function(){var n=document.querySelector('${TINY}');return n?n.innerHTML.replace(/<div class="t-(tools|grip)"[\\s\\S]*?<\\/div>/g,'').replace(/\\s*picked|\\s*selected/g,''):'';})()`);
  check(tinySig0 === tinySig1, '1×1 卡片内容与平时一模一样（只有角上的尺寸标）', 'normal=' + String(tinySig0).slice(0, 80) + ' | edit=' + String(tinySig1).slice(0, 80));
  check(await evalJs(`(function(){var n=document.querySelector('${TINY} .t-size');return !!n && /1×/.test(n.textContent);})()`), '编辑态 1×1 卡片角上有「1×」尺寸标');
  await shot('bulk-1-edit-icons.png');

  /* 1×1 卡片里名称必须齐平：控制卡（64px 圆钮）和读数卡（34px 大字）核心区等高 */
  const ALIGN = await evalJs(`(function(){
    var tiles=[].slice.call(document.querySelectorAll('.grid .tile[data-entity]'));
    var rows={},bad=[],ctl=0,read=0;
    for(var i=0;i<tiles.length;i++){
      var t=tiles[i],r=t.getBoundingClientRect(),ln=t.querySelector('.t-line');
      if(!ln||!/\\btiny\\b/.test(t.className))continue;
      var lr=ln.getBoundingClientRect(),c=t.querySelector('.t-core');
      var key=Math.round(r.top);
      (rows[key]=rows[key]||[]).push(Math.round(lr.top-r.top));
      if(c&&Math.abs(c.getBoundingClientRect().height-64)>1.5)bad.push(t.getAttribute('data-entity')+' coreH='+c.getBoundingClientRect().height);
      if(/\\bt-line-c\\b/.test(ln.className))read++;else ctl++;
    }
    var spread=[];
    for(var k in rows){var v=rows[k];var mn=Math.min.apply(null,v),mx=Math.max.apply(null,v);if(mx-mn>1)spread.push('row'+k+':'+mn+'..'+mx);}
    return JSON.stringify({ctl:ctl,read:read,bad:bad,spread:spread});})()`);
  const al = JSON.parse(ALIGN);
  check(al.spread.length === 0, '同一排里所有 1×1 卡片的名称落在同一条线上', 'spread=' + al.spread.join(','));
  check(al.bad.length === 0, '控制卡/读数卡的核心区都是 64px 高', al.bad.join(' | '));
  check(al.ctl > 0 && al.read > 0, '两种 1×1 卡都在场（控制卡 ' + al.ctl + ' / 读数卡 ' + al.read + '）');
  /* 关掉编辑，回到第 ② 节的前提 */
  await clickSel('#editBtn');
  await sleep(500);
  await enterEdit();

  /* ============ ② 批量选择 ============ */
  console.log('=== 2. 批量选择 ===');
  await clickSel('#bulkBtn');
  check((await barText()).indexOf('已选') >= 0, '多选条出现（' + (await barText()) + '）');
  check(await evalJs(`!!document.querySelector('#tileBar [data-act="bulk-remove"]')`), '多选条里有「✕ 移除」');
  check(await evalJs(`!!document.querySelector('#tileBar [data-act="bulk-all"]')`), '多选条里有「全选」');
  check(await evalJs(`getComputedStyle(document.querySelector('#bulkBtn')).display === 'none'`), '多选时入口按钮让位给多选条');

  const ents = await evalJs(`Array.prototype.slice.call(document.querySelectorAll('.tile[data-entity]')).slice(0,2).map(function(n){return n.getAttribute('data-entity');})`);
  for (let i = 0; i < 2; i++) {
    const c = await evalJs(`(function(){var n=document.querySelectorAll('.tile[data-entity]')[${i}];var r=n.getBoundingClientRect();return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
    const p = c.split(',').map(Number);
    await clickAt(p[0], p[1]);
    await sleep(350);
  }
  check((await pickedCount()) === 2, '点两张卡后勾中 2 张（实际 ' + (await pickedCount()) + '）');
  check((await barText()).indexOf('已选 2') >= 0, '多选条显示「已选 2 张卡片」');
  await shot('bulk-2-picked.png');

  /* 再点一次取消勾选 / 全选 / 取消选择 */
  const c0 = await evalJs(`(function(){var n=document.querySelectorAll('.tile[data-entity]')[0];var r=n.getBoundingClientRect();return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
  const p0 = c0.split(',').map(Number);
  await clickAt(p0[0], p0[1]); await sleep(350);
  check((await pickedCount()) === 1, '再点一次可以取消勾选（剩 1 张）');
  await clickSel('#tileBar [data-act="bulk-all"]');
  check((await pickedCount()) === (await tileCount()), '全选把所有卡都勾上');
  await clickSel('#tileBar [data-act="bulk-none"]');
  check((await pickedCount()) === 0, '取消选择清空勾选');
  check(await evalJs(`/disabled/.test(document.querySelector('#tileBar [data-act="bulk-remove"]').outerHTML)`), '没勾选时「移除」是禁用的');

  /* ============ ③ 批量移除 ============ */
  console.log('=== 3. 批量移除 ===');
  const n0 = await tileCount();
  for (let i = 0; i < 2; i++) {
    const c = await evalJs(`(function(){var n=document.querySelectorAll('.tile[data-entity]')[${i}];var r=n.getBoundingClientRect();return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
    const p = c.split(',').map(Number);
    await clickAt(p[0], p[1]);
    await sleep(350);
  }
  check((await pickedCount()) === 2, '勾中 2 张准备移除');
  await clickSel('#tileBar [data-act="bulk-remove"]');
  await sleep(700);
  const n1 = await tileCount();
  check(n1 === n0 - 2, '一次移除 2 张（' + n0 + ' → ' + n1 + '）');
  const hid = await evalJs(`(function(){try{var e=JSON.parse(localStorage.getItem('hc.edit')||'{}');return Object.keys(e.hidden||{});}catch(err){return []}})()`);
  check(ents.every(e => hid.indexOf(e) >= 0), 'hc.edit.hidden 记住了这 2 张（' + JSON.stringify(hid) + '）');
  check((await pickedCount()) === 0, '移除后勾选清空');
  await shot('bulk-3-after.png');

  /* 刷新后仍是移除状态 */
  await evalJs(`location.reload(); 1`);
  await sleep(2600);
  check((await tileCount()) === n0 - 2, '刷新后仍是移除后的张数');

  /* ============ ④ 退出复位 ============ */
  console.log('=== 4. 退出复位 ===');
  await enterEdit();
  await clickSel('#bulkBtn');
  check((await pickedCount()) === 0 && (await barText()).indexOf('已选') >= 0, '再次进入多选是干净的');
  await clickSel('#tileBar [data-act="bulk-off"]');
  check((await barText()) === '', '「退出多选」收起多选条');
  check(await evalJs(`getComputedStyle(document.querySelector('#bulkBtn')).display !== 'none'`), '退出多选后入口按钮回来了');
  await evalJs(`document.querySelector('#editBtn').click(); 1`);
  await sleep(500);
  check(await evalJs(`getComputedStyle(document.querySelector('#bulkBtn')).display === 'none'`), '退出编辑后「批量选择」按钮隐藏');
  check(await evalJs(`document.querySelectorAll('.tile.picked').length === 0`), '退出编辑后没有残留勾选');

  /* ============ ⑤ 卡片里的控制按钮 / 右下角区也能选中 ============ */
  console.log('=== 5. 带控制的卡片、右下角区都能选中 ===');
  await setMode(false, {
    added: { 'cover.living_curtain': 1, 'switch.master_plug': 1 }, hidden: {}, order: ['cover.living_curtain', 'switch.master_plug'],
    span: { 'cover.living_curtain': 2 }, rows: {}
  });
  const COVER = '.tile[data-entity="cover.living_curtain"]';
  const PLUG = '.tile[data-entity="switch.master_plug"]';
  check(await evalJs(`!!document.querySelector('${COVER} [data-act="cover-open"]')`), '窗帘卡里有「打开」按钮（data-act）');

  /* 单选模式下点那张「打开」按钮：应该是选中这张卡，而不是真去开窗帘 */
  /* 拦一下后端：编辑态点任何控制按钮都不该发出服务调用 */
  await evalJs(`(function(){window.__calls=[];var M=window.MockBackend;if(M&&!M.__hooked){var o=M.prototype.call;M.prototype.call=function(d,s,dd){window.__calls.push(d+'.'+s);return o.apply(this,arguments);};M.__hooked=1;}return 1;})()`);
  await enterEdit();
  await evalJs(`window.__calls=[]; 1`);
  await clickSel(`${COVER} [data-act="cover-open"]`);
  check(await evalJs(`!!document.querySelector('${COVER}.selected')`), '编辑态点窗帘卡的「打开」是选中卡片');
  check((await evalJs(`(window.__calls||[]).length`)) === 0, '编辑态点「打开」没有发出任何服务调用（' + JSON.stringify(await evalJs(`window.__calls`)) + '）');

  /* 右下 88px 角区：单选时点一下＝选中，不是「什么都没发生」 */
  const corner = await evalJs(`(function(){var n=document.querySelector('${PLUG}');var r=n.getBoundingClientRect();return (r.right-20)+','+(r.bottom-20);})()`);
  const cp = corner.split(',').map(Number);
  await clickAt(cp[0], cp[1]); await sleep(450);
  check(await evalJs(`!!document.querySelector('${PLUG}.selected')`), '单选模式点卡片右下角区也是选中（不是死区）');
  check(await evalJs(`(function(){var n=document.querySelector('${PLUG}');return /(^|\s)(span-|rows-)/.test(n.className)===false;})()`), '点角区没有误改成 2×');

  /* 多选模式下：点「打开」按钮 = 勾选；点右下角区 = 勾选 */
  await clickSel('#bulkBtn');
  const btnSel = `${COVER} [data-act="cover-open"]`;
  await clickSel(btnSel);
  check((await pickedCount()) === 1 && await evalJs(`!!document.querySelector('${COVER}.picked')`), '多选时点窗帘卡的「打开」也照样勾中');
  await clickAt(cp[0], cp[1]); await sleep(450);
  check((await pickedCount()) === 2 && await evalJs(`!!document.querySelector('${PLUG}.picked')`), '多选时点右下角区也能勾中');
  check(await evalJs(`!document.querySelector('${PLUG} .t-grip')`), '多选模式不显示拉伸角（整张卡都能点）');
  await shot('bulk-4-corner.png');
  await clickSel('#tileBar [data-act="bulk-off"]');
  await evalJs(`document.querySelector('#editBtn').click(); 1`);
  await sleep(400);
  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-BULK PASS'); process.exit(0); }
  console.log('E2E-BULK FAIL (' + failed + ')');
  process.exit(1);
})();
