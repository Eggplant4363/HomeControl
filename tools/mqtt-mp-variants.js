// 一次性诊断：同一台 broker 上试多种 media_player discovery payload 变体（+ 一个 switch 作对照），
// 看 HA 到底接受哪一种（每轮发完查 /api/states，找不到就换下一个变体）。
// 用法: node tools/mqtt-mp-variants.js [host] [port] [user] [pass]
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

function haGet(path) {
  return new Promise((resolve) => {
    const req = http.get(HA.url + path, { headers: { Authorization: 'Bearer ' + HA.token }, timeout: 10000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ code: -1, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: -2, body: 'timeout' }); });
  });
}

function withConn(fns) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => {
      const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
      const body = Buffer.concat([Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0]), str('hc-var-' + Date.now()), user ? str(user) : Buffer.alloc(0), pass ? str(pass) : Buffer.alloc(0)]);
      s.write(pkt(0x10, body));
    });
    let acked = false;
    s.on('data', (d) => {
      if (acked) return;
      acked = true;
      if (d[3] !== 0) { console.log('CONNACK rc=' + d[3]); s.destroy(); resolve(); return; }
      for (const [t, p] of fns) s.write(pub(t, p));
      setTimeout(() => { s.destroy(); resolve(); }, 1200);
    });
    s.on('error', (e) => { console.log('ERR ' + e.message); resolve(); });
  });
}

const variants = [
  { tag: 'v1', label: 'A 最小', payload: { name: 'hcmp_min', unique_id: 'hcmp_min', state_topic: 'homecontrol/mp1/state', command_topic: 'homecontrol/mp1/cmd' } },
  { tag: 'v2', label: 'B 最小+device', payload: { name: 'hcmp_dev', unique_id: 'hcmp_dev', state_topic: 'homecontrol/mp2/state', command_topic: 'homecontrol/mp2/cmd', device: { identifiers: ['hcmp2'], name: 'HC MP Test' } } },
  { tag: 'v3', label: 'C 最小+value_template', payload: { name: 'hcmp_vt', unique_id: 'hcmp_vt', state_topic: 'homecontrol/mp3/state', command_topic: 'homecontrol/mp3/cmd', value_template: '{{ value_json.status }}' } },
  { tag: 'v4', label: 'D 最小+supported_features', payload: { name: 'hcmp_sf', unique_id: 'hcmp_sf', state_topic: 'homecontrol/mp4/state', command_topic: 'homecontrol/mp4/cmd', supported_features: ['PAUSE', 'PLAY', 'STOP', 'NEXT_TRACK', 'PREVIOUS_TRACK'] } },
  { tag: 'v5', label: 'E 只有 state_topic', payload: { name: 'hcmp_st', unique_id: 'hcmp_st', state_topic: 'homecontrol/mp5/state' } },
  { tag: 'sw', label: '对照 switch', payload: { name: 'hcmp_sw', unique_id: 'hcmp_sw', state_topic: 'homecontrol/sw/state', command_topic: 'homecontrol/sw/cmd' } }
];

(async () => {
  for (const v of variants) {
    const comp = v.tag === 'sw' ? 'switch' : 'media_player';
    const topic = 'homeassistant/' + comp + '/hcmp_' + v.tag + '/config';
    console.log('=== ' + v.label + '  ' + topic);
    await withConn([[topic, JSON.stringify(v.payload)]]);
    await sleep(4000);
    const all = await haGet('/api/states');
    let found = [];
    try { found = JSON.parse(all.body).filter((x) => x.entity_id.indexOf('hcmp_') === 0 || x.entity_id.indexOf('media_player.hcmp') === 0).map((x) => x.entity_id + '=' + x.state); } catch (e) { }
    console.log('   实体: ' + (found.length ? found.join(', ') : '(无)'));
    // 清理
    await withConn([[topic, '']]);
    await sleep(800);
  }
})();
