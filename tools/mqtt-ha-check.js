// 一次性诊断：往 EMQX 发一条测试 discovery（非 retain）+ 状态，然后查 HA 是否建出实体。
// 用来判断「HA 的 MQTT 集成到底连没连这台 broker」——HA 收到才会建 sensor.hcprobe_<tag>。
// 用法: node tools/mqtt-ha-check.js [host] [port] [user] [pass] [tag]
const net = require('net');
const http = require('http');

const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const tag = process.argv[6] || 'lead';

const HA = { url: 'http://10.10.1.7:8123', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM' };
const ENT = 'sensor.hcprobe_' + tag.toLowerCase();

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function pub(topic, payload, retain) { return pkt(retain ? 0x38 : 0x30, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')])); }

function haState() {
  return new Promise((resolve) => {
    const req = http.get(HA.url + '/api/states/' + ENT, { headers: { Authorization: 'Bearer ' + HA.token }, timeout: 8000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ code: -1, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: -2, body: 'timeout' }); });
  });
}

(async () => {
  console.log('--- HA 里是否有 ' + ENT + '（发之前）');
  console.log(JSON.stringify(await haState()).slice(0, 200));

  await new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => {
      const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-check-' + Date.now()), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)]);
      s.write(pkt(0x10, body));
    });
    let acked = false;
    s.on('data', (d) => {
      if (acked) { console.log('rx after connect: ' + d.slice(0, 8).toString('hex')); return; }
      acked = true;
      console.log('CONNACK rc=' + d[3]);
      if (d[3] !== 0) { s.destroy(); resolve(); return; }
      const cfgTopic = 'homeassistant/sensor/hcprobe_' + tag + '/config';
      const payload = JSON.stringify({ name: 'hcprobe_' + tag, state_topic: 'homecontrol/hcprobe_' + tag + '/state', unique_id: 'hcprobe_' + tag, value_template: '{{ value }}' });
      s.write(pub(cfgTopic, payload, false));
      console.log('PUB ' + cfgTopic + ' <- ' + payload);
      s.write(pub('homecontrol/hcprobe_' + tag + '/state', 'hello', false));
      setTimeout(() => { s.destroy(); resolve(); }, 6000);
    });
    s.on('error', (e) => { console.log('ERR ' + e.message); resolve(); });
  });

  console.log('--- 等 8s 再看 HA（HA 收到非 retain 的 discovery 才会建实体）');
  await new Promise((r) => setTimeout(r, 8000));
  console.log(JSON.stringify(await haState()).slice(0, 400));
})();
