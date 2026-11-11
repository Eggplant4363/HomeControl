/* 面板渲染逻辑的离线单测（不需要设备、不需要浏览器）
   跑法：node tools\test-ui.js
   原理：给 app.js 一个够用的 DOM/window 桩，让它只定义函数不执行 boot()，
        再从 window.__PANEL_TEST__ 取纯函数断言「能力自适配」的渲染结果。
   覆盖：离线设备、onoff 灯、亮度灯、heeh_cool 双设定点、无温度空调、
        无开合度卷帘、自动化语义、卡片 na 类。 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');

var passed = 0;
var failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? ('  → ' + extra) : ''));
  }
}
function eq(actual, expect, name) {
  ok(actual === expect, name, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expect));
}

/* ---------- 最小 DOM 桩 ---------- */
function El(tag) {
  this.tagName = (tag || 'div').toUpperCase();
  this.className = '';
  this.textContent = '';
  this.innerHTML = '';
  this.style = {};
  this.children = [];
  this.dataset = {};
  this.parentNode = null;
  this.offsetWidth = 100;
  this.clientWidth = 100;
  this.scrollWidth = 100;
  this.scrollLeft = 0;
}
El.prototype.addEventListener = function () {};
El.prototype.removeEventListener = function () {};
El.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
El.prototype.setAttribute = function (k, v) { this[k] = v; };
El.prototype.getAttribute = function (k) { return this[k] == null ? null : this[k]; };
El.prototype.removeAttribute = function (k) { delete this[k]; };
El.prototype.querySelector = function () { return null; };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 };
};

var registry = {};
function getEl(id) {
  if (!registry[id]) registry[id] = new El('div');
  return registry[id];
}

var documentStub = {
  readyState: 'loading',                       /* 不触发 DOMContentLoaded → 不执行 boot() */
  documentElement: new El('html'),
  body: new El('body'),
  getElementById: getEl,
  createElement: function (tag) { return new El(tag); },
  addEventListener: function () {},
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  getElementsByTagName: function () { return []; }
};

var storageData = {};
var windowStub = {
  document: documentStub,
  location: { search: '', reload: function () {} },
  localStorage: {
    getItem: function (k) { return storageData[k] == null ? null : storageData[k]; },
    setItem: function (k, v) { storageData[k] = String(v); },
    removeItem: function (k) { delete storageData[k]; },
    clear: function () { storageData = {}; }
  },
  navigator: { userAgent: 'node' },
  setTimeout: function () { return 0; },
  clearTimeout: function () {},
  setInterval: function () { return 0; },
  clearInterval: function () {},
  addEventListener: function () {},
  requestAnimationFrame: function (fn) { fn(); },
  AndroidBridge: null
};
windowStub.window = windowStub;

var sandbox = {
  window: windowStub,
  document: documentStub,
  localStorage: windowStub.localStorage,
  navigator: windowStub.navigator,
  console: console,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  Promise: Promise,
  setTimeout: windowStub.setTimeout,
  clearTimeout: windowStub.clearTimeout,
  setInterval: windowStub.setInterval,
  clearInterval: windowStub.clearInterval,
  requestAnimationFrame: windowStub.requestAnimationFrame
};
vm.createContext(sandbox);

