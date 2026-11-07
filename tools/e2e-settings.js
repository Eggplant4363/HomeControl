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
const MOCK_URL = 'http://127.0.0.1:8791/';
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

  const profile = path.join(ROOT, 'build', 'edge-set');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9336', '--user-data-dir=' + profile, '--window-size=1024,768', MOCK_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:9336/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8791') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-SETTINGS FAIL（拿不到 CDP 目标）'); process.exit(1); }

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
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return 1;})()`);
  const text = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.replace(/\\s+/g,' ').trim():'';})()`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);

  const store = async key => { const v = await evalJs('localStorage.getItem(' + JSON.stringify(key) + ')'); return v === undefined || v === null ? '' : String(v); };
  const shot = async name => { const r = await ws.call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT, 'docs', 'screens', name), Buffer.from(r.data, 'base64')); };
  await evalJs('(function(){try{localStorage.clear()}catch(e){}location.reload();return 1;})()');
  await sleep(2000);
  /* 首进会弹「接入 HA」引导页（1200ms 后），先标记已看过再重载，截图和断言才干净 */
  await evalJs(`localStorage.setItem('hc.guide.v1','1'); localStorage.setItem('hc.hint.v1','1'); location.reload(); 1`);
  await sleep(2500);

  console.log('=== 0. 添加卡片：默认没有卡 → 编辑 → 从列表里挑 ===');
  console.log('  LS probe set/read:', await evalJs(`(function(){try{localStorage.setItem('probe1','v1');var r=localStorage.getItem('probe1');localStorage.removeItem('probe1');return 'ok=' + r;}catch(e){return 'err:' + e.message;}})()`));
  await waitFor(`document.querySelectorAll('.tile[data-entity]').length >= 0`, 8000);
  const tiles0 = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  check(tiles0 === 0, '默认不添加任何设备（实际 ' + tiles0 + ' 张）');
  await click('#editBtn');
  check(await waitFor(`document.querySelector('#editBtn').getAttribute('data-editing') === '1'`), '点编辑按钮进入编辑模式（按钮变 ✓）');
  const tilesEdit = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  check(tilesEdit === 0, '编辑模式不会把全部设备铺出来（' + tilesEdit + ' 张）');
  check(!(await evalJs(`!!document.querySelector('.edit-bar.show')`)), '编辑模式不再显示那一行工具条');
  check(await evalJs(`!!document.querySelector('[data-act="edit-add"]')`), '空网格里有「＋ 添加卡片」入口');
  await shot('panel-edit-empty.png');
  await click('[data-act="edit-add"]');
  check(await waitFor(`!!document.querySelector('.sheet.show .ed-row')`), '「+ 添加卡片」打开可选列表');
  const listRows = await evalJs(`document.querySelectorAll('.sheet.show .ed-row').length`);
  check(listRows > 0, '列表里列出了可选设备（' + listRows + ' 个）');
  /* 从列表挑 4 个：每点一次面板会重排，所以按「首个未勾选的行」点，不按固定下标 */
  for (let i = 0; i < 4; i++) {
    const hit = await evalJs(`(function(){var r=document.querySelectorAll('.sheet.show .ed-row');for(var k=0;k<r.length;k++){if(r[k].className.indexOf(' on')<0){r[k].click();return k+1;}}return 0;})()`);
    if (!hit) { console.log('  （第 ' + (i + 1) + ' 次没找到未勾选的行）'); }
    await sleep(250);
  }
  const picked = await evalJs(`document.querySelectorAll('.grid .tile[data-entity]').length`);
  check(picked === 4, '挑了 4 个 → 网格里出现 4 张卡（实际 ' + picked + '）');
  const editStore = await store('hc.edit');
  const parsed = editStore ? JSON.parse(editStore) : {};
  const addedCount = Object.keys(parsed.added || {}).length;
  check(addedCount === 4, 'hc.edit.added 写入 4 个（实际 ' + addedCount + '）');
  await click('[data-act="add-done"]');
  await sleep(500);
  check(await evalJs(`!(document.querySelector('.sheet.show'))`), '「完成」关掉添加列表');
  check(await evalJs(`document.querySelector('#editBtn').getAttribute('data-editing') === '1'`), '关列表后仍在编辑模式（✓ 还亮着）');
  await shot('panel-edit-cards.png');
  await click('#editBtn');
  await sleep(500);
  check(await evalJs(`document.querySelector('#editBtn').getAttribute('data-editing') === '0'`), '点顶栏 ✓ 退出编辑（按钮回到 ✎）');
  check(!(await evalJs(`!!document.querySelector('.tile.t-empty')`)), '退出编辑后虚线「＋ 添加卡片」格子消失');
  const tilesAfter = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  check(tilesAfter === 4, '退出编辑后保留挑的 4 张卡（' + tilesAfter + '）');
  await sleep(300);

  console.log('=== 1. 打开设置 ===');
  if (await evalJs(`document.querySelector('.sheet.show')`)) { await click('[data-act="close"]'); await sleep(300); }
  await click('#gear');
  check(await waitFor(`!!document.querySelector('.set-row')`), '点齿轮打开设置页');
  check((await text('.view.show .sheet-title')) === '设置', '标题是「设置」');
  const rows = await evalJs(`document.querySelectorAll('.view.show .set-row').length`);
  check(rows >= 10, '设置项 >= 10（实际 ' + rows + '）');

  console.log('=== 1b. 编辑模式下也能点设置项，但要先退出编辑再验网格 ===');
  await longPress('#time', 900);
  await waitFor(`!!document.querySelector('[data-act="diag-panel"]')`);
  await click('[data-act="diag-panel"]');
  await waitFor(`!!document.querySelector('.set-row')`);

  console.log('=== 2. 每行卡片 3 列 ===');

  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="cols"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='3')b[i].click();return 1;})()`);
  await sleep(600);


  const cls3 = await evalJs(`document.querySelector('.grid').className`);
  check(String(cls3).indexOf('cols-3') >= 0, '网格变成 3 列（' + cls3 + '）');
  const pref3 = await store('hc.prefs');
  check(String(pref3).indexOf('"cols":3') >= 0, '偏好写入 hc.prefs（' + pref3 + '）');

  console.log('=== 3. 隐藏传感器卡 ===');
  const beforeTiles = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="sensors"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='false')b[i].click();return 1;})()`);
  await sleep(700);
  const afterTiles = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  const sensorsPref = await store('hc.prefs');
  check(String(sensorsPref).indexOf('"sensors":false') >= 0, '隐藏传感器偏好已写入（' + sensorsPref + '）');
  check(afterTiles <= beforeTiles, '隐藏传感器后卡片不会变多（' + beforeTiles + '→' + afterTiles + '）');
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="sensors"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='true')b[i].click();return 1;})()`);
  await sleep(500);

  console.log('=== 4. 点一下打开面板（不直接开关）===');
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="tap"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='sheet')b[i].click();return 1;})()`);
  await sleep(500);
  await click('[data-act="close"]');
  await sleep(400);
  const st0 = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  await click('.tile[data-entity="light.living_strip"]');
  await sleep(700);
  const sheetOpen = await evalJs(`!!document.querySelector('.sheet.show')`);
  const st1 = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  check(sheetOpen === true, '点卡片打开了面板');
  check(/\bon\b/.test(st0) === /\bon\b/.test(st1), '没有误开关（' + st0 + ' → ' + st1 + '）');
  await click('#mask');
  await sleep(300);

  console.log('=== 5. 恢复默认设置 ===');
  await click('#gear');
  await waitFor(`!!document.querySelector('[data-act="pref-reset"]')`);
  await click('[data-act="pref-reset"]');
  await sleep(800);
  const cls4 = await evalJs(`document.querySelector('.grid').className`);
  const prefsEnd = await store('hc.prefs');
  check(String(cls4).indexOf('cols-4') >= 0, '恢复默认后回到 4 列（' + cls4 + '）');
  check(String(prefsEnd) === '' || String(prefsEnd) === '{}', 'hc.prefs 已清空（' + prefsEnd + '）');

  console.log('=== 6. 每行 6 列 + 卡片跨列 + 顺序稳定 ===');
  if (await evalJs(`document.querySelector('.sheet.show')`)) { await click('[data-act="close"]'); await sleep(300); }
  await click('#gear');
  await waitFor(`!!document.querySelector('.set-row')`);
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="cols"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='6')b[i].click();return 1;})()`);
  await sleep(500);
  const cls6 = await evalJs(`document.querySelector('.grid').className`);
  check(String(cls6).indexOf('cols-6') >= 0, '网格变成 6 列（' + cls6 + '）');

  /* 顺序：切回 3 列，卡片顺序必须一致 */
  const orderOf = () => evalJs(`(function(){var a=[];var t=document.querySelectorAll('.grid .tile[data-entity]');for(var i=0;i<t.length;i++)a.push(t[i].getAttribute('data-entity'));return a.join(',');})()`);
  const o6 = await orderOf();
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="cols"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='3')b[i].click();return 1;})()`);
  await sleep(500);
  const o3 = await orderOf();
  check(o6 === o3, '3 列与 6 列切换后顺序不变（' + String(o6).split(',').slice(0,3).join(',') + '…）');
  await evalJs(`(function(){var b=document.querySelectorAll('.view.show [data-key="cols"]');for(var i=0;i<b.length;i++)if(b[i].getAttribute('data-val')==='4')b[i].click();return 1;})()`);
  await sleep(400);

  /* 跨列：进编辑，把第一张卡设成 2×，退出后网格里应带 span-2 */
  await click('[data-act="close"]');
  await sleep(300);
  await click('#editBtn');
  await sleep(500);
  /* 选中卡片后，宽度/顺序/移除按钮在浮动 #tileBar 里 */
  const clicked = await evalJs(`(function(){var t=document.querySelectorAll('.grid .tile[data-entity]');if(!t.length)return 0;t[0].click();return document.querySelectorAll('#tileBar [data-act="card-span"]').length;})()`);
  check(clicked === 1, '编辑模式选中卡片后出现宽度按钮（' + clicked + '）');
  await evalJs(`document.querySelector('#tileBar [data-act="card-span"]').click()`);
  await sleep(500);
  const spanTxt = await evalJs(`(function(){var b=document.querySelector('#tileBar [data-act="card-span"]');return b?b.textContent:'(无)';})()`);
  check(spanTxt === '2×', '点一下宽度变成 2×（' + spanTxt + '）');
  const spanStore = await store('hc.edit');
  check(String(spanStore).indexOf('"span"') >= 0, '跨列写入 hc.edit.span（' + String(spanStore).slice(0, 60) + '…）');
  /* 顺序：把第二张卡往前挪一位 */
  const before2 = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.grid .tile[data-entity]'), function(e){return e.getAttribute('data-entity');}).join(',')`);
  await evalJs(`(function(){var t=document.querySelectorAll('.grid .tile[data-entity]');if(!t[1])return 0;t[1].click();var b=document.querySelector('#tileBar [data-act="card-move-left"]');if(b)b.click();return 1;})()`);
  await sleep(400);
  const after2 = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.grid .tile[data-entity]'), function(e){return e.getAttribute('data-entity');}).join(',')`);
  const bA = String(before2).split(','), aA = String(after2).split(',');
  check(aA[0] === bA[1] && aA[1] === bA[0], '◀ 把第二张卡挪到了第一位（' + aA.slice(0, 2).join(' | ') + '）');
  /* 移除当时排第四的那张 */
  const rmTarget = aA[3];
  await evalJs(`(function(){var t=document.querySelectorAll('.grid .tile[data-entity]');if(!t[3])return 0;t[3].click();var b=document.querySelector('#tileBar [data-act="card-remove"]');if(b)b.click();return 1;})()`);
  await sleep(400);
  const afterRm = await evalJs(`document.querySelectorAll('.grid .tile[data-entity]').length`);
  const rmGone = await evalJs("!document.querySelector('.tile[data-entity=\"' + " + JSON.stringify(rmTarget) + " + '\"]')");
  check(afterRm === 3 && rmGone === true, '✕ 移除一张卡后剩 3 张（' + afterRm + '）');
  await click('#editBtn');
  await sleep(500);

  const spanTiles = await evalJs(`document.querySelectorAll('.grid .tile[data-span]').length`);
  check(spanTiles >= 1, '退出编辑后仍有跨列卡片（' + spanTiles + ' 张）');
  await shot('panel-edit.png');

  /* 恢复默认编辑：回到一张都没有 */
  await longPress('#time', 900);
  await waitFor(`!!document.querySelector('[data-act="diag-panel"]')`);
  await click('[data-act="diag-panel"]');
  await waitFor(`!!document.querySelector('[data-act="edit-reset"]')`);
  await click('[data-act="edit-reset"]');
  await sleep(700);
  const tilesEnd = await evalJs(`document.querySelectorAll('.tile[data-entity]').length`);
  check(tilesEnd === 0, '恢复默认编辑后一张卡都没有（实际 ' + tilesEnd + '）');
  await click('[data-act="close"]');
  await sleep(300);

  await shot('panel-settings.png');

  ws.close();
  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-SETTINGS PASS'); process.exit(0); }
  console.log('E2E-SETTINGS FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-SETTINGS 异常: ' + (e && e.message)); process.exit(1); });
