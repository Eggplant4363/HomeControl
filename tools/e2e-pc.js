/*
 * PC 侧交互验收（不需要平板）：用 Edge 的 CDP 真正点面板，验证「点了会不会变」。
 * 跑法：node tools\e2e-pc.js        依赖：本机 Edge，node 内置模块，无 npm 依赖
 */
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./lib/cdp');
const { ROOT, sleep, httpGet, findEdge, openEdge, WS, evaluate, wait, closeAll } = cdp;

const PANEL_URL = 'http://127.0.0.1:8787/';

let failed = 0;
const check = (ok, name, extra) => {
  if (ok) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); if (extra) console.log('        ' + extra); failed++; }
};

(async () => {
  if (!findEdge()) { console.log('未找到 Edge，跳过'); process.exit(0); }

  let server = null;
  try { await httpGet(PANEL_URL); } catch (e) {
    server = spawn('node', [path.join(ROOT, 'tools', 'devserver.js')], { cwd: ROOT, stdio: 'ignore' });
    await sleep(1500);
  }

  let edge, target;
  try {
    const opened = await openEdge({ port: 9333, url: PANEL_URL, urlMatch: '8787', userDir: path.join(ROOT, 'build', 'edge-e2e') });
    edge = opened.proc; target = opened.target;
  } catch (e) { check(false, '拿到 CDP 页面目标'); console.log('E2E FAIL'); process.exit(1); }
  check(true, '拿到 CDP 页面目标');

  const ws = await WS.connect(target.webSocketDebuggerUrl);
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const evalJs = async (expr, awaitPromise) => {
    try { return await evaluate(ws, expr, awaitPromise); }
    catch (e) { return undefined; }
  };
  const waitFor = (expr, ms) => wait(ws, expr, ms);
  const click = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return 0;el.click();return 1;})()`);
  const text = sel => evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.replace(/\\s+/g,' ').trim():'';})()`);
  const count = sel => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const longPress = (sel, ms) => evalJs(`new Promise(function(res){var el=document.querySelector(${JSON.stringify(sel)});
      if(!el){res(0);return;}
      el.dispatchEvent(new Event('touchstart',{bubbles:true,cancelable:true}));
      setTimeout(function(){el.dispatchEvent(new Event('touchend',{bubbles:true,cancelable:true}));res(1);}, ${ms || 700});
    })`, true);

  /* 干净起点：清掉上一轮留下的 localStorage，让首次引导一定出现 */
  await evalJs('try{localStorage.clear()}catch(e){}; location.reload(); 1');
  await sleep(2500);

  console.log('=== 1. 启动 ===');
  check(await waitFor(`document.querySelectorAll('.tile').length > 6`), '面板渲染出卡片');
  const tiles = await count('.tile');
  check(tiles >= 8, '卡片数量 >= 8（实际 ' + tiles + '）');

  console.log('=== 2. 首次引导 ===');
  check(await waitFor(`!!document.querySelector('.sheet.show .g-step')`), '自动弹出三步引导');
  check((await count('.sheet.show .g-step')) === 3, '引导三步');
  check(await click('[data-act="guide-demo"]'), '点「先看模拟数据」');
  await sleep(700);
  check(!(await evalJs(`!!document.querySelector('.sheet.show')`)), '弹层关闭');

  console.log('=== 3. 开关灯 + 撤销 ===');
  await click('.tile[data-entity="light.living_strip"]');
  await sleep(600);
  let cls = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  check(String(cls).indexOf('on') >= 0, '点灯带后卡片变 on（' + cls + '）');
  let tst = await text('#toast');
  check(/已开启/.test(tst), 'toast 提示已开启（' + tst + '）');
  await click('#toast .toast-act');
  await sleep(800);
  cls = await evalJs(`document.querySelector('.tile[data-entity="light.living_strip"]').className`);
  check(String(cls).indexOf('on') < 0, '点撤销后回到 off（' + cls + '）');

  console.log('=== 4. 灯详情 + 换色 ===');
  check((await longPress('.tile[data-entity="light.living_main"]', 700)) === 1, '对灯卡长按 700ms');
  check(await waitFor(`!!document.querySelector('.sheet.show .sw-row')`), '打开灯弹层且有换色块');
  check((await count('.sheet.show .sw')) === 8, '8 个预设颜色');
  await click('.sheet.show .sw:nth-child(5)');
  await sleep(700);
  check((await count('.sheet.show .sw.on')) === 1, '只有选中的色块高亮');
  await click('#mask');
  await sleep(500);

  console.log('=== 5. 场景执行 ===');
  check((await count('.chip[data-scene]')) > 0, '有场景键');
  await click('.chip[data-scene]');
  await sleep(600);
  tst = await text('#toast');
  check(/已执行|已触发/.test(tst), '点场景有反馈（' + tst + '）');

  console.log('=== 6. 诊断页 + 面板设置 ===');
  check((await longPress('#time', 900)) === 1, '对时间长按 900ms');
  check(await waitFor(`!!document.querySelector('.sheet.show .diag')`), '打开诊断页');
  const diag = await text('.sheet.show .diag');
  check(/版本/.test(diag), '诊断页有版本行');
  check(/内存/.test(diag), '诊断页有内存行');
  await click('[data-act="diag-panel"]');
  await sleep(600);
  const rows = await count('.sheet.show .p-row');
  check(rows >= 6, '面板设置列出房间（' + rows + ' 行）');
  const before = await count('.tab[data-room]');
  await click('.sheet.show .p-sw');
  await sleep(600);
  const after = await count('.tab[data-room]');
  check(after === before - 1, '隐藏一个房间后 tab 少一个（' + before + '→' + after + '）');
  await click('[data-act="room-reset"]');
  await sleep(500);
  check((await count('.tab[data-room]')) === before, '恢复默认后 tab 复原');

  closeAll(ws, edge);
  if (server) { try { server.kill(); } catch (e) { } }

  console.log('');
  if (failed === 0) { console.log('E2E PASS'); process.exit(0); }
  console.log('E2E FAIL ' + failed);
  process.exit(1);
})().catch(e => { console.log('E2E 异常: ' + (e && e.message)); process.exit(1); });