function load(rel) {
  var code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('panel/js/config.js');
load('panel/js/icons.js');
load('panel/js/layout.js');
load('panel/js/app.js');

var api = windowStub.__PANEL_TEST__;
if (!api) {
  console.log('FAIL  未能从 app.js 取到 __PANEL_TEST__');
  process.exit(1);
}

/* ---------- 断言 ---------- */
console.log('面板渲染逻辑（离线）');

/* 1. 离线设备：读数位留「—」；控制卡的状态由圆钮颜色负责，不写状态词 */
ok(api.isNa('unavailable') && api.isNa('unknown') && !api.isNa('on'), '状态判定：unavailable/unknown 视为离线');
eq(api.valHtml({ type: 'light', entity: 'light.x', name: 'x' }, 'unavailable', {}), '—',
  '离线灯：读数位是「—」，卡片变暗由 na 类负责');

/* 2. 灯：开/关不再出现在读数位（状态由圆钮颜色说），只有亮度这种真数值才显示 */
eq(api.valHtml({ type: 'light', entity: 'light.a', name: 'a' }, 'on', { supported_color_modes: ['onoff'] }), '',
  'onoff 灯（无亮度能力）：读数位留空');
ok(/^100<span class="u">%<\/span>$/.test(api.valHtml({ type: 'light', entity: 'light.b', name: 'b' }, 'on',
  { brightness: 255, supported_color_modes: ['brightness'] })), '亮度灯：值显示百分比');
ok(api.hasBrightness({ supported_color_modes: ['onoff'] }) === false, '能力判定：onoff 灯没有亮度');
ok(api.hasBrightness({ brightness: 128 }) === true, '能力判定：有 brightness 就有亮度');

/* 3. 空调：双设定点 */
var dualAttrs = { target_temp_low: 20, target_temp_high: 26, target_temp_step: 1 };
var dual = api.dualTarget(dualAttrs);
ok(dual && dual.low === 20 && dual.high === 26, 'dualTarget 解析 low/high');
eq(api.valHtml({ type: 'climate', entity: 'climate.f', name: 'f' }, 'heat_cool', dualAttrs), '20–26<span class="u">°C</span>',
  'heat_cool 空调：卡片显示区间');

/* 4. 空调：没有目标温度能力（新风） */
var noTemp = { supported_features: 384, hvac_modes: ['off', 'fan_only'] };
var caps = api.climateTempCaps(noTemp);
ok(caps.single === false && caps.range === false, '能力判定：supported_features=384 无温度能力');
eq(api.valHtml({ type: 'climate', entity: 'climate.n', name: 'n' }, 'fan_only', noTemp), '送风',
  '无温度空调：值显示模式文字（送风）');

/* 5. 卷帘：没有开合度 */
ok(api.hasPosition({ supported_features: 15 }) === true, '能力判定：supported_features=15 有开合度');
ok(api.hasPosition({ supported_features: 3 }) === false, '能力判定：supported_features=3 无开合度');
eq(api.valHtml({ type: 'cover', entity: 'cover.c', name: 'c' }, 'closed', { supported_features: 3 }), '',
  '无开合度卷帘：读数位留空（没有可信数字就不编一个 0%）');
ok(/^60<span class="u">%<\/span>$/.test(api.valHtml({ type: 'cover', entity: 'cover.d', name: 'd' }, 'open',
  { supported_features: 15, current_position: 60 })), '有开合度卷帘：值显示百分比');

/* 6. 自动化语义 */
ok(api.isAuto({ entity: 'automation.morning' }), '自动化识别');
eq(api.valHtml({ type: 'switch', entity: 'automation.morning', name: 'm' }, 'on', {}), '启用',
  '自动化卡片：值显示「启用」（不是「开」）');
eq(api.subText({ type: 'switch', entity: 'automation.morning', name: 'm' }, 'on', {}), '点按触发',
  '自动化卡片：副标题提示点按触发');

/* 7. 卡片 HTML：离线卡片带 na 类（状态由 updateTile 填，tileHtml 只出骨架） */
var naHtml = api.tileHtml({
  tile: { entity: 'light.off', type: 'light', name: '落地灯' }, room: '客厅'
});
ok(/class="tile[^"]*\bna\b/.test(naHtml), '离线实体的卡片带 na 类（整卡变暗、隐藏控件）');
api.setStates({ 'light.ok': { entity_id: 'light.ok', state: 'on', attributes: {} } });
var okHtml = api.tileHtml({
  tile: { entity: 'light.ok', type: 'light', name: '主灯' }, room: '客厅'
});
ok(!/class="tile[^"]*\bna\b/.test(okHtml), '正常实体不带 na 类', okHtml.slice(0, 80));
ok(okHtml.indexOf('data-entity="light.ok"') > -1, 'tileHtml 带上实体 id（点击派发用）');

