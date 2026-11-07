/*
 * 对真实 Home Assistant 的只读联调检查（不改动任何设备）。
 *
 * 用法：
 *   node tools\real-ha-check.js http://10.10.1.7:8123 <长期访问令牌>
 *
 * 做的四件事：
 *   1) REST：GET /api/  探活 + 校验令牌
 *   2) WS：用面板自己的 panel/js/backend.js 连 /api/websocket，认证、get_states、订阅事件
 *   3) 三张 registry：area / device / entity，交给 panel/js/layout.js 生成房间与卡片
 *   4) 打印「真实家里会长成什么样」的摘要（按域统计、房间分布、卡片数、场景数）
 *
 * 只发只读命令（auth / get_states / registries / subscribe_events），
 * 不发 call_service —— 所以不会动你家里的任何设备。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  console.log('usage: node tools\\real-ha-check.js <http://host:8123> <token>');
  process.exit(2);
}

let rawBase = process.argv[2];
let token = process.argv[3];
/* 没给地址/令牌时，退回项目根的 ha.json（部署脚本用的也是它） */
if (!rawBase || !token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ha.json'), 'utf8'));
    rawBase = rawBase || cfg.url;
    token = token || cfg.token;
  } catch (e) { }
}
if (!rawBase || !token) usage();

/* 复用面板里的规整逻辑（normalizeHa / haHttpBase）——单独实现一遍会和产品行为脱节 */
function normalizeUrl(raw) {
  let u = String(raw).trim();
  if (/^wss:/i.test(u)) u = u.replace(/^wss:/i, 'https:');
  else if (/^ws:/i.test(u)) u = u.replace(/^ws:/i, 'http:');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '').replace(/\/api\/websocket\/?$/i, '');
  const ws = u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return ws.replace(/\/?$/, '') + '/api/websocket';
}

const wsUrl = normalizeUrl(rawBase);
const httpBase = wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/api\/websocket$/, '');

function getJson(url, headers) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: headers, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

