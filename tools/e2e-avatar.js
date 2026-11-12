/*
 * 重命名验收（不需要平板）：用 Edge CDP 真点击，验证
 *   长按卡片 → 铅笔 → 输入新名 → 保存 → 卡片改名 + localStorage["hc.names"]
 *   诊断页 → 面板设置 → 恢复默认名称 → 名字回滚
 * 跑法：node tools\e2e-avatar.js（前提：node tools\sim.js --mock --port 8793 已启动）
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, httpGet, findEdge, openEdge, WS, evaluate, wait, screenshot, closeAll } = cdp;

const PANEL_URL = 'http://127.0.0.1:8793/';

let failed = 0;
const check = (ok, name, extra) => {
  if (ok) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); if (extra) console.log('        ' + extra); failed++; }
};

(async () => {
  if (!findEdge()) { console.log('未找到 Edge，跳过'); process.exit(0); }
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\sim.js --mock --port 8793'); process.exit(1); }

  let edge, target;
  try {
    const opened = await openEdge({ port: 9337, url: PANEL_URL, urlMatch: '8793', userDir: path.join(ROOT, 'build', 'edge-who') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('E2E-AVATAR FAIL（拿不到 CDP 目标）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    try { return await evaluate(ws, expr, awaitPromise); }
    catch (e) { console.log('  eval error: ' + e.message); return undefined; }
  };
  const waitFor = (expr, ms) => wait(ws, expr, ms);
  const text = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");return e?e.textContent.replace(/\\s+/g,' ').trim():'';})()");
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);
  /* ============ 住户头像 / 在家-离家 验收 ============ */
  await ws.call('Network.enable');
  await ws.call('Network.setCacheDisabled', { cacheDisabled: true });
  await evalJs("try{localStorage.clear();localStorage['hc.guide.v1']='1';localStorage['hc.hint.v1']='1';}catch(e){}; 1");
  await evalJs('location.reload(); 1');
  check(await waitFor("!!document.querySelector('#who .who-t')", 12000), '顶栏出现住户区');

  const cls = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");return e?e.className:'';})()");
  const rect = sel => evalJs("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(!e)return null;var r=e.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height,rr:r.right,b:r.bottom};})()");
  const shot = n => screenshot(ws, path.join(ROOT, 'build', n));

  console.log('=== 1. 位置与内容 ===');
  check((await evalJs("typeof window.__PANEL_TEST__.whoState === 'function'")), '浏览器里跑的是新版 app.js（有 whoState）');
  check((await text('#who .who-t')) === '在家', '默认显示「在家」', 'got ' + await text('#who .who-t'));
  check((await cls('#who')).indexOf('home') >= 0, '顶栏住户区带 home 类');
  check((await evalJs("document.querySelectorAll('#who .who-av').length")) === 1, '只有一个住户头像');
  check((await evalJs("!!document.querySelector('#who .who-av img')")), '头像用 img 渲染（不是只有首字母）');
  check((await evalJs("(function(){var i=document.querySelector('#who .who-av img');return i&&i.naturalWidth>0;})()")), '头像图真的加载出来了');
  const rw = await rect('#who'), rs = await rect('#status'), rt = await rect('.topbar');
  check(rw && rs && rw.rr <= rs.l + 1, '住户区在「已连接」左边（不重叠）');
  check(rw && rs && Math.abs((rw.t + rw.h / 2) - (rs.t + rs.h / 2)) < 3, '与状态胶囊垂直居中对齐');
  check(rw && rs && (rs.l - rw.rr) >= 6 && (rs.l - rw.rr) <= 24, '和状态胶囊间距合理（' + (rs.l - rw.rr).toFixed(1) + 'px）');
  /* 环的颜色跟主题的 --ok-rgb 走（浅色主题是偏灰的绿），所以断言「绿通道最大 + 2px 实环」，
     不锁死色值；离家时是 1px 的中性描边，不该有突出的绿 */
  const ringOf = s => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)\s*0px\s*0px\s*0px\s*2px/.exec(s || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const sh = await evalJs("getComputedStyle(document.querySelector('#who .who-av')).boxShadow");
  const ringHome = ringOf(sh);
  check(!!ringHome && ringHome.g > ringHome.r + 8 && ringHome.g > ringHome.b + 8 && ringHome.a > 0.4,
    '在家时头像有一圈绿色描边', 'got ' + sh);
  await shot('shot-who-home.png');

  console.log('=== 2. 离家 / 未知 / 无住户 ===');
  await evalJs("window.__PANEL_TEST__.setStates({ 'person.mock_owner': { entity_id:'person.mock_owner', state:'not_home', attributes:{ friendly_name:'我' } } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await text('#who .who-t')) === '离家', 'not_home → 显示「离家」');
  check((await cls('#who')).indexOf('away') >= 0, '离家时顶栏带 away 类');
  const sh2 = await evalJs("getComputedStyle(document.querySelector('#who .who-av')).boxShadow");
  const ringAway = ringOf(sh2);
  check(!ringAway, '离家时没有绿色实环', 'got ' + sh2);
  await shot('shot-who-away.png');

  await evalJs("window.__PANEL_TEST__.setStates({ 'person.mock_owner': { entity_id:'person.mock_owner', state:'unavailable', attributes:{} } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await text('#who .who-t')) === '状态未知', 'unavailable → 显示「状态未知」');

  await evalJs("window.__PANEL_TEST__.setStates({ 'light.kitchen_main': { entity_id:'light.kitchen_main', state:'on', attributes:{} } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await evalJs("getComputedStyle(document.querySelector('#who')).display")) === 'none', '没有 person 实体时住户区整个隐藏');

  console.log('=== 3. 多人 ===');
  await evalJs("window.__PANEL_TEST__.setStates({ 'person.a': { entity_id:'person.a', state:'home', attributes:{ friendly_name:'A' } }, 'person.b': { entity_id:'person.b', state:'not_home', attributes:{ friendly_name:'B' } } }); window.__PANEL_TEST__.renderWho(); 1");
  await sleep(200);
  check((await evalJs("document.querySelectorAll('#who .who-av').length")) === 2, '两个住户画出两个头像');
  check((await text('#who .who-t')) === '1/2 在家', '多人时显示「1/2 在家」', 'got ' + await text('#who .who-t'));

  closeAll(ws, edge);
  console.log('');
  if (failed === 0) { console.log('E2E-AVATAR PASS'); process.exit(0); }
  console.log('E2E-AVATAR FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-AVATAR 异常: ' + (e && e.message)); process.exit(1); });