/* 7b. 1×1 只有两种模板（照用户手绘）：控制卡 = 圆钮 + 名称；传感卡 = 大字读数 + 名称 */
api.setStates({
  'light.ok': { entity_id: 'light.ok', state: 'on', attributes: {} },
  'sensor.bed': { entity_id: 'sensor.bed', state: '21.5', attributes: { unit_of_measurement: '°C', device_class: 'temperature' } }
});
var readHtml = api.tileHtml({ tile: { entity: 'sensor.bed', type: 'sensor', name: '卧室温度' }, room: '' });
ok(readHtml.indexOf('t-big') > -1, '1×1 传感卡：大字读数模板（t-big）');
ok(readHtml.indexOf('21.5') > -1, '1×1 传感卡：读数写进模板');
var ctrlHtml = api.tileHtml({ tile: { entity: 'light.ok', type: 'light', name: '主灯' }, room: '' });
ok(ctrlHtml.indexOf('t-round') > -1, '1×1 控制卡：圆钮模板（t-round）');
ok(ctrlHtml.indexOf('主灯') > -1, '1×1 控制卡：只写名称');
ok(ctrlHtml.indexOf('data-role="statetxt"') === -1, '1×1 控制卡：不写状态词（圆钮颜色就是状态）');
ok(ctrlHtml.indexOf('t-power') === -1, '1×1 控制卡：卡上不再挂第二个电源钮');

/* 8. scene 不应被当成自动化 */
ok(!api.isAuto({ entity: 'scene.movie' }), 'scene 不被当作自动化');

/* 9. 地址/令牌规整：用户随手填的地址不该连不上 */
function norm(u) { return api.normalizeHa(u); }
eq(norm('192.168.1.10:8123'), 'ws://192.168.1.10:8123/api/websocket', '只有 IP:端口 → 自动补 http 与 /api/websocket');
eq(norm('http://ha.local:8123/'), 'ws://ha.local:8123/api/websocket', '多余结尾斜杠被吃掉');
eq(norm('https://ha.example.com'), 'wss://ha.example.com/api/websocket', 'https → wss');
eq(norm('ws://ha:8123/api/websocket'), 'ws://ha:8123/api/websocket', '已经是 WS 端点则原样');
eq(norm('http://ha:8123/api/websocket'), 'ws://ha:8123/api/websocket', '带 /api/websocket 的 http 地址 → ws');
eq(norm('  HA.local:8123  '), 'ws://ha.local:8123/api/websocket', '两侧空白被去掉');
eq(norm('http://ha:8123/ha/'), 'ws://ha:8123/ha/api/websocket', '子路径（反代）保留');
eq(norm(''), '', '空地址 → 空');
eq(api.haHttpBase('ws://ha:8123/api/websocket'), 'http://ha:8123', 'WS 端点 → http 地址（探活/展示用）');
eq(api.haHttpBase('wss://ha.example.com/api/websocket'), 'https://ha.example.com', 'wss → https');
eq(api.normalizeToken('eyJ.abc\n  '), 'eyJ.abc', '令牌里的换行/空白被去掉');

/* 10. 场景条溢出：真实 HA 里 script.* 常有十几条 */
function chips(n) {
  var list = [];
  for (var i = 0; i < n; i++) list.push({ name: '场景' + i, entity: 'script.s' + i, icon: 'play' });
  return list;
}
var c5 = api.sceneChips(chips(5), 6);
eq(c5.visible.length, 5, '5 个场景：全部显示在顶栏');
eq(c5.more.length, 0, '5 个场景：没有「更多」');
var c6 = api.sceneChips(chips(6), 6);
eq(c6.visible.length, 6, '正好 6 个：仍全部显示');
eq(c6.more.length, 0, '正好 6 个：仍没有「更多」');
var c7 = api.sceneChips(chips(7), 6);
eq(c7.visible.length, 5, '7 个：顶栏留 5 个');
eq(c7.more.length, 2, '7 个：剩下 2 个进「更多」');
var c20 = api.sceneChips(chips(20), 6);
eq(c20.visible.length, 5, '20 个：顶栏仍是 5 个');
eq(c20.more.length, 15, '20 个：15 个进「更多」');
eq(c20.visible[0].entity, 'script.s0', '顺序保持不变（按 HA 返回顺序）');

