// 一次性诊断：同一连接里发 switch / binary_sensor / media_player 三条 discovery，
// 之后轮询 HA /api/states 12s，报告各自是否建出实体（过滤条件按 entity_id 的子串，不再用前缀）。
// 用法: node tools/mqtt-disc-check.js [host] [port] [user] [pass]
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
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-disc-' + Date.now()), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)]);
      s.write(pkt(0x10, body));
    });
    let acked = false;
    s.on('data', (d) => {
      if (acked) return; acked = true;
      console.log('CONNACK rc=' + d[3]);
      if (d[3] !== 0) { s.destroy(); resolve(); return; }
      for (const [t, p] of msgs) { s.write(pub(t, p)); console.log('  PUB ' + t); }
      setTimeout(() => { s.destroy(); resolve(); }, holdMs);
    });
    s.on('error', (e) => { console.log('ERR ' + e.message); resolve(); });
  });
}

const K = 'zprobe';
const msgs = [
  ['homeassistant/switch/' + K + '_sw/config', JSON.stringify({ name: K + '_sw', unique_id: K + '_sw', state_topic: 'homecontrol/' + K + '/state', command_topic: 'homecontrol/' + K + '/cmd' })],
  ['homeassistant/binary_sensor/' + K + '_bs/config', JSON.stringify({ name: K + '_bs', unique_id: K + '_bs', state_topic: 'homecontrol/' + K + '/bs' })],
  ['homeassistant/media_player/' + K + '_mp/config', JSON.stringify({ name: K + '_mp', unique_id: K + '_mp', state_topic: 'homecontrol/' + K + '/state', command_topic: 'homecontrol/' + K + '/cmd' })]
];

(async () => {
  await publishAll(msgs, 4000);
  for (let i = 1; i <= 6; i++) {
    await sleep(2000);
    const st = await haStates();
    const hit = st.filter((x) => x.entity_id.indexOf(K) >= 0).map((x) => x.entity_id);
    console.log('  t+' + (i * 2) + 's: ' + (hit.length ? hit.join(', ') : '(无)'));
  }
  const all = await haStates();
  console.log('media_player 总数=' + all.filter((x) => x.entity_id.indexOf('media_player.') === 0).length);
  // 清理
  await publishAll(msgs.map(([t]) => [t, '']), 1500);
})();
