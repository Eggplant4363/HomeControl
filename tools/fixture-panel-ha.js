/* 仅用于设备端「真实模式」离线验收：假装成 HABackend，提供同一套接口，
   数据是 tools/fake-ha.js 里的同一份 fixture（2 个区域 / 11 台设备实体）。
   这样在不具备 设备→PC 网络连通（Windows 防火墙）时可以验证：
   ha.json 读取 → 真实模式 → registry 自动布局 → 场景键 → 卡片交互。 */
(function () {
  'use strict';

  var FIX = {
    states: {
      'light.living_main': { entity_id: 'light.living_main', state: 'on', attributes: { friendly_name: '主灯', brightness: 204 } },
      'light.living_strip': { entity_id: 'light.living_strip', state: 'off', attributes: { friendly_name: '灯带', brightness: 180 } },
      'switch.living_tv': { entity_id: 'switch.living_tv', state: 'on', attributes: { friendly_name: '电视插座', power: 68 } },
      'climate.living_ac': { entity_id: 'climate.living_ac', state: 'heat', attributes: { friendly_name: '空调', temperature: 24, current_temperature: 21.5, hvac_modes: ['off', 'cool', 'heat'], fan_modes: ['auto', 'low'], fan_mode: 'auto' } },
      'cover.living_curtain': { entity_id: 'cover.living_curtain', state: 'open', attributes: { friendly_name: '窗帘', current_position: 60 } },
      'light.study_onoff': { entity_id: 'light.study_onoff', state: 'on', attributes: { friendly_name: '书房小灯', supported_color_modes: ['onoff'] } },
      'cover.study_blind': { entity_id: 'cover.study_blind', state: 'closed', attributes: { friendly_name: '书房百叶', supported_features: 3 } },
      'climate.study_floor': { entity_id: 'climate.study_floor', state: 'heat_cool', attributes: { friendly_name: '书房地暖', temperature: 22, current_temperature: 20.5, target_temp_step: 1, hvac_modes: ['off', 'heat_cool'] } },      'fan.living_fan': { entity_id: 'fan.living_fan', state: 'on', attributes: { friendly_name: '风扇', percentage: 40 } },
      'automation.morning': { entity_id: 'automation.morning', state: 'on', attributes: { friendly_name: '早晨自动开灯' } },
      'sensor.living_temp': { entity_id: 'sensor.living_temp', state: '23.4', attributes: { friendly_name: '温度', device_class: 'temperature', unit_of_measurement: '°C' } },
      'sensor.living_humidity': { entity_id: 'sensor.living_humidity', state: '51', attributes: { friendly_name: '湿度', device_class: 'humidity', unit_of_measurement: '%' } },
      'binary_sensor.living_motion': { entity_id: 'binary_sensor.living_motion', state: 'off', attributes: { friendly_name: '人体感应', device_class: 'motion' } },
      'scene.movie': { entity_id: 'scene.movie', state: 'unknown', attributes: { friendly_name: '观影模式' } },
      'script.all_off': { entity_id: 'script.all_off', state: 'off', attributes: { friendly_name: '全部关闭' } }
    },
    areas: [{ area_id: 'living', name: '客厅' }, { area_id: 'master', name: '主卧' }, { area_id: 'study', name: '书房' }],
    devices: [{ id: 'dev_living', area_id: 'living' }, { id: 'dev_master', area_id: 'master' }, { id: 'dev_study', area_id: 'study' }],
    entities: [
      { entity_id: 'light.living_main', area_id: 'living', name: '主灯' },
      { entity_id: 'light.living_strip', area_id: 'living', name: '灯带' },
      { entity_id: 'switch.living_tv', device_id: 'dev_living' },
      { entity_id: 'climate.living_ac', area_id: 'living' },
      { entity_id: 'cover.living_curtain', area_id: 'living' },
      { entity_id: 'fan.living_fan', area_id: 'living' },
      { entity_id: 'automation.morning', area_id: 'living' },
      { entity_id: 'sensor.living_temp', device_id: 'dev_living' },
      { entity_id: 'sensor.living_humidity', area_id: 'living' },
      { entity_id: 'binary_sensor.living_motion', area_id: 'living' },
      { entity_id: 'scene.movie', area_id: 'living' },
      { entity_id: 'light.study_onoff', area_id: 'study' },
      { entity_id: 'cover.study_blind', area_id: 'study' },
      { entity_id: 'climate.study_floor', area_id: 'study' }
    ]
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function FixtureBackend() {
    this.states = {};
    this.stateCb = null;
    this.statusCb = null;
    this.statesLoaded = false;
    this.ws = { readyState: 1 };
    this.timer = null;
  }

  FixtureBackend.prototype.onStates = function (cb) { this.stateCb = cb; };
  FixtureBackend.prototype.onStatus = function (cb) { this.statusCb = cb; };
  FixtureBackend.prototype.stop = function () { if (this.timer) clearInterval(this.timer); };

  FixtureBackend.prototype.start = function () {
    var self = this;
    if (this.statusCb) this.statusCb({ connected: false, text: '认证中…' });
    setTimeout(function () {
      if (self.statusCb) self.statusCb({ connected: true, text: '已连接（样例数据）' });
      self.states = clone(FIX.states);
      self.statesLoaded = true;
      if (self.stateCb) self.stateCb(clone(self.states));
      /* 每 6 秒轻微漂移一次传感器，验证订阅刷新链路 */
      var demo = 0;
      self.timer = setInterval(function () {
        demo++;
        var t = self.states['sensor.living_temp'];
        if (t) t.state = (23.2 + (demo % 5) * 0.2).toFixed(1);
        if (self.stateCb) self.stateCb(clone(self.states));
      }, 6000);
    }, 400);
  };

  FixtureBackend.prototype.requestCmd = function (msg) {
    return new Promise(function (resolve, reject) {
      if (msg.type === 'config/area_registry/list') return resolve(clone(FIX.areas));
      if (msg.type === 'config/device_registry/list') return resolve(clone(FIX.devices));
      if (msg.type === 'config/entity_registry/list') return resolve(clone(FIX.entities));
      reject(new Error('样例数据不支持 ' + msg.type));
    });
  };

  FixtureBackend.prototype.call = function (domain, service, data) {
    var self = this;
    var id = data && data.entity_id;
    return new Promise(function (resolve) {
      setTimeout(function () {
        var st = id ? self.states[id] : null;
        if (st) {
          if (service === 'toggle' || service === 'homeassistant_toggle') st.state = st.state === 'on' ? 'off' : 'on';
          else if (service === 'turn_on') st.state = 'on';
          else if (service === 'turn_off') st.state = 'off';
          else if (service === 'open_cover') st.state = 'open';
          else if (service === 'close_cover') st.state = 'closed';
          else if (service === 'set_cover_position' && data.position != null) st.attributes.current_position = data.position;
          else if (service === 'set_temperature' && data.temperature != null) st.attributes.temperature = data.temperature;
          else if (service === 'set_hvac_mode' && data.hvac_mode) st.state = data.hvac_mode;
          else if (service === 'set_fan_mode' && data.fan_mode) st.attributes.fan_mode = data.fan_mode;
          else if (service === 'turn_on' && domain === 'light' && data.brightness_pct != null) st.attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
        }
        if (self.stateCb) self.stateCb(clone(self.states));
        resolve({});
      }, 120);
    });
  };

  window.HABackend = FixtureBackend;
})();
