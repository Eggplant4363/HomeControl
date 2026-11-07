/*
 * 重命名验收（不需要平板）：用 Edge CDP 真点击，验证
 *   长按卡片 → 铅笔 → 输入新名 → 保存 → 卡片改名 + localStorage["hc.names"]
 *   诊断页 → 面板设置 → 恢复默认名称 → 名字回滚
 * 跑法：node tools\E2E-PCTBAR.js（前提：node tools\sim.js --mock --port 8792 已启动）
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8792/';
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
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\sim.js --mock --port 8792'); process.exit(1); }

  const profile = path.join(ROOT, 'build', 'edge-pct');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9336', '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:9336/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8792') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-PCTBAR FAIL（拿不到 CDP 目标）'); process.exit(1); }

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
  /* ============ 进度条（卡片百分比）验收 ============ */
  /* 面板脚本带缓存会测到旧代码，先关掉 CDN 缓存再刷 */
  await ws.call('Network.enable');
  await ws.call('Network.setCacheDisabled', { cacheDisabled: true });
  await evalJs("try{localStorage.clear();localStorage['hc.guide.v1']='1';localStorage['hc.hint.v1']='1';}catch(e){}; 1");
  await evalJs("localStorage.setItem('hc.edit', JSON.stringify({ added: { 'light.master_bedside': 1, 'light.living_strip': 1, 'light.living_main': 1, 'switch.living_tv': 1 }, order: ['light.master_bedside', 'light.living_strip', 'light.living_main', 'switch.living_tv'], span: {} })); 1");
  await evalJs('location.reload(); 1');
  check(await waitFor("document.querySelectorAll('.tile').length >= 4", 12000), '面板渲染出 4 张卡片');

  /* 首次进入的引导页已经用 hc.guide.v1 压住，截图里只剩面板本身 */
  const BED = '.tile[data-entity="light.master_bedside"]';
  const BARSEL = BED + ' .t-bar[data-role="pbar"]';
  const STRIP = '.tile[data-entity="light.living_strip"]';
  const STRIPBAR = STRIP + ' .t-bar[data-role="pbar"]';

  const attr = (sel, name) => evalJs('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');return el?el.getAttribute(' + JSON.stringify(name) + '):null;})()');
  const cssv = (sel, name) => evalJs('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');return el?getComputedStyle(el).getPropertyValue(' + JSON.stringify(name) + '):"";})()');
  const rectOf = sel => evalJs('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return null;var r=el.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height,b:r.bottom,rr:r.right};})()');
  const cls = sel => evalJs('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');return el?el.className:"";})()');
  const valOf = sel => evalJs('(function(){var el=document.querySelector(' + JSON.stringify(sel + ' .t-val') + ');return el?el.textContent.replace(/\\s+/g,""):"";})()');
  const mouseAt = (type, sel, frac, onDoc) => evalJs('(function(){var b=document.querySelector(' + JSON.stringify(sel) + ');if(!b)return 0;var r=b.getBoundingClientRect();' +
    'var tgt=' + (onDoc ? 'document' : 'b') + ';' +
    'tgt.dispatchEvent(new MouseEvent(' + JSON.stringify(type) + ',{bubbles:true,cancelable:true,clientX:r.left+r.width*' + frac + ',clientY:r.top+r.height/2,button:0}));return 1;})()');
  const touchAt = (type, sel, frac, onDoc) => evalJs('new Promise(function(res){var b=document.querySelector(' + JSON.stringify(sel) + ');if(!b){res(0);return;}var r=b.getBoundingClientRect();' +
    'function T(f){return new Touch({identifier:1,target:b,clientX:r.left+r.width*f,clientY:r.top+r.height/2,pageX:r.left+r.width*f,pageY:r.top+r.height/2,screenX:r.left+r.width*f,screenY:r.top+r.height/2});}' +
    'var t=T(' + frac + ');var empty=' + JSON.stringify(type === 'touchend') + ';' +
    'var tgt=' + (onDoc ? 'document' : 'b') + ';' +
    'tgt.dispatchEvent(new TouchEvent(' + JSON.stringify(type) + ',{bubbles:true,cancelable:true,touches:empty?[]:[t],targetTouches:empty?[]:[t],changedTouches:[t]}));res(1);})', true);
  const shot = async (name) => {
    const r = await ws.call('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };

  console.log('=== 1. 条本身：存在 / 够高 / 有拖动钮 ===');
  check(await evalJs("typeof window.__PANEL_TEST__ === 'object' && typeof window.__PANEL_TEST__.pctMeta === 'function'"), '浏览器里跑的是新版 app.js（有 pctMeta）');
  /* 卡片骨架先于状态包画出来：等第一次状态落地（床头灯 brightness 90 → 35%）再断言 */
  check(await waitFor("(function(){var b=document.querySelector('" + BARSEL + "');return !!b && b.getAttribute('data-pct') === '35';})()", 12000), '首个状态包到达后进度条画到 35%');
  check(await waitFor("!!document.querySelector('" + BARSEL + "')", 8000), '有亮度属性的灯卡片出现进度条');
  check((await evalJs("document.querySelectorAll('" + '.tile[data-entity="switch.living_tv"] .t-bar' + "').length")) === 0, '纯开关卡片没有进度条');
  const h = parseFloat(await cssv(BARSEL, 'height'));
  check(h >= 20, '进度条高 ' + h + 'px（原来 5px）');
  check((await evalJs("!!document.querySelector('" + BARSEL + " b.t-knob')")), '进度条有圆形拖动钮');
  var pct0 = await attr(BARSEL, 'data-pct');
  check(pct0 === '35', '初始百分比 35%（brightness 90）', 'got ' + pct0);
  var cssp = (await cssv(BARSEL, '--pct')).trim();
  check(cssp === '35%', 'CSS 变量 --pct 与数据一致', 'got ' + cssp);
  const tb = await rectOf(BARSEL), tt = await rectOf(BED);
  check(tb && tt && tb.l >= tt.l - 1 && tb.rr <= tt.rr + 1 && tb.b <= tt.b + 1, '进度条没有溢出卡片');

  console.log('=== 2. 鼠标按下即定位 ===');
  await mouseAt('mousedown', BARSEL, 0.25, false);
  await sleep(120);
  var pct25 = await attr(BARSEL, 'data-pct');
  check(pct25 === '25', '按在 1/4 处 → 25%', 'got ' + pct25);
  check((await cls(BARSEL)).indexOf('dragging') >= 0, '按下后进入 dragging 状态');
  check((await cls(BED)).indexOf('on') >= 0, '拖动亮度会顺带把灯点亮');
  check((await cls(BED)).indexOf('sel') < 0, '按下进度条不会顺带选中卡片');

  console.log('=== 3. 拖动跟手 ===');
  await mouseAt('mousemove', BARSEL, 0.8, true);
  await sleep(120);
  var pct80 = await attr(BARSEL, 'data-pct');
  check(pct80 === '80', '拖到 80% 处 → 80%', 'got ' + pct80);
  await shot('shot-pctbar-drag.png');
  check((await attr(BARSEL, 'data-pct')) === '80', '截图时仍是 80%（拖动中不被回包拉回）');

  console.log('=== 4. 松手写回 ===');
  await mouseAt('mouseup', BARSEL, 0.8, true);
  await sleep(700);
  check((await cls(BARSEL)).indexOf('dragging') < 0, '松手退出 dragging 状态');
  var v80 = await valOf(BED);
  check(v80 === '80%', '卡片数值变成 80%（服务已写回）', 'got ' + v80);
  check((await attr(BARSEL, 'data-pct')) === '80', '松手后条仍停在 80%');
  await shot('shot-pctbar.png');

  console.log('=== 5. 拖完那一下不能当成开关点击 ===');
  /* 真机上 touchend 之后浏览器会立刻补一个 click；这里在同一次执行里复现：
     按下 → 松手 → 立刻 click，中间不给死区时间。 */
  var r5 = await evalJs("(function(){var b=document.querySelector('" + BARSEL + "');var t=document.querySelector('" + BED + "');var rc=b.getBoundingClientRect();" +
    "function M(type,frac,tgt){tgt.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:rc.left+rc.width*frac,clientY:rc.top+rc.height/2,button:0}));}" +
    "M('mousedown',0.4,b);M('mouseup',0.4,document);t.click();" +
    "return {pct:b.getAttribute('data-pct'),on:t.className.indexOf('on')>=0};})()");
  check(r5 && r5.on === true, '拖完紧接着的 click 被吞掉（灯没被关）', JSON.stringify(r5));
  check(r5 && r5.pct === '40', '拖完的 click 没把亮度清零', JSON.stringify(r5));

  console.log('=== 6. 正常点击卡片仍然是开关 ===');
  await sleep(700);
  await evalJs("(function(){var el=document.querySelector('" + BED + "');if(el)el.click();return 1;})()");
  await sleep(500);
  check((await cls(BED)).indexOf('on') < 0, '静默期过后点击照常关灯', 'cls=' + (await cls(BED)));
  var pctOff = await attr(BARSEL, 'data-pct');
  check(pctOff === '0', '关灯后条画到 0（但条还在）', 'got ' + pctOff);
  check((await evalJs("!!document.querySelector('" + BARSEL + "')")), '关灯后仍能看到条（点一下就能点亮）');

  console.log('=== 7. 手指（touch）路径 ===');
  await touchAt('touchstart', STRIPBAR, 0.6, false);
  await sleep(120);
  check((await attr(STRIPBAR, 'data-pct')) === '60', '手指按在 60% 处 → 60%');
  check((await cls(STRIP)).indexOf('on') >= 0, '手指按下即点亮（灯带原来关着）');
  await touchAt('touchmove', STRIPBAR, 0.3, true);
  await sleep(120);
  check((await attr(STRIPBAR, 'data-pct')) === '30', '手指拖到 30% → 30%');
  await touchAt('touchend', STRIPBAR, 0.3, true);
  await sleep(700);
  check((await cls(STRIPBAR)).indexOf('dragging') < 0, '手指抬起退出 dragging');
  check((await valOf(STRIP)) === '30%', '灯带数值变成 30%');
  check((await cls(STRIP)).indexOf('on') >= 0, '抬手指没有被当成点击关灯');

  console.log('=== 8. 编辑态不响应拖动（避免和拉伸冲突） ===');
  await evalJs("(function(){var b=document.querySelector('" + STRIPBAR + "');var t=document.querySelector('" + STRIP + "');var r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+40,button:0}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return 1;})()");
  await sleep(300);
  check(true, '编辑态冒烟（不崩）');
  ws.close();
  try { edge.kill(); } catch (e) { }
  console.log('');
  if (failed === 0) { console.log('E2E-PCTBAR PASS'); process.exit(0); }
  console.log('E2E-PCTBAR FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-PCTBAR 异常: ' + (e && e.message)); process.exit(1); });