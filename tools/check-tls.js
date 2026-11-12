/* 用真实设备验 TLS：让 Java 桥（TlsPolicy）探几个 https 目标，再看面板实体数。
   用法：node tools\check-tls.js <serial> [--https]
   --https 把 HA 地址换成 homeass.cchong.cc（内网反代 + Let's Encrypt 证书）：
     Android 5.1 系统信任库没有 ISRG Root X1，靠 TlsPolicy 自带锚（assets/certs）兜住。
   负面用例：self-signed / 域名不匹配 必须被拒（证明不是无脑 trustAll）。
   令牌不落进仓库：只从设备 cat 回来，用完丢掉。 */
'use strict';
const cdp = require('./lib/cdp.js');

const SERIAL = process.argv[2] || '';
const WANT_HTTPS = process.argv.indexOf('--https') >= 0;
const PUBLIC_HOST = 'homeass.cchong.cc';

function probe(ws, url, token) {
  return cdp.evaluate(ws, 'AndroidBridge.httpProbe(' + JSON.stringify(url) + ',' + JSON.stringify(token || '') + ')');
}

async function main() {
  const raw = cdp.adbOut(SERIAL, ['shell', 'cat', '/sdcard/HomeControl/ha.json']);
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error('设备 ha.json 读不到/解析失败：' + raw.slice(0, 80)); }
  const haUrl = WANT_HTTPS ? 'https://' + PUBLIC_HOST + '/' : cfg.url;
  console.log('config url = ' + cfg.url + ' → 测 ' + haUrl);

  const conn = await cdp.connectWebView({ serial: SERIAL });
  const ws = conn.ws;

  console.log('  HA 探测      ' + haUrl + ' → ' + await probe(ws, haUrl, cfg.token));
  console.log('  自签证书     https://self-signed.badssl.com/ → ' + await probe(ws, 'https://self-signed.badssl.com/', ''));
  console.log('  域名不匹配   https://wrong-site.badssl.com/ → ' + await probe(ws, 'https://wrong-site.badssl.com/', ''));

  await cdp.closeAll();

  const log = cdp.adbOut(SERIAL, ['shell', 'logcat -d -v time -s HomePanel:*']);
  const lines = log.split(/\r?\n/);
  const first = lines.filter((l) => /first states/.test(l)).slice(-1);
  const net = lines.filter((l) => /httpProbe|ws |WS|websocket|wss|reconnect|SSL|ssl|证书|denied|failed/i.test(l));
  console.log('面板首帧：' + (first.join(' | ') || '(本轮没有 first states 日志)'));
  console.log('关键日志（最后 10 条）：');
  net.slice(-10).forEach((l) => console.log('  ' + l.trim()));
}

main().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
