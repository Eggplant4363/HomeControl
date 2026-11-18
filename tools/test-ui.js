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
load('panel/js/update.js');
load('panel/js/mqtt.js');
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

/* 「显示全部设备」下也要能移除：hidden 与 added 各管一半 */
windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 4, size: 'md', allCards: true }));
windowStub.localStorage.setItem('hc.edit', JSON.stringify({ added: {}, hidden: { 'light.living_main': 1 } }));
api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
eq(api.prefs().allCards, true, '全部设备模式：allCards=true');
eq(api.cardVisible('light.living_main'), false, '全部设备模式：hidden 里的卡片不可见');
eq(api.cardVisible('light.living_strip'), true, '全部设备模式：没被 hidden 的仍可见');
eq(api.readEdit().hidden['light.living_main'], 1, 'hidden 会被读回来');

api.setCardVisible('light.living_strip', false);
eq(api.cardVisible('light.living_strip'), false, 'setCardVisible(false) 把卡隐藏');
eq(api.readEdit().hidden['light.living_strip'], 1, 'setCardVisible(false) 写进 hidden');
eq(api.readEdit().added['light.living_strip'], undefined, 'setCardVisible(false) 不留在 added');

api.setCardVisible('light.living_strip', true);
eq(api.cardVisible('light.living_strip'), true, 'setCardVisible(true) 把卡放回来');
eq(api.readEdit().hidden['light.living_strip'], undefined, 'setCardVisible(true) 清掉 hidden');

/* 手动添加模式（allCards=false）移除照旧：只删 added */
windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 4, size: 'md', allCards: false }));
windowStub.localStorage.setItem('hc.edit', JSON.stringify({ added: { 'light.living_main': 1, 'light.living_strip': 1 } }));
api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
api.setCardVisible('light.living_main', false);
eq(api.cardVisible('light.living_main'), false, '手动模式：移除后不可见');
eq(Object.keys(api.readEdit().added).length, 1, '手动模式：只删 added 一项');

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

/* 拖放换位置：纯函数 orderForDrop(order, 拖的, 目标, 目标之后?) —— 只挪这一项 */
eq(api.orderForDrop(['a', 'b', 'c'], 'a', 'c', false).join(','), 'b,a,c', '拖放：a 插到 c 前面');
eq(api.orderForDrop(['a', 'b', 'c'], 'a', 'c', true).join(','), 'b,c,a', '拖放：a 插到 c 后面');
eq(api.orderForDrop(['a', 'b', 'c'], 'c', 'a', false).join(','), 'c,a,b', '拖放：c 插到 a 前面');
eq(api.orderForDrop(['a', 'b', 'c'], 'b', 'a', true).join(','), 'a,b,c', '拖放：本来就在那，顺序不变');
eq(api.orderForDrop(['a', 'b', 'c'], 'b', 'b', false).join(','), 'a,b,c', '拖放：拖到自己是空操作');
eq(api.orderForDrop(['a', 'b', 'c'], 'a', 'zz', false).join(','), 'a,b,c', '拖放：目标不在顺序里就原样返回');
eq(api.orderForDrop(['a', 'b', 'c'], 'zz', 'a', false).join(','), 'zz,a,b,c', '拖放：顺序里没有的项也能插进去');
eq(api.orderForDrop(['a', 'b', 'c'], '', 'a', false).join(','), 'a,b,c', '拖放：没给实体就原样返回');
eq(api.orderForDrop(['a', 'b', 'c'], 'a', 'c', false).length, 3, '拖放：不会多出/丢掉一项');
eq(api.orderForDrop(['a'], 'a', 'a', true).join(','), 'a', '拖放：只有一张卡时保持原样');
/* 跨房间：order 是全局的，只动被拖的那一项，别的房间的排列不受影响 */
eq(api.orderForDrop(['r1a', 'r2a', 'r1b'], 'r1a', 'r1b', true).join(','), 'r2a,r1b,r1a', '拖放：跨房间条目位置保持');

/* 每行 3~6 */
var colsOpts = (api.panelSheetHtml().match(/data-key="cols"/g) || []).length;
eq(colsOpts, 4, '每行卡片可选 3/4/5/6');

/* 添加卡片：按设备分组（dev_id 相同的实体归一台设备；无设备的归「其它设备」） */
(function () {
  var cfg = api.cfgRef;
  var savedRooms = cfg.rooms;
  var savedPrefs = windowStub.localStorage.getItem('hc.prefs');
  windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 4, size: 'md', allCards: false }));
  api.setReal(false);
  cfg.rooms = [
    { id: 'r1', name: '客厅', tiles: [
      { type: 'light', entity: 'light.a', name: 'A 灯', dev: '吸顶灯', dev_id: 'dev1' },
      { type: 'light', entity: 'light.b', name: 'B 灯', dev: '吸顶灯', dev_id: 'dev1' },
      { type: 'sensor', entity: 'sensor.t', name: '温度', dev: '温湿度计', dev_id: 'dev2' }
    ] },
    { id: 'r2', name: '主卧', tiles: [
      { type: 'switch', entity: 'switch.c', name: 'C 开关', dev: '插座', dev_id: 'dev3' },
      { type: 'scene', entity: 'scene.night', name: '睡觉', dev: '', dev_id: '' }
    ] }
  ];
  var html = api.addSheetHtml();
  eq(html.indexOf('ed-dev') >= 0, true, '添加面板：有设备分组头');
  eq(html.indexOf('data-act="add-device:dev1"') >= 0, true, '添加面板：dev1 设备头在列');
  eq(html.indexOf('data-act="add-device:dev3"') >= 0, true, '添加面板：dev3 设备头在列');
  eq(html.indexOf('data-act="add-device:__none__"') >= 0, true, '添加面板：无设备实体归「其它设备」');
  eq(html.indexOf('ed-row ed-sub') >= 0, true, '添加面板：实体行带 ed-sub 缩进');
  eq(html.indexOf('data-act="add-toggle:light.a"') >= 0, true, '添加面板：单条实体仍可 add-toggle');
  /* 整组切换的收集逻辑 + 翻转 */
  windowStub.localStorage.setItem('hc.edit', JSON.stringify({ added: {}, order: [] }));
  api.writeEdit(JSON.parse(windowStub.localStorage.getItem('hc.edit')));
  var devEnts = api.deviceEntities('dev1').slice().sort();
  eq(devEnts.join(','), 'light.a,light.b', '设备分组：dev1 收集到两个灯');
  eq(api.deviceEntities('__none__').join(','), 'scene.night', '设备分组：无设备实体归「其它设备」');
  eq(api.cardVisible('light.a'), false, '设备分组：整组加入前 A 灯不可见');
  var allOn = devEnts.every(function (e) { return api.cardVisible(e); });
  devEnts.forEach(function (e) { api.setCardVisible(e, !allOn); });
  eq(api.cardVisible('light.a'), true, '设备分组：整组加入后 A 灯可见');
  eq(api.cardVisible('light.b'), true, '设备分组：整组加入后 B 灯可见');
  eq(api.cardVisible('sensor.t'), false, '设备分组：别组实体不受影响');
  cfg.rooms = savedRooms;
  if (savedPrefs == null) windowStub.localStorage.removeItem('hc.prefs'); else windowStub.localStorage.setItem('hc.prefs', savedPrefs);
})();