/* 11. 传感器历史曲线：坐标映射是纯函数，离线可测 */
eq(api.historyPoints([], 320, 70, 8).points, '', '空历史：没有坐标');
eq(api.historyPoints([{ t: 1, v: 20 }], 320, 70, 8).points, '', '只有一个点：不画线');
var hp = api.historyPoints([{ t: 0, v: 20 }, { t: 3600, v: 24 }, { t: 7200, v: 22 }], 320, 70, 8);
var coords = hp.points.split(' ');
eq(coords.length, 3, '三个采样：三个坐标点');
eq(hp.min, 20, '取到最低值');
eq(hp.max, 24, '取到最高值');
eq(hp.first, 20, '第一个值');
eq(hp.last, 22, '最后一个值');
eq(hp.n, 3, '点数');
var xs = coords.map(function (c) { return parseFloat(c.split(',')[0]); });
eq(xs[0] < xs[1] && xs[1] < xs[2], true, '横坐标随时间递增');
var ys = coords.map(function (c) { return parseFloat(c.split(',')[1]); });
eq(ys[1] < ys[0] && ys[1] < ys[2], true, '最高值的 y 最小（画在上方）');
var flat = api.historyPoints([{ t: 0, v: 21 }, { t: 10, v: 21 }, { t: 20, v: 21 }], 320, 70, 8);
var fys = flat.points.split(' ').map(function (c) { return parseFloat(c.split(',')[1]); });
eq(fys[0] === fys[1] && fys[1] === fys[2], true, '数值全平时：三个点等高');
eq(fys[0], 35, '数值全平时：画在垂直中间（h/2）');
eq(api.sparkHtml([], '').indexOf('暂无历史数据') >= 0, true, '空数据渲染「暂无历史数据」');
eq(api.sparkHtml([{ t: 0, v: 1 }, { t: 1, v: 2 }], '°C').indexOf('<polyline') >= 0, true, '有数据渲染 polyline');

/* 12. 彩色灯：能力判断 + 颜色换算 */
eq(api.hasColor({ supported_color_modes: ['hs', 'color_temp'] }), true, 'hs 模式算彩色灯');
eq(api.hasColor({ supported_color_modes: ['rgbw'] }), true, 'rgbw 模式算彩色灯');
eq(api.hasColor({ supported_color_modes: ['brightness'] }), false, '只有亮度的灯不算彩色灯');
eq(api.hasColor({ supported_color_modes: ['onoff'] }), false, 'onoff 灯不算彩色灯');
eq(api.hasColor({ rgb_color: [1, 2, 3] }), true, '没有模式字段时按 rgb_color 兜底判断');
eq(api.rgbCss([255, 176, 80]), '255,176,80', 'rgb 转 css 三元组');
eq(api.rgbCss([-5, 300, 10]), '0,255,10', 'rgb 越界会被夹到 0..255');
eq(api.rgbCss(null), '', '没有颜色时返回空串');
eq(api.hsvToRgb(0, 1, 1).join(','), '255,0,0', 'HSV 红');
eq(api.hsvToRgb(120, 1, 1).join(','), '0,255,0', 'HSV 绿');
eq(api.hsvToRgb(240, 1, 1).join(','), '0,0,255', 'HSV 蓝');
eq(api.rgbToHs([255, 0, 0])[0], 0, 'RGB 红 → 色相 0');
eq(api.rgbToHs([0, 0, 255])[0], 240, 'RGB 蓝 → 色相 240');
eq(api.rgbToHs([128, 128, 128])[1], 0, '灰色饱和度为 0');
eq(api.colorPresets.length, 8, '预设 8 个颜色');
eq(api.colorPresets.every(function (c) { return c.rgb.length === 3; }), true, '每个预设都是三元组');

