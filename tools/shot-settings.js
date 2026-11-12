/*
 * 设置页截图（含滚到底部）：长按时间打开诊断页 → 面板设置，存到 docs/screens。
 * 用法：node tools\shot-settings.js（前提：node tools\sim.js --mock --port 8791 已启动）
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
    const opened = await openEdge({ port: 9338, url: PANEL_URL, urlMatch: '8791', userDir: path.join(ROOT, 'build', 'edge-shot2') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('没拿到 CDP'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable'); await ws.call('Page.enable');
  const js = async (e, aw) => { try { return await evaluate(ws, e, aw); } catch (err) { return undefined; } };
  const shot = async name => {
    await screenshot(ws, path.join(OUT, name));
    console.log('saved ' + name);
  };
  await js('(function(){try{localStorage.clear()}catch(e){}location.reload();return 1;})()');
  await sleep(2700);
  await wait("document.querySelectorAll('.tile').length > 6");
  const lp = async (sel, ms) => js('new Promise(function(res){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el){res(0);return;}el.dispatchEvent(new Event("touchstart",{bubbles:true,cancelable:true}));setTimeout(function(){el.dispatchEvent(new Event("touchend",{bubbles:true,cancelable:true}));res(1);},' + (ms || 700) + ');})', true);
  await lp('#time', 900);
  await wait("!!document.querySelector('[data-act=\"diag-panel\"]')");
  await js("document.querySelector('[data-act=\"diag-panel\"]').click(); 1");
  await wait("!!document.querySelector('.sheet.show .set-row')");
  await sleep(500);
  await shot('panel-settings.png');
  await js("document.querySelector('.sheet.show').scrollTop = 9999; 1");
  await sleep(500);
  await shot('panel-settings-bottom.png');
  closeAll(ws, edge);
})().catch(e => { console.log('异常: ' + e.message); process.exit(1); });
