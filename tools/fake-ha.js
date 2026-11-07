/* 假 Home Assistant WebSocket 服务器（零依赖，手写最小 WS 实现）。
   用途：① tools/test-ha.js 里做协议单测；② 没有真 HA 时在局域网里跑起来，
   让平板走「真实模式」做端到端联调。

   单独启动：node tools\fake-ha.js 8123
   然后面板配置文件写 {"url":"http://<PC的局域网IP>:8123","token":"good-token"} */
'use strict';

const http = require('http');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onClose = onClose;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => { if (this.onClose) this.onClose(); });
    socket.on('error', () => {});
  }

  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      const mask = masked ? this.buf.slice(offset, offset + 4) : null;
      let payload = this.buf.slice(offset + maskLen, offset + maskLen + len);
      if (mask) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buf = this.buf.slice(offset + maskLen + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.sendRaw(Buffer.from([0x8a, 0])); continue; }
      if (opcode === 0x1) this.onMessage(payload.toString('utf8'));
    }
  }

  sendRaw(buf) { try { this.socket.write(buf); } catch (e) {} }
  send(text) { this.sendRaw(encodeText(text)); }
  sendJson(obj) { this.send(JSON.stringify(obj)); }
  close() { try { this.socket.end(); } catch (e) {} }
}