/* 13. 房间可见性：关掉的房间不该出现在顶栏和「全部」里 */
var roomsAll = [{ id: 'living', name: '客厅' }, { id: 'master', name: '主卧' }, { id: 'kid', name: '儿童房' }];
eq(api.visibleRooms(roomsAll, []).length, 3, '没隐藏时三个房间都在');
eq(api.visibleRooms(roomsAll, ['kid']).length, 2, '隐藏一个剩两个');
eq(api.visibleRooms(roomsAll, ['kid'])[1].id, 'master', '顺序保持不变');
eq(api.visibleRooms(roomsAll, ['kid', 'living', 'master']).length, 0, '全隐藏时为空');
eq(api.visibleRooms(roomsAll, ['nope']).length, 3, '隐藏列表里有不存在的 id 不影响');
eq(api.visibleRooms(null, ['x']).length, 0, '房间为空时返回空数组而不是抛错');

/* 14. 面板设置页：每个房间一行开关 */
var sheet = api.panelSheetHtml();
eq(sheet.indexOf('<div class="sheet-title">设置</div>') >= 0, true, '设置页有标题');
eq(sheet.indexOf('客厅') >= 0, true, '设置页列出房间名');
eq(sheet.indexOf('data-act="room-toggle:') >= 0, true, '每行带 room-toggle 动作');
eq(sheet.indexOf('显示中') >= 0, true, '默认状态是「显示中」');
eq(sheet.indexOf('恢复默认') >= 0, true, '带「恢复默认」按钮');

/* 15. 首次引导：三步说明 + 两个出口 */
var g = api.guideSheetHtml();
eq(g.indexOf('Home Assistant') >= 0, true, '引导页提到 Home Assistant');
eq(g.indexOf('长期访问令牌') >= 0, true, '第一步讲令牌');
eq(g.indexOf('192.168.1.10:8123') >= 0, true, '第二步给出地址示例');
eq(g.indexOf('data-act="guide-config"') >= 0, true, '带「填地址和令牌」按钮');
eq(g.indexOf('data-act="guide-demo"') >= 0, true, '带「先看模拟数据」出口');

/* 16. 摄像头：快照地址、状态文案、弹层结构 */
var camUrl = api.camSrc('camera.living_cam', { entity_picture: '/api/camera_proxy/camera.living_cam?token=t' });
eq(camUrl.indexOf('/api/camera_proxy/camera.living_cam') >= 0, true, '有 entity_picture 时用它拼快照地址');
var camUrl2 = api.camSrc('camera.x', {});
eq(camUrl2.indexOf('/api/camera_proxy/') >= 0 && camUrl2.indexOf('token=') > 0, true, '没有 entity_picture 时退化到 camera_proxy + 令牌');
eq(api.camStateText('idle'), '待机', 'idle → 待机');
eq(api.camStateText('streaming'), '传输中', 'streaming → 传输中');
eq(api.camStateText('unavailable'), '离线', 'unavailable → 离线');
eq(api.camStateText('weird'), '待机', '未知状态兜底待机');
api.setReal(true);
var camOk = api.cameraSheet({ entity: 'camera.living_cam' }, 'camera.living_cam', 'idle', { entity_picture: '/x.jpg' });
eq(camOk.indexOf('cam-big') >= 0, true, '有画面时弹层放大图');
eq(camOk.indexOf('cam-refresh') >= 0, true, '弹层带刷新按钮');
var camNa = api.cameraSheet({ entity: 'camera.off' }, 'camera.off', 'unavailable', {});
eq(camNa.indexOf('摄像头没有画面') >= 0, true, '离线摄像头明确说没有画面');
eq(camNa.indexOf('cam-big') < 0, true, '离线时不放大图');