/* 添加卡片弹层中途重画/翻勾不能动滚动（用户投诉：点下面的设备，列表「自己跳回顶部」没法连着挑） */
(function () {
  var cfg = api.cfgRef;
  var savedRooms = cfg.rooms;
  var savedPrefs = windowStub.localStorage.getItem('hc.prefs');
  var savedEdit = windowStub.localStorage.getItem('hc.edit');
  windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 4, size: 'md', allCards: false }));
  api.setReal(false);
  cfg.rooms = [{ id: 'r1', name: '客厅', tiles: [
    { type: 'light', entity: 'light.a', name: 'A 灯', dev: '吸顶灯', dev_id: 'dev1' }
  ] }];
  var listStub = { scrollTop: 80 };
  var innerStub = {
    scrollTop: 300, innerHTML: '',
    querySelector: function (sel) { return sel === '.ed-list' ? listStub : null; },
    querySelectorAll: function () { return []; }
  };
  api.els.sheetInner = innerStub;
  api.refreshSheet('<div class="ed-list">x</div>');
  eq(innerStub.scrollTop, 300, '弹层中途重画：外层滚动不丢');
  eq(listStub.scrollTop, 80, '弹层中途重画：.ed-list 滚动不丢（不再跳回顶部）');
  /* 勾选状态就地翻勾：不重建行、滚动不动（editState 有缓存，必须走 writeEdit 不能只写 localStorage） */
  api.writeEdit({ added: {}, hidden: {}, order: [], span: {}, rows: {} });
  var boxA = { innerHTML: '' };
  var rowA = { className: 'ed-row ed-sub', getAttribute: function () { return 'add-toggle:light.a'; }, querySelector: function () { return boxA; } };
  var dboxA = { innerHTML: '' };
  var devA = { className: 'ed-dev', getAttribute: function () { return 'add-device:dev1'; }, querySelector: function () { return dboxA; } };
  innerStub.querySelectorAll = function (sel) {
    return sel === '.ed-row' ? [rowA] : sel === '.ed-dev' ? [devA] : [];
  };
  innerStub.scrollTop = 250;
  api.refreshAddRows();
  eq(rowA.className, 'ed-row ed-sub', '就地翻勾：没加入的行不带 on');
  eq(boxA.innerHTML, '', '就地翻勾：勾空着');
  api.setCardVisible('light.a', true);
  api.refreshAddRows();
  eq(rowA.className, 'ed-row ed-sub on', '就地翻勾：加入后行带上 on');
  eq(boxA.innerHTML, '✓', '就地翻勾：行里出现 ✓');
  eq(devA.className, 'ed-dev on', '就地翻勾：整组都加入 → 设备头带上 on');
  eq(dboxA.innerHTML, '✓', '就地翻勾：设备头出现 ✓');
  eq(innerStub.scrollTop, 250, '就地翻勾：滚动一动没动');
  api.setCardVisible('light.a', false);
  api.refreshAddRows();
  eq(rowA.className, 'ed-row ed-sub', '就地翻勾：移除后 on 掉');
  eq(boxA.innerHTML, '', '就地翻勾：✓ 掉');
  eq(devA.className, 'ed-dev', '就地翻勾：设备头 on 掉');
  delete api.els.sheetInner;
  cfg.rooms = savedRooms;
  if (savedPrefs == null) windowStub.localStorage.removeItem('hc.prefs'); else windowStub.localStorage.setItem('hc.prefs', savedPrefs);
  if (savedEdit == null) windowStub.localStorage.removeItem('hc.edit'); else windowStub.localStorage.setItem('hc.edit', savedEdit);
})();

