/* 探针 v3：验证 ① discovery 里用 object_id 能否锁定 entity_id（中文 name 会被 slug 成一长串拼音）
 * ② availability_topic 是否让实体变 unavailable（发 online 后再看）
 * 用法: node tools/mqtt-music-check.js [slug]
 */
'use strict';
const net = require('net');
const http = require('http');

const HOST = '10.10.1.8', PORT = 1883, USER = 'Fountain', PASS = 'nRjhfa0zOHZnWr';
const HA = 'http://10.10.1.7:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM';
const slug = process.argv[2] || '21051182c';
const TAG = 'mo' + Date.now().toString(36).slice(-5);

const T = { avail: 'homecontrol/' + slug + '/availability', cmd: 'homecontrol/' + slug + '/cmd', state: 'homecontrol/' + slug + '/state' };

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function pub(topic, payload) { return pkt(0x30, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')])); }

function connectMqtt() {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: HOST, port: PORT, timeout: 5000 }, () => {
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, 0xC2, 0, 60, 0]),
        str('mcheck-' + Date.now()), str(USER), str(PASS)]);
      s.write(pkt(0x10, body));
    });
    s.once('data', (d) => { if (d[0] === 0x20 && d[3] === 0) resolve(s); else reject(new Error('CONNACK rc=' + d[3])); });
    s.once('error', reject);
  });
}
function get(path) {
  return new Promise((res) => {
    const req = http.request(HA + path, { headers: { Authorization: 'Bearer ' + TOKEN } }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    req.on('error', (e) => res({ code: 0, body: String(e) })); req.end();
  });
}

const dev = { identifiers: ['homecontrol_panel_' + slug], name: '中控屏 ' + slug, manufacturer: 'HomeControl', model: '平板中控屏' };
const avail = { availability_topic: T.avail, payload_available: 'online', payload_unavailable: 'offline' };

const cases = [
  // ① 中文 name + default_entity_id（HA 2025.10+ 的 MQTT discovery 新键）：看 entity_id 能否锁定
  ['deid_sensor', 'homeassistant/sensor/' + TAG + '_s/config',
    { name: '中控屏音乐', default_entity_id: 'sensor.' + TAG + '_music', unique_id: TAG + '_s', state_topic: T.state, value_template: '{{ value_json.status }}', json_attributes_topic: T.state, ...avail, device: dev }],
  ['deid_button', 'homeassistant/button/' + TAG + '_b/config',
    { name: '播放', default_entity_id: 'button.' + TAG + '_music_play', unique_id: TAG + '_b', command_topic: T.cmd, payload_press: 'play', ...avail, device: dev }],
  ['avail_only', 'homeassistant/sensor/' + TAG + '_a/config',
    { name: TAG + '_avonly', unique_id: TAG + '_a', state_topic: T.state, ...avail }]
];

(async () => {
  const s = await connectMqtt();
  console.log('CONNECTED TAG=' + TAG);
  for (const [k, topic, payload] of cases) { s.write(pub(topic, JSON.stringify(payload))); console.log('PUB', k, topic); }
  // 先把 availability 打成 online（非 retain），看实体是否可用来判断 unavailable 的成因
  s.write(pub(T.avail, 'online'));
  console.log('PUB avail online');
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await get('/api/states');
    if (r.code !== 200) { console.log('states', r.code); continue; }
    const all = JSON.parse(r.body);
    const mine = all.filter((st) => st.entity_id.indexOf(TAG) >= 0).map((st) => st.entity_id + '=' + JSON.stringify(st.state));
    const realBtn = all.filter((st) => st.entity_id === 'button.zhong_kong_ping_21051182c_bo_fang').map((st) => st.entity_id + '=' + JSON.stringify(st.state));
    console.log('t+' + (i + 1) * 2 + 's probe [' + mine.join(', ') + '] realBtn [' + realBtn.join(', ') + ']');
  }
  s.destroy();
})();