/* 17. 摄像头实时画面（MJPEG）：配置优先、弹层标记与按钮 */
api.setReal(false);
eq(api.camLiveUrl('camera.none'), '', '没配置实时源时返回空');
api.cfgRef.camStream = { 'camera.mock_cam': '/mockcam/stream.mjpeg' };
eq(api.camLiveUrl('camera.mock_cam'), '/mockcam/stream.mjpeg', 'camStream 里的地址生效');
eq(api.camLiveUrl('camera.other'), '', '没配的实体仍走快照');
api.setReal(true);
api.setStates({ 'camera.mock_cam': { entity_id: 'camera.mock_cam', state: 'idle', attributes: {} } });
var camLive = api.cameraSheet({ entity: 'camera.mock_cam' }, 'camera.mock_cam', 'idle', {});
eq(camLive.indexOf('cam-live') >= 0, true, '有实时源时大图带 cam-live 类');
eq(camLive.indexOf('/mockcam/stream.mjpeg') >= 0, true, '大图直接用实时流地址');
eq(camLive.indexOf('实时 · MJPEG') >= 0, true, '带「实时 · MJPEG」徽标');
eq(camLive.indexOf('重连画面') >= 0, true, '实时模式的按钮是「重连画面」');
api.cfgRef.camStream = {};
api.setReal(false);

/* 18. 名称清洗与自定义显示名 */
eq(api.displayName({ name: '灯', dev: '鱼缸', entity: 'light.a' }), '鱼缸灯', 'displayName 通用名补设备前缀（灯）');
eq(api.displayName({ name: '插座', dev: 'Channel 1', entity: 'switch.b' }), 'Channel 1 插座', 'displayName 通用名补设备前缀（插座）');
eq(api.displayName({ name: '龟缸灯 按键3', dev: '鱼缸架四键开关', entity: 'switch.c' }), '龟缸灯 按键3', 'displayName 具体名保持原样');
eq(api.displayName({ name: '', dev: '鱼缸', entity: 'light.d' }), '鱼缸', 'displayName 名为空时用设备名');
eq(api.displayName({ name: '灯', dev: '', entity: 'light.e' }), '灯', 'displayName 无设备名时保持原名');
api.setName('light.a', '鱼缸氛围灯');
eq(api.displayName({ name: '灯', dev: '鱼缸', entity: 'light.a' }), '鱼缸氛围灯', 'displayName 自定义名优先');
api.clearNames();
eq(api.displayName({ name: '灯', dev: '鱼缸', entity: 'light.a' }), '鱼缸灯', 'displayName 恢复默认后回落');
eq(windowStub.Layout.cleanLabel('* 自定义 母婴模式'), '自定义 母婴模式', 'cleanLabel 去前置星号');
eq(windowStub.Layout.cleanLabel('提示音 提示音'), '提示音', 'cleanLabel 折叠重复词');
eq(windowStub.Layout.cleanLabel('光照度传感器 光照度（1-暗；100-亮；不支持其他数值）'), '光照度传感器 光照度', 'cleanLabel 去括号说明');
eq(windowStub.Layout.shortDev('米家智能鱼缸'), '鱼缸', 'shortDev 去米家/智能前缀');
eq(windowStub.Layout.shortDev('REDMI 投影仪 4 Pro'), '投影仪 4', 'shortDev 去品牌与 Pro 后缀');
eq(windowStub.Layout.shortDev('Xiaomi 温度计 Pro'), '温度计', 'shortDev 去品牌与 Pro 后缀');

eq(typeof api.prefs, 'function', '导出 prefs');
eq(api.prefs().cols, 4, '默认每行 4 张');
eq(api.prefs().tap, 'toggle', '默认点一下直接开关');
var setHtml = api.panelSheetHtml();
eq(setHtml.indexOf('每行卡片') >= 0, true, '设置页有「每行卡片」');
eq(setHtml.indexOf('防烧屏位移') >= 0, true, '设置页有「防烧屏位移」');
eq(setHtml.indexOf('恢复默认设置') >= 0, true, '设置页有「恢复默认设置」');
eq(setHtml.indexOf('data-act="pref"') >= 0, true, '设置页按钮带 pref 动作');

