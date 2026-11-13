/* 自动布局：从 HA 的 registry（区域 / 设备 / 实体）+ 当前状态，生成房间、卡片与场景键。
   目标环境 Chromium 57：ES5 写法，不用可选链、不用模板字符串以外的现代语法。 */
(function () {
  'use strict';

  var TYPE_ORDER = { camera: 0, light: 1, switch: 2, climate: 3, cover: 4, sensor: 9 };
  /* 每个房间每类最多放几张：真实家里 100+ 开关很常见，若只按总量截断，
     排在后面的灯/传感器会被整段切掉，墙上就只剩开关。 */
  var TYPE_CAP = { camera: 4, light: 24, switch: 24, climate: 12, cover: 12, sensor: 12 };
  /* 米家设备的“指示灯/屏幕亮度”这类实体不是给人操作的功能灯，墙上不该出现 */
  var NOISE_ID = /(_indicator_light|_indicator|_screen_brightness)$/;
  var NOISE_NAME = /指示灯|屏幕亮度|指示燈/;
  var SENSOR_CLASSES = {
    temperature: 1, humidity: 1, motion: 1, occupancy: 1, door: 1, window: 1,
    smoke: 1, gas: 1, moisture: 1, illuminance: 1, co2: 1, carbon_dioxide: 1, pm25: 1, pm10: 1
  };
  var ICON_RULES = [
    [/客厅|living|起居/, 'sofa'], [/主卧|卧室|master|bed/, 'bed'],
    [/书|study|office/, 'desk'], [/厨|kitchen/, 'pot'],
    [/卫|浴|bath|toilet/, 'shower'], [/阳|balcony|laundry/, 'hanger'],
    [/儿童|kids|child/, 'bed'], [/餐|dining/, 'pot'],
    [/走廊|玄关|门厅|hall|entry|走廊/, 'home']
  ];
  var SCENE_ICONS = ['home', 'play', 'moon', 'power', 'star', 'sun', 'scene', 'gear'];

  function typeOf(entityId, attrs) {
    var d = String(entityId).split('.')[0];
    if (d === 'light') return 'light';
    if (d === 'switch' || d === 'fan' || d === 'input_boolean' || d === 'humidifier') return 'switch';
    if (d === 'automation' || d === 'input_switch') return 'switch';
    if (d === 'cover') return 'cover';
    if (d === 'climate') return 'climate';
    if (d === 'camera') return 'camera';
    if (d === 'sensor' || d === 'binary_sensor') return 'sensor';
    if (d === 'media_player') return 'media';
    return null;
  }

  function iconForRoom(name) {
    for (var i = 0; i < ICON_RULES.length; i++) {
      if (ICON_RULES[i][0].test(name)) return ICON_RULES[i][1];
    }
    return 'home';
  }

  /* 名称清洗：米家集成会把 friendly_name / registry name 拼成「设备名  子功能」，
     还会带哈希段、括号说明、重复词、前导星号，直接显示在墙上很难看。 */
  var NAME_HASH = /^(?=.*\d{6})[a-z0-9]{8,}$/i;
  var NAME_GENERIC = /^(灯|灯带|开关|插座|静音|提示音|勿扰|温度|湿度|亮度|状态|模式|按键|左键|右键|中键|一键|二键|三键|四键|开\/关|开\/关机|开关机|接触状态|电量|档位)$/;
  var NAME_EN = { brightness: '亮度', light: '灯', switch: '开关', plug: '插座', temperature: '温度', humidity: '湿度' };

  function cleanLabel(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[（(][^)）]*[)）]/g, ' ');        // 去掉括号说明
    s = s.replace(/^[\s*·]+/, '');                   // 前导星号/点
    s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var parts = s.split(' ').filter(function (w) { return w && !NAME_HASH.test(w); });
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (NAME_EN[parts[i].toLowerCase()]) parts[i] = NAME_EN[parts[i].toLowerCase()];
      if (i && parts[i] === parts[i - 1]) continue;                 // 相邻重复词
      if (out.length && parts[i] === out[out.length - 1]) continue;
      if (out.length && parts[i].indexOf(out[out.length - 1]) === 0) { out[out.length - 1] = parts[i]; continue; }
      out.push(parts[i]);
    }
    // 末尾是通用词、前面还有具体词 → 丢掉通用词
    if (out.length > 1 && NAME_GENERIC.test(out[out.length - 1])) out.pop();
    s = out.join(' ').trim();
    return s;
  }

  /* 设备名去掉品牌前缀/系列后缀，用来在通用名（例如「灯」）前面补上下文 */
  function shortDev(raw) {
    var s = cleanLabel(raw);
    s = s.replace(/^(?:(?:米家|小米|智能|AI智能|小爱|涂鸦|Tuya|Aqara|aqara|Xiaomi|xiaomi|MI|Redmi|REDMI|redmi)\s*)+/i, '');
    s = s.replace(/\s*(智能|Pro|Lite|MESH|Mesh)$/i, '');
    return s.trim();
  }

  function shortName(entityId, st) {
    var attrs = (st && st.attributes) || {};
    var fn = attrs.friendly_name;
    if (fn) return String(fn);
    var part = String(entityId).split('.')[1] || entityId;
    return part;
  }

  function isHidden(rec) {
    if (!rec) return false;
    if (rec.hidden_by) return true;
    if (rec.disabled_by) return true;
    if (rec.entity_category === 'diagnostic' || rec.entity_category === 'config') return true;
    return false;
  }

  /**
   * @param states  entity_id -> state object
   * @param areas   [{area_id,name}]
   * @param devices [{id,area_id,name}]
   * @param entities[{entity_id,area_id,device_id,name,original_name,entity_category,hidden_by,disabled_by}]
   */
  function build(states, areas, devices, entities) {
    var devArea = {}, devName = {}, entArea = {}, entName = {}, entById = {}, areaName = {}, areaIcon = {};
    (devices || []).forEach(function (d) {
      if (!d || !d.id) return;
      devArea[d.id] = d.area_id || null;
      devName[d.id] = shortDev(d.name || d.name_by_user || '');
    });
    (entities || []).forEach(function (e) {
      if (!e || !e.entity_id) return;
      entById[e.entity_id] = e;
      var a = e.area_id || devArea[e.device_id] || null;
      if (a) entArea[e.entity_id] = a;
      if (e.name || e.original_name) entName[e.entity_id] = e.name || e.original_name;
    });
    (areas || []).forEach(function (a) {
      if (!a || !a.area_id) return;
      areaName[a.area_id] = a.name || a.area_id;
      areaIcon[a.area_id] = iconForRoom(a.name || '');
    });

    var rooms = {}, order = [];
    var scenes = [];

    function pushTile(areaId, tile) {
      var key = areaId || '__none__';
      if (!rooms[key]) { rooms[key] = []; order.push(key); }
      rooms[key].push(tile);
    }

    for (var id in states) {
      var st = states[id];
      if (!id) continue;
      var d = String(id).split('.')[0];
      var attrs = (st && st.attributes) || {};

      if (d === 'scene' || d === 'script') {
        if (scenes.length < 24) {
          scenes.push({
            name: shortName(id, st),
            entity: id,
            icon: SCENE_ICONS[scenes.length % SCENE_ICONS.length]
          });
        }
        continue;
      }

      var type = typeOf(id, attrs);
      if (!type) continue;
      if (type === 'media') continue;

      if (type === 'sensor') {
        var dc = attrs.device_class;
        if (!dc || !SENSOR_CLASSES[dc]) continue;
      }

      if ((type === 'light' || type === 'switch') && (NOISE_ID.test(String(id)) || NOISE_NAME.test(shortName(id, st)))) continue;

      var rec = entById[id] || null;
      if (isHidden(rec)) continue;

      var areaId = entArea[id] || null;
      var dev = (rec && rec.device_id && devName[rec.device_id]) || '';
      pushTile(areaId, {
        type: type,
        entity: id,
        name: cleanLabel(entName[id] || shortName(id, st)) || cleanLabel(shortName(id, st)),
        dev: dev,
        _order: TYPE_ORDER[type] == null ? 5 : TYPE_ORDER[type],
        _sub: String(id)
      });
    }

    var out = [];
    order.forEach(function (key) {
      var list = rooms[key];
      list.sort(function (a, b) {
        if (a._order !== b._order) return a._order - b._order;
        return String(a.name).localeCompare(String(b.name));
      });
      var perType = {};
      list = list.filter(function (t) {
        var cap = TYPE_CAP[t.type] == null ? 24 : TYPE_CAP[t.type];
        perType[t.type] = (perType[t.type] || 0) + 1;
        return perType[t.type] <= cap;
      });
      var name = key === '__none__' ? '其他' : (areaName[key] || key);
      out.push({
        id: key === '__none__' ? 'other' : key,
        name: name,
        icon: key === '__none__' ? 'home' : (areaIcon[key] || 'home'),
        tiles: list.map(function (t) { return { type: t.type, entity: t.entity, name: t.name, dev: t.dev || '' }; })
      });
    });

    // 设备多的房间排前面
    out.sort(function (a, b) { return b.tiles.length - a.tiles.length; });

    return { rooms: out, scenes: scenes };
  }

  window.Layout = { build: build, typeOf: typeOf, cleanLabel: cleanLabel, shortDev: shortDev };
})();
