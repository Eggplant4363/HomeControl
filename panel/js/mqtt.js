/* ---------- MQTT 节点：把本机音乐挂成 HA 的 sensor + button ----------
 * 配置在 /sdcard/HomeControl/mqtt.json（弹层里填，保存走 AndroidBridge.mqttRestart）。
 * Java 侧（MqttClient.java）负责连接/上线/HA discovery/收命令；这里负责：
 *   - 设置弹层那一节（主机/端口/账号/密码 + 状态行 + 保存/停用）
 *   - 收命令执行（Java 派发 __hcMqttCmd）：play/pause/toggle/next/prev/stop
 *   - 状态上报（变化才发 {status,title} JSON；HA sensor 按 value_json.status 显示，歌名进 JSON 属性）
 * 主题约定（<slug> 来自 app.js 的 selfSlug，一台设备一个）：
 *   homecontrol/<slug>/availability|cmd|state
 *   discovery 挂 homeassistant/sensor|button/…（**不用 media_player**：HA 核心没有 mqtt.media_player 平台）
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
  var VOL_STEP = 5; /* 音量 +/- 按钮的步长（百分点） */
  var lastSent = '';
  var lastStatus = '';

  function bridge() {
    return (typeof AndroidBridge !== 'undefined') ? AndroidBridge : null;
  }

  /* 设备名（mqtt.json 的 name）：**必须和 Java 侧一样用这个名字**。
     Java 的 MqttClient.slug 取的就是它，discovery/availability 都按它发；JS 侧若改用设备型号，
     一旦「名称」和型号不一致，state 就会发到另一条主题上（HA 实体永远 unknown）。
     0.7.45 前只按型号取 slug，模拟器/改过名称的设备都会踩这个坑。 */
  function cfgName() {
    var b = bridge();
    var raw = (b && b.readText) ? b.readText(CFG_FILE) : '';
    if (!raw) return '';
    try { var o = JSON.parse(raw); return (o && o.name) ? String(o.name).trim() : ''; } catch (e) { return ''; }
  }

  function slug() {
    var nm = cfgName();
    if (nm) return nm;
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
      // HA 核心没有 mqtt.media_player 平台（实测 12 个 mqtt 平台里唯独它静默不建实体），
      // 所以音乐用 sensor（状态+歌名）+ 三个 button（播放/暂停/停止）表达。
      // 主题必须以 /config 结尾（discovery 订阅器只看 homeassistant/<component>/<object_id>/config）；
      // 0.7.32 及更早漏了这个后缀，导致 discovery 发到一条没人订阅的普通主题上。
      disc: 'homeassistant/sensor/homecontrol_panel_' + sl + '_music/config',
      discButtons: [
        'homeassistant/button/homecontrol_panel_' + sl + '_music_play/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_pause/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_stop/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_prev/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_next/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_volume_up/config',
        'homeassistant/button/homecontrol_panel_' + sl + '_music_volume_down/config'
      ],
      /* 音量走 HA 的 number 平台（mqtt 装载了它）：滑块下发纯数字，回读 state 里的 value_json.volume；
         另配两个按钮做 5% 步进，墙上点按比拖滑块方便 */
      discVolume: 'homeassistant/number/homecontrol_panel_' + sl + '_music_volume/config',
      /* 电量：sensor + device_class battery，值取 state 里的 battery 字段 */
      discBattery: 'homeassistant/sensor/homecontrol_panel_' + sl + '_battery/config'
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
    /* 音量 +/- 按钮：步长 5%，夹在 0..100（runCmd 里用当前音量算新值） */
    if (p === 'volume_up' || p === 'volup') return 'volup';
    if (p === 'volume_down' || p === 'voldown') return 'voldown';
    /* HA 的 number 滑块发的是纯数字（"37" 或 "37.0"），按音量百分比理解 */
    if (/^[0-9]{1,3}(\.[0-9]+)?$/.test(p)) {
      var v = Math.max(0, Math.min(100, Math.round(parseFloat(p))));
      return 'volume:' + v;
    }
    return null;
  }

  function runCmd(payload) {
    var m = mapCmd(payload);
    if (!m) return;
    var mu = window.MusicUI;
    if (!mu) return;
    var playing = !!(mu.isPlaying && mu.isPlaying());
    if (m === 'play') {
      /* 冷启动没选歌时 togglePlay 只会弹一句「先去右侧歌单里点一首」，
         HA 的播放按钮就变成哑的 —— 走 playDefault：自动开音乐页 + 播第一首 */
      if (!playing) { if (mu.playDefault) mu.playDefault(); else mu.togglePlay(); }
    }
    else if (m === 'pause') { if (playing) mu.togglePlay(); }
    else if (m === 'stop') { if (mu.stopPlay) mu.stopPlay(); else if (playing) mu.togglePlay(); }
    else if (m === 'toggle') { mu.togglePlay(); }
    else if (m === 'next') { mu.next(); }
    else if (m === 'prev') { if (mu.prevTrack) mu.prevTrack(); else mu.prev(); }
    else if (m.indexOf('volume:') === 0) {
      if (mu.setVolume) mu.setVolume(parseInt(m.slice(7), 10));
    }
    else if (m === 'volup' || m === 'voldown') {
      if (mu.setVolume && mu.volume) {
        var cur = mu.volume();
        var step = VOL_STEP;
        mu.setVolume(Math.max(0, Math.min(100, cur + (m === 'volup' ? step : -step))));
      }
    }
    pushState(); /* 命令执行完立刻回报一次，HA 滑块不用等下一轮轮询 */
  }

  /* 状态上报载荷：idle / paused / playing + 当前歌名（HA attribute 显示） */
  /* 电量：桥的 battery() 返回 {level, charging}；取不到就报 null，HA 侧显示 unknown 而不是 0 */
  function batteryInfo() {
    var b = bridge();
    if (!b || !b.battery) return { level: null, charging: false };
    try {
      var o = JSON.parse(b.battery());
      var lv = parseInt(o.level, 10);
      return { level: (isFinite(lv) && lv >= 0) ? lv : null, charging: !!o.charging };
    } catch (e) { return { level: null, charging: false }; }
  }

  function statePayload() {
    var mu = window.MusicUI;
    var track = (mu && mu.playing) ? mu.playing() : null;
    var status = !track ? 'idle' : (mu.isPlaying && mu.isPlaying() ? 'playing' : 'paused');
    var vol = (mu && mu.volume) ? mu.volume() : null;
    var bt = batteryInfo();
    return JSON.stringify({ status: status, title: (track && track.title) || '', volume: vol,
      battery: bt.level, charging: bt.charging });
  }

  /* 主动发一次状态（命令执行完立即回报；轮询也走这里） */
  function pushState() {
    var b = bridge();
    if (!b || !b.mqttPublish) return;
    var c = readCfg();
    if (!c.enabled) return;
    var p = statePayload();
    if (p === lastSent) return;
    if (b.mqttPublish(topics(slug()).state, p, '0')) lastSent = p;
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
      '<div class="sheet-desc">接上 MQTT 后，HA 里会出现「中控屏音乐」传感器（状态 playing/paused/idle，歌名看属性）' +
      '、播放/暂停/停止/上一曲/下一曲 按钮、音量滑块与 音量+/音量- 按钮，' +
      '以及「中控屏电量」传感器（含是否充电属性）。' +
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
      // 刚连上（含 broker 踢线后重连）：清掉 lastSent，让下一轮轮询把当前状态重发一次。
      // discovery/availability 都是非 retain，HA 重启或实体刚建时 state 是未知的，必须主动补一条。
      if (s.state === 'connected' || s.state === 'connected-no-sub') lastSent = '';
      lastStatus = json;
      if (s.state === 'connected') toast('MQTT 已连接：HA 里会有「中控屏音乐」+ 播放/暂停/停止/上下曲/音量按钮 和「中控屏电量」');
      else if (s.state === 'connected-no-sub') toast('MQTT 已连接（订阅被 broker 拒：过滤器非法/ACL，HA 只能看状态）');
      else if (s.state === 'offline') toast('MQTT 连不上：' + (s.err || '重试中'));
    } catch (e) { }
  };

  /* 状态轮询：变了才发；未启用/没连上时桥自己返回 false，零成本 */
  setInterval(pushState, POLL_MS);

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
