// 验证 SUBSCRIBE 报文：先按 MqttClient.java 现有字节（缺 topic 长度前缀）发一次，再按修正后的发一次。
// 期望：现有字节 → SUBACK 0x8F / DISCONNECT 143；修正字节 → SUBACK 0x00。
const net = require('net');

const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const topic = process.argv[6] || 'homecontrol/21051182c/cmd';

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }

function variant(name, buildSub) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => {
      const flags = 0x02 | 0x80 | 0x40;
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-sub-' + Date.now()), str(user), str(pass)]);
      s.write(pkt(0x10, body));
    });
    let step = 0;
    s.on('data', (d) => {
      if (step === 0) {
        step = 1;
        if (d[3] !== 0) { console.log(name + ': CONNACK rc=' + d[3]); s.destroy(); resolve(); return; }
        s.write(buildSub());
        return;
      }
      const t = d[0] & 0xF0;
      if (t === 0x90) console.log(name + ': SUBACK ' + [...d.slice(2)].map((x) => '0x' + x.toString(16)).join(' '));
      else if (t === 0xE0) console.log(name + ': DISCONNECT reason=' + (d[1] ? (d[2] & 0xFF) : -1));
      else console.log(name + ': pkt 0x' + t.toString(16) + ' ' + [...d].map((x) => x.toString(16)).join(' '));
      setTimeout(() => { s.destroy(); resolve(); }, 500);
    });
    s.on('error', (e) => { console.log(name + ': ERR ' + e.message); resolve(); });
    setTimeout(() => { s.destroy(); resolve(); }, 6000);
  });
}

const tb = Buffer.from(topic, 'utf8');

// ① 复刻 MqttClient.java 现在的字节：报文号(2) + properties(1) + topic 裸字节 + options(1)，漏了 topic 长度
function buggySub() {
  const sub = Buffer.alloc(2 + 1 + tb.length + 1);
  sub[0] = 0; sub[1] = 1;
  sub[2] = 0;
  tb.copy(sub, 3);
  sub[3 + tb.length] = 0;
  return pkt(0x82, sub);
}

// ② 修正：报文号(2) + properties(1) + topic长度(2) + topic + options(1)
function fixedSub() {
  const sub = Buffer.concat([Buffer.from([0, 1, 0]), str(topic), Buffer.from([0])]);
  return pkt(0x82, sub);
}

(async () => {
  await variant('[旧字节] ', buggySub);
  await variant('[修正后] ', fixedSub);
})();
