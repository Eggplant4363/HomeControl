/*
 * 重命名验收（不需要平板）：用 Edge CDP 真点击，验证
 *   长按卡片 → 铅笔 → 输入新名 → 保存 → 卡片改名 + localStorage["hc.names"]
 *   诊断页 → 面板设置 → 恢复默认名称 → 名字回滚
 * 跑法：node tools\e2e-rename.js（前提：node tools\sim.js --mock --port 8791 已启动）
 */
'use strict';
const path = require('path');
const cdp = require('./lib/cdp');
const { ROOT, sleep, httpGet, findEdge, openEdge, WS, evaluate, wait, closeAll } = cdp;

const PANEL_URL = 'http://127.0.0.1:8791/';

let failed = 0;
const check = (ok, name, extra) => {
  if (ok) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); if (extra) console.log('        ' + extra); failed++; }
};

(async () => {
  if (!findEdge()) { console.log('未找到 Edge，跳过'); process.exit(0); }
  try { await httpGet(PANEL_URL); } catch (e) { console.log('模拟器没开：先 node tools\sim.js --mock --port 8791'); process.exit(1); }

  let edge, target;
  try {
    const opened = await openEdge({ port: 9334, url: PANEL_URL, urlMatch: '8791', userDir: path.join(ROOT, 'build', 'edge-rn') });
    edge = opened.proc; target = opened.target;
  } catch (e) { console.log('E2E-RENAME FAIL（拿不到 CDP 目标）'); process.exit(1); }

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    try { return await evaluate(ws, expr, awaitPromise); }
    catch (e) { console.log('  eval error: ' + e.message); return undefined; }
  };
  const waitFor = (expr, ms) => wait(ws, expr, ms);
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const text = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.replace(/\\s+/g,' ').trim():'';})()`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);

  /* 干净起点 */
  await evalJs('try{localStorage.clear()}catch(e){}; localStorage.setItem("hc.guide.v1","1"); location.reload(); 1');
  await sleep(2500);
  check(await waitFor(`document.querySelectorAll('.tile').length > 6`), '面板渲染出卡片');

  console.log('=== 1. 长按卡片打开重命名页 ===');
  check((await longPress('.tile[data-entity="light.living_main"]', 700)) === 1, '长按灯卡 700ms');
  check(await waitFor(`!!document.querySelector('.sheet.show .sheet-rename')`), '弹层里有「重命名」按钮');
  const beforeName = await text('.tile[data-entity="light.living_main"] .t-name');
  check(beforeName.length > 0, '重命名前有名字（' + beforeName + '）');

  console.log('=== 2. 打开重命名页并预填 ===');
  await click('.sheet.show .sheet-rename');
  check(await waitFor(`!!document.querySelector('#rnIn')`), '打开重命名页');
  const pref = await evalJs(`document.querySelector('#rnIn') ? document.querySelector('#rnIn').value : ''`);
  check(pref === beforeName, '输入框预填当前名（' + pref + '）');

  console.log('=== 3. 保存后卡片改名 ===');
  await evalJs(`(function(){var i=document.querySelector('#rnIn');i.value='测试灯';i.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
  await click('[data-act="rename-save"]');
  await sleep(900);
  const afterName = await text('.tile[data-entity="light.living_main"] .t-name');
  check(afterName === '测试灯', '卡片显示新名（' + afterName + '）');
  const store = await evalJs(`localStorage['hc.names'] || ''`);
  check(String(store).indexOf('light.living_main') >= 0 && String(store).indexOf('测试灯') >= 0, 'localStorage hc.names 已写入');

  console.log('=== 4. 恢复默认名称 ===');
  check((await longPress('#time', 900)) === 1, '对时间长按打开诊断页');
  check(await waitFor(`!!document.querySelector('[data-act="diag-panel"]')`), '诊断页有面板设置按钮');
  await click('[data-act="diag-panel"]');
  await sleep(600);
  check(await waitFor(`!!document.querySelector('[data-act="names-reset"]')`), '面板设置里有「恢复默认名称」');
  await click('[data-act="names-reset"]');
  await sleep(800);
  const resetName = await text('.tile[data-entity="light.living_main"] .t-name');
  const store2 = await evalJs(`localStorage['hc.names'] || ''`);
  check(resetName === beforeName, '恢复默认后名字回滚（' + resetName + '）');
  check(String(store2) === '{}' || String(store2) === '', 'localStorage hc.names 已清空（' + store2 + '）');

  closeAll(ws, edge);
  console.log('');
  if (failed === 0) { console.log('E2E-RENAME PASS'); process.exit(0); }
  console.log('E2E-RENAME FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E-RENAME 异常: ' + (e && e.message)); process.exit(1); });