function loadPanel() {
  const sandbox = {
    window: {},
    WebSocket: global.WebSocket,
    XMLHttpRequest: undefined,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    console, JSON, Math, Date, String, Number, Object, Array,
    parseInt, parseFloat, isNaN
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  for (const f of ['panel/js/backend.js', 'panel/js/layout.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window;
}

(async () => {
  console.log('HA http base : ' + httpBase);
  console.log('HA ws url    : ' + wsUrl);
  console.log('');

  /* ---------- 1) REST 探活 ---------- */
  const probe = await getJson(httpBase + '/api/', { Authorization: 'Bearer ' + token });
  if (probe.status !== 200) {
    console.log('FAIL  GET /api/ -> ' + (probe.error || ('HTTP ' + probe.status)));
    console.log('      令牌或地址有问题，后面的 WS 检查没意义，先停。');
    process.exit(1);
  }
  console.log('PASS  GET /api/ -> 200 ' + probe.body.slice(0, 60));

  /* ---------- 2) / 3) WS 连接 + registry ---------- */
  const win = loadPanel();
  const be = new win.HABackend({ url: wsUrl, token: token });

  let states = null;
  let statusText = '';
  let events = 0;

  be.onStates((s) => { states = s; });
  be.onStatus((st) => { statusText = (st && st.text) || ''; });

  const t0 = Date.now();
  be.start();

  /* 等首个 states（最多 15s） */
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (states || Date.now() - t0 > 15000) { clearInterval(timer); resolve(); }
    }, 200);
  });

  if (!states) {
    console.log('FAIL  WebSocket 没拿到状态（连接状态：' + (statusText || '未知') + '）');
    process.exit(1);
  }
  const ms = Date.now() - t0;
  const ids = Object.keys(states);
  console.log('PASS  WS 认证 + get_states  ' + ids.length + ' 个实体（' + ms + 'ms）');

  /* 订阅事件：等 2 秒，确认能收到 state_changed（有的家庭一直安静） */
  const evBefore = events;
  await new Promise((r) => setTimeout(r, 2000));
  console.log('INFO  订阅 state_changed 后 2 秒内收到 ' + (events - evBefore) + ' 次推送');

  /* registry 三表 */
  const reg = { areas: [], devices: [], entities: [] };
  const names = ['config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list'];
  for (let i = 0; i < names.length; i++) {
    const res = await new Promise((resolve) => {
      if (!be.requestCmd) return resolve(null);
      be.requestCmd({ type: names[i] }).then(
        (r) => resolve(r),
        (e) => resolve(null)
      );
    });
    const list = Array.isArray(res) ? res : (res && res.result) || null;
    if (list) {
      if (i === 0) reg.areas = list;
      if (i === 1) reg.devices = list;
      if (i === 2) reg.entities = list;
      console.log('PASS  ' + names[i] + ' -> ' + list.length + ' 条');
    } else {
      console.log('WARN  ' + names[i] + ' 不可用（' + ((res && res.error && res.error.message) || '无响应') + '）');
    }
  }

  /* ---------- 4) 布局：真实家里会长成什么样 ---------- */
  const layout = win.Layout.build(states, reg.areas, reg.devices, reg.entities);
  console.log('');
  console.log('=== 面板会长成这样 ===');
  console.log('房间 ' + layout.rooms.length + ' 个 · 场景 ' + layout.scenes.length + ' 个');
  /* 摄像头：真实家庭里常只有一两个，混在 Top 域里看不到，单独列 */
  const camStates = (Array.isArray(states) ? states : Object.keys(states || {}).map((k) => states[k]))
    .filter((x) => String((x && x.entity_id) || '').indexOf('camera.') === 0);
  const camTiles = [];
  layout.rooms.forEach((r) => r.tiles.forEach((t) => { if (t && t.type === 'camera') camTiles.push(r.name + '/' + (t.entity || t.entity_id)); }));
  if (camStates.length) {
    console.log('摄像头实体  ' + camStates.map((c) => c.entity_id + '=' + c.state).join('  '));
    console.log('摄像头卡片  ' + (camTiles.length ? camTiles.join('  ') : '（未进布局：检查 area / entity_category / hidden_by）'));
  }
  layout.rooms.forEach((room) => {
    const byType = {};
    room.tiles.forEach((t) => { byType[t.type] = (byType[t.type] || 0) + 1; });
    console.log('  · ' + room.name + '（' + room.tiles.length + ' 张卡：' +
      Object.keys(byType).map((k) => k + '×' + byType[k]).join(' ') + '）');
  });
  if (layout.scenes.length) {
    console.log('  场景：' + layout.scenes.slice(0, 8).map((s) => s.name).join(' / ') +
      (layout.scenes.length > 8 ? ' …共 ' + layout.scenes.length + ' 个' : ''));
  }

  /* 按域统计，方便判断有没有漏掉的东西 */
  const domains = {};
  ids.forEach((id) => { const d = id.split('.')[0]; domains[d] = (domains[d] || 0) + 1; });
  const top = Object.keys(domains).sort((a, b) => domains[b] - domains[a]).slice(0, 12);
  console.log('');
  console.log('实体域 Top：' + top.map((d) => d + '×' + domains[d]).join('  '));

  /* 不受支持的域（能看到但面板不渲染），列出来让用户心里有数 */
  const shown = {};
  layout.rooms.forEach((r) => r.tiles.forEach((t) => { const eid = t && (t.entity || t.entity_id); if (eid) shown[String(eid).split('.')[0]] = 1; }));
  const skipped = Object.keys(domains).filter((d) => !shown[d]).sort();
  if (process.env.DEBUG_SHOWN) console.log('DEBUG shown=' + JSON.stringify(Object.keys(shown)) );
  console.log('面板暂不渲染的域：' + (skipped.length ? skipped.join(' ') : '（无）'));

  be.stop();
  console.log('');
  console.log('REAL HA CHECK OK（只读，未改动任何设备）');
  process.exit(0);
})().catch((e) => {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
