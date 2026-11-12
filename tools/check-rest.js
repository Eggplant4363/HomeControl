/* 验原生 REST 回调表：并发 5 个请求必须全部回调（以前 __restCb 是单槽，只剩最后一个）。
   用法：node tools\check-rest.js <serial> */
'use strict';
const cdp = require('./lib/cdp.js');

const SERIAL = process.argv[2] || '';

async function main() {
  const raw = cdp.adbOut(SERIAL, ['shell', 'cat', '/sdcard/HomeControl/ha.json']);
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error('设备 ha.json 读不到：' + raw.slice(0, 60)); }

  const conn = await cdp.connectWebView({ serial: SERIAL });
  const expr =
    '(function(){' +
    'var cfg = JSON.parse(AndroidBridge.readText("/sdcard/HomeControl/ha.json"));' +
    'var bk = new window.HABackend({ url: cfg.url, token: cfg.token });' +
    'var got = 0, codes = [];' +
    'for (var i = 0; i < 5; i++) { bk.rest("GET", "/api/states", null, function (ok, code) { got++; codes.push(code); }); }' +
    'return new Promise(function (res) { setTimeout(function () { res(JSON.stringify({ got: got, codes: codes })); }, 6000); });' +
    '})()';
  const out = await cdp.evaluate(conn.ws, expr, true);
  await cdp.closeAll();
  console.log('并发 5 个 REST：回调 ' + out);
  const j = JSON.parse(out);
  if (j.got !== 5) { console.log('REST FAIL（期望 5 个回调，实际 ' + j.got + '）'); process.exit(1); }
  console.log('REST OK');
}

main().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
