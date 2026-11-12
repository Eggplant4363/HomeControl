/* 验「没有设定温度的空调点加减号」这条路径：以前 adjustTemp 的 noTemp 分支是粘贴进来的弹层 markup，
   引用 st/cur/modeHtml/fans → 必 ReferenceError；现在应该是 toast + return。
   用法：node tools\check-temp.js <serial>（需要 debug.flag，走 WebView CDP） */
'use strict';
const cdp = require('./lib/cdp.js');

const SERIAL = process.argv[2] || '';

async function main() {
  const conn = await cdp.connectWebView({ serial: SERIAL });
  const expr =
    '(function(){' +
    'var t = window.__PANEL_TEST__;' +
    'if (!t || !t.adjustTemp) return JSON.stringify({skip:"没有 __PANEL_TEST__.adjustTemp"});' +
    'var ref = t.statesRef();' +
    'ref["climate.cdp_no"] = { entity_id:"climate.cdp_no", state:"auto", attributes:{ hvac_modes:["off","auto","cool"], fan_modes:["low"] } };' +
    'var err = null, ret;' +
    'try { ret = t.adjustTemp("climate.cdp_no", 1, "single"); } catch (e) { err = String(e); }' +
    'delete ref["climate.cdp_no"];' +
    'var toast = document.getElementById("toast");' +
    'return JSON.stringify({ err: err,' +
    ' ret: ret === undefined ? "undefined" : String(ret).slice(0, 40),' +
    ' toastText: toast ? toast.textContent : "",' +
    ' toastShown: toast ? /(^|\\s)show(\\s|$)/.test(toast.className) : false });' +
    '})()';
  const out = await cdp.evaluate(conn.ws, expr, false);
  await cdp.closeAll();
  const j = JSON.parse(out);
  console.log('adjustTemp(noTemp 空调) → ' + out);
  if (j.skip) { console.log('TEMP SKIP ' + j.skip); process.exit(1); }
  if (j.err) { console.log('TEMP FAIL 抛错：' + j.err); process.exit(1); }
  if (j.ret !== 'undefined') { console.log('TEMP FAIL 动作函数返回了 markup：' + j.ret); process.exit(1); }
  if (!j.toastShown || j.toastText.indexOf('没有可调') < 0) {
    console.log('TEMP FAIL 没弹 toast（text="' + j.toastText + '", shown=' + j.toastShown + '）');
    process.exit(1);
  }
  console.log('TEMP OK：toast 提示「这台空调没有可调的设定温度」，函数返回 undefined');
}

main().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