/* ---- 字号角色档：同屏同角色一个字号（type scale），文字不按卡片现场算 ---- */
(function () {
  var tok = {};
  var node = {
    style: {
      setProperty: function (k, v) { tok[k] = v; },
      gridTemplateColumns: '', gridAutoFlow: '', gridAutoRows: '', gridTemplateRows: ''
    },
    setAttribute: function () {}
  };
  var savedPrefs = windowStub.localStorage.getItem('hc.prefs');
  /* 桩里没 innerWidth → 走 (1024)-48=976 兜底：4 列 md 的卡 235px */
  windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 4, size: 'md', allCards: false }));
  api.setColumns(node, 4);
  eq(tok['--fsz'], '207px', '角色档：4 列 md 几何档 fsz=207');
  eq(tok['--fsz-t'], '101px', '角色档：4 列 md 几何档 fsz-t=101');
  eq(tok['--fsz-n'], '18px', '角色档：名字档 18px（宽卡/小卡/半高卡通用）');
  eq(tok['--fsz-v'], '38px', '角色档：数值档 38px（全模板共用）');
  eq(tok['--fsz-s'], '14px', '角色档：辅助档 14px');
  /* 6 列 sm = 下限标定点：正好等于改之前的写死值 15/34/12，字不会比旧版小 */
  windowStub.localStorage.setItem('hc.prefs', JSON.stringify({ cols: 6, size: 'sm', allCards: false }));
  api.setColumns(node, 6);
  eq(tok['--fsz'], '174px', '角色档：6 列 sm 几何档钳到下限 174');
  eq(tok['--fsz-n'], '15px', '角色档：6 列 sm 名字=15px（旧写死值）');
  eq(tok['--fsz-v'], '34px', '角色档：6 列 sm 数值=34px（旧写死值）');
  eq(tok['--fsz-s'], '12px', '角色档：6 列 sm 辅助=12px（旧写死值）');
  /* 字号升序：读数 > 名字 > 辅助，同屏只有一个这套阶梯（2×2 Display 除外） */
  ok(parseInt(tok['--fsz-v'], 10) > parseInt(tok['--fsz-n'], 10) && parseInt(tok['--fsz-n'], 10) > parseInt(tok['--fsz-s'], 10),
     '角色档：数值 > 名字 > 辅助 阶梯成立');
  if (savedPrefs == null) windowStub.localStorage.removeItem('hc.prefs'); else windowStub.localStorage.setItem('hc.prefs', savedPrefs);
})();

/* CSS 字号体检：除 2×2 Display 档外，字号不许再按卡片比例现场算 */
(function () {
  var css = fs.readFileSync(path.join(root, 'panel', 'css', 'app.css'), 'utf8');
  eq(css.indexOf('font-size: var(--fsz-n)') >= 0, true, 'CSS：名称（.t-name/.t-line/.t-hname）走 var(--fsz-n)');
  eq(css.indexOf('font-size: var(--fsz-v)') >= 0, true, 'CSS：数值（.t-val/.t-big）走 var(--fsz-v)');
  eq(css.indexOf('font-size: var(--fsz-s)') >= 0, true, 'CSS：辅助行（.t-sub/.t-set/.t-hval/.u）走 var(--fsz-s)');
  eq((css.match(/font-size: calc\(var\(--fsz\)/g) || []).length, 1, 'CSS：按卡片比例的字号只剩 2×2 Display 档一条');
  eq(css.indexOf('font-size: calc(var(--fsz) * .31)') >= 0, true, 'CSS：Display 档保留（2×2 气候数值）');
  eq(css.indexOf('font-size: calc(var(--fsz-t)') >= 0, false, 'CSS：小卡/半高卡不再按 --fsz-t 定字号');
  ['.229', '.194', '.275', '.135', '.152', '.146', '.145', '.126'].forEach(function (r) {
    eq(css.indexOf('font-size: calc(var(--fsz) * ' + r) >= 0, false, 'CSS：旧比例 ' + r + ' 的字号已删');
    eq(css.indexOf('font-size: calc(var(--fsz-t) * ' + r) >= 0, false, 'CSS：旧 --fsz-t 比例 ' + r + ' 的字号已删');
  });
})();

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

/* ---------- 编辑态批量选择 ---------- */
eq(api.bulk().on, false, '批量选择：默认关着');
eq(api.bulkCount(), 0, '批量选择：默认一张都没勾');
eq(typeof api.toggleBulk, 'function', '导出 toggleBulk');
eq(typeof api.doBulk, 'function', '导出 doBulk');

console.log('');
console.log('== 半高卡（1×½） ==');
var halfTile = { entity: 'light.living_main', type: 'light', name: '主灯' };
api.writeEdit({ added: {}, hidden: {}, order: [], span: {}, rows: {} });
eq(api.cellRows({ entity: 'light.x', type: 'light' }), 1, '灯默认占一行');
eq(api.cellRows({ entity: 'camera.x', type: 'camera' }), 2, '摄像头默认占两行');
api.writeEdit({ added: {}, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 0.5 } });
eq(api.cellRows(halfTile), 0.5, 'rows 存 0.5 → 半高');
/* 只有三档：乱存 0.8 / 1.4 / 9 都要被收回到 0.5 / 1 / 2 */
api.writeEdit({ added: {}, hidden: {}, order: [], span: {}, rows: { 'light.living_main': 0.8 } });
eq(api.cellRows(halfTile), 1, '0.8 收回成 1 行');
api.writeEdit({ added: {}, hidden: {}, order: [], span: {}, rows: { 'light.living_main': 1.4 } });
eq(api.cellRows(halfTile), 1, '1.4 收回成 1 行');
api.writeEdit({ added: {}, hidden: {}, order: [], span: {}, rows: { 'light.living_main': 9 } });
eq(api.cellRows(halfTile), 2, '9 收回成 2 行');

api.writeEdit({ added: { 'light.living_main': 1 }, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 0.5 } });
var halfHtml = api.tileHtml({ tile: halfTile, item: {} });
eq(halfHtml.indexOf(' half') >= 0, true, '半高卡带 half 类');
eq(halfHtml.indexOf('t-mini') >= 0, true, '半高卡有迷你图标');
eq(halfHtml.indexOf('t-hname') >= 0, true, '半高卡有名称');
eq(halfHtml.indexOf('t-hval') >= 0, true, '半高卡读数位始终在（后面能补数值）');
eq(halfHtml.indexOf('t-hval muted') >= 0, true, '没有状态时读数是压暗的破折号');

/* 编辑态不再显示尺寸标（用户：「编辑模式下不用显示它的大小是一叉还是半高」）：
   卡上不再出现 t-size；已加入的卡连工具条都不挂，没加入的卡仍保留「+ 添加」 */
