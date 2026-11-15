/*
 * 「编辑态拖动换位置」验收（不需要平板）：Edge headless + CDP 真手势。
 *   ① 进编辑态按住卡片拖到另一张卡上 → 拖动中有克隆卡 + 目标卡高亮 + 原卡变淡
 *   ② 松手后顺序真的变了（DOM 顺序 + hc.edit.order 都变，刷新后还在），落点也有记录
 *   ③ 拖动那一下不会被当成「点选」（工具条不浮出）；没拖动过的普通点击照旧能选中
 *   ④ 非编辑态拖拽不会误触发；右下角拉伸区拖拽仍归拉伸
 *   ⑤ 半高卡也能拖着换位置，换完还是半高
 * 跑法：node tools\sim.js --mock --port 8794 然后 node tools\e2e-drag.js
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8794/';
const CDP_PORT = 9346;
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

(async () => {
  const profile = path.join(ROOT, 'build', 'edge-drag');
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
  if (!target) { console.log('E2E-DRAG FAIL（拿不到 CDP 目标）'); edge.kill(); process.exit(1); }

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Network.setCacheDisabled', { cacheDisabled: true });

  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r && r.exceptionDetails) {
      console.log('  eval error: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return undefined;
    }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(150); }
    return false;
  };
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };
  const center = (sel) => evalJs(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return null;var r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:r.width,h:r.height};})()`);
  const clickSel = async (sel) => {
    const c = await center(sel);
    if (!c) return false;
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await sleep(420);
    return true;
  };
  /* 真手势：按下 → 分 10 步移动（每步够大，能过 DRAG_LIFT 阈值）→ 松手 */
  const dragTo = async (from, to, opts) => {
    opts = opts || {};
    const a = await center(from), b = await center(to);
    if (!a || !b) return false;
    const sx = opts.sx != null ? opts.sx : a.x, sy = opts.sy != null ? opts.sy : a.y;
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
    const steps = opts.steps || 10;
    for (let i = 1; i <= steps; i++) {
      const x = sx + (b.x - sx) * i / steps, y = sy + (b.y - sy) * i / steps;
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(opts.stepDelay || 40);
    }
    if (opts.midCheck) await opts.midCheck();
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(opts.settle || 500);
    return true;
  };
  const setMode = async (prefs, edit) => {
    await evalJs(`(function(){
      localStorage.setItem('hc.guide.v1','1'); localStorage.setItem('hc.hint.v1','1');
      localStorage.setItem('hc.prefs', JSON.stringify(${JSON.stringify(prefs)}));
      localStorage.setItem('hc.edit', JSON.stringify(${JSON.stringify(edit)}));
      location.reload(); return 1;})()`);
    await sleep(2400);
    await waitFor(`document.querySelectorAll('.tile[data-entity]').length > 0`, 8000);
  };
  const domOrder = () => evalJs(`Array.prototype.map.call(document.querySelectorAll('.tile[data-entity]'), function(n){return n.getAttribute('data-entity');}).join(',')`);
  const savedOrder = () => evalJs(`(JSON.parse(localStorage.getItem('hc.edit')||'{}').order||[]).join(',')`);
  const lastDrop = () => evalJs(`JSON.stringify(window.__lastDrop||null)`);
  const editOn = async () => { await evalJs(`document.querySelector('#editBtn').click(); 1`); await sleep(500); };

  const P4 = { cols: 4, allCards: false, size: 'md', sensors: true, offline: false, tap: 'toggle', undo: 5, autoDim: true, bright: 100, night: true, burn: true, theme: 'dark' };
  const CARDS = ['switch.master_plug', 'light.living_main', 'sensor.living_temp', 'light.living_strip'];
  const T1 = '.tile[data-entity="light.living_main"]';
  const T2 = '.tile[data-entity="switch.master_plug"]';
  const T3 = '.tile[data-entity="sensor.living_temp"]';
  const T4 = '.tile[data-entity="light.living_strip"]';

  /* ============ ① 编辑态拖动：拖动中的视觉反馈 ============ */
  console.log('=== 1. 编辑态拖动：拖动中的视觉反馈 ===');
  await setMode(P4, {
    added: { 'light.living_main': 1, 'switch.master_plug': 1, 'sensor.living_temp': 1, 'light.living_strip': 1 },
    hidden: {}, order: CARDS.slice(), span: {}, rows: {}
  });
  check((await domOrder()) === CARDS.join(','), '初始顺序 = 四张卡的默认顺序', await domOrder());
  await editOn();
  check(await evalJs(`!!document.querySelector('.grid.editing')`), '进入编辑态（grid 有 editing 类）');

  const st = {};
  /* sensor（第 3 张）拖到 light.living_main（第 2 张）正中心 → 插到它前面 */
  await dragTo(T3, T1, {
    midCheck: async () => {
      st.ghost = await evalJs(`document.querySelectorAll('.drag-ghost').length`);
      st.src = await evalJs(`(function(){var n=document.querySelector('${T3}');return !!n && / drag-src/.test(n.className);})()`);
      st.over = await evalJs(`(function(){var n=document.querySelector('${T1}');return !!n && / drag-over/.test(n.className);})()`);
      st.overN = await evalJs(`document.querySelectorAll('.tile.drag-over').length`);
      st.ghostCss = await evalJs(`(function(){var g=document.querySelector('.drag-ghost');if(!g)return '';var s=getComputedStyle(g);return s.position+'/'+s.pointerEvents;})()`);
      st.moves = await evalJs(`(function(){var g=document.querySelector('.drag-ghost');if(!g)return 0;var r=g.getBoundingClientRect();return Math.round(r.left+r.width/2);})()`);
      await shot('drag-1-dragging.png');
    }
  });
  check(st.ghost === 1, '拖动中有一张克隆卡跟着走', 'ghost=' + st.ghost);
  check(st.src === true, '原卡变淡（drag-src）');
  check(st.over === true, '手指底下那张卡高亮（drag-over）');
  check(st.overN === 1, '同时只有一张卡高亮', 'n=' + st.overN);
  check(st.ghostCss === 'fixed/none', '克隆卡是固定定位且不吃点击（不挡 elementFromPoint）', st.ghostCss);

  /* ============ ② 松手落地 + 持久化 ============ */
  console.log('=== 2. 松手后顺序真的变了 ===');
  const want2 = 'switch.master_plug,sensor.living_temp,light.living_main,light.living_strip';
  check((await lastDrop()) === JSON.stringify({ entity: 'sensor.living_temp', target: 'light.living_main', after: false }),
    '落点判定：插到 light.living_main 前面', await lastDrop());
  check((await domOrder()) === want2, 'DOM 顺序变成「温度卡在光照卡前面」', await domOrder());
  check((await evalJs(`document.querySelectorAll('.drag-ghost').length`)) === 0, '松手后克隆卡消失');
  check((await evalJs(`document.querySelectorAll('.drag-src, .drag-over').length`)) === 0, '松手后拖动样式清干净');
  check((await savedOrder()) === want2, 'hc.edit.order 落盘顺序与界面一致', await savedOrder());

  await evalJs(`location.reload(); 1`);
  await sleep(2400);
  await waitFor(`document.querySelectorAll('.tile[data-entity]').length > 0`, 8000);
  check((await domOrder()) === want2, '刷新后顺序还在', await domOrder());

  /* ============ ③ 拖动 ≠ 点选 ============ */
  console.log('=== 3. 拖动那一下不会被当成点选 ===');
  await editOn();
  await evalJs(`(function(){var b=document.getElementById('tileBar'); if(b) b.className='tile-bar'; return 1;})()`);
  await dragTo(T4, T2, {});      /* 最后一张拖到第一张正中心 → 插到最前面 */
  const want3 = 'light.living_strip,switch.master_plug,sensor.living_temp,light.living_main';
  check(!(await evalJs(`(function(){var b=document.getElementById('tileBar');return !!b && /show/.test(b.className);})()`)), '拖完工具条没浮出（没被当成点选）');
  check((await domOrder()) === want3, '拖到第一张前面：顺序正确', await domOrder());
  await shot('drag-2-dropped.png');

  await clickSel(T2);
  check(await evalJs(`(function(){var b=document.getElementById('tileBar');return !!b && /show/.test(b.className);})()`), '普通点击照旧选中并浮出工具条');
  check((await domOrder()) === want3, '普通点击不改顺序');

  /* ============ ④ 边界：非编辑态不拖、右下角仍归拉伸 ============ */
  console.log('=== 4. 边界：非编辑态 / 拉伸角 ===');
  await evalJs(`document.querySelector('#editBtn').click(); 1`);
  await sleep(500);
  check(!(await evalJs(`!!document.querySelector('.grid.editing')`)), '退出编辑态');
  await dragTo(T1, T4, { midCheck: async () => { st.ghostOff = await evalJs(`document.querySelectorAll('.drag-ghost').length`); } });
  check(st.ghostOff === 0, '非编辑态拖动不产生克隆卡');
  check((await domOrder()) === want3, '非编辑态拖动不改顺序');

  await editOn();
  const c1 = await center(T1);
  await dragTo(T1, T4, { sx: c1.right - 20, sy: c1.bottom - 20 });
  check((await evalJs(`document.querySelectorAll('.drag-ghost').length`)) === 0, '右下角拖拽不产生克隆卡（归拉伸）');
  check((await domOrder()) === want3, '右下角拖拽不改顺序');
  await evalJs(`__PANEL_TEST__.resizeCard('light.living_main', 1, 1); 1`);
  await sleep(300);

  /* ============ ⑤ 半高卡也能拖着换位置 ============ */
  console.log('=== 5. 半高卡照样能拖 ===');
  await evalJs(`__PANEL_TEST__.resizeCard('sensor.living_temp', 1, 0.5); 1`);
  await sleep(500);
  check(await evalJs(`(function(){var n=document.querySelector('${T3}');return !!n && /\\bhalf\\b/.test(n.className);})()`), '温度卡改成半高');
  await dragTo(T3, T4, {});      /* 半高卡拖到最前面 */
  const want5 = 'sensor.living_temp,light.living_strip,switch.master_plug,light.living_main';
  check((await domOrder()) === want5, '半高卡拖到最前面', await domOrder());
  check(await evalJs(`(function(){var n=document.querySelector('${T3}');return !!n && /\\bhalf\\b/.test(n.className);})()`), '换位置后半高还在');
  await shot('drag-3-half.png');

  /* ============ ⑥ 两张半高卡叠在同一个 1×1 框里 ============ */
  console.log('=== 6. 两张半高能叠成一个 1×1 ===');
  await setMode(P4, {
    added: { 'light.living_main': 1, 'switch.master_plug': 1, 'sensor.living_temp': 1, 'light.living_strip': 1 },
    hidden: {}, order: CARDS.slice(), span: {}, rows: {}
  });
  await evalJs(`__PANEL_TEST__.resizeCard('light.living_main', 1, 0.5); __PANEL_TEST__.resizeCard('light.living_strip', 1, 0.5); 1`);
  await sleep(700);
  const geo = JSON.parse(await evalJs(`(function(){
    function r(e){var n=document.querySelector('.tile[data-entity="'+e+'"]');if(!n)return null;var b=n.getBoundingClientRect();
      return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),row:n.style.gridRow,col:n.style.gridColumn};}
    return JSON.stringify({a:r('light.living_main'),b:r('light.living_strip'),full:r('switch.master_plug')});
  })()`));
  check(!!geo.a && !!geo.b && !!geo.full, '三张卡都在');
  check(geo.a.col.split('/')[0] === geo.b.col.split('/')[0], '两张半高卡落在同一列', geo.a.col + ' vs ' + geo.b.col);
  check(geo.b.y > geo.a.y && Math.abs((geo.a.x) - (geo.b.x)) < 2, '第二张正好叠在第一张下面（同 x）', geo.a.x + '/' + geo.b.x);
  check(Math.abs((geo.b.y + geo.b.h) - (geo.a.y + geo.full.h)) <= 8, '两张半高 + 行距 = 一个 1×1 的高度',
    'pair=' + (geo.b.y + geo.b.h - geo.a.y) + ' full=' + geo.full.h);
  await shot('drag-4-stack.png');
  await editOn();
  check(await evalJs(`!!document.querySelector('.grid.editing')`), '叠好的两张卡在编辑态也正常');

  /* 排版不留空洞：任何卡落在「半行」的奇数行（即某个 1×1 的下半格）时，正上方那格必须有卡 */
  const holes = await evalJs(`(function(){
    var out=[], ns=document.querySelectorAll('.grid > .tile');
    for (var i=0;i<ns.length;i++){
      var n=ns[i], row=parseInt(n.style.gridRow,10)||1, col=n.style.gridColumn||'';
      if (row % 2 === 0) {                       /* gridRow 是 1 起的：偶数 = 某个 1×1 的下半格 */
        var up=false;
        for (var j=0;j<ns.length;j++){
          var m=ns[j];
          if (m===n) continue;
          if ((parseInt(m.style.gridRow,10)||1) === row-1 && m.style.gridColumn === col) { up=true; break; }
        }
        if (!up) out.push(n.getAttribute('data-entity')+'@r'+row);
      }
    }
    return out.join(',');
  })()`);
  check(holes === '', '没有卡片悬在下半格而上方留空', holes);

  console.log('');
  if (failed === 0) { console.log('E2E-DRAG PASS'); edge.kill(); process.exit(0); }
  console.log('E2E-DRAG FAIL（' + failed + ' 项）');
  edge.kill();
  process.exit(1);
})().catch(e => { console.log('E2E-DRAG ERROR: ' + (e && e.stack || e)); process.exit(1); });
