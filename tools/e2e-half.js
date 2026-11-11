/*
 * 「半高卡（1×½）」验收（不需要平板）：Edge headless + CDP 真渲染。
 *   ① 半高卡的高度正好是一个方格的一半（两份半高 + 一道行距 = 一个 1×1）
 *   ② 半高卡用「图标 + 名称（+ 小读数）」那套横向模板，不是圆钮/大字那套
 *   ③ 尺寸弹层里能选「1×½ 半高」，选完写进 hc.edit.rows，刷新后还在
 *   ④ 编辑态：半高卡角上有「1× · 半高」、有拉伸角、能选能移除
 * 跑法：node tools\sim.js --mock --port 8794 然后 node tools\e2e-half.js
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8794/';
const CDP_PORT = 9344;
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
  const profile = path.join(ROOT, 'build', 'edge-half');
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
  if (!target) { console.log('E2E-HALF FAIL（拿不到 CDP 目标）'); edge.kill(); process.exit(1); }

  /* Node 自带 WebSocket 就够用：不手写握手，也不带 Origin（Edge 不挑） */
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
  const clickSel = async (sel) => {
    const c = await evalJs(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return '';var r=n.getBoundingClientRect();return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
    if (!c) return false;
    const p = c.split(',').map(Number);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await sleep(420);
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

  const P4 = { cols: 4, allCards: false, size: 'md', sensors: true, offline: false, tap: 'toggle', undo: 5, autoDim: true, bright: 100, night: true, burn: true, theme: 'dark' };
  const cards = ['light.living_main', 'switch.master_plug', 'sensor.living_temp', 'light.living_strip'];
  const HALF_SW = '.tile[data-entity="switch.master_plug"]';
  const HALF_SE = '.tile[data-entity="sensor.living_temp"]';
  const FULL = '.tile[data-entity="light.living_main"]';

  /* ============ ① 几何：半高正好一半，和 1×1 同一排左端对齐 ============ */
  console.log('=== 1. 半高卡的几何 ===');
  await setMode(P4, { added: { 'light.living_main': 1, 'switch.master_plug': 1, 'sensor.living_temp': 1, 'light.living_strip': 1 },
    hidden: {}, order: cards, span: {}, rows: { 'switch.master_plug': 0.5, 'sensor.living_temp': 0.5 } });
  check((await evalJs(`document.querySelectorAll('.tile[data-entity]').length`)) === 4, '手动模式 4 张卡');
  const geo = await evalJs(`(function(){
    var g=document.querySelector('.grid');
    var half=document.querySelector('${HALF_SW}'), full=document.querySelector('${FULL}');
    var hh=half.getBoundingClientRect(), fh=full.getBoundingClientRect();
    return {half: Math.round(hh.height*100)/100, full: Math.round(fh.height*100)/100,
            unit: getComputedStyle(g).gridAutoRows, cols: g.getAttribute('data-cols'),
            halfTop: Math.round(hh.top), fullTop: Math.round(fh.top),
            halfLeft: Math.round(hh.left), fullLeft: Math.round(fh.left)};
  })()`);
  const unit = parseFloat(geo.unit);
  check(geo.half < geo.full * 0.55 && geo.half > geo.full * 0.4, '半高卡高度约是 1×1 的一半', JSON.stringify(geo));
  /* 两份半高 + 一道行距 = 一个 1×1（行高会被容器拉伸一点点，所以按实测的半高反推） */
  check(Math.abs(geo.full - (geo.half * 2 + 12)) <= 2, '1×1 = 两个半高 + 一道行距（unit=' + unit + '）', JSON.stringify(geo));
  check(Math.abs(geo.half - unit) <= 2, '半高卡正好一个半行高', JSON.stringify(geo));
  check(geo.halfTop === geo.fullTop, '同一排两张卡顶端对齐');

  /* ============ ② 模板：图标 + 名称 + 小读数 ============ */
  console.log('=== 2. 半高卡用横向模板 ===');
  check(await evalJs(`(function(){var n=document.querySelector('${HALF_SW}');return !!n && /\\bhalf\\b/.test(n.className);})()`), '半高卡带 half 类');
  check(await evalJs(`!document.querySelector('${HALF_SW} .t-core') && !document.querySelector('${HALF_SW} .t-round')`), '半高卡没有圆钮/核心区');
  check(await evalJs(`!!document.querySelector('${HALF_SW} .t-mini')`), '半高卡有迷你图标');
  check(await evalJs(`(function(){var n=document.querySelector('${HALF_SW} .t-hname');return !!n && n.textContent.length>0;})()`), '半高卡有名称');
  check(await evalJs(`(function(){var n=document.querySelector('${HALF_SW} .t-hval');return n ? !/\\d/.test(n.textContent) : true;})()`), '开关型半高卡没有数值读数（读数位留空）');
  check(await evalJs(`(function(){var n=document.querySelector('${HALF_SE} .t-hval');return !!n && /\\d/.test(n.textContent);})()`), '读数型半高卡右边有数值');
  check(await evalJs(`(function(){var n=document.querySelector('${HALF_SW} .t-mini'),b=n.getBoundingClientRect();return b.width>20&&b.width<40;})()`), '迷你图标尺寸合理');
  const mtop = await evalJs(`(function(){var n=document.querySelector('${HALF_SW} .t-mini'),r=n.getBoundingClientRect(),c=document.querySelector('${HALF_SW}').getBoundingClientRect();return Math.round(Math.abs((r.top+r.height/2)-(c.top+c.height/2)));})()`);
  check(mtop <= 1, '迷你图标在条里竖向居中', 'off=' + mtop);
  await shot('half-1-mixed.png');

  /* ============ ③ 尺寸弹层选半高 ============ */
  console.log('=== 3. 尺寸弹层里能选半高 ===');
  await evalJs(`document.querySelector('#editBtn').click(); 1`);
  await sleep(400);
  await clickSel(FULL);
  check(await evalJs(`(function(){var b=document.getElementById('tileBar');return !!b&&/show/.test(b.className);})()`), '选中卡片后浮出工具条');
  await clickSel('#tileBar [data-act="card-size"]');
  check(await waitFor(`!!document.querySelector('.sheet.show [data-act="card-size-set:1:0.5"]')`, 3000), '尺寸弹层里有「1×½ 半高」');
  check(await evalJs(`(function(){var n=document.querySelector('[data-act="card-size-set:1:0.5"]');return !!n && /半高/.test(n.textContent);})()`), '半高档文案带「半高」');
  await clickSel('[data-act="card-size-set:1:0.5"]');
  await sleep(500);
  check(await evalJs(`(function(){var n=document.querySelector('${FULL}');return !!n && /\\bhalf\\b/.test(n.className);})()`), '选完这张卡变成半高');
  check((await evalJs(`JSON.parse(localStorage.getItem('hc.edit')).rows['light.living_main']`)) === 0.5, 'rows 写进 hc.edit = 0.5');
  check(await evalJs(`(function(){var n=document.querySelector('${FULL} .t-size');return !!n && /半高/.test(n.textContent);})()`), '角上的尺寸标写着「半高」');
  check(await evalJs(`!!document.querySelector('${FULL} .t-grip')`), '半高卡也有拉伸角');
  await evalJs(`(function(){var b=document.querySelector('[data-act="span-close"]');if(b)b.click();return 1;})()`);
  await sleep(300);
  await shot('half-2-edit.png');
  await evalJs(`document.querySelector('#editBtn').click(); 1`);
  await sleep(400);

  /* 刷新后仍是半高（不是只改了当前 DOM） */
  await evalJs(`location.reload(); 1`);
  await sleep(2400);
  await waitFor(`document.querySelectorAll('.tile[data-entity]').length > 0`, 8000);
  check(await evalJs(`(function(){var n=document.querySelector('${FULL}');return !!n && /\\bhalf\\b/.test(n.className);})()`), '刷新后半高还在');

  /* ============ ④ 收缩/放大回来 ============ */
  console.log('=== 4. 改回 1×1 / 放大到 2×2 ===');
  await evalJs(`__PANEL_TEST__.resizeCard('light.living_main', 1, 1); 1`);
  await sleep(500);
  check(await evalJs(`!document.querySelector('${FULL} .t-hname') && !!document.querySelector('${FULL} .t-core')`), '改回 1×1 又变回方格模板');
  await evalJs(`__PANEL_TEST__.resizeCard('light.living_main', 2, 2); 1`);
  await sleep(500);
  check(await evalJs(`(function(){var n=document.querySelector('${FULL}');return !!n && /\\brows-2\\b/.test(n.className);})()`), '2×2 卡片带 rows-2 类');
  const g22 = await evalJs(`(function(){var n=document.querySelector('${FULL}').getBoundingClientRect();return Math.round(n.height);})()`);
  check(g22 > geo.full * 1.7, '2×2 高度接近两个方格', g22 + ' vs ' + geo.full);

  /* ============ ⑤ 六列紧凑布局也站得住 ============ */
  console.log('=== 5. 六列窄卡 ===');
  await setMode({ ...P4, cols: 6 }, { added: { 'light.living_main': 1, 'switch.master_plug': 1, 'sensor.living_temp': 1, 'light.living_strip': 1, 'switch.kitchen_light': 1, 'cover.living_curtain': 1 },
    hidden: {}, order: cards.concat(['switch.kitchen_light', 'cover.living_curtain']), span: {},
    rows: { 'switch.master_plug': 0.5, 'sensor.living_temp': 0.5, 'switch.kitchen_light': 0.5 } });
  const g6 = await evalJs(`(function(){var g=document.querySelector('.grid'),h=document.querySelector('${HALF_SW}');
    return {unit: getComputedStyle(g).gridAutoRows, half: Math.round(h.getBoundingClientRect().height),
            icon: Math.round(h.querySelector('.t-mini').getBoundingClientRect().width)};})()`);
  check(g6.half <= parseFloat(g6.unit) + 2, '六列时半高卡仍只有一个半行高', JSON.stringify(g6));
  check(g6.icon <= 28, '六列时迷你图标收小到 26px', JSON.stringify(g6));
  await shot('half-3-cols6.png');

  console.log('');
  if (failed === 0) console.log('E2E-HALF PASS');
  else console.log('E2E-HALF FAIL (' + failed + ')');
  sock.close();
  edge.kill();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.log('E2E-HALF ERROR ' + (e && e.stack || e)); process.exit(1); });
