// 一次性诊断：对比「最小合法 media_player discovery」与「面板实际发的 payload」，
// 看 HA 到底建不建实体（判断是 discovery 报文本身被 HA 拒，还是面板根本没发出去）。
// 用法: node tools/mqtt-mp-check.js [host] [port] [user] [pass]
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
function pub(topic, payload, retain) { return pkt(retain ? 0x38 : 0x30, Buffer.concat([str(topic), Buffer.from([0]), Buffer.from(payload, 'utf8')])); }

function haState(ent) {
  return new Promise((resolve) => {
    const req = http.get(HA.url + '/api/states/' + ent, { headers: { Authorization: 'Bearer ' + HA.token }, timeout: 8000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ code: -1, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: -2, body: 'timeout' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 MqttClient.java 的 discoveryJson() 完全一致的 payload（slug=21051182c）
function panelPayload(slug) {
  const avail = 'homecontrol/' + slug + '/availability';
  const state = 'homecontrol/' + slug + '/state';
  const cmd = 'homecontrol/' + slug + '/cmd';
  return '{"availability_topic":"' + avail + '"'
    + ',"payload_available":"online","payload_unavailable":"offline"'
    + ',"state_topic":"' + state + '"'
    + ',"value_template":"{{ value_json.status }}"'
    + ',"attribute_template":"{{ value_json.title }}"'
    + ',"command_topic":"' + cmd + '"'
    + ',"payload_play":"play","payload_pause":"pause","payload_stop":"stop"'
    + ',"payload_playing":"playing","payload_paused":"paused","payload_idle":"idle"'
    + ',"name":"中控屏音乐 ' + slug + '"'
    + ',"unique_id":"homecontrol_panel_' + slug + '_music"}';
}

function withConn(fn) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => {
      const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-mp-' + Date.now()), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)]);
      s.write(pkt(0x10, body));
    });
    let acked = false;
    s.on('data', (d) => {
      if (acked) { console.log('  rx after connect: ' + d.slice(0, 8).toString('hex')); return; }
      acked = true;
      console.log('  CONNACK rc=' + d[3]);
      fn(s).then(() => { setTimeout(() => { s.destroy(); resolve(); }, 2500); });
    });
    s.on('error', (e) => { console.log('  ERR ' + e.message); resolve(); });
    s.setTimeout(15000, () => { s.destroy(); resolve(); });
  });
}

(async () => {
  const cases = [
    {
      name: '最小合法 media_player discovery',
      ent: 'media_player.hcprobe_min',
      topic: 'homeassistant/media_player/hcprobe_min/config',
      payload: JSON.stringify({ name: 'hcprobe_min', unique_id: 'hcprobe_min', state_topic: 'homecontrol/hcprobe_min/state', command_topic: 'homecontrol/hcprobe_min/cmd' })
    },
    {
      name: '面板实际 payload（含 value_template/attribute_template）',
      ent: 'media_player.hcprobe_panel',
      topic: 'homeassistant/media_player/hcprobe_panel/config',
      payload: panelPayload('hcprobe_panel')
    }
  ];
  for (const c of cases) {
    console.log('=== ' + c.name);
    const before = await haState(c.ent);
    console.log('  before: code=' + before.code);
    await withConn(async (s) => {
      s.write(pub(c.topic, c.payload, false));
      console.log('  PUB ' + c.topic + ' len=' + c.payload.length);
      await sleep(300);
      s.write(pub(c.payload.match(/"availability_topic":"([^"]+)"/) ? RegExp.$1 : 'homecontrol/hcprobe_panel/availability', 'online', false));
    });
    await sleep(5000);
    const after = await haState(c.ent);
    console.log('  after: code=' + after.code + ' ' + after.body.slice(0, 220));
    // 清理：空 payload 删掉 discovery
    await withConn(async (s) => { s.write(pub(c.topic, '', false)); });
    await sleep(1500);
  }
})();
