/* 在 HA 里按「友好名/unique_id」找实体，绕开 entity_id 猜不准的问题（中文 name 的 MQTT 实体会被 slug 成别的 id）。
 * 用法: node tools/ha-find.js [关键字...] */
'use strict';
const http = require('http');
const HA = 'http://10.10.1.7:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNmVhZmYyOGY1YTQ0YWMxYWNhY2FlN2Q5NWI5N2Q2ZCIsImlhdCI6MTc5MzkyNDk4MSwiZXhwIjoyMTA5Mjg0OTgxfQ.hSfxF4NvpJMoees8QkyyBqpsuaf7-xTakMk9sCh_WWM';
const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['中控屏', 'homecontrol_panel_21051182c'];

function get(path) {
  return new Promise((res) => {
    const req = http.request(HA + path, { headers: { Authorization: 'Bearer ' + TOKEN } }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
    });
    req.on('error', (e) => res({ code: 0, body: String(e) }));
    req.end();
  });
}

(async () => {
  const r = await get('/api/states');
  if (r.code !== 200) { console.log('GET /api/states ->', r.code, r.body.slice(0, 200)); return; }
  const all = JSON.parse(r.body);
  console.log('states 总数', all.length);
  const hit = all.filter((s) => keys.some((k) => (s.entity_id + ' ' + JSON.stringify(s.attributes)).indexOf(k) >= 0));
  for (const s of hit) {
    console.log(s.entity_id, '=', JSON.stringify(s.state), '| name=', s.attributes.friendly_name, '| attrs=', JSON.stringify(s.attributes).slice(0, 220));
  }
  console.log('命中', hit.length, 'keys=', keys.join(','));
})();
