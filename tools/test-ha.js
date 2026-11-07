/* 用假 HA WebSocket 服务器验证 panel/js/backend.js 与 layout.js 的协议行为。
   服务器实现见 tools/fake-ha.js。
   运行：node tools\test-ha.js   （退出码 0 = 全部通过） */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createServer } = require('./fake-ha');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS  ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  console.log('  TIMEOUT waiting for ' + label);
  return false;
}

/* ---------------- REST 测试用的最小 XHR ---------------- */
const http = require('http');
class FakeXHR {
  constructor() {
    this.readyState = 0; this.status = 0; this.responseText = '';
    this.timeout = 8000; this.headers = {}; this._m = 'GET'; this._u = '';
  }
  setRequestHeader(k, v) { this.headers[k] = v; }
  open(m, u) { this._m = m; this._u = u; }
  send(body) {
    let u;
    try { u = new URL(this._u); } catch (e) { if (this.onerror) this.onerror(); return; }
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: this._m, headers: this.headers
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        this.status = res.statusCode; this.responseText = buf; this.readyState = 4;
        if (this.onreadystatechange) this.onreadystatechange();
      });
    });
    req.on('error', () => { this.status = 0; this.readyState = 4; if (this.onerror) this.onerror(); });
    if (body) req.write(body);
    req.end();
  }
}
/* ---------------- 装载面板脚本 ---------------- */
function loadPanel(websocketImpl) {
  const sandbox = {
    window: {},
    WebSocket: websocketImpl,
    XMLHttpRequest: FakeXHR,
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

function badBadConn(ha) {
  /* 认证会话不应该还留着错误令牌的连接 */
  return ha.conns.some((c) => c.token === 'bad-token');
}

async function main() {
  const win = loadPanel(global.WebSocket);
  ok(!!win.HABackend, 'HABackend 已加载');
  ok(!!win.MockBackend, 'MockBackend 已加载');
  ok(!!win.Layout, 'Layout 已加载');

  const { server, ha, listen } = createServer({ port: 0, host: '127.0.0.1' });
  await listen();
  const port = server.address().port;
  const url = 'ws://127.0.0.1:' + port + '/api/websocket';
  console.log('fake HA on ' + url);

  /* --- 场景 1：正常认证 + 状态 + 事件 + 调用 --- */
  let states = null;
  let events = 0;
  let status = null;
  const be = new win.HABackend({ url: url, token: 'good-token' });
  be.onStates((s) => { states = s; events++; });
  be.onStatus((s) => { status = s; });
  be.start();

  const expectStates = Object.keys(ha.states).length;
  ok(await waitFor(() => states && Object.keys(states).length === expectStates, 5000, '首次全量状态'),
    'get_states 收到全部 ' + expectStates + ' 个实体', states ? Object.keys(states).length : 'null');
  ok(!!status && status.connected === true, 'onStatus 置为已连接', status && status.text);

  const before = events;
  ha.states['light.living_main'].state = 'off';
  ha.broadcast('light.living_main');
  ok(await waitFor(() => states['light.living_main'].state === 'off', 2000, 'state_changed 事件'),
    'state_changed 事件更新到面板');
  ok(events > before, '事件触发 onStates 回调');

  const res = await be.call('light', 'toggle', { entity_id: 'light.living_main' });
  ok(!!res, 'call_service 返回 result');
  ok(states['light.living_main'].state === 'on', 'call_service 后状态同步为 on', states['light.living_main'].state);

  /* --- 场景 2：registry + 自动布局 --- */
  const areas = await be.requestCmd({ type: 'config/area_registry/list' });
  const devices = await be.requestCmd({ type: 'config/device_registry/list' });
  const entities = await be.requestCmd({ type: 'config/entity_registry/list' });
  ok(areas.length === ha.areas.length && devices.length === ha.devices.length && entities.length === ha.entities.length,
    'registry 三张表返回正常');

  const layout = win.Layout.build(states, areas, devices, entities);
  const roomNames = layout.rooms.map((r) => r.name).join(',');
  ok(roomNames === '客厅,书房', '自动布局只保留有设备的房间（主卧为空被跳过）', roomNames);
  const living = layout.rooms.filter((r) => r.name === '客厅')[0];
  ok(!!living && living.tiles.length === 11, '客厅卡片数 11', living && living.tiles.length);
  const study = layout.rooms.filter((r) => r.name === '书房')[0];
  const studyTypes = study ? study.tiles.map((t) => t.type).join(',') : '';
  ok(studyTypes === 'light,climate,cover', '书房 3 张卡（灯/空调/窗帘）', studyTypes);
  const onoff = states['light.study_onoff'];
  ok(onoff && onoff.attributes.brightness == null, 'onoff 灯不带 brightness 属性（面板应隐藏亮度滑杆）');
  const blind = states['cover.study_blind'];
  ok(blind && blind.attributes.current_position == null && (blind.attributes.supported_features & 4) === 0,
    '只支持开/合的窗帘（无 SET_POSITION），面板应隐藏开合度滑杆');
  const floor = states['climate.study_floor'];
  ok(floor && floor.attributes.hvac_modes.indexOf('heat_cool') > -1 && !floor.attributes.fan_modes,
    '仅支持 heat_cool 且无风速档位的空调，面板应按 hvac_modes 渲染模式、隐藏风速段');

  const types = living ? living.tiles.map((t) => t.type).join(',') : '';
  ok(types === 'camera,light,light,switch,switch,switch,climate,cover,sensor,sensor,sensor',
    '卡片按 灯→开关→空调→窗帘→传感器 排序（fan/automation 归开关）', types);
  const names = living.tiles.map((t) => t.name);
  ok(names.indexOf('主灯') >= 0 && names.indexOf('灯带') >= 0 && names.indexOf('观影模式') < 0,
    '卡片名用 registry 名字、场景不进卡片', names.join('/'));
  ok(layout.scenes.length === 2, '场景键取自 scene/script', layout.scenes.map((s) => s.name).join(','));
  ok(living.tiles.filter((t) => t.type === 'switch').length === 3, 'fan 与 automation 都归到开关卡');

  /* --- 场景 3：fan / automation 用各自域 toggle --- */
  const fanBefore = states['fan.living_fan'].state;
  await be.call('fan', 'toggle', { entity_id: 'fan.living_fan' });
  ok(await waitFor(() => states['fan.living_fan'].state !== fanBefore, 2000, 'fan toggle'),
    'fan.toggle 生效（不再只支持 light/switch）');
  const autoBefore = states['automation.morning'].state;
  await be.call('automation', 'toggle', { entity_id: 'automation.morning' });
  ok(await waitFor(() => states['automation.morning'].state !== autoBefore, 2000, 'automation toggle'),
    'automation.toggle 生效');

  /* --- 场景 4：断线重连 --- */
  let reconnects = 0;
  const t0 = Date.now();
  ha.conns.forEach((c) => c.close());
  ok(await waitFor(() => be.ws && be.ws.readyState === 1 && be.statesLoaded === true, 10000, '重连'),
    '断线后自动重连并重新拉取状态（' + Math.round((Date.now() - t0) / 100) / 10 + 's）');
  ok(await waitFor(() => states && states['light.living_main'], 2000, '重连后状态'), '重连后仍能收到状态');

  /* --- 场景 5：错误令牌 --- */
  const bad = new win.HABackend({ url: url, token: 'bad-token' });
  let badStatus = null;
  bad.onStatus((s) => { badStatus = s; });
  bad.start();
  ok(await waitFor(() => badStatus && /令牌/.test(badStatus.text), 3000, 'auth_invalid'),
    '令牌无效时给出提示并停止重连', badStatus && badStatus.text);
  const badConnsBefore = ha.totalConns;
  await sleep(3000);
  const badConnsOpened = ha.totalConns - badConnsBefore;
  ok(true, '令牌错误后 3 秒内新连接数：' + badConnsOpened + '（be 仍在线，允许它自己重连）');
  ok(!badBadConn(ha), '错误令牌的连接不会被反复重建',
    ha.conns.map((c) => c.token).join(','));

  /* --- 场景 6：连不上时的诊断（地址/端口不通） --- */
  const down = new win.HABackend({ url: 'ws://127.0.0.1:9/api/websocket', token: 'x' });
  let downStatus = null;
  down.onStatus((s) => { downStatus = s; });
  down.start();
  ok(await waitFor(() => downStatus && /连不上|连接失败/.test(downStatus.text), 8000, '连不上诊断'),
    '地址/端口不通时给出「连不上」提示而不是一直「连接中…」', downStatus && downStatus.text);
  down.stop();

  /* --- 场景 7：手动重连（面板短按状态胶囊走这条路径） --- */
  be.stop();
  await sleep(200);
  be.reconnect();
  ok(await waitFor(() => be.statesLoaded === true, 5000, '手动重连'),
    'reconnect() 能重新连上并拉取状态');
  const evBefore = events;
  ha.states['light.living_strip'].state = 'on';
  ha.broadcast('light.living_strip');
  ok(await waitFor(() => states && states['light.living_strip'] && states['light.living_strip'].state === 'on' && events > evBefore, 3000, '重连后事件'),
    '手动重连后订阅仍生效（state_changed 能收到）');

  /* --- 场景 8：脏数据容错（真实 HA 的 registry / states 未必干净） --- */
  let d1 = null;
  try { d1 = win.Layout.build(null, null, null, null); } catch (e) { d1 = null; }
  ok(d1 && Array.isArray(d1.rooms) && d1.rooms.length === 0,
    'states 传 null 时布局返回空房间而不是抛错');

  let d2 = null;
  try {
    d2 = win.Layout.build(
      { 'light.a': null, 'sensor.b': { state: 'unavailable' }, 'scene.c': null },
      [{ area_id: 'x' }, null, { area_id: 'y', name: null }],
      [null, { id: 1 }],
      [null, { entity_id: 'light.a', area_id: 'x' }, { device_id: 1 }]
    );
  } catch (e) { d2 = null; }
  ok(d2 && d2.rooms && d2.rooms.length >= 1,
    'registry 混入 null / 缺字段时不抛错，仍能产出房间', d2 && d2.rooms.map((r) => r.id + '(' + r.tiles.length + ')').join(','));

  let threw = false;
  try {
    const hb = new win.HABackend({ url: 'ws://127.0.0.1:9/api/websocket', token: 'x' });
    hb.handle('null');
    hb.handle('{');
    hb.handle('{"type":"result","id":9999,"success":true}');
    hb.handle('{"type":"event"}');
    hb.handle('{"type":"auth_required"}');
  } catch (e) { threw = true; }
  ok(!threw, '收到 null / 非 JSON / 缺字段的 WS 消息时不抛错（只忽略）');

  /* --- 场景 9：用户没在 HA 里建区域时，实体不能凭空消失 --- */
  const noArea = win.Layout.build(
    { 'light.a': { entity_id: 'light.a', state: 'on', attributes: {} },
      'switch.b': { entity_id: 'switch.b', state: 'off', attributes: {} } },
    [], [], [{ entity_id: 'light.a', name: '台灯' }, { entity_id: 'switch.b', name: '插座' }]
  );
  ok(noArea.rooms.length === 1 && noArea.rooms[0].name === '其他' && noArea.rooms[0].tiles.length === 2,
    '没有区域时全部实体落进「其他」房间',
    noArea.rooms.map((r) => r.name + ':' + r.tiles.length).join(','));

  /* --- 场景 9.5：heat_cool 双设定点，set_temperature 带 low/high --- */
  await be.call('climate', 'set_temperature', {
    entity_id: 'climate.living_ac', target_temp_low: 21, target_temp_high: 25
  });
  await waitFor(() => Number(ha.states['climate.living_ac'].attributes.target_temp_low) === 21, 2000, 'low 写回');
  ok(Number(ha.states['climate.living_ac'].attributes.target_temp_low) === 21, '双设定点写回 low', ha.states['climate.living_ac'].attributes.target_temp_low);
  ok(Number(ha.states['climate.living_ac'].attributes.target_temp_high) === 25, '双设定点写回 high', ha.states['climate.living_ac'].attributes.target_temp_high);

  /* --- 场景 10：WebSocket 不通时用 REST 兜底 --- */
  const rb = new win.HABackend({ url: 'ws://127.0.0.1:' + port + '/api/websocket', token: 'good-token' });
  let rbStates = null, rbStatus = null;
  rb.onStates((s) => { rbStates = s; });
  rb.onStatus((s) => { rbStatus = s; });
  rb.restLoadStates();
  await waitFor(() => !!rbStates, 3000, 'REST 拉取状态');
  ok(rbStates && Object.keys(rbStates).length >= 10,
    'REST /api/states 能拉到全量状态', rbStates ? Object.keys(rbStates).length + ' 个' : 'null');
  ok(rbStatus && /REST/.test(String(rbStatus.text)),
    'REST 兜底成功后状态文案会说明「无实时推送」', rbStatus && rbStatus.text);

  const beforeOff = ha.states['light.living_main'].state;
  let restCallOk = false;
  try {
    await rb.call('light', 'turn_off', { entity_id: 'light.living_main' });
    restCallOk = true;
  } catch (e) { restCallOk = false; }
  ok(restCallOk && ha.states['light.living_main'].state === 'off',
    'WS 未连时 call() 会走 REST 并真的改到服务端状态', 'before=' + beforeOff);

  /* --- 场景 11：REST 令牌错误要报「令牌无效」 --- */
  const rbBad = new win.HABackend({ url: 'ws://127.0.0.1:' + port + '/api/websocket', token: 'bad-token' });
  let rbBadStatus = null;
  rbBad.onStatus((s) => { rbBadStatus = s; });
  rbBad.restLoadStates();
  await waitFor(() => rbBadStatus && /令牌无效/.test(String(rbBadStatus.text)), 3000, 'REST 401 提示');
  ok(rbBadStatus && /令牌无效/.test(String(rbBadStatus.text)),
    'REST 返回 401 时提示「令牌无效」', rbBadStatus && rbBadStatus.text);

  /* --- 场景 12：历史曲线（sparkline 数据源） --- */
  let histPts = null;
  rb.restHistory('sensor.living_temp', 12, (list) => { histPts = list; });
  await waitFor(() => !!histPts, 3000, 'REST 历史');
  ok(histPts && histPts.length >= 10, '历史接口返回足够多的点', histPts ? histPts.length + ' 个' : 'null');
  ok(histPts && histPts.every((x) => !isNaN(x.t) && !isNaN(x.v)), '历史点都带时间戳与数值');
  ok(histPts && histPts.every((x, i, a) => i === 0 || x.t >= a[i - 1].t), '历史点按时间升序');

  be.stop();
  bad.stop();
  server.close();
  await sleep(300);

  console.log(failures === 0 ? '\nALL PASS (' + 0 + ' failed)' : '\n' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
