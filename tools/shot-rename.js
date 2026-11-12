/*
 * 重命名弹层/输入框截图：直接连 mock 面板（8791），存到 docs/screens。
 * 用法：node tools\shot-rename.js（前提：node tools\sim.js --mock --port 8791 已启动）
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, httpGet, openEdge, WS, evaluate, wait, screenshot, closeAll } = cdp;

const PANEL_URL = 'http://127.0.0.1:8791/';
const OUT = path.join(ROOT, 'docs', 'screens');

(async () => {
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开'); process.exit(1); }
  let edge, target;
  try {
    const opened = await openEdge({ port: 9335, url: PANEL_URL, urlMatch: '8791', userDir: path.join(ROOT, 'build', 'edge-shot') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('没拿到 CDP'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable'); await ws.call('Page.enable');
  const js = async (e, aw) => { try { return await evaluate(ws, e, aw); } catch (err) { return undefined; } };
  const shot = async name => {
    await screenshot(ws, path.join(OUT, name));
    console.log('saved ' + name);
  };
  await js('try{localStorage.clear()}catch(e){}; location.reload(); 1');
  await sleep(2600);
  await wait("document.querySelectorAll('.tile').length > 6");
  await js("document.querySelector('.tile[data-entity=\"light.living_main\"] .t-more').click(); 1");
  await wait("!!document.querySelector('.sheet.show .sheet-rename')");
  await sleep(500);
  await shot('panel-rename-sheet.png');
  await js("document.querySelector('.sheet.show .sheet-rename').click(); 1");
  await wait("!!document.querySelector('#rnIn')");
  await sleep(400);
  await shot('panel-rename-input.png');
  closeAll(ws, edge);
})().catch(e => { console.log('异常: ' + e.message); process.exit(1); });
