// 分辨「MQTT 的 media_player 平台到底有没有被 HA 装载」：
// 同一连接里发 light / climate / cover / button / media_player 五种最小 discovery，
// 各自唯一 topic，12s 后看哪些建出实体。media_player 再补 3 个变体。
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
      const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-var-' + Date.now()), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)]);
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

const ST = 'homecontrol/probe/state';
const CT = 'homecontrol/probe/cmd';
const P = 'pchip';
const msgs = [
  ['homeassistant/light/' + P + '_lt/config', JSON.stringify({ name: P + '_lt', unique_id: P + '_lt', state_topic: ST, command_topic: CT })],
  ['homeassistant/climate/' + P + '_cl/config', JSON.stringify({ name: P + '_cl', unique_id: P + '_cl', mode_command_topic: CT })],
  ['homeassistant/cover/' + P + '_cv/config', JSON.stringify({ name: P + '_cv', unique_id: P + '_cv', state_topic: ST, command_topic: CT })],
  ['homeassistant/button/' + P + '_bt/config', JSON.stringify({ name: P + '_bt', unique_id: P + '_bt', command_topic: CT })],
  ['homeassistant/media_player/' + P + '_mp/config', JSON.stringify({ name: P + '_mp', unique_id: P + '_mp', state_topic: ST, command_topic: CT })],
  ['homeassistant/media_player/' + P + '_mp2/config', JSON.stringify({ name: P + '_mp2', unique_id: P + '_mp2', state_topic: ST })],
  ['homeassistant/media_player/' + P + '_mp3/config', JSON.stringify({ name: P + '_mp3', unique_id: P + '_mp3', state_topic: ST, supported_features: ['play', 'pause', 'stop', 'next_track', 'previous_track', 'volume_set'], device: { identifiers: [P], name: P } })],
  ['homeassistant/media_player/' + P + '_mp4/config', JSON.stringify({ name: P + '_mp4', state_topic: ST, value_template: '{{ value_json.status }}' })]
];

(async () => {
  await publishAll(msgs, 4000);
  for (let i = 1; i <= 5; i++) {
    await sleep(2500);
    const st = await haStates();
    const hit = st.filter((x) => x.entity_id.indexOf(P) >= 0).map((x) => x.entity_id);
    console.log('  t+' + (i * 2.5) + 's: ' + (hit.length ? hit.join(', ') : '(无)'));
  }
  await publishAll(msgs.map(([t]) => [t, '']), 1500);
})();
