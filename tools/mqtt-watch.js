// 只订阅不发布：看 broker 侧到底收到哪些面板消息（availability / discovery / state）
// 用法: node tools/mqtt-watch.js [host] [port] [user] [pass] [seconds] [topic...]
const net = require('net');
const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const secs = Number(process.argv[6] || 30);
const topics = process.argv.slice(7);
if (!topics.length) topics.push('homecontrol/#', 'homeassistant/+/homecontrol_panel_#/config', 'homeassistant/+/+/homecontrol_panel_#/config');

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }

const s = net.connect({ host, port, timeout: 6000 }, () => {
  const flags = 0x02 | 0x80 | 0x40;
  const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-watch-' + Date.now()), str(user), str(pass)]);
  s.write(pkt(0x10, body));
});
s.on('data', (d) => {
  const t = d[0] & 0xF0;
  if (t === 0x20) {
    console.log('CONNACK rc=' + d[3]);
    const parts = [Buffer.from([0, 1, 0])];
    for (const tp of topics) { parts.push(str(tp)); parts.push(Buffer.from([0])); }
    s.write(pkt(0x82, Buffer.concat(parts)));
  } else if (t === 0x90) {
    console.log('SUBACK ' + [...d.slice(2)].map((x) => '0x' + x.toString(16)).join(' '));
  } else if (t === 0x30) {
    const tl = (d[2] << 8) | d[3];
    const topic = d.slice(4, 4 + tl).toString();
    const body = d.slice(4 + tl + 1).toString();
    console.log('[PUB] ' + topic + ' -> ' + body.slice(0, 300));
  } else if (t === 0xE0) {
    console.log('DISCONNECT reason=' + (d.length > 2 ? (d[2] & 0xFF) : -1));
  }
});
s.on('error', (e) => console.log('ERR ' + e.message));
setTimeout(() => { console.log('watch 结束'); s.destroy(); }, secs * 1000);
