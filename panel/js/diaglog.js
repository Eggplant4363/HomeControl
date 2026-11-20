/* 面板诊断日志（ES5，Chromium 57 可用）
 *
 * 为什么需要它：MI PAD 2（Android 5.1）偶尔「自动闪退」，logcat 一重启就没了、没 root 也读不到
 * dropbox。原生侧（PanelLog.java）已经把生命周期 / JS 报错 / 内存水位 / 未捕获异常写进
 * /sdcard/HomeControl/logs/panel.log；这个模块负责两件事：
 *   1) 把面板这一侧的信息也记进去（JS 异常、心跳、关键动作），出问题时两边能对上时间；
 *   2) 把整份日志「上传到 HA」——一份完整 JSON 存进用户账户（frontend/set_user_data，
 *      key = homecontrol.panel_log），同时发一条 persistent_notification 摘要，在 HA 界面上直接能看。
 *
 * 另外一个关键行为：如果上次是异常退出（没有 exit 行 / 有 crash.log 且还没上传过），
 * 面板下次起来会自己把上次的现场传上去一次，用户不用记得点按钮。
 */
(function (w) {
  'use strict';

  var RING = [], RING_MAX = 240;
  var HEART_MS = 60000;
  var LOG_KEY = 'homecontrol.panel_log';
  var NOTIFY_ID = 'homecontrol_panel_log';
  var timer = null, installed = false, lastUpload = 0, lastMsg = '';

  function now() { return new Date(); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function stamp() {
    var d = now();
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function iso(d) {
    d = d || now();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function bridge() {
    var b = w.AndroidBridge;
    return (b && b.logJs) ? b : null;
  }

  function push(text) {
    RING.push(text);
    while (RING.length > RING_MAX) RING.shift();
  }

  /** 记一行：内存里留一份（上传时用），桥在就同时落盘 */
  function note(msg) {
    var line = stamp() + ' ' + msg;
    push(line);
    var b = bridge();
    if (b) { try { b.logJs(msg); } catch (e) { } }
    return line;
  }

  function info() {
    var b = bridge();
    if (!b || !b.logInfo) return null;
    try {
      return JSON.parse(b.logInfo());
    } catch (e) {
      return null;
    }
  }

  function tail(maxBytes) {
    var b = bridge();
    if (!b || !b.logTail) return '';
    try {
      return String(b.logTail(maxBytes || 131072));
    } catch (e) {
      return '';
    }
  }

  function pending() {
    var b = bridge();
    if (!b || !b.logPending) return false;
    try {
      return !!b.logPending();
    } catch (e) {
      return false;
    }
  }

  function markSent() {
    var b = bridge();
    if (!b || !b.logMarkSent) return;
    try { b.logMarkSent(); } catch (e) { }
  }

  /* ---------------- 面板状态摘要 ---------------- */
  function panelState() {
    var out = { url: String(w.location ? w.location.pathname : '') };
    try {
      out.viewport = w.innerWidth + 'x' + w.innerHeight;
      out.tiles = document.querySelectorAll('#grid .tile').length;
      out.rooms = document.querySelectorAll('[data-act="room"]').length;
      out.entities = (w.__PANEL_TEST__ && w.__PANEL_TEST__.stats) ?
        (w.__PANEL_TEST__.stats().entities || 0) : 0;
      out.sheets = (document.getElementById('sheet') || {}).className || '';
      out.editing = !!(document.getElementById('grid') &&
        document.getElementById('grid').className.indexOf('editing') >= 0);
    } catch (e) { }
    return out;
  }

  function deviceState() {
    var b = w.AndroidBridge, out = {};
    if (b && b.info) {
      try {
        var i = JSON.parse(b.info());
        out.model = i.model;
        out.sdk = i.sdk;
        out.ver = i.ver;
        out.verCode = i.verCode;
        out.beatAge = i.beatAge;
      } catch (e) { }
    }
    out.ua = String(w.navigator ? w.navigator.userAgent : '');
    out.time = iso();
    return out;
  }

  /** 整份现场：设备 + 面板 + 面板这侧的日志环 + 原生日志尾部 */
  function bundle(why) {
    var inf = info() || {};
    var data = {
      app: 'homecontrol',
      kind: 'panel-log',
      why: why || 'manual',
      savedAt: iso(),
      device: deviceState(),
      panel: panelState(),
      logFile: inf,
      js: RING.slice(0),
      native: tail(131072)
    };
    return data;
  }

  function kb(n) { return Math.round(n / 102.4) / 10 + ' KB'; }

  /** 摘要：给 persistent_notification 用，太长会被 HA 截断 */
  function excerpt(data) {
    var lines = String(data.native || '').split('\n');
    var pick = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      if (l.indexOf('fatal') >= 0 || l.indexOf('watchdog') >= 0 || l.indexOf('js.err') >= 0 ||
        l.indexOf('[boot]') >= 0 || l.indexOf('[exit]') >= 0 || l.indexOf('mem') >= 0 ||
        l.indexOf('page]') >= 0) {
        pick.push(l);
      }
    }
    if (pick.length > 24) pick = pick.slice(pick.length - 24);
    var head = '版本 ' + ((data.device && data.device.ver) || '?') +
      ' · ' + ((data.device && data.device.model) || '?') +
      ' · 上传于 ' + data.savedAt;
    var body = pick.length ? ('\n\n关键行：\n' + pick.join('\n')) : '';
    var s = head + body;
    if (s.length > 2200) s = s.slice(0, 2200) + '…';
    return s;
  }

  /** 上传到 HA：完整 JSON 进用户账户，摘要发一条通知 */
  function upload(opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    if (!w.HCStore || !w.HCStore.putUser) { done(cb, false, '这一版没有配置模块，传不了'); return; }
    if (!w.HCStore.available()) { done(cb, false, 'HA 没连上，等连上再传'); return; }
    var data = bundle(opts.why || 'manual');
    var text = JSON.stringify(data);
    note('上传日志（' + Math.round(text.length / 1024) + ' KB，原因 ' + data.why + '）');
    w.HCStore.putUser(LOG_KEY, data, function (ok, msg) {
      if (!ok) { done(cb, false, '上传失败：' + msg); return; }
      markSent();
      w.HCStore.service('persistent_notification', 'create', {
        notification_id: NOTIFY_ID,
        title: '中控屏日志（' + ((data.device && data.device.model) || '面板') + '）',
        message: excerpt(data)
      }, function (nOk) {
        lastUpload = Date.now();
        var out = ok && nOk ? '日志已上传到 HA（' + Math.round(text.length / 1024) + ' KB）' +
          (opts.silent ? '' : '，也在 HA 通知里留了一份摘要')
          : '日志已存进 HA 账户（通知没发出去）';
        done(cb, true, out);
      });
    });
  }

  function done(cb, ok, msg) {
    lastMsg = msg;
    note((ok ? 'OK ' : 'ERR ') + msg);
    if (typeof cb === 'function') cb(ok, msg);
  }

  /** 另存一份到平板存储（adbd / 文件管理器直接能拷走） */
  function exportFile(cb) {
    var b = w.AndroidBridge;
    if (!b || !b.writeText) { done(cb, false, '这一版没有壳 App，存不了文件'); return; }
    var data = bundle('manual');
    var path = '/sdcard/HomeControl/logs/panel-log-' +
      String(Date.now()) + '.json';
    var ok = false;
    try {
      ok = b.writeText(path, JSON.stringify(data, null, 2));
    } catch (e) {
      ok = false;
    }
    done(cb, !!ok, ok ? ('已存到 ' + path) : '存文件失败');
  }

  function clear(cb) {
    var b = w.AndroidBridge;
    RING.length = 0;
    if (b && b.logClear) { try { b.logClear(); } catch (e) { } }
    note('日志已清空');
    done(cb, true, '日志已清空');
  }

  function status() {
    var inf = info() || {};
    return {
      file: inf.dir ? (inf.dir + '/' + 'panel.log') : '/sdcard/HomeControl/logs/panel.log',
      size: inf.size || 0,
      pending: !!inf.pending,
      crashFile: !!inf.crashFile,
      lastUpload: lastUpload,
      msg: lastMsg,
      jsLines: RING.length
    };
  }

  /* ---------------- 安装：JS 异常 + 心跳 + 上次崩溃自传 ---------------- */
  function install() {
    if (installed) return;
    installed = true;
    var prevOnError = w.onerror;
    w.onerror = function (msg, src, line, col, err) {
      var text = String(msg) + ' @' + String(src || '') + ':' + (line || 0) + ':' + (col || 0);
      if (err && err.stack) text += ' | ' + String(err.stack).split('\n').slice(0, 3).join(' / ');
      note('window.onerror ' + text);
      if (typeof prevOnError === 'function') {
        try { return prevOnError.apply(w, arguments); } catch (e) { }
      }
      return false;
    };
    if (w.addEventListener) {
      w.addEventListener('unhandledrejection', function (ev) {
        var r = ev && ev.reason;
        note('unhandledrejection ' + (r && r.stack ? String(r.stack).split('\n')[0] : String(r)));
      }, false);
    }
    note('面板启动 ' + (w.navigator ? String(w.navigator.userAgent).slice(0, 60) : ''));
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var s = panelState();
      note('hb tiles=' + s.tiles + ' entities=' + s.entities + ' editing=' + (s.editing ? 1 : 0));
    }, HEART_MS);
    /* 上次异常退出：起来后自传一次，不用等用户去点 */
    if (pending()) {
      note('检测到上次异常退出，自动上传现场');
      setTimeout(function () { upload({ why: 'crash', silent: true }, function () { }); }, 8000);
    }
  }

  w.HCDiag = {
    install: install,
    note: note,
    info: info,
    tail: tail,
    pending: pending,
    bundle: bundle,
    excerpt: excerpt,
    upload: upload,
    exportFile: exportFile,
    clear: clear,
    status: status,
    LOG_KEY: LOG_KEY,
    RING: RING
  };
})(window);
