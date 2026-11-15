// 逐项验证面板假设：① retain 发布(0x38) 是否被拒 ② CONNECT 带 Will 是否被关线 ③ 修正 SUBSCRIBE 后能否收到消息
const net = require('net');

const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || 'Fountain';
const pass = process.argv[5] || 'nRjhfa0zOHZnWr';

function encRem(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; o.push(d); } while (n); return Buffer.from(o); }
function pkt(h, b) { return Buffer.concat([Buffer.from([h]), encRem(b.length), b]); }
function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(clientId, withWill) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 6000 }, () => {
      let flags = 0x02 | 0x80 | 0x40;
      if (withWill) flags |= 0x04 | 0x20; // will flag + will retain
      const parts = [Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5, flags, 0, 60, 0])];
      if (withWill) parts.push(Buffer.from([0]), str('homecontrol/_probe_will'), str('offline'), Buffer.from([0]));
      parts.push(str(clientId), str(user), str(pass));
      s.write(pkt(0x10, Buffer.concat(parts)));
    });
    let done = false;
    s.on('data', (d) => {
      if (done) return; done = true;
      console.log('  CONNACK rc=' + d[3] + ' (' + d.length + 'B)');
      resolve(d[3] === 0 ? s : null);
    });
    s.on('close', () => { if (!done) { done = true; console.log('  closed by broker, no CONNACK'); resolve(null); } });
    s.on('error', (e) => { if (!done) { done = true; console.log('  ERR ' + e.message); resolve(null); } });
    setTimeout(() => { if (!done) { done = true; console.log('  timeout'); s.destroy(); resolve(null); } }, 6000);
  });
}

(async () => {
  console.log('[1] CONNECT 不带 Will');
  const a = await connect('hc-t1-' + Date.now(), false);
  if (!a) return;
  console.log('[2] retain 发布 0x38 -> homecontrol/probe/rt');
  const tb = Buffer.from('homecontrol/probe/rt', 'utf8');
  const body = Buffer.concat([str('homecontrol/probe/rt'), Buffer.from([0]), Buffer.from('retained-test', 'utf8')]);
  a.write(pkt(0x38, body));
  await sleep(800);
  console.log('    连接仍在? state=' + (a.destroyed ? 'closed' : 'open'));
  console.log('[3] 修正 SUBSCRIBE -> homecontrol/probe/rt');
  a.write(pkt(0x82, Buffer.concat([Buffer.from([0, 2, 0]), str('homecontrol/probe/rt'), Buffer.from([0])])));
  a.on('data', (d) => {
    const t = d[0] & 0xF0;
    if (t === 0x90) console.log('    SUBACK ' + [...d.slice(2)].map((x) => '0x' + x.toString(16)).join(' '));
    else if (t === 0xE0) console.log('    DISCONNECT 143? reason=' + (d[2] & 0xFF));
    else if (t === 0x30) {
      const tl = (d[2] << 8) | d[3];
      console.log('    收到 PUBLISH topic=' + d.slice(4, 4 + tl).toString() + ' payload=' + d.slice(4 + tl + 1).toString());
    }
  });
  await sleep(1200);
  console.log('[4] 自己再发一条非 retain 到同一主题，看能否收回来');
  a.write(pkt(0x30, Buffer.concat([str('homecontrol/probe/rt'), Buffer.from([0]), Buffer.from('echo-1', 'utf8')])));
  await sleep(1500);
  a.destroy();

  console.log('[5] CONNECT 带 Will');
  const b = await connect('hc-t2-' + Date.now(), true);
  if (b) b.destroy();
})();
