/* 真机回归：熄屏遮罩必须是纯黑不透明 + 字大而粗（Chromium 57 的 getComputedStyle 能读到真实值）
   用法：node tools/check-dim.js [序列]   （默认 env:HC_DEVICE / ANDROID_SERIAL）
   注意：enterDim 会把本窗口背光压到 0.35，截图会偏暗是正常的；跑完 exitDim 还原。 */
'use strict';
const cdp = require('./lib/cdp');
const serial = process.argv[2] || process.env.HC_DEVICE || process.env.ANDROID_SERIAL;
if (!serial) { console.log('FAIL 没给设备序列'); process.exit(1); }
const PORT = 9366;

function probe() {
  var d = document.getElementById('dim');
  if (!d) return { err: 'no #dim' };
  var t = document.getElementById('dimTime');
  var hint = d.querySelector('.dim-hint');
  var cs = getComputedStyle(d);
  var ct = t ? getComputedStyle(t) : null;
  var ch = hint ? getComputedStyle(hint) : null;
  return {
    class: d.className,
    inline: d.style.background || '',
    bg: cs.backgroundColor,
    opacity: cs.opacity,
    display: cs.display,
    timeText: t ? t.textContent : '',
    timeSize: ct ? ct.fontSize : '',
    timeWeight: ct ? ct.fontWeight : '',
    timeColor: ct ? ct.color : '',
    hintSize: ch ? ch.fontSize : '',
    hintWeight: ch ? ch.fontWeight : '',
    hintColor: ch ? ch.color : ''
  };
}

async function main() {
  const conn = await cdp.connectWebView({ serial: serial, port: PORT });
  console.log('webview pid=' + conn.pid);
  console.log('dim 关闭时 ' + JSON.stringify(await cdp.evaluate(conn.ws, '(' + probe.toString() + ')()')));

  await cdp.evaluate(conn.ws, 'window.__PANEL_TEST__.enterDim()');
  await cdp.sleep(900);
  const on = await cdp.evaluate(conn.ws, '(' + probe.toString() + ')()');
  console.log('dim 打开时 ' + JSON.stringify(on));
  const shot = cdp.ROOT + '\\build\\dim-' + serial.replace(/[:.]/g, '_') + '.png';
  await cdp.screenshot(conn.ws, shot);
  await cdp.evaluate(conn.ws, 'window.__PANEL_TEST__.exitDim()');
  await cdp.sleep(700);
  const off = await cdp.evaluate(conn.ws, '(' + probe.toString() + ')()');
  console.log('dim 退出后 ' + JSON.stringify(off));

  var ok = true;
  function need(cond, msg) { if (!cond) { ok = false; console.log('  FAIL ' + msg); } }
  var px = function (v) { return parseFloat(v) || 0; };
  need(on && on.bg === 'rgb(0, 0, 0)', '遮罩背景不是纯黑：' + (on && on.bg));
  need(on && on.inline === 'rgb(0, 0, 0)', 'JS 写的 inline 背景不是纯黑：' + (on && on.inline));
  need(on && on.opacity === '1', '遮罩不透明度不是 1：' + (on && on.opacity));
  need(on && on.display === 'flex', '遮罩没显示：' + (on && on.display));
  need(px(on && on.timeSize) >= 200, '时钟字号太小：' + (on && on.timeSize));
  need(Number(on && on.timeWeight) >= 700, '时钟字不够粗：' + (on && on.timeWeight));
  need(on && on.timeColor === 'rgb(255, 255, 255)', '时钟颜色不是纯白：' + (on && on.timeColor));
  need(px(on && on.hintSize) >= 16, '提示字号太小：' + (on && on.hintSize));
  need(Number(on && on.hintWeight) >= 600, '提示字不够粗：' + (on && on.hintWeight));
  need(!off || off.display === 'none', '退出后遮罩还显示：' + (off && off.display));

  console.log(ok ? 'DIM OK（纯黑 + 大字粗体） 截图 ' + shot : 'DIM FAIL');
  cdp.closeAll(conn.ws, conn.edge);
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) {
  console.log('FAIL ' + (e && e.message ? e.message : e));
  process.exit(1);
});
