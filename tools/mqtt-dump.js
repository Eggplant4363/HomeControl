// 抓 broker 下行 PUBLISH 的原始字节：订阅 -> 另开一条连接发布 -> 打印收到的报文十六进制
// 用法: node tools/mqtt-dump.js [host] [port] [user] [pass] [topic] [payload]
const net = require('net');
const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const topic = process.argv[6] || 'homecontrol/21051182c/cmd';
const payload = process.argv[7] || 'ABCDEFGH';

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function conn(id) {
  const s = net.connect({ host, port, timeout: 6000 });
  s.on('connect', () => {
    const flags = 0x02 | 0x80 | 0x40;
    const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str(id), str(user), str(pass)]);
    s.write(pkt(0x10, body));
  });
  s.on('error', (e) => console.log('ERR ' + e.message));
  return s;
}

const sub = conn('hc-dump-sub-' + Date.now());
sub.on('data', (d) => {
  const t = d[0] & 0xF0;
  if (t === 0x20) {
    console.log('CONNACK rc=' + d[3]);
    sub.write(pkt(0x82, Buffer.concat([Buffer.from([0, 1, 0]), str(topic), Buffer.from([0])])));
  } else if (t === 0x90) {
    console.log('SUBACK ' + [...d.slice(2)].map((x) => '0x' + x.toString(16)).join(' '));
    setTimeout(() => {
      const pub = conn('hc-dump-pub-' + Date.now());
      pub.on('data', (x) => {
        if ((x[0] & 0xF0) === 0x20) {
          console.log('publisher CONNACK rc=' + x[3]);
          pub.write(pkt(0x30, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')])));
          setTimeout(() => pub.destroy(), 800);
        }
      });
    }, 300);
  } else if (t === 0x30) {
    console.log('RX hex: ' + d.toString('hex'));
    const hb = d[0];
    let i = 1, mul = 1, rem = 0;
    while (i < d.length) { const b = d[i++]; rem += (b & 0x7F) * mul; if (!(b & 0x80)) break; mul *= 128; }
    const tl = (d[i] << 8) | d[i + 1];
    const t2 = d.slice(i + 2, i + 2 + tl).toString();
    console.log('hb=0x' + hb.toString(16) + ' qos=' + ((hb >> 1) & 3) + ' rem=' + rem + ' topic=' + t2 + ' bodyAfterTopic=' + d.slice(i + 2 + tl).toString('hex'));
  } else if (t === 0xE0) {
    console.log('DISCONNECT reason=' + (d.length > 2 ? (d[2] & 0xFF) : -1));
  }
});
setTimeout(() => { sub.destroy(); }, 4000);
