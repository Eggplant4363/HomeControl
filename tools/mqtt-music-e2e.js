// 端到端验证「中控屏音乐」实体：按 MqttClient.java 的 payload 原样发 discovery（4 条 /config），
// 再发 availability=online 与 state，然后轮询 HA /api/states 确认实体与按钮都建出来。
// 用法: node tools/mqtt-music-e2e.js [slug]
const net = require('net');
const http = require('http');

const SLUG = process.argv[2] || '21051182c';
const HOST = '10.10.1.8', PORT = 1883, USER = 'Fountain', PASS = 'nRjhfa0zOHZnWr';
const HA = 'http://10.10.1.7:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM';

const disc = (comp, obj) => 'homeassistant/' + comp + '/' + obj + '/config';
const availJson = (slug) => ',"availability_topic":"homecontrol/' + slug + '/availability","payload_available":"online","payload_unavailable":"offline"';
const deviceJson = (slug) => '{"identifiers":["homecontrol_panel_' + slug + '"],"name":"中控屏 ' + slug + '","manufacturer":"HomeControl","model":"平板中控屏"}';

function sensorJson(slug) {
  return '{"name":"中控屏音乐"'
    + ',"default_entity_id":"sensor.homecontrol_panel_' + slug + '_music"'
    + ',"unique_id":"homecontrol_panel_' + slug + '_music"'
    + ',"state_topic":"homecontrol/' + slug + '/state"'
    + ',"value_template":"{{ value_json.status }}"'
    + ',"json_attributes_topic":"homecontrol/' + slug + '/state"'
    + ',"icon":"mdi:music"'
    + availJson(slug) + ',"device":' + deviceJson(slug) + '}';
}
function buttonJson(slug, label, payload, icon) {
  return '{"name":"' + label + '"'
    + ',"default_entity_id":"button.homecontrol_panel_' + slug + '_music_' + payload + '"'
    + ',"unique_id":"homecontrol_panel_' + slug + '_music_' + payload + '"'
    + ',"command_topic":"homecontrol/' + slug + '/cmd"'
    + ',"payload_press":"' + payload + '"'
    + ',"icon":"' + icon + '"'
    + availJson(slug) + ',"device":' + deviceJson(slug) + '}';
}

function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function pkt(type, flags, body) {
  const fixed = Buffer.from([(type << 4) | flags]);
  const len = []; let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
  return Buffer.concat([fixed, Buffer.from(len), body]);
}
function publishPkt(topic, payload) {
  return pkt(3, 0, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')]));
}

function ha(path) {
  return new Promise((resolve) => {
    const req = http.request(HA + path, { headers: { Authorization: 'Bearer ' + TOKEN } }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

const topics = [
  disc('sensor', 'homecontrol_panel_' + SLUG + '_music'),
  disc('button', 'homecontrol_panel_' + SLUG + '_music_play'),
  disc('button', 'homecontrol_panel_' + SLUG + '_music_pause'),
  disc('button', 'homecontrol_panel_' + SLUG + '_music_stop')
];
const payloads = [
  sensorJson(SLUG),
  buttonJson(SLUG, '播放', 'play', 'mdi:play'),
  buttonJson(SLUG, '暂停', 'pause', 'mdi:pause'),
  buttonJson(SLUG, '停止', 'stop', 'mdi:stop')
];

const sock = net.connect(PORT, HOST, () => {
  const body = Buffer.concat([
    Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, 0xC2, 0, 60, 0]),
    str('homecontrol-e2e-' + Date.now()), str(USER), str(PASS)
  ]);
  sock.write(pkt(1, 0, body));
});
let done = false;
sock.on('data', (buf) => {
  if (done) return;
  const type = buf[0] >> 4;
  if (type === 2) {
    const rc = buf[3]; // v5 CONNACK: type, len, ackFlags, reasonCode, props
    console.log('CONNACK rc=' + rc);
    if (rc !== 0) { sock.destroy(); process.exit(1); }
    for (let i = 0; i < topics.length; i++) {
      console.log('PUB ' + topics[i]);
      sock.write(publishPkt(topics[i], payloads[i]));
    }
    sock.write(publishPkt('homecontrol/' + SLUG + '/availability', 'online'));
    sock.write(publishPkt('homecontrol/' + SLUG + '/state', '{"status":"playing","title":"\\u7aef\\u5230\\u7aef\\u6d4b\\u8bd5\\u66f2"}'));
    // 实体是在 discovery 被处理的瞬间才存在的：紧随其后的 availability/state 会被丢掉（保留为 unavailable），
    // 所以 3 秒后再补发一次，模拟面板连上后下一次状态变化。
    setTimeout(() => {
      sock.write(publishPkt('homecontrol/' + SLUG + '/availability', 'online'));
      sock.write(publishPkt('homecontrol/' + SLUG + '/state', '{"status":"playing","title":"\\u7aef\\u5230\\u7aef\\u6d4b\\u8bd5\\u66f2"}'));
      console.log('RESEND availability+state @+3s');
    }, 3000);
    setTimeout(async () => {
      const want = [
        'sensor.homecontrol_panel_' + SLUG + '_music',
        'button.homecontrol_panel_' + SLUG + '_music_play',
        'button.homecontrol_panel_' + SLUG + '_music_pause',
        'button.homecontrol_panel_' + SLUG + '_music_stop'
      ];
      const all = await ha('/api/states');
      let states = {};
      try { states = JSON.parse(all.body).reduce((m, e) => (m[e.entity_id] = e, m), {}); } catch (e) { }
      for (const w of want) {
        const s = states[w];
        if (!s) { console.log('MISSING  ' + w); continue; }
        const attrs = s.attributes || {};
        console.log('OK       ' + w + '  state=' + s.state + '  name=' + attrs.friendly_name
          + (attrs.title ? '  title=' + attrs.title : ''));
      }
      done = true;
      sock.destroy();
      process.exit(0);
    }, 6000);
  } else if (type === 14) {
    console.log('DISCONNECT reason=' + (buf.length > 3 ? buf[buf.length - 1] : -1));
    sock.destroy();
    process.exit(2);
  }
});
sock.on('error', (e) => { console.log('socket error: ' + e.message); process.exit(3); });
setTimeout(() => { console.log('timeout'); process.exit(4); }, 25000);
