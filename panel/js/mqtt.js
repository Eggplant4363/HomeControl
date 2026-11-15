/* ---------- MQTT 节点：把本机音乐挂成 HA 的 media_player ----------
 * 配置在 /sdcard/HomeControl/mqtt.json（弹层里填，保存走 AndroidBridge.mqttRestart）。
 * Java 侧（MqttClient.java）负责连接/上线/HA discovery/收命令；这里负责：
 *   - 设置弹层那一节（主机/端口/账号/密码 + 状态行 + 保存/停用）
 *   - 收命令执行（Java 派发 __hcMqttCmd）：play/pause/toggle/next/prev/stop
 *   - 状态上报（变化才发 {status,title} JSON；HA 按 value_json.status 显示播放/暂停）
 * 主题约定（<slug> 来自 app.js 的 selfSlug，一台设备一个）：
 *   homecontrol/<slug>/availability|cmd|state，discovery 挂 homeassistant/media_player/...
 */
(function () {
  'use strict';

  var CFG_FILE = '/sdcard/HomeControl/mqtt.json';

  /* 自带轻提示：app.js/music.js 的 toast 都是模块作用域，外面调不到（真机踩坑：
   * Uncaught TypeError: toast is not a function @mqtt.js:130），这里直接操作 #toast 元素 */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2200);
  }
  var POLL_MS = 4000;
  var lastSent = '';
  var lastStatus = '';

  function bridge() {
    return (typeof AndroidBridge !== 'undefined') ? AndroidBridge : null;
  }

  function slug() {
    var t = window.__PANEL_TEST__;
    if (t && t.selfSlug) { try { return t.selfSlug(); } catch (e) { } }
    var b = bridge();
    var model = (b && b.info) ? (JSON.parse(b.info()).model || '') : '';
    return String(model).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'panel';
  }

  function topics(sl) {
    return {
      avail: 'homecontrol/' + sl + '/availability',
      cmd: 'homecontrol/' + sl + '/cmd',
      state: 'homecontrol/' + sl + '/state',
      discovery: 'homeassistant/media_player/homecontrol_panel_' + sl + '_music'
    };
  }

  function readCfg() {
    var b = bridge();
    var raw = b ? b.readText(CFG_FILE) : '';
    var o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return {
      enabled: !!(o && o.enabled), host: (o && o.host) || '', port: (o && o.port) || 1883,
      tls: !!(o && o.tls), user: (o && o.user) || '', pass: (o && o.pass) || '', name: (o && o.name) || slug()
    };
  }

  function cfgJson(c) {
    return JSON.stringify({ enabled: !!c.enabled, host: c.host, port: c.port, tls: !!c.tls, user: c.user, pass: c.pass, name: c.name });
  }

  /* 命令映射（HA media_player 发下来的 payload 字符串 → 动作）；未知命令忽略 */
  function mapCmd(payload) {
    var p = String(payload || '').trim().toLowerCase();
    if (p === 'play' || p === 'pause' || p === 'toggle' || p === 'next' || p === 'prev' || p === 'stop') return p;
    return null;
  }

  function runCmd(payload) {
    var m = mapCmd(payload);
    if (!m) return;
    var mu = window.MusicUI;
    if (!mu) return;
    var playing = !!(mu.isPlaying && mu.isPlaying());
    if (m === 'play') { if (!playing) mu.togglePlay(); }
    else if (m === 'pause' || m === 'stop') { if (playing) mu.togglePlay(); }
    else if (m === 'toggle') { mu.togglePlay(); }
    else if (m === 'next') { mu.next(); }
    else if (m === 'prev') { mu.prev(); }
  }

  /* 状态上报载荷：idle / paused / playing + 当前歌名（HA attribute 显示） */
  function statePayload() {
    var mu = window.MusicUI;
    var track = (mu && mu.playing) ? mu.playing() : null;
    var status = !track ? 'idle' : (mu.isPlaying && mu.isPlaying() ? 'playing' : 'paused');
    return JSON.stringify({ status: status, title: (track && track.title) || '' });
  }

  function statusLine() {
    var c = readCfg();
    var b = bridge();
    // 每次现取桥里的实时状态（lastStatus 只是回调缓存，可能陈旧——保存并连接后要靠桥）
    var st = null;
    if (b && b.mqttState) { try { st = b.mqttState(); } catch (e) { } }
    if (!st) st = lastStatus;
    var txt = '未启用';
    var cls = '';
    if (c.enabled) {
      var s = null;
      try { s = st ? JSON.parse(st) : null; } catch (e) { s = null; }
      if (s && s.state === 'connected') { txt = '已连接 ' + c.host + ':' + c.port; cls = ' ok'; }
      else if (s && s.state === 'connected-no-sub') { txt = '已连接（订阅被 broker 拒：HA 能看状态，下发命令收不到）'; cls = ' warn'; }
      else if (s && s.state === 'offline') { txt = '连不上：' + (s.err || '重试中'); cls = ' bad'; }
      else { txt = '正在连接 ' + c.host + ':' + c.port + '…'; }
    }
    return '<div class="sheet-desc" id="mqStat"' + cls + '>MQTT 状态：' + esc(txt) + '</div>';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sectionHtml() {
    var c = readCfg();
    var h = '<div class="set-sec">MQTT 节点</div>' +
      '<div class="sheet-desc">接上 MQTT 后，HA 会出现一个「中控屏音乐」实体：在 HA 里点播放/暂停就能控制这台平板的道理鱼。' +
      '需先在 HA 里添加 MQTT integration 指向下面的 broker。</div>' +
      '<div class="cfg-row"><div class="cfg-k">主机</div><input class="cfg-in" id="mqHost" value="' + esc(c.host) + '" placeholder="10.10.1.8"></div>' +
      '<div class="cfg-row"><div class="cfg-k">端口</div><input class="cfg-in" id="mqPort" value="' + esc(String(c.port)) + '" placeholder="1883"></div>' +
      '<div class="cfg-row"><div class="cfg-k">账号</div><input class="cfg-in" id="mqUser" value="' + esc(c.user) + '" placeholder="用户名，可留空"></div>' +
      '<div class="cfg-row"><div class="cfg-k">密码</div><input class="cfg-in" id="mqPass" type="password" value="' + esc(c.pass) + '" placeholder="密码，可留空"></div>' +
      statusLine() +
      '<div class="cfg-actions"><button class="btn primary" data-act="mqtt-save">保存并连接</button>' +
      '<button class="btn" data-act="mqtt-off">停用</button></div>';
    return h;
  }

  function save() {
    var b = bridge();
    var host = (document.getElementById('mqHost') || {}).value || '';
    var port = parseInt((document.getElementById('mqPort') || {}).value || '1883', 10) || 1883;
    var user = (document.getElementById('mqUser') || {}).value || '';
    var pass = (document.getElementById('mqPass') || {}).value || '';
    var c = { enabled: true, host: host.trim(), port: port, tls: false, user: user.trim(), pass: pass, name: slug() };
    if (!c.host) { toast('先填 broker 主机'); return; }
    if (!b || !b.writeText) { toast('没有原生桥，写不了 mqtt.json'); return; }
    b.writeText(CFG_FILE, cfgJson(c));
    try { lastStatus = b.mqttRestart(cfgJson(c)); } catch (e) { lastStatus = '{"state":"off"}'; }
    lastSent = '';
    toast('已保存，正在连接 ' + c.host + ':' + c.port);
  }

  function disable() {
    var b = bridge();
    var c = readCfg();
    c.enabled = false;
    if (b && b.writeText) b.writeText(CFG_FILE, cfgJson(c));
    if (b && b.mqttRestart) { try { lastStatus = b.mqttRestart(cfgJson(c)); } catch (e) { } }
  }

  /* Java 派发入口：收到 HA 命令 */
  window.__hcMqttCmd = function (topic, payload) {
    runCmd(payload);
  };

  /* Java 连接状态变化：刷内存里的状态 + toast 提醒 */
  window.__hcMqttStatus = function (json) {
    try {
      var s = JSON.parse(json);
      if (json === lastStatus) return;
      lastStatus = json;
      if (s.state === 'connected') toast('MQTT 已连接：HA 里会出现「中控屏音乐」');
      else if (s.state === 'connected-no-sub') toast('MQTT 已连接（订阅被拒：broker 配额/ACL，HA 只能看状态）');
      else if (s.state === 'offline') toast('MQTT 连不上：' + (s.err || '重试中'));
    } catch (e) { }
  };

  /* 状态轮询：变了才发；未启用/没连上时桥自己返回 false，零成本 */
  setInterval(function () {
    var b = bridge();
    if (!b || !b.mqttPublish) return;
    var c = readCfg();
    if (!c.enabled) return;
    var p = statePayload();
    if (p === lastSent) return;
    if (b.mqttPublish(topics(slug()).state, p, '0')) lastSent = p;
  }, POLL_MS);

  /* 供 tools/test-ui.js 断言的纯函数（不碰 DOM/桥） */
  window.HCMqtt = {
    sectionHtml: sectionHtml,
    save: save,
    disable: disable,
    statusLine: statusLine,
    __test: {
      topics: topics,
      slug: slug,
      mapCmd: mapCmd,
      cfgJson: cfgJson,
      readCfgDefaults: function () { return { enabled: false, host: '', port: 1883, tls: false, user: '', pass: '', name: 'panel' }; }
    }
  };
})();
