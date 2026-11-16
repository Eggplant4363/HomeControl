/* 设置/读取 HA 的 number 实体：node tools/ha-num.js <entity_id> <value>
 * 只用于真机联调（复用 tools/ha-press.js 里的 HA url/token 约定）。 */
const https = require('https');
const HA = { url: 'http://10.10.1.7:8123', token: process.env.HA_TOKEN || require('./ha-token.json').token };

function call(path, body) {
  return new Promise((res, rej) => {
    const u = new URL(HA.url + path);
    const data = body ? JSON.stringify(body) : null;
    const req = require('http').request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: body ? 'POST' : 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + HA.token, 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res({ status: r.statusCode, body: s })); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const ent = process.argv[2] || 'number.homecontrol_panel_21051182c_music_volume';
  const val = process.argv[3];
  const domain = ent.split('.')[0];
  if (val !== undefined) {
    const r = await call('/api/services/' + domain + '/set_value', { entity_id: ent, value: Number(val) });
    console.log('set_value ' + ent + ' = ' + val + ' -> ' + r.status);
  }
  await new Promise(r => setTimeout(r, 1500));
  const s = await call('/api/states/' + ent);
  console.log(ent + ' -> ' + s.status + ' ' + s.body.slice(0, 300));
})();
