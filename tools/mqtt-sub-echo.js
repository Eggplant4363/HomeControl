// 修正 SUBSCRIBE 后：订阅 -> 自己发一条 -> 应能收回（证明 QoS0 下行通路可用）
const net = require('net');
const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const topic = process.argv[6] || 'homecontrol/21051182c/cmd';

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = net.connect({ host, port, timeout: 6000 }, () => {
  const flags = 0x02 | 0x80 | 0x40;
  const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-echo-' + Date.now()), str(user), str(pass)]);
  s.write(pkt(0x10, body));
});
let got = 0;
s.on('data', (d) => {
  const t = d[0] & 0xF0;
  if (t === 0x20) { console.log('CONNACK rc=' + d[3]); s.write(pkt(0x82, Buffer.concat([Buffer.from([0, 1, 0]), str(topic), Buffer.from([0])]))); }
  else if (t === 0x90) {
    console.log('SUBACK ' + [...d.slice(2)].map((x) => '0x' + x.toString(16)).join(' '));
    setTimeout(() => s.write(pkt(0x30, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from('play', 'utf8')]))), 300);
  } else if (t === 0x30) {
    const tl = (d[2] << 8) | d[3];
    console.log('收到 PUBLISH topic=' + d.slice(4, 4 + tl).toString() + ' payload=' + d.slice(4 + tl + 1).toString());
    got++;
  } else if (t === 0xE0) console.log('DISCONNECT reason=' + (d.length > 2 ? (d[2] & 0xFF) : -1));
});
setTimeout(() => { console.log(got ? 'OK 下行链路可用' : '未收到回环消息'); s.destroy(); }, 2500);
