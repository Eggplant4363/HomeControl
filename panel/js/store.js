/* 配置中枢：面板所有「用户配置」都从这里进出。
   - 键名集中声明：设置（hc.prefs）、界面编辑（hc.edit / hc.names / hc.icons / hc.hidden）、音乐（hc.music*）
   - snapshot()/applyBundle() 负责一进一出，带 schema 版本号
   - toFile()/fromFile() 走 Android 桥的 writeText/readText → /sdcard/HomeControl/panel-config.json
   - pull()/push() 走 Home Assistant 的 frontend/get_user_data / set_user_data
     （存在 HA 里那个登录账户自己的 user data 下，键名 homecontrol.panel_config）
   - 临时状态（当前房间、重载标记、引导看过没有…）不算配置，见 TRANSIENT */
(function () {
  'use strict';

  var SCHEMA = 1;
  var APP = 'homecontrol';
  var NS = 'homecontrol.panel_config';
  var FILE = '/sdcard/HomeControl/panel-config.json';

  /* 真正会被导出/同步的配置键（HCStore 对外的短名 → localStorage 键） */
  var K = {
    prefs: 'hc.prefs',
    edit: 'hc.edit',
    names: 'hc.names',
    icons: 'hc.icons',
    hidden: 'hc.hidden',
    music: 'hc.music',
    musicVol: 'hc.music.vol',
    musicMode: 'hc.music.mode'
  };
  var ORDER = ['prefs', 'edit', 'names', 'icons', 'hidden', 'music', 'musicVol', 'musicMode'];

  /* 不算配置的本地状态：不导出、不同步、随便清 */
  var TRANSIENT = ['hc.room', 'hc.reload', 'hc.guide.v1', 'hc.hint.v1', 'hc.selftest.done'];

  var transport = null;
  var listeners = [];
  var auto = true;
  var applying = false;
  var pushTimer = null;
  var lastPush = 0;
  var lastPushOk = false;
  var lastMsg = '';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  function lsKey(k) { return K[k] || k; }

  function get(k) { return lsGet(lsKey(k)); }

  function set(k, raw) {
    var key = lsKey(k);
    if (raw === null || raw === undefined || raw === '') lsDel(key);
    else lsSet(key, String(raw));
    changed(k);
  }

  function getJSON(k, def) {
    var raw = get(k);
    if (!raw) return def;
    try {
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : def;
    } catch (e) { return def; }
  }

  function setJSON(k, obj) { set(k, JSON.stringify(obj || {})); }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function changed(key) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](key, applying); } catch (e) { }
    }
    if (!applying) schedulePush();
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return ''; }
  }

  /** 当前配置的完整快照（可直接 JSON.stringify 存文件 / 存 HA） */
  function bundle() {
    var data = {}, i, k, raw, v;
    for (i = 0; i < ORDER.length; i++) {
      k = ORDER[i];
      raw = lsGet(K[k]);
      if (!raw) continue;
      if (k === 'musicVol') {
        v = Number(raw);
        if (isFinite(v)) data[k] = v;
        continue;
      }
      try { data[k] = JSON.parse(raw); } catch (e) { }
    }
    return { app: APP, schema: SCHEMA, savedAt: nowIso(), data: data };
  }

  /** 摘要：给设置页显示一眼能看懂的数字 */
  function summary() {
    var b = bundle(), d = b.data, n = {};
    n.prefs = d.prefs ? Object.keys(d.prefs).length : 0;
    n.added = d.edit && d.edit.added ? Object.keys(d.edit.added).length : 0;
    n.hidden = d.edit && d.edit.hidden ? Object.keys(d.edit.hidden).length : 0;
    n.extra = d.edit && d.edit.extra ? Object.keys(d.edit.extra).length : 0;
    n.rows = d.edit && d.edit.rows ? Object.keys(d.edit.rows).length : 0;
    n.names = d.names ? Object.keys(d.names).length : 0;
    n.icons = d.icons ? Object.keys(d.icons).length : 0;
    n.hiddenRooms = d.hidden && d.hidden.length ? d.hidden.length : 0;
    n.music = d.music ? 1 : 0;
    n.bytes = JSON.stringify(b).length;
    n.savedAt = b.savedAt;
    return n;
  }

  function parseBundle(o) {
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (e) { return null; }
    }
    if (!o || typeof o !== 'object') return null;
    if (o.app && o.app !== APP) return null;
    if (o.schema && Number(o.schema) > SCHEMA) return null;
    if (!o.data || typeof o.data !== 'object') return null;
    return o;
  }

  /** 把一份配置写回本地；opts.reload=false 时不重载页面（测试用） */
  function applyBundle(o, opts) {
    var b = parseBundle(o);
    if (!b) return false;
    var i, k, v;
    applying = true;
    for (i = 0; i < ORDER.length; i++) {
      k = ORDER[i];
      if (b.data[k] === undefined || b.data[k] === null) continue;
      v = b.data[k];
      if (k === 'musicVol') lsSet(K[k], String(v));
      else lsSet(K[k], JSON.stringify(v));
    }
    applying = false;
    for (i = 0; i < listeners.length; i++) {
      try { listeners[i]('*', true); } catch (e) { }
    }
    if (!(opts && opts.reload === false)) reloadPanel();
    return true;
  }

  function reloadPanel() {
    try {
      if (window.HCPanel && window.HCPanel.reboot) { window.HCPanel.reboot(); return; }
    } catch (e) { }
    try { window.location.reload(); } catch (e) { }
  }

  /* ---------------- 文件：/sdcard/HomeControl/panel-config.json ---------------- */
  function bridge() { return window.AndroidBridge || null; }

  function toFile(cb) {
    var b = bridge();
    if (!b || !b.writeText) { cb(false, '当前环境不能写文件'); return; }
    var text = JSON.stringify(bundle(), null, 2), ok = false;
    try { ok = b.writeText(FILE, text); } catch (e) { ok = false; }
    cd(cb, ok, ok ? '已保存到 ' + FILE : '写入失败（检查文件权限）');
  }

  function fromFile(cb) {
    var b = bridge();
    if (!b || !b.readText) { cb(false, '当前环境不能读文件'); return; }
    var text = '';
    try { text = b.readText(FILE) || ''; } catch (e) { text = ''; }
    if (!text) { cb(false, '没找到 ' + FILE); return; }
    var o = parseBundle(text);
    if (!o) { cd(cb, false, '文件内容不是有效配置'); return; }
    applyBundle(o);
    cd(cb, true, '已从文件恢复配置');
  }

  function cd(cb, ok, msg) { if (typeof cb === 'function') cb(ok, msg); }

  /* ---------------- HA 用户账户 ---------------- */
  function bindTransport(t) { transport = t || null; }

  function available() {
    try { return !!(transport && transport.available && transport.available()); } catch (e) { return false; }
  }

  function call(msg, cb) {
    if (!transport || !transport.request) { cd(cb, false, '没有可用的 HA 连接'); return; }
    var done = false, timer = setTimeout(function () {
      if (done) return;
      done = true;
      cd(cb, false, 'HA 没有响应');
    }, 6000);
    var sent = false;
    try {
      sent = transport.request(msg, function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cd(cb, true, res);
      });
    } catch (e) { sent = false; }
    if (!sent && !done) {
      done = true;
      clearTimeout(timer);
      cd(cb, false, '连接未就绪');
    }
  }

  function push(cb) {
    var b = bundle(), msg = { type: 'frontend/set_user_data', key: NS, value: b };
    call(msg, function (ok, res) {
      if (ok) {
        lastPush = Date.now();
        lastPushOk = true;
        lastMsg = 'HA 账户已同步（' + Math.round(JSON.stringify(b).length / 102.4) / 10 + ' KB）';
        cd(cb, true, lastMsg);
      } else {
        lastPushOk = false;
        lastMsg = String(res || '同步失败');
        cd(cb, false, lastMsg);
      }
    });
  }

  function pull(cb) {
    call({ type: 'frontend/get_user_data', key: NS }, function (ok, res) {
      if (!ok) { cd(cb, false, String(res || '读取失败')); return; }
      var v = res && res.value;
      if (!v) { cd(cb, false, 'HA 账户里还没有存过配置'); return; }
      var b = parseBundle(v);
      if (!b) { cd(cb, false, 'HA 里的配置格式不认识'); return; }
      applyBundle(b);
      cd(cb, true, '已从 HA 账户恢复配置');
    });
  }

  function schedulePush() {
    if (!auto || applying || !available()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      push(function () { });
    }, 2500);
  }

  function status() {
    return {
      auto: auto,
      available: available(),
      lastPush: lastPush,
      lastOk: lastPushOk,
      msg: lastMsg,
      ns: NS,
      file: FILE
    };
  }

  function setAuto(on) {
    auto = !!on;
    if (auto) schedulePush();
    return auto;
  }

  window.HCStore = {
    SCHEMA: SCHEMA,
    NS: NS,
    FILE: FILE,
    KEYS: K,
    TRANSIENT: TRANSIENT,
    get: get,
    set: set,
    getJSON: getJSON,
    setJSON: setJSON,
    onChange: onChange,
    bundle: bundle,
    summary: summary,
    applyBundle: applyBundle,
    toFile: toFile,
    fromFile: fromFile,
    bindTransport: bindTransport,
    available: available,
    push: push,
    pull: pull,
    setAuto: setAuto,
    status: status,
    reloadPanel: reloadPanel
  };
})();