api.setEditMode(true);
var editAdded = api.tileHtml({ tile: halfTile, item: {} });   // 上面已 added 的半高卡
eq(editAdded.indexOf('t-size') >= 0, false, '编辑态：已加入的卡没有尺寸标');
eq(editAdded.indexOf('t-tools') >= 0, false, '编辑态：已加入的卡不挂工具条');
eq(editAdded.indexOf('t-grip') >= 0, true, '编辑态：已加入的卡仍有拉伸角');
api.writeEdit({ added: {}, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 0.5 } });
var editNot = api.tileHtml({ tile: halfTile, item: {} });     // 没加入的半高卡
eq(editNot.indexOf('t-size') >= 0, false, '编辑态：没加入的卡也没有尺寸标');
eq(editNot.indexOf('t-add') >= 0, true, '编辑态：没加入的卡仍有「+ 添加」按钮');
api.setEditMode(false);
eq(api.tileHtml({ tile: halfTile, item: {} }).indexOf('t-tools') >= 0, false, '非编辑态：没加入的卡不挂工具条');
eq(fs.readFileSync(path.join(root, 'panel', 'css', 'app.css'), 'utf8').indexOf('.t-size') >= 0, false, 'CSS：.t-size 规则全删（注意别拿 t-size 当子串——font-size 里也有）');

/* 读数型（温湿度计）半高卡右边多一个小数值 */
api.setStates({ 'sensor.temp_in': { entity_id: 'sensor.temp_in', state: '21.6', attributes: { unit_of_measurement: '°C', device_class: 'temperature' } } });
api.writeEdit({ added: { 'sensor.temp_in': 1 }, hidden: {}, order: [], span: { 'sensor.temp_in': 1 }, rows: { 'sensor.temp_in': 0.5 } });
var halfRead = api.tileHtml({ tile: { entity: 'sensor.temp_in', type: 'sensor', name: '室温' }, item: {} });
eq(halfRead.indexOf('t-hval') >= 0, true, '读数卡半高时带 hval');
eq(halfRead.indexOf('21.6') >= 0, true, '读数卡半高时带数值');
api.setStates({});

api.writeEdit({ added: { 'light.living_main': 1 }, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 2 } });
var tallHtml = api.tileHtml({ tile: halfTile, item: {} });
eq(tallHtml.indexOf(' half') < 0, true, '普通卡片没有 half 类');

api.writeEdit({ added: {}, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 2 } });
var sizeHtml = api.sizeSheetHtml({ tile: halfTile });
eq(sizeHtml.indexOf('1×½ 半高') >= 0, true, '尺寸弹层有半高档');
eq(sizeHtml.indexOf('card-size-set:1:0.5') >= 0, true, '半高档按钮写 1:0.5');
eq(sizeHtml.indexOf('现在是 1×2') >= 0, true, '当前尺寸文案认双高');
api.writeEdit({ added: {}, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 0.5 } });
api.setStates({});
eq(api.sizeSheetHtml({ tile: halfTile }).indexOf('现在是 1×½') >= 0, true, '当前尺寸文案认半高');

/* 调光半高卡：开着且有亮度时右边显示百分比（和 1×1 的大数字共用 valHtml） */
api.setStates({ 'light.living_main': { entity_id: 'light.living_main', state: 'on', attributes: { brightness: 204, supported_color_modes: ['brightness'] } } });
api.writeEdit({ added: { 'light.living_main': 1 }, hidden: {}, order: [], span: { 'light.living_main': 1 }, rows: { 'light.living_main': 0.5 } });
var halfLit = api.tileHtml({ tile: halfTile, item: {} });
eq(halfLit.indexOf(' half') >= 0, true, '调光卡半高时仍是半高模板');
eq(halfLit.indexOf('80') >= 0 && halfLit.indexOf('%') >= 0, true, '调光半高卡右边显示 80%');
api.setStates({});

/* ---------------- 电池保养：开关挑选与噪音过滤 ---------------- */
console.log('电池保养：开关挑选与噪音过滤');
api.setStates({
  'switch.plug_main': { entity_id: 'switch.plug_main', state: 'on', attributes: { friendly_name: '插线板 开关' } },
  'switch.tu_ya_cha_zuo_socket_1': { entity_id: 'switch.tu_ya_cha_zuo_socket_1', state: 'unavailable', attributes: { friendly_name: '涂鸦插座 插口1' } },
  'switch.cam_mute': { entity_id: 'switch.cam_mute', state: 'off', attributes: { friendly_name: '摄像机 静音' } },
  'switch.kettle_keep_relay': { entity_id: 'switch.kettle_keep_relay', state: 'off', attributes: { friendly_name: '水壶 保温' } },
  'switch.dehum_alarm': { entity_id: 'switch.dehum_alarm', state: 'off', attributes: { friendly_name: '除湿机 提示音' } },
  'switch.pc_children_lock': { entity_id: 'switch.pc_children_lock', state: 'off', attributes: { friendly_name: '台式电脑 童锁' } }
});
eq(api.battSwitchNoise('switch.cam_mute'), true, '英文实体 id（mute）判成噪音');
eq(api.battSwitchNoise('switch.kettle_keep_relay'), true, '英文实体 id（keep_relay）判成噪音');
eq(api.battSwitchNoise('switch.dehum_alarm', '除湿机 提示音'), true, '中文友好名（提示音）判成噪音');
eq(api.battSwitchNoise('switch.pc_children_lock', '台式电脑 童锁'), true, '中文友好名（童锁）判成噪音');
eq(api.battSwitchNoise('switch.plug_main', '插线板 开关'), false, '主电源开关不是噪音');
var bs = api.battSwitchSheetHtml();
eq(bs.indexOf('插线板 开关') >= 0, true, '充电开关列表里有插线板');
eq(bs.indexOf('涂鸦插座 插口1') >= 0, true, '离线插座也列出');
eq(bs.indexOf('· 离线') >= 0, true, '离线开关带「· 离线」标记');
eq(bs.indexOf('摄像机 静音') < 0, true, '功能开关（静音）被藏掉');
eq(bs.indexOf('水壶 保温') < 0, true, '功能开关（保温）被藏掉');
eq(bs.indexOf('除湿机 提示音') < 0, true, '功能开关（提示音）被藏掉');
eq(bs.indexOf('台式电脑 童锁') < 0, true, '功能开关（童锁）被藏掉');
eq(api.battSwitchLabel(), '未选择', '没选开关时显示「未选择」');
api.setStates({});

