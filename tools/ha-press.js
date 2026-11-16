// 用 HA REST 按 MQTT button 实体：node tools/ha-press.js <entity_id> [more...]
const https = require('http');
const HOST = '10.10.1.7';
const PORT = 8123;
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM';

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: HOST, port: PORT, path, method,
      headers: Object.assign({ Authorization: 'Bearer ' + TOKEN },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ code: 0, body: String(e && e.message || e) }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const ents = process.argv.slice(2);
  for (const e of ents) {
    const r = await call('POST', '/api/services/button/press', { entity_id: e });
    console.log('press ' + e + ' -> ' + r.code + ' ' + r.body.slice(0, 120));
    await new Promise((s) => setTimeout(s, 400));
  }
  const st = await call('GET', '/api/states/sensor.homecontrol_panel_21051182c_music', null);
  console.log('sensor -> ' + st.code + ' ' + st.body.slice(0, 300));
})();
