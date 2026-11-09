/* 面板自己注册成 HA 实体：POST /api/states（实测 201 新建）+ 原生 battery() 桥方法 */
const fs = require('fs');
const JS = 'panel/js/app.js';
const JAVA = 'app/src/com/homecontrol/panel/MainActivity.java';
const patches = [];

function patch(file, from, to, marker) {
  const s = fs.readFileSync(file, 'utf8');
  const eol = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const f = from.replace(/\n/g, eol), t = to.replace(/\n/g, eol);
  if (marker && s.indexOf(marker) > -1) { patches.push(file + ' 已打过，跳过'); return; }
  const n = s.split(f).length - 1;
  if (n !== 1) throw new Error('MISS ' + file + ' x' + n + ' :: ' + from.slice(0, 50));
  fs.writeFileSync(file, s.replace(f, t));
  patches.push(file + ' +' + (t.length - f.length));
}

/* ---------- Java：battery() ---------- */
patch(JAVA,
`            return "{\\"ip\\":\\"" + ip + "\\",\\"ssid\\":\\"" + ssid + "\\"}";
        }
`,
`            return "{\\"ip\\":\\"" + ip + "\\",\\"ssid\\":\\"" + ssid + "\\"}";
        }

        /** 电池状态：注册成 HA 实体时上报电量。sticky intent，不用注册 receiver */
        @JavascriptInterface
        public String battery() {
            int level = -1, scale = 100, status = 0;
            try {
                android.content.Intent bi = getApplicationContext().registerReceiver(
                        null, new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
                if (bi != null) {
                    level = bi.getIntExtra(android.content.Intent.EXTRA_LEVEL, -1);
                    scale = bi.getIntExtra(android.content.Intent.EXTRA_SCALE, 100);
                    status = bi.getIntExtra(android.content.Intent.EXTRA_STATUS, 0);
                }
            } catch (Throwable t) { }
            int pct = (level < 0 || scale <= 0) ? -1 : Math.round(level * 100f / scale);
            boolean charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                    || status == android.os.BatteryManager.BATTERY_STATUS_FULL;
            return "{\\"level\\":" + pct + ",\\"charging\\":" + (charging ? "true" : "false") + "}";
        }
`, 'public String battery()');

/* ---------- app.js：自己注册模块（贴在 applyTheme 之后） ---------- */
patch(JS,
`  function applyTheme(name) {
    var light = name === 'light';
    document.documentElement.className = light ? 'hc-light' : '';
    renderGrid(true);
  }
`,
`  function applyTheme(name) {
    var light = name === 'light';
    document.documentElement.className = light ? 'hc-light' : '';
    renderGrid(true);
  }

  /* ---------------- 把自己挂进 Home Assistant ---------------- */
  /* HA 的 REST 允许 POST /api/states/<entity_id>（实测 201：不存在就新建），所以面板
      不用 MQTT 也能上报自己：主状态 + 连接 + 电量 + 充电 + 夜间模式开关。
      夜间开关是双向的：面板写自己的皮肤，HA 那边把开关拨了，面板跟着换皮肤。 */
  var SELF = {
    main: 'sensor.homecontrol_panel',
    conn: 'binary_sensor.homecontrol_panel_connected',
    batt: 'sensor.homecontrol_panel_battery',
    charg: 'binary_sensor.homecontrol_panel_charging',
    dark: 'switch.homecontrol_panel_dark_mode'
  };
  var selfWritten = {};      /* 我们最后写出去的值；只有 HA 那边改了它才动皮肤 */

  function selfInfo() {
    var b = window.AndroidBridge;
    var out = { model: 'MI PAD 2', ver: '?', sdk: 0, ip: '', ssid: '', theme: isLight() ? 'light' : 'dark', battery: -1, charging: false };
    if (b && b.info) {
      try { var i = JSON.parse(b.info()); if (i.model) out.model = i.model; if (i.ver) out.ver = i.ver; out.sdk = i.sdk || 0; } catch (e) { }
    }
    if (b && b.netInfo) { try { var n = JSON.parse(b.netInfo()); out.ip = n.ip || ''; out.ssid = n.ssid || ''; } catch (e) { } }
    if (b && b.battery) { try { var bt = JSON.parse(b.battery()); out.battery = bt.level; out.charging = !!bt.charging; } catch (e) { } }
    return out;
  }

  function selfPost(ent, state, attrs) {
    if (!S.real || !S.backend || !S.backend.rest) return;
    selfWritten[ent] = state;
    S.backend.rest('POST', '/api/states/' + ent, { state: state, attributes: attrs || {} }, function (ok, code) {
      if (!ok) actLog('self ' + ent + ' 写入失败 ' + (code || '网络'));
    });
  }

  function reportSelf() {
    if (!S.real) return;
    var info = selfInfo();
    var online = !!(S.status && S.status.connected);
    var seen = new Date().toISOString();
    var name = 'HomeControl 面板（' + info.model + '）';
    selfPost(SELF.main, online ? 'online' : 'offline', {
      friendly_name: name, model: info.model, app_version: info.ver, sdk: info.sdk,
      ip: info.ip, ssid: info.ssid, theme: info.theme, battery: info.battery,
      charging: info.charging, last_seen: seen, by: 'panel'
    });
    selfPost(SELF.conn, online ? 'on' : 'off', {
      friendly_name: name + ' · 连接', device_class: 'connectivity', last_seen: seen, by: 'panel'
    });
    if (info.battery >= 0) {
      selfPost(SELF.batt, String(info.battery), {
        friendly_name: name + ' · 电量', device_class: 'battery', unit_of_measurement: '%',
        charging: info.charging, last_seen: seen, by: 'panel'
      });
      selfPost(SELF.charg, info.charging ? 'on' : 'off', {
        friendly_name: name + ' · 充电', device_class: 'charging', last_seen: seen, by: 'panel'
      });
    }
    selfPost(SELF.dark, isLight() ? 'off' : 'on', {
      friendly_name: name + ' · 夜间模式', last_seen: seen, by: 'panel'
    });
  }

  /* HA 那边拨了开关就跟着换皮肤（selfWritten 让我们不把自己的写入当成外部指令） */
  function selfFollow(states) {
    var sw = states && states[SELF.dark];
    if (!sw || selfWritten[SELF.dark] === undefined) return;
    if (sw.state === selfWritten[SELF.dark]) return;
    var want = sw.state === 'on' ? 'dark' : 'light';
    selfWritten[SELF.dark] = sw.state;
    if (prefs().theme !== want) {
      actLog('HA 改夜间模式 → ' + want);
      setPref('theme', want);
      reportSelf();
    }
  }
`, null, '把自己挂进 Home Assistant');

/* ---------- app.js：每次状态推送都检查开关 ---------- */
patch(JS,
`    S.states = states;
    renderWeather();`,
`    S.states = states;
    selfFollow(states);
    renderWeather();`, 'selfFollow(states);');

/* ---------- app.js：定时上报 ---------- */
patch(JS,
`    setInterval(heartbeat, 4000);`,
`    setInterval(heartbeat, 4000);
    /* 每分钟向 HA 报一次自己的状态；连上后 3 秒先报一次（这时实体才齐） */
    setInterval(reportSelf, 60000);
    setTimeout(reportSelf, 3000);`, null, 'setInterval(reportSelf');

console.log(patches.join('\n'));