/* ---------------- 卡片图标自定义：覆盖 + 图标弹层 ---------------- */
console.log('卡片图标：自定义覆盖 + 图标弹层');
api.setStates({ 'light.living_main': { entity_id: 'light.living_main', state: 'on', attributes: {} } });
var icTile = { entity: 'light.living_main', type: 'light', name: '客厅灯', dev: '' };
eq(api.iconFor(icTile), 'bulb', '灯默认是灯泡图标');
api.setIcon('light.living_main', 'moon');
eq(api.iconFor(icTile), 'moon', '自定义图标优先于自动识别');
eq(api.iconsFor()['light.living_main'], 'moon', '自定义图标已持久化到 hc.icons');
var ish = api.iconSheetHtml(icTile);
ok(ish.indexOf('data-act="icon-set:moon"') >= 0, '图标弹层列出 moon');
ok(ish.indexOf('ic-cell sel" data-act="icon-set:moon"') >= 0, '当前图标标成选中');
ok(ish.indexOf('data-act="icon-default"') >= 0, '图标弹层有「恢复默认」');
['ceiling', 'pendant', 'floorlamp', 'desklamp', 'sconce', 'strip', 'string', 'spot'].forEach(function (k) {
  ok(ish.indexOf('data-act="icon-set:' + k + '"') >= 0, '灯的类型里有 ' + k);
});
api.setIcon('light.living_main', '');
eq(api.iconFor(icTile), 'bulb', '清掉自定义后回到自动识别');
api.setStates({});

/* ---------------- 自升级（panel/js/update.js）：版本比较 / 资产挑选 / release 解析 ---------------- */
console.log('自升级：版本比较、APK 挑选、release 解析');
var UP = windowStub.HCUpdate;
ok(!!UP, 'HCUpdate 已挂到 window');
eq(UP.normVer('v0.7.14'), '0.7.14', 'normVer 去掉 v 前缀');
eq(UP.normVer('release-0.7.14\n'), '0.7.14', 'normVer 从杂字符串里取版本');
eq(UP.normVer(''), '', 'normVer 空串');
eq(UP.verCmp('0.7.10', '0.7.9'), 1, '0.7.10 比 0.7.9 新（按数字不比字符串）');
eq(UP.verCmp('0.7', '0.7.0'), 0, '缺段按 0 算：0.7 == 0.7.0');
eq(UP.verCmp('v0.7.12', '0.7.12'), 0, '带 v 也能比');
eq(UP.verCmp('1.0.0', '0.9.9'), 1, '主版本号优先');
eq(UP.verCmp('0.7.12', '0.7.12'), 0, '同版本相等');

var apkPick = UP.pickApk([
  { name: 'app-release.apk', browser_download_url: 'https://x/a.apk', size: 160000 },
  { name: 'app-debug.apk', browser_download_url: 'https://x/b.apk', size: 90000 },
  { name: 'source.zip', browser_download_url: 'https://x/c.zip', size: 999999 }
]);
eq(apkPick.name, 'app-release.apk', 'pickApk 只认 .apk，多个取大的');
eq(UP.pickApk([{ name: 'source.zip', size: 1 }]), null, 'pickApk 没有 APK 返回 null');
eq(UP.pickApk(null), null, 'pickApk 空资产返回 null');

var rel = UP.parseRelease(JSON.stringify({
  tag_name: 'v0.7.14',
  assets: [{ name: 'homecontrol.apk', browser_download_url: 'https://x/h.apk', size: 160000 }]
}));
eq(rel.ver, '0.7.14', 'parseRelease 取 tag 里的版本');
eq(rel.url, 'https://x/h.apk', 'parseRelease 取下载地址');
eq(rel.size, 160000, 'parseRelease 取文件大小');
ok(!!UP.parseRelease('{"message":"Not Found"}').error, 'release 404（message）当成错误');
ok(!!UP.parseRelease('{"tag_name":"v1.0.0","assets":[]}').error, '没有 APK 资产当成错误');
ok(!!UP.parseRelease('not json').error, '不是 JSON 当成错误');
ok(!!UP.parseRelease(JSON.stringify({
  tag_name: 'v1.0.0',
  assets: [{ name: 'h.apk', browser_download_url: 'https://x/h.apk', size: 100 * 1024 * 1024 }]
})).error, '超过 80MB 的包拒收');
eq(UP.mb(160000), '156 KB', 'mb 显示 KB');
eq(UP.mb(1600000), '1.5 MB', 'mb 显示 MB');

ok(UP.state().phase === 'idle', '初始状态是 idle');
UP.reset();
ok(UP.state().phase === 'idle' && UP.state().pct === 0, 'reset 回到 idle/0%');

