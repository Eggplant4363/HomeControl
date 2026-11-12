/*
 * 「App 内自升级」验收（不需要平板、不需要真 GitHub）：Edge headless + CDP。
 *   ① 浏览器里没有 AndroidBridge 时只显示说明，点检查给出提示，不发无效请求
 *   ② 装上假桥后：当前版本、检查更新、发现新版本
 *   ③ 下载：进度回调 → 进度条跟着长 → 完成变「立即安装」
 *   ④ 安装：调 updInstall，状态变「安装器已打开」
 *   ⑤ 已是最新 / 仓库 404 / 需要授权 三条分支
 *   ⑥ 状态变化只换设置页里的 #updSec 那一块（滚动位置不跳）
 * 跑法：node tools\sim.js --mock --port 8794
 *       node tools\e2e-update.js
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PANEL_URL = 'http://127.0.0.1:8794/';
const CDP_PORT = 9345;
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

/* 假桥：只实现升级通道要用的四个方法，动作都由页内 __MODE 控制 */
const FAKE_BRIDGE = `(function(){
  window.__REL = JSON.stringify({ tag_name: 'v0.7.14', assets: [
    { name: 'source.zip', browser_download_url: 'https://example.com/s.zip', size: 999999 },
    { name: 'homecontrol.apk', browser_download_url: 'https://example.com/h.apk', size: 160000 }
  ]});
  window.__MODE = 'ok';
  window.__CUR = '0.7.12';
  window.__LOG = [];
  window.AndroidBridge = {
    info: function () { return JSON.stringify({ ver: window.__CUR, vc: 49 }); },
    updNet: function (id, url, h) {
      window.__LOG.push('net ' + url);
      setTimeout(function () {
        if (window.__MODE === '404') { window.__hcUpdNetCb(id, JSON.stringify({ status: 404, body: '{"message":"Not Found"}' })); return; }
        if (window.__MODE === 'down') { window.__hcUpdNetCb(id, JSON.stringify({ error: 'UnknownHostException' })); return; }
        window.__hcUpdNetCb(id, JSON.stringify({ status: 200, body: window.__REL }));
      }, 20);
    },
    updDownload: function (id, url, name) {
      window.__LOG.push('download ' + url + ' ' + name);
      var steps = [10, 30, 60, 100], i = 0;
      var t = setInterval(function () {
        window.__hcUpdProg(id, steps[i]); i++;
        if (i >= steps.length) {
          clearInterval(t);
          setTimeout(function () {
            window.__hcUpdDone(id, JSON.stringify({ path: '/data/user/0/com.homecontrol.panel/cache/upd/' + name, bytes: 160000, name: name }));
          }, 120);
        }
      }, 260);
    },
    updInstall: function (id, p) {
      window.__LOG.push('install ' + p);
      setTimeout(function () {
        if (window.__MODE === 'perm') { window.__hcUpdDone(id, JSON.stringify({ error: 'need_permission' })); return; }
        window.__hcUpdDone(id, JSON.stringify({ ok: true }));
      }, 20);
    },
    updPerm: function () { window.__LOG.push('perm'); }
  };
  return 1;
})()`;

