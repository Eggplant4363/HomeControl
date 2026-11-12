/*
 * 传感器卡片迷你历史曲线的回归探针：mock 下灌入传感器卡并打开 sensors 偏好，
 * 打印每张卡 .t-spark 的存在性/尺寸/HTML 长度，再截图。
 * 用法：node tools\probe-spark.js [http://127.0.0.1:8788/] [输出绝对路径] [列数]
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, openEdge, WS, evaluate, screenshot, closeAll } = cdp;

const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9357;
const OUT = process.argv[3] || path.join(ROOT, 'build', 'spark.png');
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
      added: { 'light.living_main': 1, 'sensor.living_temp': 1, 'sensor.living_humidity': 1, 'climate.living_ac': 1, 'binary_sensor.living_motion': 1 },
      order: ['light.living_main', 'sensor.living_temp', 'sensor.living_humidity', 'climate.living_ac', 'binary_sensor.living_motion'],
      span: {}, rows: {}
    }
  };
  var colArg = num4(process.argv[4]);
  var prefStr = JSON.stringify({ cols: colArg || 4, sensors: 1 });
  await evalJs('(function(){try{localStorage.setItem("hc.guide.v1","1");localStorage.setItem("hc.hint.v1","1");localStorage.setItem("hc.edit",' + JSON.stringify(JSON.stringify(seed.edit)) + ');var ps=' + JSON.stringify(prefStr) + ';if(ps){localStorage.setItem("hc.prefs",ps);}}catch(e){}})()');
  await ws.call('Page.reload', {});
  await sleep(3600);
  const info = await evalJs('(function(){var c=[].map.call(document.querySelectorAll(".tile"),function(t){var n=t.querySelector(".t-name"),s=t.querySelector(".t-sub");return (n?n.textContent.trim():"?")+" | "+(s?s.textContent.trim():"");});return {n:c.length,cards:c,status:(document.getElementById("statusText")||{}).textContent||""};})()');
  console.log('status=' + info.status + ' tiles=' + info.n);
  console.log(info.cards.join('\n'));
  var dbg = await evalJs('(function(){var g=document.getElementById("grid")||document.querySelector(".grid");return {prefs:localStorage.getItem("hc.prefs"),cls:g?g.className:"?",colsInline:g?(g.style.gridTemplateColumns||""):""};})()');
  console.log('debug ' + JSON.stringify(dbg));
  /* 进度条几何：改条高/钮大小时先看这里，比肉眼看截图准 */
  var geo = await evalJs('(function(){var b=document.querySelector(".t-bar");if(!b)return null;var f=b.querySelector("i"),k=b.querySelector("b");var rb=b.getBoundingClientRect(),rf=f?f.getBoundingClientRect():null,rk=k?k.getBoundingClientRect():null;var cs=getComputedStyle(b);return {bar:[Math.round(rb.width),Math.round(rb.height)],barCss:[cs.height,cs.borderRadius,cs.marginTop],fill:rf?[Math.round(rf.width),Math.round(rf.height)]:null,knob:rk?[Math.round(rk.width),Math.round(rk.height)]:null};})()');
  console.log('geo ' + JSON.stringify(geo));
  /* 曲线探针：卡片上的 .t-spark 是否渲染出 svg、尺寸是否合理 */
  var sp = await evalJs('(function(){var out=[];var tiles=document.querySelectorAll(".tile");for(var i=0;i<tiles.length;i++){var t=tiles[i];var n=t.querySelector(".t-name");var s=t.querySelector(".t-spark");var svg=s?s.querySelector("svg"):null;var r=s?s.getBoundingClientRect():null;out.push({name:n?n.textContent.trim():"?",has:!!s,svg:!!svg,len:s?s.innerHTML.length:-1,rect:r?[Math.round(r.width),Math.round(r.height)]:null});}return out;})()');
  console.log('spark ' + JSON.stringify(sp));
  await screenshot(ws, OUT);
  console.log('shot=' + OUT);
  closeAll(ws, edge);
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
