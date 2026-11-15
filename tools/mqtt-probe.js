// 一次性探针：MQTT broker 连通性 + CONNECT rc（TLS1.2 → TLS → 明文 TCP 兜底）
// node tools/mqtt-probe.js [host] [port] [user] [pass]
const net = require('net');
const tls = require('tls');
const host = process.argv[2] || '10.10.1.8';
const port = Number(process.argv[3] || 1883);
const user = process.argv[4] || '';
const pass = process.argv[5] || '';

function connectPlain() {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: 4000 }, () => resolve({ sock: s, cert: null }));
    s.on('error', reject); s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}
function connectTls(opts) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, timeout: 5000, rejectUnauthorized: false, ...opts },
      () => resolve({ sock: s, cert: s.getPeerCertificate() }));
    s.on('error', reject); s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}

function encodeRem(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 0x80; out.push(d); } while (n);
  return Buffer.from(out);
}

function mqttConnect(sock) {
  // MQTT 5（broker 10.10.1.8 只认 v5；3.1.1 会被直接关线）：可变头带空 properties 块
  const cid = 'hc-probe-' + Date.now();
  const parts = [];
  parts.push(Buffer.from([0, 4]), Buffer.from('MQTT'), Buffer.from([5]), Buffer.from([user ? 0xC2 : 0x02]), Buffer.from([0, 60]), Buffer.from([0]));
  parts.push(Buffer.from([0, cid.length]), Buffer.from(cid));
  if (user) parts.push(Buffer.from([0, user.length]), Buffer.from(user));
  if (pass) parts.push(Buffer.from([0, pass.length]), Buffer.from(pass));
  const body = Buffer.concat(parts);
  // 这台 EMQX 只认 0x10 头的 CONNECT（spec 标准 0x20 被 0 字节关线，实测逐字节对照 MQTTX）
  sock.write(Buffer.concat([Buffer.from([0x10]), encodeRem(body.length), body]));
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        sock.removeListener('data', onData);
        resolve({ type: buf[0], rc: buf[3] });
      }
    };
    sock.on('data', onData);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('CONNACK timeout')); });
    sock.on('error', reject);
  });
}

(async () => {
  const mode = process.argv.length > 6 ? process.argv[6] : 'auto';
  const order = mode === 'plain' ? [connectPlain] : mode === 'tls12' ? [() => connectTls({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })] : mode === 'tls' ? [connectTls] : [() => connectTls({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }), connectTls, connectPlain];
  for (const f of order) {
    try {
      const { sock, cert } = await f();
      const label = cert ? 'TLS ' + sock.protocol : 'TCP';
      if (cert) console.log(label, 'issuer', cert.issuer, 'subject', cert.subject);
      const r = await mqttConnect(sock);
      console.log(label, host + ':' + port, 'CONNACK type=' + r.type, 'rc=' + r.rc, r.rc === 0 ? 'CONNECTED' : 'rejected');
      sock.destroy();
      return;
    } catch (e) {
      console.log('fail:', (e.message || String(e)).slice(0, 120));
    }
  }
  console.log('all modes failed');
})();
