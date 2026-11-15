// 探测这台 HA 到底装载了哪些 mqtt 平台：lock / event / siren / image / update / alarm_control_panel / device_tracker
// 用来判断「media_player 不建实体」是 media_player 独有，还是一大片平台都没装载。
const net = require('net');
const http = require('http');

const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';
const HA = { url: 'http://10.10.1.7:8123', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM' };

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function pub(t, p) { return pkt(0x30, Buffer.concat([str(t), Buffer.from([0]), Buffer.from(p, 'utf8')])); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haStates() {
  return new Promise((resolve) => {
    const req = http.get(HA.url + '/api/states', { headers: { Authorization: 'Bearer ' + HA.token }, timeout: 12000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function publishAll(msgs, holdMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => {
      const flags = 0x02 | 0x80 | 0x40;
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-p3-' + Date.now()), str(user), str(pass)]);
      s.write(pkt(0x10, body));
    });
    let acked = false;
    s.on('data', (d) => {
      if (acked) return; acked = true;
      console.log('CONNACK rc=' + d[3]);
      if (d[3] !== 0) { s.destroy(); resolve(); return; }
      for (const [t, p] of msgs) s.write(pub(t, p));
      setTimeout(() => { s.destroy(); resolve(); }, holdMs);
    });
    s.on('error', (e) => { console.log('ERR ' + e.message); resolve(); });
  });
}

const ST = 'homecontrol/p3/state';
const CT = 'homecontrol/p3/cmd';
const P = 'p3chip';
function d(o) { return JSON.stringify(o); }
const msgs = [
  ['homeassistant/lock/' + P + '_lk/config', d({ name: P + '_lk', unique_id: P + '_lk', command_topic: CT, state_topic: ST })],
  ['homeassistant/event/' + P + '_ev/config', d({ name: P + '_ev', unique_id: P + '_ev', state_topic: ST, event_types: ['a', 'b'] })],
  ['homeassistant/siren/' + P + '_sr/config', d({ name: P + '_sr', unique_id: P + '_sr', command_topic: CT, state_topic: ST })],
  ['homeassistant/image/' + P + '_im/config', d({ name: P + '_im', unique_id: P + '_im', image_topic: ST })],
  ['homeassistant/alarm_control_panel/' + P + '_ac/config', d({ name: P + '_ac', unique_id: P + '_ac', command_topic: CT, state_topic: ST })],
  ['homeassistant/humidifier/' + P + '_hm/config', d({ name: P + '_hm', unique_id: P + '_hm', target_humidity_command_topic: CT, state_topic: ST })],
  ['homeassistant/valve/' + P + '_vl/config', d({ name: P + '_vl', unique_id: P + '_vl', command_topic: CT, state_topic: ST })],
  ['homeassistant/water_heater/' + P + '_wh/config', d({ name: P + '_wh', unique_id: P + '_wh', mode_command_topic: CT, state_topic: ST })],
  ['homeassistant/device_tracker/' + P + '_dt/config', d({ name: P + '_dt', unique_id: P + '_dt', state_topic: ST })],
  ['homeassistant/update/' + P + '_up/config', d({ name: P + '_up', unique_id: P + '_up', state_topic: ST })],
  ['homeassistant/lawn_mower/' + P + '_lm/config', d({ name: P + '_lm', unique_id: P + '_lm', command_topic: CT })],
  ['homeassistant/scene/' + P + '_sc/config', d({ name: P + '_sc', unique_id: P + '_sc', command_topic: CT })]
];

(async () => {
  await publishAll(msgs, 4000);
  await sleep(4000);
  const st = await haStates();
  const hit = st.filter((x) => x.entity_id.indexOf(P) >= 0).map((x) => x.entity_id);
  console.log('建出实体: ' + (hit.length ? hit.join(', ') : '(无)'));
  console.log('未出现的平台: ' + msgs.filter(([t]) => hit.indexOf(t.split('/')[1] + '.' + P + '_' + t.split('_').pop().split('.')[0]) < 0).map(([t]) => t.split('/')[1]).join(', '));
  await publishAll(msgs.map(([t]) => [t, '']), 1500);
})();
