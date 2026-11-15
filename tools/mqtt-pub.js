// 一次性发布器：MQTT5 CONNECT（0x10 头，跟 MqttClient.java 一致）→ 发若干 PUBLISH（v5，非 retain）→ 保持连接 N 秒
// 用法: node tools/mqtt-pub.js <host> <port> <user> <pass> <keepSec> <topic=payload> [topic=payload...]
//   payload 前缀 'r:' 表示 retain 发布（这台 EMQX 实测拒 0x38，用于验证）
const net = require('net');
const [host, portS, user, pass, keepS, ...pairs] = process.argv.slice(2);
const port = Number(portS || 1883);
const keep = Number(keepS || 8);

function encRem(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; out.push(d); } while (n);
  return Buffer.from(out);
}
function pkt(header, body) { return Buffer.concat([Buffer.from([header]), encRem(body.length), body]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function publish(topic, payload, retain) {
  const body = Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')]);
  return pkt(retain ? 0x38 : 0x30, body);
}

const s = net.connect({ host, port, timeout: 5000 }, () => {
  const cid = 'hc-pub-' + Date.now();
  const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
  const body = Buffer.concat([
    Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]),
    str(cid), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)
  ]);
  s.write(pkt(0x10, body));
});
let acked = false;
s.on('data', (d) => {
  if (!acked && d.length >= 4) {
    acked = true;
    console.log('CONNACK type=' + d[0] + ' rc=' + d[3] + (d[3] === 0 ? ' CONNECTED' : ' rejected'));
    if (d[3] !== 0) { s.destroy(); process.exit(2); }
    for (const p of pairs) {
      const i = p.indexOf('=');
      let topic = p.slice(0, i), payload = p.slice(i + 1), retain = false;
      if (payload.startsWith('r:')) { retain = true; payload = payload.slice(2); }
      try { s.write(publish(topic, payload, retain)); console.log('PUB ' + (retain ? 'retain ' : '') + topic + ' <- ' + payload); }
      catch (e) { console.log('pub fail ' + topic + ': ' + e.message); }
    }
    setTimeout(() => { console.log('closing'); s.destroy(); }, keep * 1000);
  } else if (acked) {
    // 后续任何字节：DISCONNECT/SUBACK 等，打印首字节
    console.log('rx after connect: ' + d.slice(0, 8).toString('hex'));
  }
});
s.on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });
s.on('close', () => console.log('socket closed'));