/* ---------- 编辑：默认不添加设备 / 每行 3~6 / 顺序稳定 / 卡片跨列 ---------- */
windowStub.localStorage.removeItem('hc.edit');
windowStub.localStorage.removeItem('hc.prefs');
eq(api.prefs().allCards, false, '编辑：默认不自动添加任何设备（allCards=false）');
eq(Object.keys(api.readEdit().added).length, 0, '编辑：默认已添加列表为空');
eq(api.cardVisible('light.living_main'), false, '编辑：默认所有卡片都不可见');
windowStub.localStorage.setItem('hc.edit', JSON.stringify({ added: { 'light.living_main': 1 } }));
api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
eq(api.cardVisible('light.living_main'), true, '编辑：勾选后可见');
eq(api.cardVisible('light.living_strip'), false, '编辑：没勾选仍不可见');

/* 顺序：切列数不影响排序（顺序只存 entities，和列数无关） */
windowStub.localStorage.setItem('hc.edit', JSON.stringify({
  added: { b: 1, a: 1, c: 1 }, order: ['b', 'a', 'c']
}));
api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
function orderOf() { return api.sortCards([{ tile: { entity: 'c', name: 'C' } }, { tile: { entity: 'a', name: 'A' } }, { tile: { entity: 'b', name: 'B' } }]).map(function (x) { return x.tile.entity; }).join(','); }
api.prefs().cols = 3; var o3 = orderOf();
windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 6, size: 'md', allCards: false }));
var o6 = orderOf();
eq(o3, 'b,a,c', '顺序：按自定义顺序排');
eq(o6, o3, '顺序：3 列与 6 列切换后顺序不变');

/* 每行 3~6 */
var colsOpts = (api.panelSheetHtml().match(/data-key="cols"/g) || []).length;
eq(colsOpts, 4, '每行卡片可选 3/4/5/6');

/* 跨列：占 1/2/3 列，且不超过当前列数 */
windowStub.localStorage.setItem('hc.edit', JSON.stringify({ added: { x: 1 }, span: { x: 2 } }));
api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
eq(api.cardSpan('x', 6), 2, '卡片跨列：设置为 2 列');
eq(api.cardSpan('x', 3), 2, '卡片跨列：3 列时仍为 2');
eq(api.cardSpan('no', 6), 1, '卡片跨列：默认 1 列');
var html6 = api.tileHtml({ tile: { type: 'light', entity: 'x', name: 'X', dev: '' }, room: '' });
eq(html6.indexOf('span-2') >= 0, true, '跨列卡片带 span-2 类');

/* 多列样式存在 3~6 */
var css = windowStub.document && windowStub.document.styleSheets ? '' : '';
eq(api.tileHtml({ tile: { type: 'light', entity: 'y', name: 'Y', dev: '' }, room: '' }).indexOf('tile') >= 0, true, 'tileHtml 正常渲染');


/* ---- 卡片百分比进度条（亮度条） ---- */
var bm = api.pctMeta({ type: 'light', entity: 'l1' }, { brightness: 128, supported_color_modes: ['brightness'] });
eq(bm && bm.pct, 50, '百分比条：亮度 128 → 50%');
eq(bm && bm.domain, 'light', '百分比条：写回 light 域');
eq(bm && bm.key, 'brightness_pct', '百分比条：写回 brightness_pct');
eq(api.pctMeta({ type: 'light', entity: 'l2' }, { supported_color_modes: ['onoff'] }), null, '百分比条：onoff 灯不出条');
eq(api.pctMeta({ type: 'switch', entity: 's1' }, { brightness: 80 }), null, '百分比条：开关不出条');
eq(api.pctMeta({ type: 'light', entity: 'l3' }, { brightness: 255 }).pct, 100, '百分比条：满亮度 → 100%');
eq(api.pctMeta({ type: 'light', entity: 'l4' }, { brightness: 5 }).pct, 2, '百分比条：dimmest 值按比例取整（5/255≈2%）');
eq(api.pctMeta({ type: 'light', entity: 'l5' }, { brightness: 0 }).pct, 1, '百分比条：0 亮度也至少显示 1%');

