/* 配置中枢：面板所有「用户配置」都从这里进出。
   - 键名集中声明：设置（hc.prefs）、界面编辑（hc.edit / hc.names / hc.icons / hc.hidden）、音乐（hc.music*）
   - snapshot()/applyBundle() 负责一进一出，带 schema 版本号
   - toFile()/fromFile() 走 Android 桥的 writeText/readText → /sdcard/HomeControl/panel-config.json
   - push()/pull() 走 Home Assistant 的 frontend/get_user_data / set_user_data
     （存在 HA 里那个登录账户自己的 user data 下，键名 homecontrol.panel_config.<设备>，
     每台屏各存各的：各设备显示的内容不一样，不能互相覆盖）
   - 只手动备份、手动恢复：开机不比对、改完不自动上传（用户明确要求）
   - 临时状态（当前房间、重载标记、引导看过没有…）不算配置，见 TRANSIENT */
(function () {
  'use strict';

  var SCHEMA = 1;
  var APP = 'homecontrol';
  /* 账户键的前缀；真正的键名按设备分开（见 ns()） */
  var NS_BASE = 'homecontrol.panel_config';
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

  /* ---------------- 设备身份：HA 里每台屏一份配置 ---------------- */
  /* 型号 slug（和 app.js 的 selfSlug 同算法：实体的设备后缀） */
  function modelSlug() {
    var m = '';
    try { var i = JSON.parse(window.AndroidBridge.info()); m = String(i.model || ''); } catch (e) { }
    m = m.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return m || 'panel';
  }

  /* 安卓设备 id 的后 8 位；拿不到就退回一个本地随机串（首次生成后固定） */
  function deviceAid() {
    var aid = '';
    try { var i = JSON.parse(window.AndroidBridge.info()); aid = String(i.aid || ''); } catch (e) { }
    if (!aid) {
      try { aid = localStorage.getItem('hc.devid') || ''; } catch (e) { aid = ''; }
      if (!aid) {
        aid = '';
        for (var k = 0; k < 12; k++) aid += Math.floor(Math.random() * 16).toString(16);
        try { localStorage.setItem('hc.devid', aid); } catch (e) { }
      }
    }
    return aid.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  /* 设备标识：型号 + 设备 id 尾段（两台同型号的 MI PAD 2 不会互相覆盖） */
  function deviceTag() {
    var aid = deviceAid();
    return modelSlug() + (aid ? '-' + aid.slice(-8) : '');
  }

  /* 这台设备在 HA 账户里的配置键 */
  function ns() { return NS_BASE + '.' + deviceTag(); }

  var transport = null;
  var listeners = [];
  var applying = false;
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

  /** 「这份配置有多少内容」：跨设备同步靠它判断谁该覆盖谁。
      新平板开机写下的默认值内容很少，不会把另一台上传的完整配置盖掉。 */
  function richness(o) {
    var d = (o && o.data) || {}, n = 0;
    if (d.prefs) n += Object.keys(d.prefs).length;
    if (d.edit) {
      n += d.edit.added ? Object.keys(d.edit.added).length : 0;
      n += d.edit.hidden ? Object.keys(d.edit.hidden).length : 0;
      n += d.edit.extra ? Object.keys(d.edit.extra).length : 0;
      n += d.edit.rows ? Object.keys(d.edit.rows).length : 0;
    }
    if (d.names) n += Object.keys(d.names).length;
    if (d.icons) n += Object.keys(d.icons).length;
    if (d.hidden && d.hidden.length) n += d.hidden.length;
    if (d.music) n += 1;
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

  function cd(cb, ok, msg, data) { if (typeof cb === 'function') cb(ok, msg, data); }

  /* ---------------- HA 用户账户 ---------------- */
  function bindTransport(t) { transport = t || null; }

  /* 账户里那份配置的内容量与时间：决定谁覆盖谁。
     新平板开机写下的默认值内容很少，不该把另一台上传的完整配置盖掉。 */
  var remote = null;

  function shortTime(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

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

  /** 手动「备份到 HA」：把本机这份配置写进本设备的账户键（覆盖上一次备份）。
      不做内容量比较——用户点了备份就是要用现在这份覆盖。 */
  function push(cb) {
    var b = bundle(), local = richness(b);
    if (!local) { lastPushOk = false; lastMsg = '这台平板还没有配置，不上传'; cd(cb, false, lastMsg); return; }
    var key = ns();
    var msg = { type: 'frontend/set_user_data', key: key, value: b };
    call(msg, function (ok, res) {
      if (ok) {
        lastPush = Date.now();
        lastPushOk = true;
        remote = { rich: local, savedAt: b.savedAt };
        lastMsg = '本设备配置已备份到 HA（' + local + ' 项，' +
          Math.round(JSON.stringify(b).length / 102.4) / 10 + ' KB）';
        cd(cb, true, lastMsg);
      } else {
        lastPushOk = false;
        lastMsg = String(res || '备份失败');
        cd(cb, false, lastMsg);
      }
    });
  }

  /** 只读本设备的账户存档，不动本地 */
  function remoteGet(cb) {
    call({ type: 'frontend/get_user_data', key: ns() }, function (ok, res) {
      if (!ok) { cd(cb, false, String(res || '读取失败')); return; }
      var v = res && res.value;
      if (!v) { cd(cb, true, '', null); return; }
      var b = parseBundle(v);
      if (!b) { cd(cb, false, 'HA 里的配置格式不认识'); return; }
      cd(cb, true, '', b);
    });
  }

  /** 手动「从本设备备份恢复」：只读本设备的键，别的设备的存档不碰 */
  function pull(cb) {
    remoteGet(function (ok, msg, b) {
      if (!ok) { cd(cb, false, msg || '读取失败'); return; }
      if (!b) { cd(cb, false, '这台设备在 HA 里还没有备份'); return; }
      remote = { rich: richness(b), savedAt: b.savedAt };
      applyBundle(b);
      cd(cb, true, '已从本设备备份恢复（' + remote.rich + ' 项，存于 ' + shortTime(b.savedAt) + '）');
    });
  }

  /** 查一下本设备在账户里的备份情况（只读，给设置页显示） */
  function refreshRemote(cb) {
    remoteGet(function (ok, msg, b) {
      if (ok) remote = b ? { rich: richness(b), savedAt: b.savedAt } : null;
      cd(cb, ok, ok ? '' : (msg || '读取失败'), remote);
    });
  }

  /** 通用出口：别的模块（诊断日志）要发 WS 请求时用它，不用自己摸 transport */
  function wsCall(msg, cb) { call(msg, cb); }

  /** 存一份任意 key 的用户数据（frontend/set_user_data） */
  function putUser(key, value, cb) {
    call({ type: 'frontend/set_user_data', key: String(key), value: value }, function (ok, res) {
      cd(cb, ok, ok ? 'ok' : String(res || '写入失败'));
    });
  }

  /** 调一个 HA 服务（给「发一条通知」这种用） */
  function service(domain, name, data, cb) {
    call({ type: 'call_service', domain: String(domain), service: String(name), service_data: data || {} },
      function (ok, res) { cd(cb, ok, ok ? 'ok' : String(res || '调用失败')); });
  }

  function status() {
    return {
      available: available(),
      lastPush: lastPush,
      lastOk: lastPushOk,
      msg: lastMsg,
      ns: ns(),
      file: FILE,
      remoteRich: remote ? remote.rich : 0,
      remoteAt: remote ? shortTime(remote.savedAt) : ''
    };
  }

  window.HCStore = {
    SCHEMA: SCHEMA,
    NS: NS_BASE,
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
    wsCall: wsCall,
    putUser: putUser,
    service: service,
    pull: pull,
    remoteGet: remoteGet,
    refreshRemote: refreshRemote,
    ns: ns,
    deviceTag: deviceTag,
    richness: richness,
    status: status,
    reloadPanel: reloadPanel
  };
})();
