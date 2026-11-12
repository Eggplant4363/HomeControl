/*
 * 进度条手感探针：在 mock 面板里真的拖一次卡片进度条，然后采样松手后 2 秒内
 * 白色钮（.t-bar b）的位置，用来确认「松手后不会自己往回弹」。
 *
 * 用法：node tools\probe-pbar.js [http://127.0.0.1:8788/]
 * 前置：node tools\sim.js --mock --port 8788
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, openEdge, WS, evaluate, closeAll } = cdp;

const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9356;

(async () => {
  let edge, target;
  try {
    const opened = await openEdge({ port: PORT_CDP, url: 'about:blank', userDir: path.join(ROOT, 'build', 'cdp-pbar') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('FAIL no cdp（' + e.message + '）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = expr => evaluate(ws, expr, true);

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1500);

  /* 只放一张可调光的灯卡，进度条好找 */
  const edit = {
    added: { 'light.living_main': 1 },
    order: ['light.living_main'],
    span: {}, rows: {}
  };
  await evalJs('(function(){try{localStorage.setItem("hc.guide.v1","1");localStorage.setItem("hc.hint.v1","1");' +
    'localStorage.setItem("hc.edit",' + JSON.stringify(JSON.stringify(edit)) + ');' +
    'localStorage.removeItem("hc.prefs");}catch(e){}})()');
  await ws.call('Page.reload', {});
  await sleep(2600);

  const geo = await evalJs('(function(){var b=document.querySelector(".t-bar");if(!b)return null;var k=b.querySelector("b");var rb=b.getBoundingClientRect(),rk=k.getBoundingClientRect();return {x:rb.left,y:rb.top,w:rb.width,h:rb.height,knobW:rk.width,knobH:rk.height,knobMidL:rk.left+rk.width/2};})()');
  if (!geo) { console.log('FAIL no .t-bar'); closeAll(ws, edge); process.exit(1); }
  console.log('bar=' + JSON.stringify([Math.round(geo.w), Math.round(geo.h)]) + ' knob=' + JSON.stringify([Math.round(geo.knobW), Math.round(geo.knobH)]));

  const align = async (tag) => {
    const a = await evalJs('(function(){var bar=document.querySelector(".t-bar");if(!bar)return null;var i=bar.querySelector("i"),k=bar.querySelector("b");if(!i||!k)return null;var rb=bar.getBoundingClientRect(),ri=i.getBoundingClientRect(),rk=k.getBoundingClientRect();var w=bar.querySelector(".t-fill");var rw=w?w.getBoundingClientRect():null;var cs=getComputedStyle(i);return {pct:getComputedStyle(bar).getPropertyValue("--pct").trim(),fillRight:Math.round((ri.right-rb.left)*10)/10,knobMid:Math.round((rk.left+rk.width/2-rb.left)*10)/10,deltaX:Math.round((rk.left+rk.width/2-ri.right)*10)/10,deltaY:Math.round((rk.top+rk.height/2-(rb.top+rb.height/2))*10)/10,fillRadius:cs.borderTopRightRadius,fillW:Math.round(ri.width*10)/10,barW:Math.round(rb.width*10)/10,fillClip:rw?[Math.round(rw.left-rb.left),Math.round(rw.width),getComputedStyle(w).borderTopLeftRadius]:null,fillRightRadius:getComputedStyle(i).borderTopRightRadius};})()');
    console.log('align ' + tag + ' ' + JSON.stringify(a));
  };
  await align('init');

  const sample = async (tag) => {
    const v = await evalJs('(function(){var b=document.querySelector(".t-bar b");if(!b)return null;var rb=b.getBoundingClientRect();var bar=b.parentNode.getBoundingClientRect();return Math.round((rb.left+rb.width/2-bar.left)/bar.width*1000)/10;})()');
    return tag + '=' + v;
  };

  const y = Math.round(geo.y + geo.h / 2);
  const x0 = Math.round(geo.x + geo.w * 0.28);
  const x1 = Math.round(geo.x + geo.w * 0.72);

  /* 用 CDP 派发真实触摸序列：按下 → 分几步移动 → 抬手 */
  const touch = async (type, x, y2) => {
    await ws.call('Input.dispatchTouchEvent', {
      type: type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y2, radiusX: 3, radiusY: 3, force: 1, id: 1 }]
    });
  };

  await touch('touchStart', x0, y);
  await sleep(60);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', Math.round(x0 + (x1 - x0) * i / 6), y);
    await sleep(70);
  }
  console.log(await sample('during'));
  await align('during');
  await touch('touchEnd', x1, y);

  const seq = [];
  for (let i = 0; i < 14; i++) {
    await sleep(150);
    seq.push(await sample('t+' + ((i + 1) * 150) + 'ms'));
  }
  console.log('after ' + seq.join(' '));

  const nums = seq.map((s) => parseFloat(s.split('=')[1]));
  const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
  console.log('spread=' + (Math.round((max - min) * 10) / 10) + '%  (越小越稳，明显回弹会 >2)');

  /* 静默窗口过后，服务器值仍要能刷新钮：等 1.6s 再读一次 */
  await sleep(1600);
  await align('after');
  console.log(await sample('after-hold'));

  /* 极端位置：0% 与 100% 时，钮的外沿必须贴住轨道两端 */
  const edgeCheck = async () => {
    return evalJs('(function(){var bar=document.querySelector(".t-bar");if(!bar)return null;' +
      'var k=bar.querySelector("b");var rb=bar.getBoundingClientRect(),rk=k.getBoundingClientRect();' +
      'return {pct:Math.round(parseFloat(getComputedStyle(bar).getPropertyValue("--pct"))*10)/10,' +
      'leftGap:Math.round((rk.left-rb.left)*10)/10,rightGap:Math.round((rb.right-rk.right)*10)/10,' +
      'barW:Math.round(rb.width*10)/10};})()');
  };
  const dragTo = async (fx) => {
    await touch('touchStart', x0, y);
    await sleep(50);
    for (let i = 1; i <= 5; i++) await touch('touchMove', Math.round(x0 + (fx - x0) * i / 5), y), await sleep(60);
    await touch('touchEnd', fx, y);
    await sleep(320);
  };
  await dragTo(Math.round(geo.x + geo.w + 40));
  console.log('edge max ' + JSON.stringify(await edgeCheck()));
  await dragTo(Math.round(geo.x - 40));
  console.log('edge min ' + JSON.stringify(await edgeCheck()));
  closeAll(ws, edge);
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.log('ERR ' + (e && e.message)); process.exit(1); });