/* 手指横坐标 → 百分比：条从 100px 开始、宽 200px */
eq(api.pctFromX(100, 100, 200), 1, '进度条换算：最左端 → 1%');
eq(api.pctFromX(200, 100, 200), 50, '进度条换算：正中 → 50%');
eq(api.pctFromX(400, 100, 200), 100, '进度条换算：最右端 → 100%');
eq(api.pctFromX(900, 100, 200), 100, '进度条换算：超出右边界钳到 100%');
eq(api.pctFromX(10, 100, 200), 1, '进度条换算：超出左边界钳到 1%（不会变关灯）');
eq(api.pctFromX(200, 100, 0), null, '进度条换算：宽度为 0 时放弃');
eq(api.barHtml().indexOf('data-role="pbar"') >= 0, true, '进度条：骨架带 pbar 标记');
eq(api.barHtml().indexOf('t-knob') >= 0, true, '进度条：骨架带拖动钮');

console.log('');
console.log('=== 住户头像 / 在家-离家 ===');
eq(api.whoState({ state: 'home' }).text, '在家', 'person home → 在家');
eq(api.whoState({ state: 'home' }).home, true, 'person home → 在家标记');
eq(api.whoState({ state: 'not_home' }).text, '离家', 'person not_home → 离家');
eq(api.whoState({ state: 'not_home' }).home, false, 'person not_home → 不在家标记');
eq(api.whoState({ state: '公司' }).text, '公司', '自定义区域名原样显示');
eq(api.whoState({ state: 'unavailable' }).text, '状态未知', 'unavailable → 状态未知');
eq(api.whoState({ state: 'unknown' }).text, '状态未知', 'unknown → 状态未知');
eq(api.whoState(null).text, '状态未知', '空状态 → 状态未知');

eq(api.avatarUrl('data:image/png;base64,AA'), 'data:image/png;base64,AA', '头像：data URI 原样用');
eq(api.avatarUrl('http://ha.local/pic.jpg'), 'http://ha.local/pic.jpg', '头像：绝对地址原样用');
eq(api.avatarUrl(''), '', '头像：没有图返回空');
eq(api.whoInitial({ attributes: { friendly_name: '小明' } }), '小', '头像首字母兜底');
eq(api.whoInitial({ attributes: {} }), '?', '头像没有名字用问号');

api.setStates({
  'person.a': { entity_id: 'person.a', state: 'home', attributes: { friendly_name: 'A', entity_picture: '/api/image/serve/x/64' } },
  'person.b': { entity_id: 'person.b', state: 'not_home', attributes: { friendly_name: 'B' } },
  'light.c': { entity_id: 'light.c', state: 'on', attributes: {} }
});
var pl = api.personList();
eq(pl.length, 2, '只挑 person.*（忽略别的实体）');
eq(pl[0].entity_id, 'person.a', 'person 按 entity_id 排序');
var wh = api.whoHtml(pl);
eq(wh.indexOf('class="who-av home"') >= 0, true, '在家的人环点亮');
eq(wh.indexOf('who-av"') >= 0, true, '离家的人环不亮');
eq(wh.indexOf('title="A · 在家"') >= 0, true, '标题带名字与状态');
eq(wh.indexOf('/api/image/serve/x/64') >= 0, true, '相对头像路径用在 HTML 里');
eq(wh.indexOf('<b>A</b>') >= 0, true, '头像首字母在 DOM 里兜底');

api.setStates({ 'person.a': { entity_id: 'person.a', state: 'home', attributes: {} } });
eq(api.personList().length, 1, 'states 变更后重新挑人');

console.log('');
if (failed === 0) {
  console.log('ALL PASS (' + passed + ' checks)');
  process.exit(0);
} else {
  console.log(failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
