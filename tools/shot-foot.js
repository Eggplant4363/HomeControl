/*
 * 只为了「看清卡片排版」的截图脚本：mock 模式下把几张卡灌进 hc.edit，再截图。
 * 用法：node tools\shot-foot.js [http://127.0.0.1:8788/] [输出绝对路径] [列数]
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, openEdge, WS, evaluate, screenshot, closeAll } = cdp;

const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9355;
const OUT = process.argv[3] || path.join(ROOT, 'build', 'foot.png');
const num4 = (v) => { const n = parseInt(v, 10); return isFinite(n) ? n : 0; };

(async () => {
  let edge, target;
  try {
    const opened = await openEdge({ port: PORT_CDP, url: 'about:blank', userDir: path.join(ROOT, 'build', 'cdp-foot') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('FAIL no cdp（' + e.message + '）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = expr => evaluate(ws, expr);

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1500);
  const seed = {
    guide: 1, hint: 1,
    edit: {
      added: { 'light.living_main': 1, 'light.living_strip': 1, 'cover.living_curtain': 1, 'climate.living_ac': 1, 'binary_sensor.living_motion': 1 },
      order: ['light.living_main', 'light.living_strip', 'cover.living_curtain', 'climate.living_ac', 'binary_sensor.living_motion'],
      span: { 'light.living_main': 2 }, rows: {}
    }
  };
  var colArg = num4(process.argv[4]);
  var prefStr = colArg ? JSON.stringify({ cols: colArg }) : '';
  await evalJs('(function(){try{localStorage.setItem("hc.guide.v1","1");localStorage.setItem("hc.hint.v1","1");localStorage.setItem("hc.edit",' + JSON.stringify(JSON.stringify(seed.edit)) + ');var ps=' + JSON.stringify(prefStr) + ';if(ps){localStorage.setItem("hc.prefs",ps);}}catch(e){}})()');
  await ws.call('Page.reload', {});
  await sleep(2600);
  const info = await evalJs('(function(){var c=[].map.call(document.querySelectorAll(".tile"),function(t){var n=t.querySelector(".t-name"),s=t.querySelector(".t-sub");return (n?n.textContent.trim():"?")+" | "+(s?s.textContent.trim():"");});return {n:c.length,cards:c,status:(document.getElementById("statusText")||{}).textContent||""};})()');
  console.log('status=' + info.status + ' tiles=' + info.n);
  console.log(info.cards.join('\n'));
  var dbg = await evalJs('(function(){var g=document.getElementById("grid")||document.querySelector(".grid");return {prefs:localStorage.getItem("hc.prefs"),cls:g?g.className:"?",colsInline:g?(g.style.gridTemplateColumns||""):""};})()');
  console.log('debug ' + JSON.stringify(dbg));
  /* 进度条几何：改条高/钮大小时先看这里，比肉眼看截图准 */
  var geo = await evalJs('(function(){var b=document.querySelector(".t-bar");if(!b)return null;var f=b.querySelector("i"),k=b.querySelector("b");var rb=b.getBoundingClientRect(),rf=f?f.getBoundingClientRect():null,rk=k?k.getBoundingClientRect():null;var cs=getComputedStyle(b);return {bar:[Math.round(rb.width),Math.round(rb.height)],barCss:[cs.height,cs.borderRadius,cs.marginTop],fill:rf?[Math.round(rf.width),Math.round(rf.height)]:null,knob:rk?[Math.round(rk.width),Math.round(rk.height)]:null};})()');
  console.log('geo ' + JSON.stringify(geo));
  await screenshot(ws, OUT);
  console.log('shot=' + OUT);
  closeAll(ws, edge);
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