function makeHa() {
  const ha = {
    states: {
      'light.living_main': { entity_id: 'light.living_main', state: 'on', attributes: { friendly_name: '主灯', brightness: 204, supported_color_modes: ['brightness'] } },
      'light.living_strip': { entity_id: 'light.living_strip', state: 'off', attributes: { friendly_name: '灯带', brightness: 180 } },
      'switch.living_tv': { entity_id: 'switch.living_tv', state: 'on', attributes: { friendly_name: '电视插座', power: 68 } },
      'climate.living_ac': { entity_id: 'climate.living_ac', state: 'heat', attributes: { friendly_name: '空调', temperature: 24, current_temperature: 21.5, hvac_modes: ['off', 'cool', 'heat', 'fan_only', 'dry', 'auto'], fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'auto' } },
      'cover.living_curtain': { entity_id: 'cover.living_curtain', state: 'open', attributes: { friendly_name: '窗帘', current_position: 60 } },
      'camera.living_cam': { entity_id: 'camera.living_cam', state: 'idle', attributes: { friendly_name: '客厅摄像头', entity_picture: '/api/camera_proxy/camera.living_cam?token=good-token' } },
      'light.study_onoff': { entity_id: 'light.study_onoff', state: 'on', attributes: { friendly_name: '书房小灯', supported_color_modes: ['onoff'] } },
      'cover.study_blind': { entity_id: 'cover.study_blind', state: 'closed', attributes: { friendly_name: '书房百叶', supported_features: 3 } },
      'climate.study_floor': { entity_id: 'climate.study_floor', state: 'heat_cool', attributes: { friendly_name: '书房地暖', temperature: 22, current_temperature: 20.5, target_temp_step: 1, hvac_modes: ['off', 'heat_cool'] } },      'fan.living_fan': { entity_id: 'fan.living_fan', state: 'on', attributes: { friendly_name: '风扇', percentage: 40 } },
      'automation.morning': { entity_id: 'automation.morning', state: 'on', attributes: { friendly_name: '早晨自动开灯' } },
      'sensor.living_temp': { entity_id: 'sensor.living_temp', state: '23.4', attributes: { friendly_name: '温度', device_class: 'temperature', unit_of_measurement: '°C' } },
      'sensor.living_humidity': { entity_id: 'sensor.living_humidity', state: '51', attributes: { friendly_name: '湿度', device_class: 'humidity', unit_of_measurement: '%' } },
      'binary_sensor.living_motion': { entity_id: 'binary_sensor.living_motion', state: 'off', attributes: { friendly_name: '人体感应', device_class: 'motion' } },
      'scene.movie': { entity_id: 'scene.movie', state: 'unknown', attributes: { friendly_name: '观影模式' } },
      'script.all_off': { entity_id: 'script.all_off', state: 'off', attributes: { friendly_name: '全部关闭' } },
      'weather.home': { entity_id: 'weather.home', state: 'cloudy', attributes: { friendly_name: '天气', temperature: 18 } }
    },
    areas: [
      { area_id: 'living', name: '客厅' },
      { area_id: 'master', name: '主卧' },
      { area_id: 'study', name: '书房' }
    ],
    devices: [
      { id: 'dev_living', area_id: 'living' },
      { id: 'dev_master', area_id: 'master' },
      { id: 'dev_study', area_id: 'study' }
    ],
    entities: [
      { entity_id: 'light.living_main', area_id: 'living', name: '主灯' },
      { entity_id: 'light.living_strip', area_id: 'living', name: '灯带' },
      { entity_id: 'switch.living_tv', device_id: 'dev_living' },
      { entity_id: 'climate.living_ac', area_id: 'living' },
      { entity_id: 'cover.living_curtain', area_id: 'living' },
      { entity_id: 'camera.living_cam', area_id: 'living' },
      { entity_id: 'fan.living_fan', area_id: 'living' },
      { entity_id: 'automation.morning', area_id: 'living' },
      { entity_id: 'sensor.living_temp', device_id: 'dev_living' },
      { entity_id: 'sensor.living_humidity', area_id: 'living' },
      { entity_id: 'binary_sensor.living_motion', area_id: 'living' },
      { entity_id: 'scene.movie', area_id: 'living' },
      { entity_id: 'light.study_onoff', area_id: 'study' },
      { entity_id: 'cover.study_blind', area_id: 'study' },
      { entity_id: 'climate.study_floor', area_id: 'study' }
    ],
    conns: [],
    totalConns: 0,
    subCounter: 0
  };

  ha.broadcast = function (entityId) {
    const st = ha.states[entityId];
    if (!st) return;
    const msg = {
      id: 1000 + (ha.subCounter++),
      type: 'event',
      event: { event_type: 'state_changed', data: { entity_id: entityId, new_state: st, old_state: null } }
    };
    ha.conns.forEach((c) => c.sendJson(msg));
  };

  function applyToggle(entityId) {
    const st = ha.states[entityId];
    if (!st) return;
    if (st.state === 'on') st.state = 'off';
    else if (st.state === 'off') st.state = 'on';
  }

  ha.handle = function (conn, msg) {
    if (msg.type === 'auth') {
      conn.token = msg.access_token;
      if (msg.access_token === 'good-token') conn.sendJson({ type: 'auth_ok', version: 1 });
      else conn.sendJson({ type: 'auth_invalid', message: 'Invalid access token or password' });
      return;
    }
    if (msg.type === 'ping') { conn.sendJson({ type: 'pong', id: msg.id }); return; }
    if (msg.type === 'get_states') {
      conn.sendJson({ id: msg.id, type: 'result', success: true, result: Object.keys(ha.states).map((k) => ha.states[k]) });
      return;
    }
    if (msg.type === 'subscribe_events') {
      conn.sendJson({ id: msg.id, type: 'result', success: true, result: null });
      return;
    }
    if (msg.type === 'config/area_registry/list') {
      conn.sendJson({ id: msg.id, type: 'result', success: true, result: ha.areas });
      return;
    }
    if (msg.type === 'config/device_registry/list') {
      conn.sendJson({ id: msg.id, type: 'result', success: true, result: ha.devices });
      return;
    }
    if (msg.type === 'config/entity_registry/list') {
      conn.sendJson({ id: msg.id, type: 'result', success: true, result: ha.entities });
      return;
    }
    if (msg.type === 'call_service') {
      const data = msg.service_data || {};
      const entityId = data.entity_id;
      const st = entityId ? ha.states[entityId] : null;
      const dom = msg.domain;
      const svc = msg.service;

      if (dom === 'homeassistant' && svc === 'toggle' && st) {
        applyToggle(entityId);
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if (dom === 'light' && st) {
        if (svc === 'toggle') applyToggle(entityId);
        else if (svc === 'turn_on') {
          st.state = 'on';
          if (data.brightness_pct != null) st.attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
        } else if (svc === 'turn_off') st.state = 'off';
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if (dom === 'switch' && st) {
        if (svc === 'toggle') applyToggle(entityId);
        else if (svc === 'turn_on') st.state = 'on';
        else if (svc === 'turn_off') st.state = 'off';
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if ((dom === 'fan' || dom === 'automation' || dom === 'input_boolean' || dom === 'humidifier') && st) {
        if (svc === 'toggle') applyToggle(entityId);
        else if (svc === 'turn_on') st.state = 'on';
        else if (svc === 'turn_off') st.state = 'off';
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if (dom === 'cover' && st) {
        if (svc === 'open_cover') st.state = 'open';
        else if (svc === 'close_cover') st.state = 'closed';
        else if (svc === 'stop_cover') { /* noop */ }
        else if (svc === 'set_cover_position' && data.position != null) {
          st.attributes.current_position = data.position;
          st.state = data.position > 0 ? 'open' : 'closed';
        }
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if (dom === 'climate' && st) {
        if (svc === 'set_temperature' && (data.target_temp_low != null || data.target_temp_high != null)) {
          if (data.target_temp_low != null) st.attributes.target_temp_low = data.target_temp_low;
          if (data.target_temp_high != null) st.attributes.target_temp_high = data.target_temp_high;
          conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
          ha.broadcast(entityId);
          return;
        }
        if (svc === 'set_temperature' && data.temperature != null) st.attributes.temperature = data.temperature;
        if (svc === 'set_hvac_mode' && data.hvac_mode) st.state = data.hvac_mode;
        if (svc === 'set_fan_mode' && data.fan_mode) st.attributes.fan_mode = data.fan_mode;
        if (svc === 'turn_off') st.state = 'off';
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        ha.broadcast(entityId);
        return;
      }
      if (dom === 'script' || dom === 'scene') {
        conn.sendJson({ id: msg.id, type: 'result', success: true, result: {} });
        return;
      }
      conn.sendJson({ id: msg.id, type: 'result', success: false, error: { message: 'unsupported: ' + dom + '.' + svc } });
      return;
    }
    conn.sendJson({ id: msg.id, type: 'result', success: false, error: { message: 'unknown command ' + msg.type } });
  };

  return ha;
}

function createServer(opts) {
  const options = opts || {};
  const ha = makeHa();
  const server = http.createServer((req, res) => {
    /* 最小 REST：/api/ 探活、/api/states 全量、POST /api/services/<domain>/<service> */
    const auth = String(req.headers['authorization'] || '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const url = String(req.url || '/');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (url === '/api/' || url === '/api') {
      if (token !== 'good-token') return send(401, { message: 'Unauthorized' });
      return send(200, { message: 'API running.' });
    }
    if (token !== 'good-token') return send(401, { message: 'Unauthorized' });
    if (url.indexOf('/api/history/period') === 0) {
      const u2 = new URL(req.url, 'http://x');
      const eid = u2.searchParams.get('filter_entity_id') || 'sensor.living_temp';
      const st2 = ha.states[eid];
      const base = st2 ? parseFloat(st2.state) : 24;
      const now = Date.now();
      const series = [];
      for (let k = 0; k <= 24; k++) {
        const t = now - 12 * 3600 * 1000 + (12 * 3600 * 1000) * k / 24;
        series.push({
          entity_id: eid,
          state: (base + Math.sin((k / 24) * Math.PI * 2 - 1.2) * 1.6).toFixed(1),
          last_changed: new Date(t).toISOString(),
        });
      }
      send(200, [series]);
      return;
    }
    if (url.indexOf('/api/camera_proxy/') === 0) {
      const cam = path.join(__dirname, 'mock-cam.jpg');
      if (!fs.existsSync(cam)) return send(404, { message: 'no mock-cam.jpg' });
      const buf = fs.readFileSync(cam);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
      return;
    }
    if (url === '/api/states') {
      return send(200, Object.keys(ha.states).map((k) => ha.states[k]));
    }
    const m = url.match(/^\/api\/services\/([^\/]+)\/([^\/]+)$/);
    if (m && (req.method === 'POST' || req.method === 'GET')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { data = {}; }
        ha.handle({ sendJson: () => {} }, {
          id: 0, type: 'call_service', domain: m[1], service: m[2], service_data: data
        });
        send(200, []);
      });
      return;
    }
    send(404, { message: 'Not found' });
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new Conn(
      socket,
      (text) => { let m; try { m = JSON.parse(text); } catch (e) { return; } ha.handle(conn, m); },
      () => { ha.conns = ha.conns.filter((c) => c !== conn); }
    );
    ha.conns.push(conn);
    ha.totalConns++;
    conn.sendJson({ type: 'auth_required', ha_version: '2024.10.0' });
  });
  return { server, ha, listen: () => new Promise((res) => server.listen(options.port || 0, options.host || '0.0.0.0', res)) };
}

module.exports = { makeHa, createServer, Conn, encodeText };

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8123', 10);
  const { listen, server } = createServer({ port: port, host: '0.0.0.0' });
  listen().then(() => {
    const addrs = Object.values(require('os').networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
    console.log('fake HA listening on 0.0.0.0:' + port + '  token=good-token');
    console.log('LAN URLs: ' + addrs.map((a) => 'http://' + a + ':' + port).join('  '));
  });
  setInterval(() => {}, 1 << 30);
}
