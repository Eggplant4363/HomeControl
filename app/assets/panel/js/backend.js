/* 数据层：真实 Home Assistant WebSocket 与本地模拟实现，对外接口一致
     backend.onStates(cb)   cb(statesMap)      entity_id -> { entity_id, state, attributes }
     backend.onEntity(cb)   cb(entity_id, st)  只有 HABackend 有：单实体增量
     backend.onStatus(cb)   cb({connected,text})
     backend.call(domain, service, data) -> Promise
     backend.start()
*/
(function () {
  function bnum(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }


  /* =========================== 真实 HA =========================== */
  function HABackend(cfg) {
    this.url = cfg.url;
    this.token = cfg.token || '';
    this.ws = null;
    this.msgId = 1;
    this.pending = {};
    this.states = {};
    this.stateCb = null;
    this.entityCb = null;      /* 增量回调：只回单个实体，避免每次推送复制全部 1000+ 实体 */
    this.statusCb = null;
    this.tries = 0;
    this.pingTimer = null;
    this.restTimer = null;   /* WS 不通时定时重拉 /api/states（HA 那边改的东西才看得见） */
    this.stopped = false;
    this.statesLoaded = false;
    this.restTried = false;
    this.restOk = false;
  }

  HABackend.prototype.onStates = function (cb) { this.stateCb = cb; };
  /* 面板如果注册了 onEntity，state_changed 就走增量（只发这一个实体）；
     没注册时退回全量，兼容老页面/单测 */
  HABackend.prototype.onEntity = function (cb) { this.entityCb = cb; };
  HABackend.prototype.onStatus = function (cb) { this.statusCb = cb; };
  HABackend.prototype.start = function () { this.stopped = false; this.connect(); };
  HABackend.prototype.stop = function () {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearInterval(this.restTimer);
    this.restTimer = null;
    if (this.ws) this.ws.close();
  };

  HABackend.prototype.status = function (connected, text) {
    if (this.statusCb) this.statusCb({ connected: connected, text: text });
  };

  HABackend.prototype.nextId = function () { return this.msgId++; };

  HABackend.prototype.reconnect = function () {
    /* 手动重连：切回模拟模式或改完配置后由面板调用 */
    this.stopped = false;
    this.tries = 0;
    this.everAuthed = false;
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) { } this.ws = null; }
    this.connect();
  };

  HABackend.prototype.connect = function () {
    var self = this;
    if (this.stopped) return;
    if (this.restOk && this.tries === 0) this.status(false, 'REST 兜底 · 尝试恢复 WebSocket…');
    else if (this.tries === 0) this.status(false, this.everAuthed ? '重连中…' : '连接中…');
    else if (this.tries < 2) this.status(false, '连接失败，重试中…');
    else this.status(false, '连不上 HA（第 ' + this.tries + ' 次重试）');
    var ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.retry();
      return;
    }
    this.ws = ws;

    ws.onopen = function () { clearTimeout(self.connectTimer); clearInterval(self.restTimer); self.restTimer = null; self.status(false, '认证中…'); };
    ws.onmessage = function (ev) { self.handle(ev.data); };
    ws.onerror = function () { };
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(function () {
      if (!self.everAuthed && self.ws) {
        self.status(false, '连不上 HA · 检查地址与网络');
        try { self.ws.close(); } catch (e) { }
      }
    }, 12000);

    ws.onclose = function () {
      clearTimeout(self.connectTimer);
      self.ws = null;
      clearInterval(self.pingTimer);
      self.statesLoaded = false;
      self.rejectPending('连接已断开');
      if (self.stopped) return;
      if (self.restOk) self.status(false, 'REST 兜底 · 无实时推送（WS 重试中）');
      else if (self.everAuthed) self.status(false, '连接断开，重连中…');
      else if (self.tries >= 2) self.status(false, '连不上 HA · 检查地址与网络');
      else self.status(false, '连接失败，重试中…');
      self.retry();
      /* WS 连续失败时用 REST 兜一次：至少让面板显示真实状态、按钮还能用 */
      if (!self.statesLoaded && self.tries >= 3 && !self.restTried) {
        self.restTried = true;
        self.restLoadStates();
      }
    };
  };

  HABackend.prototype.rejectPending = function (reason) {
    var ids = [];
    for (var k in this.pending) ids.push(k);
    for (var i = 0; i < ids.length; i++) {
      var p = this.pending[ids[i]];
      delete this.pending[ids[i]];
      if (p && p.reject) p.reject(new Error(reason));
    }
  };

  HABackend.prototype.retry = function () {
    var self = this;
    if (this.stopped) return;
    this.tries++;
    var delay = Math.min(15000, 1000 * Math.pow(2, Math.min(4, this.tries)));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () { self.connect(); }, delay);
  };

  HABackend.prototype.send = function (msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  };

  HABackend.prototype.request = function (msg, onResult) {
    var id = this.nextId();
    msg.id = id;
    var ok = this.send(msg);
    if (!ok) return false;
    this.pending[id] = { onResult: onResult };
    return true;
  };

  HABackend.prototype.handle = function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'auth_required') {
      this.send({ type: 'auth', access_token: this.token });
    } else if (msg.type === 'auth_ok') {
      this.tries = 0;
      this.everAuthed = true;
      clearTimeout(this.connectTimer);
      this.status(true, '已连接');
      this.startPing();
      var self = this;
      this.request({ type: 'get_states' }, function (list) {
        self.states = {};
        (list || []).forEach(function (st) { if (st && st.entity_id) self.states[st.entity_id] = st; });
        self.statesLoaded = true;
        self.emitStates();
      });
      this.request({ type: 'subscribe_events', event_type: 'state_changed' }, null);
    } else if (msg.type === 'auth_invalid') {
      this.status(false, '令牌无效 · 长按右上角修改');
      this.stopped = true;
      clearInterval(this.pingTimer);
      if (this.ws) this.ws.close();
    } else if (msg.type === 'result') {
      var p = this.pending[msg.id];
      if (!p) return;
      delete this.pending[msg.id];
      if (!msg.success) {
        if (p.reject) p.reject(new Error((msg.error && msg.error.message) || '调用失败'));
        return;
      }
      if (p.onResult) p.onResult(msg.result);
      else if (p.resolve) p.resolve(msg.result);
    } else if (msg.type === 'event') {
      var data = msg.event && msg.event.data;
      if (!data) return;
      if (data.new_state && data.new_state.entity_id) {
        this.states[data.new_state.entity_id] = data.new_state;
        if (this.entityCb) this.emitEntity(data.new_state);
        else this.emitStates();
      }
    }
  };

  /* 增量推送：浅拷贝单个实体，避免每次事件都遍历 states 建全量副本（1254 实体 × 4 次/秒 = 大量垃圾） */
  HABackend.prototype.emitEntity = function (st) {
    if (!this.entityCb) return;
    this.entityCb(st.entity_id, {
      entity_id: st.entity_id,
      state: st.state,
      attributes: st.attributes || {},
      last_changed: st.last_changed,
      last_updated: st.last_updated || st.last_changed
    });
  };

  HABackend.prototype.startPing = function () {
    var self = this;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(function () {
      if (self.ws && self.ws.readyState === 1) self.send({ type: 'ping' });
    }, 25000);
  };

  HABackend.prototype.emitStates = function () {
    if (!this.stateCb) return;
    /* 发副本，避免面板的乐观更新改到后端缓存（与 MockBackend 同理） */
    var copy = {}, id, s;
    for (id in this.states) {
      s = this.states[id];
      copy[id] = { entity_id: id, state: s.state, attributes: s.attributes || {}, last_changed: s.last_changed, last_updated: s.last_updated || s.last_changed };
    }
    this.stateCb(copy);
  };

  /** 通用命令：返回 Promise，用于 get_states 之外的查询（如各 registry） */
  HABackend.prototype.requestCmd = function (msg) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self.ws || self.ws.readyState !== 1) { reject(new Error('未连接到 HA')); return; }
      var id = self.nextId();
      msg.id = id;
      self.pending[id] = { resolve: resolve, reject: reject };
      if (!self.send(msg)) { delete self.pending[id]; reject(new Error('发送失败')); }
    });
  };

  /** http(s) 基地址：把 ws://…/api/websocket 还原成 http://… */
  HABackend.prototype.httpBase = function () {
    var u = String(this.url || '');
    u = u.replace(/\/api\/websocket\/?$/i, '');
    u = u.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    return u.replace(/\/+$/, '');
  };

  /** REST 兜底：WebSocket 掉了也能读状态、发服务调用（Chromium 57 有 XHR） */
  HABackend.prototype.rest = function (method, path, body, onDone) {
    var self = this;
    var bridge = window.AndroidBridge;
    /* 壳 App 里有原生 REST：file:// 页面直接 XHR 会被 CORS 拦，所以优先走桥 */
    if (bridge && bridge.rest) {
      var cbId = 'r' + (this.restSeq = (this.restSeq || 0) + 1);
      window.__restCb = function (id, raw) {
        if (id !== cbId) return;
        var r = null;
        try { r = JSON.parse(raw); } catch (e) { r = null; }
        if (!r) { onDone(false, 0, null); return; }
        if (r.error) { onDone(false, 0, null); return; }
        var data = null;
        try { data = r.body ? JSON.parse(r.body) : null; } catch (e) { data = null; }
        onDone(r.status >= 200 && r.status < 300, r.status, data);
      };
      try { bridge.rest(cbId, this.httpBase(), this.token, method, path, body ? JSON.stringify(body) : ''); }
      catch (e) { onDone(false, 0, null); }
      return;
    }
    var url = this.httpBase() + path;
    var x = new XMLHttpRequest();
    var done = false;
    var fin = function (ok, code, data) { if (done) return; done = true; onDone(ok, code, data); };
    try {
      x.open(method, url, true);
      x.setRequestHeader('Authorization', 'Bearer ' + this.token);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 8000;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var data = null;
        try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) { data = null; }
        fin(x.status >= 200 && x.status < 300, x.status, data);
      };
      x.ontimeout = function () { fin(false, 0, null); };
      x.onerror = function () { fin(false, 0, null); };
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) { fin(false, 0, null); }
  };

  /* 取最近 hours 小时的历史，回调 [{t,v}]（时间戳 ms / 数值） */
  HABackend.prototype.restHistory = function (entityId, hours, ok, fail) {
    var self = this;
    var h = bnum(hours, 12);
    var start = new Date(Date.now() - h * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    var path = '/api/history/period/' + start + '?filter_entity_id=' + encodeURIComponent(entityId) +
      '&minimal_response&no_attributes';
    this.rest('GET', path, null, function (success, status, arr) {
      if (!success || !arr) { if (fail) fail({ status: status }); return; }
      var row = (arr && arr[0]) || [];
      var out = [];
      for (var i = 0; i < row.length; i++) {
        var it = row[i];
        if (!it) continue;
        out.push({ t: new Date(it.last_changed || it.last_updated || it.lu || 0).getTime(), v: parseFloat(it.state) });
      }
      out = out.filter(function (x) { return !isNaN(x.t) && !isNaN(x.v); });
      out.sort(function (a, b) { return a.t - b.t; });
      if (ok) ok(out);
    });
  };

  /** 只用 REST 拉一次全量状态（WS 不通时兜底，没有实时推送） */
  HABackend.prototype.restLoadStates = function () {
    var self = this;
    this.rest('GET', '/api/states', null, function (ok, code, data) {
      if (ok && data && data.length) {
        self.states = {};
        for (var i = 0; i < data.length; i++) {
          var st = data[i];
          if (st && st.entity_id) self.states[st.entity_id] = st;
        }
        self.statesLoaded = true;
        self.restOk = true;
        self.status(false, 'REST 兜底 · 无实时推送');
        self.emitStates();
        /* 没有推送就自己定时重拉：HA 那边拨了开关，面板 15 秒内能看见 */
        if (!self.restTimer) {
          self.restTimer = setInterval(function () {
            if (!self.stopped && (!self.ws || self.ws.readyState !== 1)) self.restLoadStates();
          }, 15000);
        }
      } else if (code === 401 || code === 403) {
        self.status(false, '令牌无效 · 长按右上角修改');
      } else if (code === 0) {
        self.status(false, '连不上 HA · 检查地址与网络');
      }
    });
  };

  HABackend.prototype.call = function (domain, service, data) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.ws && self.ws.readyState === 1) {
        var id = self.nextId();
        self.pending[id] = { resolve: resolve, reject: reject };
        var ok = self.send({
          id: id, type: 'call_service', domain: domain, service: service,
          service_data: data || {}
        });
        if (!ok) { delete self.pending[id]; reject(new Error('发送失败')); }
        return;
      }
      /* WS 不在线：退到 REST（真实 HA 的 /api/services 接口） */
      self.rest('POST', '/api/services/' + domain + '/' + service, data || {}, function (ok, code) {
        if (ok) { resolve({}); return; }
        if (code === 401 || code === 403) { reject(new Error('令牌无效')); return; }
        reject(new Error('未连接到 HA'));
      });
    });
  };

  /* =========================== 模拟后端 =========================== */
  var SCENE_PRESETS = {
    'scene.arrive': function (set) {
      set('light.living_main', 'on', { brightness: 204 });
      set('light.living_strip', 'on', { brightness: 255 });
      set('cover.living_curtain', 'open', { current_position: 100 });
      set('climate.living_ac', 'heat', { temperature: 24 });
    },
    'scene.movie': function (set) {
      set('light.living_main', 'off', {});
      set('light.living_strip', 'on', { brightness: 60 });
      set('cover.living_curtain', 'closed', { current_position: 0 });
    },
    'scene.sleep': function (set) {
      set('light.living_main', 'off', {});
      set('light.living_strip', 'off', {});
      set('light.master_bedside', 'on', { brightness: 30 });
      set('cover.master_curtain', 'closed', { current_position: 0 });
    }
  };

  function MockBackend(cfg) {
    this.entities = {};
    var src = window.MOCK_ENTITIES || {};
    for (var id in src) {
      var e = JSON.parse(JSON.stringify(src[id]));
      e.entity_id = id;
      e.last_changed = new Date().toISOString();
      this.entities[id] = e;
    }
    this.stateCb = null;
    this.statusCb = null;
    this.timer = null;
    this.coverTimers = {};
  }

  MockBackend.prototype.onStates = function (cb) { this.stateCb = cb; };
  MockBackend.prototype.onStatus = function (cb) { this.statusCb = cb; };
  MockBackend.prototype.emit = function () {
    if (!this.stateCb) return;
    /* 必须发副本：面板会做乐观更新（直接改 S.states），若把内部对象传出去，
       面板的 patch 会改到 mock 自己的数据，随后的 toggle 就会把刚改的状态又翻回去。 */
    var copy = {};
    for (var id in this.entities) {
      var s = this.entities[id];
      copy[id] = {
        entity_id: s.entity_id,
        state: s.state,
        attributes: JSON.parse(JSON.stringify(s.attributes || {})),
        last_changed: s.last_changed
      };
    }
    this.stateCb(copy);
  };

  MockBackend.prototype.start = function () {
    var self = this;
    setTimeout(function () {
      if (self.statusCb) self.statusCb({ connected: true, text: '模拟数据' });
      self.emit();
    }, 250);
    this.timer = setInterval(function () { self.tick(); }, 6000);
  };

  MockBackend.prototype.stop = function () { clearInterval(this.timer); };

  MockBackend.prototype.set = function (id, state, attrs) {
    var e = this.entities[id];
    if (!e) return;
    if (state != null) e.state = state;
    for (var k in attrs) e.attributes[k] = attrs[k];
    e.last_changed = new Date().toISOString();
  };

  MockBackend.prototype.tick = function () {
    var self = this;
    // 温湿度轻微漂移
    for (var id in this.entities) {
      var e = this.entities[id];
      if (e.attributes && e.attributes.device_class === 'temperature' && /^sensor\./.test(id)) {
        var v = parseFloat(e.state);
        if (!isNaN(v)) e.state = (v + (Math.random() - 0.5) * 0.2).toFixed(1);
      } else if (e.attributes && e.attributes.device_class === 'humidity' && /^sensor\./.test(id)) {
        var h = parseFloat(e.state);
        if (!isNaN(h)) e.state = String(Math.round(h + (Math.random() - 0.5) * 2));
      } else if (id === 'climate.living_ac' && e.state !== 'off') {
        var cur = e.attributes.current_temperature || 22;
        var tgt = e.attributes.temperature || 24;
        e.attributes.current_temperature = Math.round((cur + (tgt - cur) * 0.08) * 10) / 10;
      }
    }
    if (Math.random() < 0.25) {
      var m = this.entities['binary_sensor.living_motion'];
      if (m) m.state = m.state === 'on' ? 'off' : 'on';
    }
    this.emit();
  };

  MockBackend.prototype.animateCover = function (id, target) {
    var self = this;
    var e = this.entities[id];
    if (!e) return;
    clearInterval(this.coverTimers[id]);
    var pos = e.attributes.current_position == null ? (e.state === 'closed' ? 0 : 100) : e.attributes.current_position;
    if (pos === target) {
      e.state = target > 0 ? 'open' : 'closed';
      this.emit();
      return;
    }
    e.state = target > pos ? 'opening' : 'closing';
    this.emit();
    this.coverTimers[id] = setInterval(function () {
      var cur = self.entities[id].attributes.current_position || 0;
      var step = target > cur ? 10 : -10;
      var next = cur + step;
      if ((step > 0 && next >= target) || (step < 0 && next <= target)) next = target;
      self.entities[id].attributes.current_position = next;
      if (next === target) {
        clearInterval(self.coverTimers[id]);
        self.entities[id].state = target > 0 ? 'open' : 'closed';
      }
      self.emit();
    }, 120);
  };

  MockBackend.prototype.call = function (domain, service, data) {
    var self = this;
    data = data || {};
    var id = data.entity_id;
    var e = id ? this.entities[id] : null;

    if (id === 'script.all_off') {
      for (var k in this.entities) {
        var ent = this.entities[k];
        if (/^light\./.test(k) || /^switch\./.test(k)) ent.state = 'off';
        if (/^climate\./.test(k)) ent.state = 'off';
        if (/^cover\./.test(k)) { ent.state = 'closed'; ent.attributes.current_position = 0; }
      }
      this.emit();
      return Promise.resolve();
    }
    if (SCENE_PRESETS[id]) {
      SCENE_PRESETS[id](function (eid, st, attrs) { self.set(eid, st, attrs); });
      this.set(id, 'unknown', {});
      this.emit();
      return Promise.resolve();
    }
    if (!e) return Promise.reject(new Error('实体不存在: ' + id));

    if (domain === 'light' || domain === 'switch' || domain === 'fan') {
      if (service === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
      else if (service === 'turn_on') e.state = 'on';
      else if (service === 'turn_off') e.state = 'off';
      if (domain === 'light' && service === 'turn_on' && data.brightness_pct != null) {
        e.attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
      }
      if (domain === 'switch') e.attributes.power = e.state === 'on' ? (e.attributes.power || Math.round(20 + Math.random() * 150)) : 0;
      this.emit();
      return Promise.resolve();
    }
    if (domain === 'climate') {
      if (service === 'set_temperature' && data.temperature != null) e.attributes.temperature = data.temperature;
      else if (service === 'set_hvac_mode') e.state = data.hvac_mode;
      else if (service === 'set_fan_mode') e.attributes.fan_mode = data.fan_mode;
      else if (service === 'turn_off') e.state = 'off';
      else if (service === 'turn_on') e.state = e.state === 'off' ? 'auto' : e.state;
      this.emit();
      return Promise.resolve();
    }
    if (domain === 'cover') {
      if (service === 'open_cover') this.animateCover(id, 100);
      else if (service === 'close_cover') this.animateCover(id, 0);
      else if (service === 'stop_cover') {
        clearInterval(this.coverTimers[id]);
        e.state = e.attributes.current_position > 0 ? 'open' : 'closed';
        this.emit();
      } else if (service === 'set_cover_position' && data.position != null) this.animateCover(id, data.position);
      return Promise.resolve();
    }
    if (domain === 'scene') { this.set(id, 'unknown', {}); this.emit(); return Promise.resolve(); }
    return Promise.resolve();
  };

  MockBackend.prototype.restHistory = function (entityId, hours, ok) {
    var self = this;
    var h = bnum(hours, 12);
    var end = Date.now(), start = end - h * 3600 * 1000;
    var st = this.entities[entityId];
    var base = st ? parseFloat(st.state) : 24;
    if (isNaN(base)) base = 24;
    var out = [];
    for (var i = 0; i <= 24; i++) {
      var t = start + (end - start) * i / 24;
      var wave = Math.sin((i / 24) * Math.PI * 2 - 1.2) * 1.6;
      out.push({ t: t, v: Math.round((base + wave) * 10) / 10 });
    }
    if (ok) ok(out);
  };

  MockBackend.prototype.requestCmd = function () {
    return Promise.reject(new Error('模拟数据不支持该命令'));
  };

  window.HABackend = HABackend;
  window.MockBackend = MockBackend;
})();
