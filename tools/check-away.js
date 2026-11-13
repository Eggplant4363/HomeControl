/* 「离家熄屏 / 在家亮屏」真机回归：造两组 person 状态，验策略真的把系统熄屏值改了。
   node tools/check-away.js [serial]
   只造合成实体，测完删掉并还原 prefs；不动真实实体。 */
'use strict';
const cdp = require('./lib/cdp');

const serial = process.argv[2] || (process.env.HC_DEVICE || 'emulator-5554');

(async () => {
  const conn = await cdp.connectWebView({ serial: serial, port: 9222 });
  const ws = conn.ws;

  const before = await cdp.evaluate(ws, 'AndroidBridge.screenTimeout()');
  const writable = await cdp.evaluate(ws, 'AndroidBridge.screenWritable()');
  console.log('  设备原来的熄屏值: ' + before + 'ms   有写权限: ' + writable);
  if (!writable) {
    console.log('FAIL 没有改屏幕超时的权限（正式版要在设备上「去系统设置允许」）');
    cdp.closeAll(ws, conn.edge);
    process.exit(1);
  }

  const snap = await cdp.evaluate(ws, 'localStorage.getItem("hc.edit") || ""');
  /* 真实 HA 里可能本来就有人在家，所以这里显式传 list/home，单独验桥那头的策略 */
  await cdp.evaluate(ws, `
    var p = JSON.parse(localStorage.getItem('hc.edit') || '{}');
    p.awayScreen = true; p.awayOff = 5000;
    localStorage.setItem('hc.edit', JSON.stringify(p));
    var awayList = [
      { entity_id: 'person.cdp_a', state: 'not_home', attributes: { friendly_name: 'A' } },
      { entity_id: 'person.cdp_b', state: 'not_home', attributes: { friendly_name: 'B' } }
    ];
    __PANEL_TEST__.applyScreenPolicy(awayList, 0);
    void 0
  `);
  await cdp.sleep(1500);
  const away = await cdp.evaluate(ws, 'AndroidBridge.screenTimeout()');
  console.log('  全都不在家 -> ' + away + 'ms（期望 5000）');

  await cdp.evaluate(ws, `
    __PANEL_TEST__.applyScreenPolicy([{ entity_id: 'person.cdp_a', state: 'home', attributes: { friendly_name: 'A' } }], 1);
    void 0
  `);
  await cdp.sleep(1500);
  const home = await cdp.evaluate(ws, 'AndroidBridge.screenTimeout()');
  console.log('  有人在家   -> ' + home + 'ms（期望还原成 ' + before + '）');

  await cdp.evaluate(ws, `
    var st = __PANEL_TEST__.statesRef();
    delete st['person.cdp_a']; delete st['person.cdp_b'];
    var p = JSON.parse(localStorage.getItem('hc.edit') || '{}');
    p.awayScreen = false;
    localStorage.setItem('hc.edit', JSON.stringify(p));
    __PANEL_TEST__.applyPrefs();
    void 0
  `);
  await cdp.sleep(1500);
  const off = await cdp.evaluate(ws, 'AndroidBridge.screenTimeout()');
  console.log('  关掉开关   -> ' + off + 'ms（期望还原成 ' + before + '）');

  /* 还原 prefs（测完把设备设置交回去） */
  await cdp.evaluate(ws, `localStorage.setItem("hc.edit", ${JSON.stringify(snap === '' ? 'null' : JSON.stringify(snap))}); __PANEL_TEST__.applyPrefs(); void 0`);
  cdp.closeAll(ws, conn.edge);

  const ok = String(away) === '5000' && String(home) === String(before) && String(off) === String(before);
  if (ok) console.log('AWAY OK：不在家按设的值熄屏，在家/关掉都还原常亮');
  else console.log('FAIL：期望 away=5000 home=' + before + ' off=' + before + '，实得 away=' + away + ' home=' + home + ' off=' + off);
  process.exit(ok ? 0 : 1);
})().catch(function (e) {
  console.log('FAIL ' + (e && e.message ? e.message : e));
  process.exit(1);
});
