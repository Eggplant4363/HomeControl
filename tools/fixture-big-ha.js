/* 压力测试用「真实模式」样例后端：8 个房间、每间 10 个实体、6 个场景。
   用途：验证房间 tab 溢出时能横向滑动、实体多的房间能纵向滚动。
   由 tools\make-big-fixture.ps1 注入到 build\panel-big\js\fixture-ha.js。 */
(function () {
  'use strict';

  /* 地址栏带 ?rooms=N 可以放大规模：默认 8 房，N=30 就是 300 个实体 */
  var _rm = /[?&]rooms=(\d+)/.exec((window.location && window.location.search) || '');
  var ROOM_COUNT = _rm ? Math.max(1, Math.min(60, parseInt(_rm[1], 10) || 8)) : 8;
  var EXTRA_NAMES = ['工作间', '儿童房', '衣帽间', '储物间', '影音室', '健身房', '客房', '玄关', '车库', '书房二', '琴房', '茶室', '书房三', '露台', '洗衣房', '游戏室', '手工间', '影音二', '健身二', '客卧二', '书库', '花房'];

  var AREAS_BASE = [
    { area_id: 'living', name: '客厅' },
    { area_id: 'master', name: '主卧' },
    { area_id: 'second', name: '次卧' },
    { area_id: 'study', name: '书房' },
    { area_id: 'kitchen', name: '厨房' },
    { area_id: 'bath', name: '卫生间' },
    { area_id: 'balcony', name: '阳台' },
    { area_id: 'hall', name: '走廊' }
  ];

  var AREAS = AREAS_BASE.slice();
  for (var ei = 0; ei < ROOM_COUNT - AREAS_BASE.length; ei++) {
    var nm = EXTRA_NAMES[ei % EXTRA_NAMES.length] + (ei >= EXTRA_NAMES.length ? (' ' + (ei - EXTRA_NAMES.length + 2)) : '');
    AREAS.push({ area_id: 'room' + (ei + 1), name: nm });
  }
  AREAS = AREAS.slice(0, ROOM_COUNT);

  var KINDS = ['light', 'switch', 'cover', 'climate', 'sensor'];

  var entSeq = 0;
  var entities = [];
  var states = {};

  function addState(id, state, attrs) {
    states[id] = {
      entity_id: id,
      state: state,
      attributes: attrs || {},
      last_changed: new Date().toISOString()
    };
  }

  AREAS.forEach(function (area, ai) {
    for (var i = 0; i < 10; i++) {
      entSeq++;
      var kind = KINDS[i % KINDS.length];
      var areaName = area.name;
      var id = '';
      if (kind === 'light') {
        id = 'light.' + area.area_id + '_lamp' + i;
        addState(id, i % 3 === 0 ? 'on' : 'off', {
          friendly_name: areaName + '灯' + i,
          brightness: 200,
          supported_color_modes: (i % 2 ? ['brightness'] : ['brightness', 'color_temp']),
          color_mode: 'brightness'
        });
      } else if (kind === 'switch') {
        id = 'switch.' + area.area_id + '_plug' + i;
        addState(id, i % 2 ? 'on' : 'off', { friendly_name: areaName + '插座' + i, power: 40 + i });
      } else if (kind === 'cover') {
        id = 'cover.' + area.area_id + '_curtain' + i;
        addState(id, i % 2 ? 'open' : 'closed', {
          friendly_name: areaName + '窗帘' + i,
          current_position: i % 2 ? 60 : 0,
          supported_features: 15
        });
      } else if (kind === 'climate') {
        id = 'climate.' + area.area_id + '_ac' + i;
        addState(id, i % 2 ? 'heat' : 'off', {
          friendly_name: areaName + '空调' + i,
          temperature: 24,
          current_temperature: 22 + (ai % 3),
          hvac_modes: ['off', 'cool', 'heat', 'auto'],
          fan_modes: ['auto', 'low', 'high'],
          fan_mode: 'auto',
          target_temp_step: 0.5
        });
      } else {
        id = 'sensor.' + area.area_id + '_t' + i;
        addState(id, String(20 + (ai % 4) + i / 10), {
          friendly_name: areaName + '温度' + i,
          device_class: 'temperature',
          unit_of_measurement: '°C'
        });
      }
      entities.push({
        entity_id: id,
        area_id: area.area_id,
        device_id: null,
        name: null,
        original_name: null,
        hidden_by: null,
        disabled_by: null,
        entity_category: null
      });
    }
  });

  var devices = [];
  var scenes = [];
  for (var s = 1; s <= 12; s++) {
    var sid = 'scene.preset_' + s;
    addState(sid, 'scening', { friendly_name: '场景 ' + s });
    entities.push({
      entity_id: sid, area_id: null, device_id: null, name: '场景 ' + s,
      original_name: null, hidden_by: null, disabled_by: null, entity_category: null
    });
    scenes.push(sid);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function BigBackend(opts) {
    this.opts = opts || {};
    this.stateCb = null;
    this.statusCb = null;
    this.timer = null;
    this.states = clone(states);
  }

  BigBackend.prototype.onStates = function (fn) { this.stateCb = fn; };
  BigBackend.prototype.onStatus = function (fn) { this.statusCb = fn; };

  BigBackend.prototype.emit = function () {
    if (this.stateCb) this.stateCb(clone(this.states));
  };

  BigBackend.prototype.start = function () {
    var self = this;
    if (this.statusCb) this.statusCb({ connected: true, text: '已连接（压力样例 ' + Object.keys(states).length + ' 实体 / ' + ROOM_COUNT + ' 房间）' });
    this.emit();
    /* 每 6 秒动一下传感器，模拟真实推送 */
    this.timer = setInterval(function () {
      Object.keys(self.states).forEach(function (id) {
        if (id.indexOf('sensor.') === 0) {
          var v = parseFloat(self.states[id].state) + (Math.random() - 0.5) * 0.3;
          self.states[id].state = v.toFixed(1);
        }
      });
      self.emit();
    }, 6000);
  };

  BigBackend.prototype.stop = function () {
    clearInterval(this.timer);
    this.timer = null;
  };

  BigBackend.prototype.requestCmd = function (msg) {
    if (msg.type === 'config/area_registry/list') return Promise.resolve(clone(AREAS));
    if (msg.type === 'config/device_registry/list') return Promise.resolve(clone(devices));
    if (msg.type === 'config/entity_registry/list') return Promise.resolve(clone(entities));
    return Promise.reject(new Error('unsupported ' + msg.type));
  };

  BigBackend.prototype.call = function (domain, service, data) {
    var self = this;
    data = data || {};
    var id = data.entity_id;
    var st = id && this.states[id];
    if (st) {
      if (service === 'toggle') st.state = st.state === 'on' ? 'off' : 'on';
      else if (service === 'turn_on') st.state = 'on';
      else if (service === 'turn_off') st.state = 'off';
      else if (service === 'open_cover') st.state = 'open';
      else if (service === 'close_cover') st.state = 'closed';
      else if (service === 'set_temperature' && data.temperature != null) {
        st.attributes.temperature = data.temperature;
        st.state = 'heat';
      } else if (service === 'set_hvac_mode' && data.hvac_mode) st.state = data.hvac_mode;
      if (st.attributes.brightness != null && service === 'turn_on' && data.brightness_pct != null) {
        st.attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
      }
    }
    setTimeout(function () { self.emit(); }, 60);
    return Promise.resolve({ context: { id: 'big' } });
  };

  window.HABackend = BigBackend;
})();
