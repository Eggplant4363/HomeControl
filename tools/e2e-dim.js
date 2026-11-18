/*
 * 「空闲待机页」验收（不需要平板）：Edge headless + CDP。
 *   ① 进熄屏后：纯黑底 + 大时钟 + 日期副行，「轻触屏幕唤醒」提示彻底没了
 *   ② 有音乐在放时下方补一条「正在播放」：封面 / 曲名 / 艺术家 / 进度条 / 时间
 *   ③ 没在放歌（或暂停）时那条自动收起，时钟位置一动不动
 *   ④ 退出熄屏后遮罩收掉，面板照常
 * 跑法：node tools\sim.js --mock --port 8796 然后 node tools\e2e-dim.js
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8796/';
const CDP_PORT = 9347;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));

let failed = 0;
const check = (ok, name, extra) => {
  if (ok) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); if (extra) console.log('        ' + extra); failed++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpGet = url => new Promise((resolve, reject) => {
  http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b)); }).on('error', reject);
});

(async () => {
  const profile = path.join(ROOT, 'build', 'edge-dim');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8796') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-DIM FAIL（拿不到 CDP 目标，模拟器起了吗？）'); edge.kill(); process.exit(1); }

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Network.setCacheDisabled', { cacheDisabled: true });

  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r && r.exceptionDetails) {
      console.log('  eval error: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return undefined;
    }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(150); }
    return false;
  };
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };

  /* 面板起来：等到卡片渲染、测试钩子可用 */
  const ready = await waitFor("window.__PANEL_TEST__ && document.getElementById('dim') && document.getElementById('dimTime').textContent.length > 2", 15000);
  check(ready, '面板加载完成（测试钩子可用、时钟在走）');
  if (!ready) { edge.kill(); console.log('E2E-DIM FAIL'); process.exit(1); }

  /* ---------- ① 待机页结构 ---------- */
  console.log('\n① 熄屏待机页');
  check(await evalJs("document.getElementById('dim').className.indexOf('show') < 0"), '平时遮罩不显示');
  await evalJs("window.__PANEL_TEST__.enterDim(); true");
  await sleep(800);
  check(await evalJs("document.getElementById('dim').className.indexOf('show') >= 0"), '进熄屏后遮罩 show');
  check(await evalJs("window.DimScreen.isOn()"), '待机页的每秒刷新已启动');
  check(await evalJs("document.querySelector('.dim-hint') === null"), '「轻触屏幕唤醒」提示节点已删除');
  check(await evalJs("document.getElementById('dim').innerText.indexOf('轻触') < 0"), '遮罩里再也找不到「轻触」字样');
  const timeTxt = await evalJs("document.getElementById('dimTime').textContent");
  check(/^\d{1,2}:\d{2}$/.test(timeTxt || ''), '大时钟显示 HH:MM', 'got ' + JSON.stringify(timeTxt));
  const dateTxt = await evalJs("document.getElementById('dimDate').textContent");
  check(/^\d{1,2}月\d{1,2}日 · 周[一二三四五六日]$/.test(dateTxt || ''), '日期副行「11月18日 · 周三」式', 'got ' + JSON.stringify(dateTxt));
  const clockPx = await evalJs("parseFloat(getComputedStyle(document.getElementById('dimTime')).fontSize)");
  check(clockPx >= 150, '时钟仍然够大（≥150px，远看能读）', 'got ' + clockPx);
  check(await evalJs("getComputedStyle(document.getElementById('dim')).backgroundColor === 'rgb(0, 0, 0)'"), '背景纯黑');
  check(await evalJs("getComputedStyle(document.getElementById('dimNow')).display === 'none'"), '没放歌时「正在播放」不显示');
  const clockTop = await evalJs("document.getElementById('dimTime').getBoundingClientRect().top");
  await shot('dim-1-clock.png');

  /* ---------- ② 放歌时补一条正在播放 ---------- */
  console.log('\n② 有音乐在放');
  const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  await evalJs(`(function(){
    var f = document.getElementById('mFill');
    if (f) f.style.width = '37%';
    var p = document.getElementById('mPos'); if (p) p.textContent = '1:23';
    var d = document.getElementById('mDur'); if (d) d.textContent = '3:20';
    window.MusicUI = {
      isPlaying: function () { return true; },
      playing: function () { return { title: '暖光', artist: 'Demo', cover: ${JSON.stringify(cover)} }; }
    };
    window.DimScreen.paint();
    return true;
  })()`);
  check(await evalJs("document.getElementById('dimNow').className === 'dim-now on'"), '「正在播放」显示');
  check(await evalJs("getComputedStyle(document.getElementById('dimNow')).display === 'flex'"), '布局是 flex 一行（封面 + 文字）');
  check(await evalJs("document.getElementById('dimTitle').textContent === '暖光'"), '曲名进待机页');
  check(await evalJs("document.getElementById('dimArtist').textContent === 'Demo'"), '艺术家进待机页');
  check(await evalJs("document.getElementById('dimBar').style.width === '37%'"), '进度条跟着音乐页走');
  check(await evalJs("document.getElementById('dimPos').textContent === '1:23' && document.getElementById('dimDur').textContent === '3:20'"), '已播/总时长跟着音乐页走');
  const coverShown = await waitFor("document.getElementById('dimCover').className.indexOf('has') >= 0", 4000);
  check(coverShown, '封面图加载后盖住占位音符');
  const clockTop2 = await evalJs("document.getElementById('dimTime').getBoundingClientRect().top");
  check(Math.abs(clockTop2 - clockTop) < 1, '「正在播放」出现时时钟不跳位置', 'before ' + clockTop + ' after ' + clockTop2);
  await shot('dim-2-music.png');

  /* ---------- ③ 暂停后收起 ---------- */
  console.log('\n③ 暂停后收起');
  await evalJs("window.MusicUI.isPlaying = function () { return false; }; true");
  const hid = await waitFor("document.getElementById('dimNow').className === 'dim-now'", 4000);
  check(hid, '暂停后自动收起（不用等退出熄屏）');
  check(await evalJs("getComputedStyle(document.getElementById('dimNow')).display === 'none'"), '收起后不占位');

  /* ---------- ④ 退出熄屏 ---------- */
  console.log('\n④ 退出熄屏');
  await evalJs("window.__PANEL_TEST__.exitDim(); true");
  await sleep(500);
  check(await evalJs("document.getElementById('dim').className.indexOf('show') < 0"), '遮罩收掉');
  check(await evalJs("!window.DimScreen.isOn()"), '每秒刷新已停（不白耗电）');
  check(await evalJs("!!document.getElementById('grid') && getComputedStyle(document.getElementById('grid')).display !== 'none'"), '面板本身还在（没被遮罩弄坏）');

  console.log('');
  if (failed === 0) {
    console.log('E2E-DIM PASS');
    edge.kill();
    process.exit(0);
  } else {
    console.log('E2E-DIM FAIL (' + failed + ' 项)');
    edge.kill();
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
