'use strict';
// 桥的安全回归检查：直接在设备上通过 WebView CDP 调 AndroidBridge，验证文件白名单。
// 前提：平板上有 /sdcard/HomeControl/debug.flag（开发部署由 push.ps1 写），App 在跑。
// 用法：node tools/check-security.js [设备号]   （默认 $env:HC_DEVICE，再默认 emulator-5554）
const cdp = require('./lib/cdp');

const serial = process.argv[2] || process.env.HC_DEVICE || 'emulator-5554';
let fails = 0;
function check(ok, name, extra) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
  if (!ok) fails++;
}

(async () => {
  const { ws, pid } = await cdp.connectWebView({ serial });
  console.log('connected to WebView pid=' + pid);

  // 1. ../ 穿越必须被拒（以前 startsWith('/sdcard/HomeControl/') 会放行）
  const trav = await cdp.evaluate(ws, "AndroidBridge.readText('/sdcard/HomeControl/../Download/x.txt')");
  check(trav === null || trav === '', 'readText 拒绝 ../ 穿越（不返回内容）', 'got ' + JSON.stringify(trav));

  // 2. 别的目录必须被拒
  const other = await cdp.evaluate(ws, "AndroidBridge.readText('/sdcard/Download/x.txt')");
  check(other === null || other === '', 'readText 拒绝配置目录外的路径', 'got ' + JSON.stringify(other));

  // 3. 配置目录内的文件必须能读（/sdcard 是 symlink，规范路径要判对）
  const ha = await cdp.evaluate(ws, "AndroidBridge.readText('/sdcard/HomeControl/ha.json')");
  check(typeof ha === 'string' && ha.indexOf('"url"') >= 0, 'readText 能读 ha.json',
    typeof ha === 'string' ? ha.slice(0, 40) : 'got ' + JSON.stringify(ha));

  // 4. mtime 热更新信号必须能用（看门狗/热重载都依赖它）
  const mt = await cdp.evaluate(ws, "AndroidBridge.mtime('/sdcard/HomeControl/panel/.rev')");
  check(typeof mt === 'number' && mt > 0, 'mtime 允许 .rev', 'got ' + mt);

  // 5. 写与删只在配置目录内生效
  const w1 = await cdp.evaluate(ws, "AndroidBridge.writeText('/sdcard/HomeControl/.sectest.tmp','ok')");
  check(w1 === true || w1 === 1 || w1 === 'ok', 'writeText 允许配置目录内', 'got ' + JSON.stringify(w1));
  const r1 = await cdp.evaluate(ws, "AndroidBridge.readText('/sdcard/HomeControl/.sectest.tmp')");
  check(r1 === 'ok', '刚写的文件能读回', 'got ' + JSON.stringify(r1));
  const w2 = await cdp.evaluate(ws, "AndroidBridge.writeText('/sdcard/HomeControl/../Download/pwn.txt','x')");
  check(w2 !== true && w2 !== 1, 'writeText 拒绝 ../ 穿越', 'got ' + JSON.stringify(w2));
  const del = await cdp.evaluate(ws, "AndroidBridge.removeFile('/sdcard/HomeControl/.sectest.tmp')");
  check(del === true || del === 1, 'removeFile 删掉测试文件', 'got ' + JSON.stringify(del));

  // 6. 目录本身被当文件读要失败，不能泄露内容
  const dir = await cdp.evaluate(ws, "AndroidBridge.readText('/sdcard/HomeControl/panel')");
  check(dir === null || dir === '', 'readText 拒绝目录路径', 'got ' + JSON.stringify(dir));

  cdp.closeAll(ws, null);
  console.log(fails === 0 ? 'SECURITY OK' : 'SECURITY FAIL ' + fails);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.log('异常: ' + e.message);
  process.exit(2);
});