/* ---------------- 下载通道（update.json）：直连/国内镜像/局域网代理 ---------------- */
console.log('下载通道：镜像前缀改写、代理参数、通道文案');
eq(JSON.stringify(UP.parseChannel('')), JSON.stringify({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '没配置 → 直连');
eq(JSON.stringify(UP.parseChannel('not json')), JSON.stringify({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '坏 JSON → 直连');
var chM = UP.parseChannel('{"channel":"mirror","mirror":"https://gh-proxy.com/"}');
eq(chM.channel, 'mirror', 'mirror 通道保留');
eq(JSON.stringify(UP.parseChannel('{"channel":"mirror","mirror":"no-scheme.com/"}')), JSON.stringify({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '镜像前缀不合法 → 回直连');
eq(JSON.stringify(UP.parseChannel('{"channel":"proxy","proxyHost":"","proxyPort":7890}')), JSON.stringify({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '代理没主机 → 回直连');
eq(UP.normalizePrefix('https://gh-proxy.com'), 'https://gh-proxy.com/', 'normalizePrefix 自动补尾斜杠');
eq(UP.normalizePrefix('https://gh-proxy.com/'), 'https://gh-proxy.com/', '已有尾斜杠不动');
eq(UP.normalizePrefix('gh-proxy.com/'), '', '没 scheme 的前缀不合法');
eq(UP.applyChannel(chM, 'https://github.com/Eggplant4363/HomeControl/releases/download/v0.7.24/homecontrol.apk'),
  'https://gh-proxy.com/https://github.com/Eggplant4363/HomeControl/releases/download/v0.7.24/homecontrol.apk', '镜像：GitHub 下载 URL 加前缀');
eq(UP.applyChannel({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }, 'https://api.github.com/x'), 'https://api.github.com/x', '直连原样');
var chP = UP.parseChannel('{"channel":"proxy","proxyHost":"10.10.1.2","proxyPort":7890}');
eq(UP.applyChannel(chP, 'https://api.github.com/x'), 'https://api.github.com/x', '代理不改 URL（代理在 Java 侧做）');
eq(UP.proxyJson(chP), '{"host":"10.10.1.2","port":7890}', 'proxyJson 给 Java 桥');
eq(UP.proxyJson({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '', '直连不传代理');
eq(UP.channelLabel({ channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 }), '直连 GitHub', '直连文案');
eq(UP.channelLabel(chM), 'gh-proxy.com', '内置镜像用名字');
eq(UP.channelLabel({ channel: 'mirror', mirror: 'https://mine.io/', proxyHost: '', proxyPort: 0 }), '镜像 https://mine.io/', '自定义镜像显示前缀');
eq(UP.channelLabel(chP), '代理 10.10.1.2:7890', '代理文案');
var updHtml = UP.sectionHtml();
ok(updHtml.indexOf('下载通道') >= 0, '升级节有下载通道选择');
ok(updHtml.indexOf('data-act="upd-ch:direct"') >= 0, '直连按钮');
ok(updHtml.indexOf('data-act="upd-ch:mirror:https://gh-proxy.com/"') >= 0, 'gh-proxy.com 按钮');
ok(updHtml.indexOf('ghproxy.net') < 0, 'ghproxy.net 不内置（API 403 实测，会误导）');
ok(updHtml.indexOf('id="updMirror"') >= 0 && updHtml.indexOf('upd-ch-custom') >= 0, '自定义镜像输入+按钮');
ok(updHtml.indexOf('id="updProxyHost"') >= 0 && updHtml.indexOf('upd-ch-proxy') >= 0, '代理输入+按钮');
var appSrcUpd = fs.readFileSync(path.join(root, 'panel', 'js', 'app.js'), 'utf8');
ok(appSrcUpd.indexOf("'upd-ch-custom'") >= 0, 'app.js 处理 upd-ch-custom');
ok(appSrcUpd.indexOf("'upd-ch-proxy'") >= 0, 'app.js 处理 upd-ch-proxy');
ok(appSrcUpd.indexOf('upd-ch:') >= 0, 'app.js 处理内置通道按钮');
var mcSrcUpd = fs.readFileSync(path.join(root, 'app', 'src', 'com', 'homecontrol', 'panel', 'MainActivity.java'), 'utf8');
ok(mcSrcUpd.indexOf('java.net.Proxy') >= 0, 'MainActivity 支持 java.net.Proxy');
ok(mcSrcUpd.indexOf('proxyFromJson') >= 0, 'MainActivity 解析 proxyJson');
ok(mcSrcUpd.indexOf('public void updDownload(final String cbId, final String url, final String fileName, final String proxyJson)') >= 0, 'updDownload 4 参版');
ok(mcSrcUpd.indexOf('public void updNet(final String cbId, final String url, final String headersJson, final String proxyJson)') >= 0, 'updNet 4 参版');
ok(mcSrcUpd.indexOf('public void updNet(final String cbId, final String url, final String headersJson)') >= 0, '旧 3 参 updNet 重载保留（旧面板不炸）');
ok(mcSrcUpd.indexOf('u.openConnection(proxy)') >= 0, 'httpText/updFetch 走代理打开连接');

/* ---------------- MQTT 节点（panel/js/mqtt.js）：主题/命令映射/弹层节 ---------------- */
console.log('MQTT：主题约定、命令映射、弹层节、Java 接线');
var MQ = windowStub.HCMqtt;
ok(!!MQ, 'HCMqtt 已挂到 window');
var tp = MQ.__test.topics('nabu');
eq(tp.cmd, 'homecontrol/nabu/cmd', '命令主题');
eq(tp.avail, 'homecontrol/nabu/availability', '上线/离线主题');
eq(tp.state, 'homecontrol/nabu/state', '状态主题');
eq(tp.disc, 'homeassistant/sensor/homecontrol_panel_nabu_music/config', 'HA discovery 主题（sensor：状态+歌名，必须以 /config 结尾）');
eq((tp.discButtons || []).length, 7, '七个 button discovery 主题（播放/暂停/停止/上一曲/下一曲/音量+/音量-）');
ok((tp.discVolume || '').indexOf('/number/') > 0, '音量 discovery 主题在 number 平台下');
eq((tp.discButtons || [])[0], 'homeassistant/button/homecontrol_panel_nabu_music_play/config', '播放按钮 discovery 主题（/config 结尾）');
eq(MQ.__test.mapCmd('play'), 'play', 'mapCmd play');
eq(MQ.__test.mapCmd('PAUSE'), 'pause', 'mapCmd 大小写不敏感');
eq(MQ.__test.mapCmd('toggle'), 'toggle', 'mapCmd toggle');
eq(MQ.__test.mapCmd('next'), 'next', 'mapCmd next');
eq(MQ.__test.mapCmd('prev'), 'prev', 'mapCmd prev');
eq(MQ.__test.mapCmd('stop'), 'stop', 'mapCmd stop');
eq(MQ.__test.mapCmd('bogus'), null, '未知命令忽略（返回 null）');
eq(MQ.__test.mapCmd(''), null, '空 payload 忽略');
var cj = JSON.parse(MQ.__test.cfgJson({ enabled: true, host: '10.10.1.8', port: 1883, tls: false, user: 'F', pass: 'p', name: 'nabu' }));
eq(cj.enabled, true, 'cfgJson enabled');
eq(cj.host, '10.10.1.8', 'cfgJson host');
eq(cj.port, 1883, 'cfgJson port');
ok(typeof windowStub.__hcMqttCmd === 'function', '__hcMqttCmd 挂上（Java 派发入口）');
var threw = false;
try { windowStub.__hcMqttCmd('homecontrol/nabu/cmd', 'play'); } catch (e) { threw = true; }
eq(threw, false, '没有 MusicUI 时收到命令也不崩（安全退回）');
var mqHtml = MQ.sectionHtml();
ok(mqHtml.indexOf('data-act="mqtt-save"') >= 0, 'MQTT 节有保存按钮');
ok(mqHtml.indexOf('id="mqHost"') >= 0, 'MQTT 节有主机输入框');
ok(mqHtml.indexOf('MQTT 状态') >= 0, 'MQTT 节有状态行');
var mqttSrc = fs.readFileSync(path.join(root, 'panel', 'js', 'mqtt.js'), 'utf8');
ok(mqttSrc.indexOf('function toast') >= 0, 'mqtt.js 自带 toast（app.js/music.js 的是模块作用域，真机踩过 TypeError）');
var idxHtml = fs.readFileSync(path.join(root, 'panel', 'index.html'), 'utf8');
ok(idxHtml.indexOf('js/mqtt.js') >= 0, 'index.html 加载 mqtt.js');
var appSrc = fs.readFileSync(path.join(root, 'panel', 'js', 'app.js'), 'utf8');
ok(appSrc.indexOf('window.HCMqtt') >= 0, 'app.js 弹层渲染 MQTT 节');
ok(appSrc.indexOf("'mqtt-save'") >= 0, 'app.js 处理 mqtt-save 动作');
ok(appSrc.indexOf('selfSlug: selfSlug') >= 0, 'app.js 导出 selfSlug 给 mqtt.js');
var musicSrc = fs.readFileSync(path.join(root, 'panel', 'js', 'music.js'), 'utf8');
ok(musicSrc.indexOf('isPlaying:') >= 0, 'music.js 导出 isPlaying');
var javaSrc = fs.readFileSync(path.join(root, 'app', 'src', 'com', 'homecontrol', 'panel', 'MainActivity.java'), 'utf8');
ok(javaSrc.indexOf('startMqttIfNeeded') >= 0, 'MainActivity 页面就绪后自动起 MQTT');
ok(javaSrc.indexOf('mqttPublish') >= 0 && javaSrc.indexOf('mqttRestart') >= 0 && javaSrc.indexOf('mqttState') >= 0, 'MainActivity 暴露 publish/restart/state 桥方法');
ok(javaSrc.indexOf('__hcMqttCmd') >= 0, 'MainActivity 把命令派发给 JS');
var mqttJava = fs.readFileSync(path.join(root, 'app', 'src', 'com', 'homecontrol', 'panel', 'MqttClient.java'), 'utf8');
ok(mqttJava.indexOf('b.write(5)') >= 0, 'MqttClient 用 MQTT 5 协议级别（用户 broker 只认 v5）');
ok(mqttJava.indexOf('MQTT 5') >= 0, 'MqttClient 注释写明 v5');
ok(mqttJava.indexOf('writePacket(0x10, b.toByteArray())') >= 0, 'CONNECT 固定头用 0x10（这台 EMQX 不认 spec 的 0x20，实测）');
ok(mqttJava.indexOf('0x02 | 0x04') < 0, 'CONNECT 不带 Will Flag（这台 EMQX 拒任何带 will 的 CONNECT）');
ok(mqttJava.indexOf('publish(availTopic(), "online", false)') >= 0, 'availability 非 retain（这台 EMQX 拒 retain 发布，实测 DISCONNECT 129）');
ok(mqttJava.indexOf('publishDiscovery();') >= 0, 'discovery 非 retain（publishDiscovery 内部逐个 publish(..., false)）');
ok(mqttJava.indexOf('_music/config"') >= 0, 'Java discovery 主题以 /config 结尾（漏了 HA 完全忽略）');
ok(mqttJava.indexOf('publishDiscovery();\n    publish(availTopic(), "online", false);') >= 0, '先发 discovery 再发 availability（反了实体停在 unavailable）');
ok(mqttJava.indexOf('"homeassistant/sensor/homecontrol_panel_" + slug + "_music/config"') >= 0, '音乐状态用 sensor 表达（HA 核心没有 mqtt.media_player 平台，实测）');
ok(mqttJava.indexOf('payload_press') >= 0, '播放/暂停/停止用 button + payload_press');
ok(mqttJava.indexOf('\\"default_entity_id\\":\\"sensor.homecontrol_panel_') >= 0, 'sensor 带 default_entity_id（否则中文名会被 HA slug 成长串拼音 id）');
ok(mqttJava.indexOf('\\"default_entity_id\\":\\"button.homecontrol_panel_') >= 0, 'button 带 default_entity_id');
ok(mqttJava.indexOf('homeassistant/media_player/') < 0, '不再发 media_player discovery（HA 核心没有 mqtt.media_player 平台，静默被忽略）');
ok(mqttJava.indexOf('lastDiscoveryAt') >= 0, 'discovery 定期重发（非 retain 时 HA 重启后靠重发）');
ok(mqttJava.indexOf('sub[3] = (byte) ((ct.length >> 8) & 0xFF)') >= 0, 'SUBSCRIBE 报文带 topic 长度前缀（漏了它 broker 回 DISCONNECT 143）');
ok(mqttJava.indexOf('subscribe denied (0x') >= 0, 'SUBACK >=0x80 时降级为只发布状态');
ok(mqttJava.indexOf('int qos = (hb >> 1) & 0x03') >= 0, 'PUBLISH 的 QoS 取固定头 bit1-2（写成 >>3 会吃掉 payload 前两字节）');
ok(mqttJava.indexOf('broker DISCONNECT reason=') >= 0, 'broker 踢线原因码进日志');
ok(fs.readFileSync(path.join(root, 'panel', 'js', 'mqtt.js'), 'utf8').indexOf('connected-no-sub') >= 0, '面板显示降级状态（已连接但订阅被拒）');
const mqttJs = fs.readFileSync(path.join(root, 'panel', 'js', 'mqtt.js'), 'utf8');
const musicJs = fs.readFileSync(path.join(root, 'panel', 'js', 'music.js'), 'utf8');
const updJs = fs.readFileSync(path.join(root, 'panel', 'js', 'update.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'panel', 'js', 'app.js'), 'utf8');
const mainCode = fs.readFileSync(path.join(root, 'app', 'src', 'com', 'homecontrol', 'panel', 'MainActivity.java'), 'utf8');
ok(mqttJs.indexOf('mu.playDefault') >= 0, 'HA 播放按钮走 playDefault（冷启动没选歌时 togglePlay 只弹提示，不出声）');
ok(musicJs.indexOf('playDefault: playDefault') >= 0, 'MusicUI 导出 playDefault');
ok(musicJs.indexOf('stopPlay: stopPlay') >= 0, 'MusicUI 导出 stopPlay');
ok(musicJs.indexOf('volume: function () { return Math.round(S.vol * 100); }') >= 0, 'MusicUI 导出 volume（0-100）');
ok(musicJs.indexOf('prevTrack: prevTrack') >= 0, 'MusicUI 导出 prevTrack（HA 上一曲=上一首）');
ok(mqttJs.indexOf('mu.prevTrack') >= 0, 'HA 的 prev 命令走 prevTrack 而不是交互版 prev');
ok(mqttJs.indexOf('discBattery:') >= 0 && mqttJs.indexOf('_battery/config') >= 0, 'MQTT 发布电量 sensor 的 discovery 主题');
ok(mqttJs.indexOf('function cfgName()') >= 0 && mqttJs.indexOf('var nm = cfgName();') >= 0, 'JS 的 slug 与 Java 一致，优先用 mqtt.json 的 name（否则 state 发到型号主题，HA 永远 unknown）');
ok(mqttJs.indexOf('battery: bt.level') >= 0 && mqttJs.indexOf('charging: bt.charging') >= 0, 'state 载荷带 battery/charging（电量实体取值来源）');
ok(mqttJs.indexOf("p === 'volume_up'") >= 0 && mqttJs.indexOf('VOL_STEP') >= 0, '音量 +/- 按钮命令与步长');
ok(mqttJs.indexOf('_music_volume_up/config') >= 0 && mqttJs.indexOf('_music_volume_down/config') >= 0, '音量按钮的 discovery 主题');
ok(musicJs.indexOf('function prevTrack()') >= 0 && musicJs.indexOf('S.hist.length > 2') >= 0, 'prevTrack 覆盖随机历史与队首回退');
ok(musicJs.indexOf('setVolume: function (pct)') >= 0, 'MusicUI 导出 setVolume');
ok(mqttJs.indexOf('_music_next/config') >= 0 && mqttJs.indexOf('_music_prev/config') >= 0, '面板侧 discovery 主题含上一曲/下一曲');
ok(mqttJava.indexOf('buttonJson("下一曲", "next"') >= 0 && mqttJava.indexOf('buttonJson("上一曲", "prev"') >= 0, 'Java 侧 discovery 含上一曲/下一曲按钮');
ok(mqttJava.indexOf('homeassistant/number/homecontrol_panel_') >= 0 && mqttJava.indexOf('private String numberJson()') >= 0, '音量走 HA number 平台');
ok(mqttJs.indexOf("'volume:' + v") >= 0 && mqttJs.indexOf("m.indexOf('volume:') === 0") >= 0, '纯数字命令按音量处理');
ok(mqttJs.indexOf('volume: vol') >= 0 && mqttJs.indexOf('function pushState()') >= 0, 'state 上报带 volume，命令后立即回报');
ok(updJs.indexOf('updSha256') >= 0 && updJs.indexOf('updApkInfo') >= 0, '升级：下载完先验 sha256 + APK versionCode 再装');
ok(updJs.indexOf('U.digest = r.digest') >= 0, '升级：从 release JSON 取 digest');
ok(updJs.indexOf('下载到的不是新版本') >= 0, '升级：包比当前旧时明确报错而不是照装');
ok(mainCode.indexOf('getPackageArchiveInfo') >= 0 && mainCode.indexOf('String updSha256') >= 0, 'Java 侧提供 updApkInfo/updSha256');
ok(mainCode.indexOf('verCode') >= 0 && mainCode.indexOf('appVersionCode()') >= 0, 'Java info() 暴露 verCode');
ok(mainCode.indexOf('Cache-Control", "no-cache') >= 0, '升级请求带 no-cache，避免代理复用旧 JSON/旧包');
ok(updJs.indexOf('applyChannel(dcfg, U.url)') >= 0 && updJs.indexOf('proxyJson(dcfg)') >= 0, '下载要走通道：镜像加前缀/代理交给 Java（原来只有 check 走通道，下载永远直连）');
ok(updJs.indexOf('upd-retry-mirror') >= 0 && appJs.indexOf('upd-retry-mirror') >= 0, '直连下载超时给「换 gh-proxy.com 重试」出口');
ok(updJs.indexOf('SocketTimeout') >= 0, '超时错误单独识别，给出可操作提示');
ok(mqttJs.indexOf("m === 'stop'") >= 0 && mqttJs.indexOf('mu.stopPlay') >= 0, 'HA 停止按钮走 stopPlay（回未在播放，不是暂停）');
ok(musicJs.indexOf('playTrack(S.lib.items[0], S.lib.items, 0)') >= 0, 'playDefault 冷启动会拉全库并播第一首');

console.log('');
if (failed === 0) {
  console.log('ALL PASS (' + passed + ' checks)');
  process.exit(0);
} else {
  console.log(failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