(async () => {
  const profile = path.join(ROOT, 'build', 'edge-upd');
  fs.mkdirSync(profile, { recursive: true });
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=1024,768', PANEL_URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/list'));
      target = list.find(t => t.type === 'page' && t.url.indexOf('8794') >= 0);
    } catch (e) { }
  }
  if (!target) { console.log('E2E-UPDATE FAIL（拿不到 CDP 目标）'); edge.kill(); process.exit(1); }

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
    while (Date.now() - t0 < (ms || 6000)) { if (await evalJs(expr)) return true; await sleep(120); }
    return false;
  };
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'build', name), Buffer.from(r.data, 'base64'));
  };
  const clickSel = async (sel) => {
    /* 设置页是可滚动的整页视图，「升级」段在最下面：先把目标滚到视野中间再点，
       否则 elementFromPoint 落在窗口外，鼠标事件根本进不了元素 */
    const c = await evalJs(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return '';n.scrollIntoView({block:'center'});var r=n.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)return '';return (r.left+r.width/2)+','+(r.top+r.height/2);})()`);
    if (!c) return false;
    await sleep(160);
    const p = c.split(',').map(Number);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await sleep(420);
    return true;
  };

  const openSettings = async () => { await clickSel('#gear'); await waitFor("!!document.querySelector('#updSec')", 5000); };
  const note = () => evalJs("(function(){var n=document.querySelector('#updSec .upd-note');return n?n.textContent:'';})()");
  const btns = () => evalJs("(function(){var a=document.querySelectorAll('#updSec [data-act]');var o=[];for(var i=0;i<a.length;i++)o.push(a[i].getAttribute('data-act')+':'+a[i].textContent);return o.join(' | ');})()");

  /* 清掉引导页，回到干净的 mock 面板 */
  await sleep(1200);
  await evalJs("(function(){localStorage.setItem('hc.guide.v1','1');localStorage.setItem('hc.hint.v1','1');location.reload();return 1;})()");
  await waitFor("!!document.querySelector('.tile') || !!document.querySelector('#grid')", 8000);
  await sleep(800);

  /* ---------- ① 浏览器里没有桥 ---------- */
  console.log('== ① 没有 AndroidBridge 的浏览器预览 ==');
  await openSettings();
  check(await evalJs("!!window.HCUpdate"), 'HCUpdate 已加载');
  check((await evalJs("(function(){var v=document.querySelector('#updSec .set-v b');return v?v.textContent:'';})()")) === '（浏览器预览）', '没有桥时当前版本显示「（浏览器预览）」');
  check(/从 GitHub 的 Release 取最新版/.test(await note()), 'idle 状态给出说明文案');
  await clickSel('#updSec [data-act="upd-check"]');
  await sleep(400);
  check(/没有升级通道/.test(await note()), '没桥时点检查只说「没有升级通道」，不发请求', await note());
  check(await evalJs("!!(window.HCUpdate.state().phase === 'error')"), '状态是 error');
  await shot('upd-1-nobridge.png');

  /* ---------- ② 装上假桥：检查更新 ---------- */
  console.log('== ② 有桥：检查更新 ==');
  await evalJs(FAKE_BRIDGE);
  await evalJs("window.HCUpdate.reset(); 1");
  await clickSel('#gear');      /* 关掉 */
  await sleep(200);
  await openSettings();
  check((await evalJs("(function(){var v=document.querySelector('#updSec .set-v b');return v?v.textContent:'';})()")) === 'v0.7.12', '当前版本读 AndroidBridge.info()');
  await clickSel('#updSec [data-act="upd-check"]');
  await waitFor("window.HCUpdate.state().phase === 'found'", 5000);
  check(await evalJs("window.HCUpdate.state().phase === 'found'"), '检查完进入 found');
  check(/发现新版本 v0\.7\.14/.test(await note()), '文案里有新版本号', await note());
  check(/156 KB/.test(await note()), '文案里带包大小（取大那个 .apk）');
  check((await btns()).indexOf('upd-download:下载并安装 v0.7.14') >= 0, '按钮变成「下载并安装」', await btns());
  check(/net https:\/\/api\.github\.com\/repos\/Eggplant4363\/HomeControl\/releases\/latest/.test(await evalJs("window.__LOG.join(',')")), '走的是仓库的 releases/latest');
  await shot('upd-2-found.png');

  /* ---------- ③ 下载：进度 → 完成 ---------- */
  console.log('== ③ 下载 ==');
  await clickSel('#updSec [data-act="upd-download"]');
  await waitFor("window.HCUpdate.state().phase === 'downloading'", 3000);
  check(await evalJs("window.HCUpdate.state().phase === 'downloading'"), '进入 downloading');
  check(await evalJs("!!document.querySelector('#updSec .upd-bar')"), '下载中显示进度条');
  check(/homecontrol\.apk/.test(await evalJs("window.__LOG.join(',')")), '下载用的是 release 里的 apk 文件名');
  await waitFor("window.HCUpdate.state().phase === 'ready'", 8000);
  check(await evalJs("window.HCUpdate.state().phase === 'ready'"), '下载完进入 ready');
  check(await evalJs("window.HCUpdate.state().pct === 100"), '进度到 100');
  check(/下载完成/.test(await note()), '文案说下载完成', await note());
  check((await btns()).indexOf('upd-install:立即安装') >= 0, '按钮变成「立即安装」', await btns());
  await shot('upd-3-ready.png');

  /* ---------- ④ 安装 ---------- */
  console.log('== ④ 安装 ==');
  await clickSel('#updSec [data-act="upd-install"]');
  await waitFor("window.HCUpdate.state().phase === 'installing'", 3000);
  check(await evalJs("window.HCUpdate.state().phase === 'installing'"), '进入 installing');
  check(/安装器已打开/.test(await note()), '提示安装器已打开', await note());
  check(/install \/data\/user\/0\/com\.homecontrol\.panel\/cache\/upd\/homecontrol\.apk/.test(await evalJs("window.__LOG.join(',')")), '把下载到的路径交给安装器');
  await shot('upd-4-installing.png');

  /* ---------- ⑤ 三条分支：已是最新 / 404 / 需要授权 ---------- */
  console.log('== ⑤ 已是最新 / 404 / 需要授权 ==');
  await evalJs("(function(){window.HCUpdate.reset();window.__CUR='0.7.14';window.__MODE='ok';return 1;})()");
  await clickSel('#updSec [data-act="upd-check"]');
  await waitFor("window.HCUpdate.state().phase === 'latest'", 5000);
  check(/已是最新/.test(await note()), '同版本 → 已是最新', await note());
  check(await evalJs("!!document.querySelector('#updSec .upd-note.good')"), '已是最新是绿色文案');

  await evalJs("(function(){window.HCUpdate.reset();window.__CUR='0.7.12';window.__MODE='404';return 1;})()");
  await clickSel('#updSec [data-act="upd-check"]');
  await waitFor("window.HCUpdate.state().phase === 'error'", 5000);
  check(/还没有发布任何版本/.test(await note()), '404 → 仓库还没发版', await note());

  await evalJs("(function(){window.HCUpdate.reset();window.__MODE='ok';return 1;})()");
  await clickSel('#updSec [data-act="upd-check"]');
  await waitFor("window.HCUpdate.state().phase === 'found'", 5000);
  await evalJs("(function(){window.__MODE='perm';return 1;})()");
  await clickSel('#updSec [data-act="upd-download"]');
  await waitFor("window.HCUpdate.state().phase === 'ready'", 8000);
  await clickSel('#updSec [data-act="upd-install"]');
  await waitFor("/允许这台设备安装应用/.test(document.querySelector('#updSec .upd-note').textContent)", 4000);
  check(/去授权/.test(await btns()), '需要授权时出现「去授权」', await btns());
  await clickSel('#updSec [data-act="upd-perm"]');
  await sleep(400);
  check(/perm/.test(await evalJs("window.__LOG.join(',')")), '「去授权」调到了 updPerm');
  check(/授权后回来再点/.test(await note()), '授权后提示回来再装', await note());
  await shot('upd-5-perm.png');

  /* ---------- ⑥ 重绘只换 #updSec，不重建整页 ---------- */
  console.log('== ⑥ 原地重绘 ==');
  await evalJs("(function(){window.HCUpdate.reset();window.__MODE='ok';window.__CUR='0.7.12';return 1;})()");
  await evalJs("window.__other = document.querySelector('#updSec').parentNode; 1");
  await clickSel('#updSec [data-act="upd-check"]');
  await waitFor("window.HCUpdate.state().phase === 'found'", 5000);
  check(await evalJs("document.querySelector('#updSec').parentNode === window.__other"), '状态变化后宿主容器没被重建');
  check(await evalJs("!!document.querySelector('#updSec')"), '#updSec 仍在页面上');

  sock.close();
  edge.kill();
  console.log('');
  if (failed === 0) { console.log('E2E-UPDATE PASS'); process.exit(0); }
  console.log('E2E-UPDATE FAIL (' + failed + ')');
  process.exit(1);
})();
