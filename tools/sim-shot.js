/*
 * 模拟器截图与自检：用 Edge 的 CDP 打开 tools\sim.js 起的模拟器页面，
 * 等真实 HA 数据到位后截图（1024x768，就是平板上的视口），并打印摘要。
 *
 * 前置：node tools\sim.js 已在跑（默认 8788）
 * 用法：node tools\sim-shot.js [http://127.0.0.1:8788/] [房间名] [卡片名]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const cdp = require('./lib/cdp');
const { ROOT, sleep, httpGet, openEdge, WS, evaluate, screenshot, closeAll } = cdp;

const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8788/';
const PORT_CDP = 9344;

(async () => {
  /* 0) 模拟器在跑吗 */
  try { await httpGet(URL_PAGE); } catch (e) {
    console.log('FAIL  ' + URL_PAGE + ' 打不开，先运行  node tools\\sim.js');
    process.exit(1);
  }

  const profile = path.join(ROOT, 'build', 'sim-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  let edge, target;
  try {
    const opened = await openEdge({ port: PORT_CDP, url: 'about:blank', userDir: profile });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('FAIL  拿不到 CDP 页面（' + e.message + '）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = (expr, awaitPromise) => evaluate(ws, expr, awaitPromise);

  await ws.call('Page.navigate', { url: URL_PAGE });
  await sleep(1200);

  /* 共享库的 WS.call 只认请求-应答，收不到 Runtime.exceptionThrown 事件；
     改成在页面里挂 onerror 收集器，效果一样（最后打印 JS 异常） */
  const jsErrors = [];
  try {
    await evalJs("(function(){window.__cdpErr=[];window.onerror=function(m){window.__cdpErr.push(String(m));return false;};return 1;})()");
  } catch (e) { }
  const readErrs = async () => {
    try { return (await evalJs('(function(){return (window.__cdpErr||[]).slice(0,3).join(" | ");})()')) || ''; }
    catch (e) { return ''; }
  };

  /* 先把「首次引导」标记成看过，免得遮住要截的界面（模拟模式下它会自己弹） */
  try {
    await evalJs("(function(){try{localStorage.setItem('hc.guide.v1','1');localStorage.setItem('hc.hint.v1','1');}catch(e){}})()");
    await ws.call('Page.reload', {});
    await sleep(1600);
  } catch (e) { }
  await sleep(300);

  /* 2) 等面板连上真实 HA：卡片出现 + 状态胶囊不是「连接中/未配置」 */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      ready = await evalJs('(function(){var n=document.querySelectorAll(".tile").length;' +
        'var s=(document.getElementById("statusText")||{}).textContent||"";' +
        'return n>0 && !/连接中|未配置|失败|重试/.test(s);})()');
    } catch (e) { }
    if (ready) break;
  }

  const info = await evalJs('(function(){' +
    'var tabs=[].map.call(document.querySelectorAll(".tab"),function(t){return t.textContent.trim();});' +
    'var cards=[].map.call(document.querySelectorAll(".tile"),function(t){' +
    'var n=t.querySelector(".t-name"),v=t.querySelector(".t-val");' +
    'return (n?n.textContent.trim():"?")+"="+(v?v.textContent.trim():"");});' +
    'return {status:(document.getElementById("statusText")||{}).textContent||"",' +
    'tabs:tabs, cards:cards.length, sample:cards.slice(0,8),' +
    'title:document.title, err:(window.__err||"")};})()');

  console.log('=== 模拟器摘要 ===');
  console.log('页面      ' + URL_PAGE + '  (1024x768)');
  console.log('状态胶囊  ' + info.status);
  console.log('房间 tab  ' + info.tabs.join(' / '));
  console.log('卡片数    ' + info.cards);
  console.log('前 8 张   ' + info.sample.join(' | '));
  console.log('连上 HA   ' + (ready ? '是' : '否'));
  const errs = await readErrs();
  if (errs) console.log('JS 异常   ' + errs);

  /* 3) 截图：首页 */
  const shot1 = path.join(ROOT, 'build', 'sim-home.png');
  await screenshot(ws, shot1);
  console.log('截图      build\\sim-home.png');

  /* 4) 切到一个房间再截一张 */
  const wantRoom = process.argv[3] || '';
  const room = (wantRoom && info.tabs.indexOf(wantRoom) >= 0) ? wantRoom : (info.tabs.find((t) => t && t !== '全部') || null);
  if (room) {
    await evalJs('(function(){var ts=document.querySelectorAll(".tab");' +
      'for(var i=0;i<ts.length;i++){if(ts[i].textContent.trim()===' + JSON.stringify(room) + '){ts[i].click();return true;}}return false;})()');
    await sleep(900);
    await screenshot(ws, path.join(ROOT, 'build', 'sim-room.png'));
    console.log('截图      build\\sim-room.png（房间：' + room + '）');
  }

  /* 5) 打开一张卡的详情（长按 -> 弹层），验证 REST 曲线也在真实 HA 下工作 */
  const wantName = process.argv[4] || '';
  const opened = await evalJs('(function(){' +
    'var t=null;' +
    'if(' + JSON.stringify(wantName) + '){var all=document.querySelectorAll(".tile");' +
    'for(var i=0;i<all.length;i++){var n=all[i].querySelector(".t-name");' +
    'if(n&&n.textContent.trim()===' + JSON.stringify(wantName) + '){t=all[i];break;}}}' +
    'if(!t) t=document.querySelector(".tile");' +
    'if(!t) return false;' +
    'function ev(n){return new Event(n,{bubbles:true});}' +
    't.dispatchEvent(ev("touchstart"));return true;})()');
  if (opened) {
    await sleep(800);
    const sheet = await evalJs('(function(){var m=document.getElementById("mask");' +
      'var s=document.getElementById("sheet");' +
      'return {mask:!!(m&&m.className.indexOf("show")>=0), title:(document.querySelector(".sheet-title, .sheet h3, .hero-name")||{}).textContent||"",' +
      'hasSpark:!!document.querySelector(".spark-slot, .spark-wrap")};})()');
    console.log('长按弹层  ' + (sheet.mask ? '已打开' : '未打开') + (sheet.hasSpark ? ' · 有曲线区' : ''));
    await screenshot(ws, path.join(ROOT, 'build', 'sim-sheet.png'));
    console.log('截图      build\\sim-sheet.png');
    await evalJs('(function(){var m=document.getElementById("mask");if(m)m.click();return true;})()');
  }

  closeAll(ws, edge);
  console.log('');
  console.log(ready ? 'SIM OK（真实 HA 数据渲染正常）' : 'SIM WARN（页面起来了但没连上 HA）');
  process.exit(ready ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
