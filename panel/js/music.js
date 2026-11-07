/* 负一屏：音乐
   目标：从主屏往右滑（手指向右）拉出一页音乐，连接道理鱼 / Subsonic 兼容音乐服务，
   能看当前播放（封面 / 歌名 / 歌手 / 进度）、控制（播放暂停 / 上一首 / 下一首 / 音量）、
   点歌单里的歌就播。
   目标环境 Chromium 57：ES5、无 flex gap、无可选链、无 backdrop-filter。
   纯前端播放：音频直接交给 <audio>，API 走原生桥（file:// 里的 XHR 会被 CORS 拦）。
*/
(function () {
  'use strict';

  var MUSIC_KEY = 'hc.music';        /* localStorage：面板里改过的音乐设置 */
  var MUSIC_FILE = '/sdcard/HomeControl/music.json';  /* 部署时写一次即可 */
  var VOL_KEY = 'hc.music.vol';

  var S = {
    cfg: null,
    backend: null,
    audio: null,
    open: false,
    dragging: false,
    dx: 0,
    width: 1024,
    ready: false,
    loading: false,
    status: 'idle',       /* idle | connecting | ok | error | mock */
    statusText: '未配置',
    playlists: [],
    tracks: null,         /* 非空 = 正在看某个歌单的曲目 */
    crumb: '歌单',
    queue: [],
    qi: -1,
    track: null,
    playing: false,
    vol: 0.7,
    tickTimer: null,
    seekDrag: false,
    volDrag: false,
    el: {},
    cbSeq: 0,
    httpCbs: {},
    tone: null
  };

  /* ---------------- 小工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function toast(t) {
    if (window.__PANEL_TOAST__) window.__PANEL_TOAST__(t);
    else if (window.AndroidBridge && AndroidBridge.log) AndroidBridge.log('MUSIC ' + t);
  }
  function act(what) {
    if (window.__PANEL_ACTLOG__) window.__PANEL_ACTLOG__('music ' + what);
    else if (window.AndroidBridge && AndroidBridge.log) AndroidBridge.log('MUSIC ' + what);
  }
  function bridge() { return window.AndroidBridge || null; }

  /** 秒 → 3:07（负值 / 非法都当 0） */
  function fmtTime(sec) {
    var s = Math.floor(num(sec, 0));
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* ---------------- 配置 ---------------- */
  function defaultCfg() {
    var m = (window.PANEL_CONFIG && window.PANEL_CONFIG.music) || {};
    return {
      kind: m.kind || 'mock',          /* mock | subsonic | daoliyu */
      baseUrl: m.baseUrl || '',
      user: m.user || '',
      pass: m.pass || '',
      enabled: m.enabled !== false
    };
  }

  function readCfg() {
    var out = defaultCfg(), got = false;
    /* 先读 /sdcard/HomeControl/music.json（部署配置），再用 localStorage 覆盖（面板里改的） */
    var b = bridge();
    if (b && b.readText) {
      try {
        var raw = b.readText(MUSIC_FILE);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') { mergeCfg(out, o); got = true; }
        }
      } catch (e) { }
    }
    try {
      var ls = localStorage.getItem(MUSIC_KEY);
      if (ls) {
        var o2 = JSON.parse(ls);
        if (o2 && typeof o2 === 'object') { mergeCfg(out, o2); got = true; }
      }
    } catch (e2) { }
    if (!got && window.PANEL_CONFIG && window.PANEL_CONFIG.music) {
      mergeCfg(out, window.PANEL_CONFIG.music);
    }
    if (out.kind !== 'mock' && !out.baseUrl) out.kind = 'mock';
    return out;
  }

  function mergeCfg(dst, src) {
    for (var k in dst) {
      if (!dst.hasOwnProperty(k)) continue;
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') dst[k] = src[k];
    }
    return dst;
  }

  function saveCfg(o) {
    S.cfg = mergeCfg(defaultCfg(), o || {});
    try { localStorage.setItem(MUSIC_KEY, JSON.stringify(S.cfg)); } catch (e) { }
    var b = bridge();
    if (b && b.writeText) {
      try {
        b.writeText(MUSIC_FILE, JSON.stringify({
          kind: S.cfg.kind, baseUrl: S.cfg.baseUrl, user: S.cfg.user, pass: S.cfg.pass
        }));
      } catch (e2) { }
    }
    S.ready = false;
    S.playlists = [];
    S.tracks = null;
    S.crumb = '歌单';
    buildBackend();
    if (S.el.crumb) { paintCrumb(); paintList(); paintStatus(); }
  }

  function readVol() {
    try {
      var v = localStorage.getItem(VOL_KEY);
      if (v !== null) return clamp(num(v, 0.7), 0, 1);
    } catch (e) { }
    var m = (window.PANEL_CONFIG && window.PANEL_CONFIG.music) || {};
    return clamp(num(m.volume, 70) / 100, 0, 1);
  }

  /* ---------------- 封面（mock 用内联 SVG，不依赖网络） ---------------- */
  function mockCover(i, title) {
    var hue = [210, 268, 330, 24, 158][i % 5];
    var g = 'M0 0h300v300H0z';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + hue + ',46%,30%)"/>' +
      '<stop offset="1" stop-color="hsl(' + (hue + 26) + ',40%,12%)"/></linearGradient></defs>' +
      '<rect width="300" height="300" fill="url(#g)"/>' +
      '<circle cx="232" cy="66" r="96" fill="hsl(' + hue + ',70%,60%)" opacity="0.18"/>' +
      '<g fill="#eaf2ff" opacity="0.86">' +
      '<rect x="118" y="92" width="9" height="86" rx="4"/>' +
      '<rect x="127" y="92" width="46" height="9" rx="4"/>' +
      '<rect x="164" y="92" width="9" height="70" rx="4"/>' +
      '<circle cx="122" cy="188" r="16"/><circle cx="168" cy="170" r="13"/>' +
      '</g></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ---------------- mock 音源：现场合成一段 WAV（离线也能真的播） ---------------- */
  function toneUri() {
    if (S.tone) return S.tone;
    try {
      var rate = 11025, secs = 9, n = rate * secs;
      var buf = new ArrayBuffer(44 + n * 2);
      var v = new DataView(buf);
      function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, n * 2, true);
      var notes = [261.63, 329.63, 392.0, 523.25];
      for (var i = 0; i < n; i++) {
        var t = i / rate;
        var chord = Math.floor(t / 2.25) % notes.length;
        var f = notes[chord];
        var env = 0.5 + 0.5 * Math.sin(t * 0.6);            /* 缓慢呼吸，别太刺耳 */
        var s = Math.sin(2 * Math.PI * f * t) * 0.5 +
          Math.sin(2 * Math.PI * f * 1.5 * t) * 0.18 +
          Math.sin(2 * Math.PI * f * 2 * t) * 0.08;
        s = s * env * 0.24;
        v.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, s * 32767)), true);
      }
      var bytes = new Uint8Array(buf), bin = '', chunk = 8192;
      for (var j = 0; j < bytes.length; j += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + chunk, bytes.length)));
      }
      S.tone = 'data:audio/wav;base64,' + btoa(bin);
    } catch (e) {
      act('tone failed ' + e);
      S.tone = '';
    }
    return S.tone;
  }

  var MOCK_PLAYLISTS = [
    { id: 'mock-1', name: '夜里常放的几张', count: 4, tone: 0 },
    { id: 'mock-2', name: '客厅 · 轻爵士', count: 3, tone: 1 },
    { id: 'mock-3', name: '雨天钢琴', count: 3, tone: 2 }
  ];
  var MOCK_TRACKS = {
    'mock-1': [
      { id: 't1', title: '晚安，客厅', artist: 'Demo', album: '夜航', duration: 9, rate: 1 },
      { id: 't2', title: '暖光', artist: 'Demo', album: '夜航', duration: 12, rate: 0.75 },
      { id: 't3', title: '慢一点回家', artist: 'Demo', album: '夜航', duration: 9, rate: 1.15 },
      { id: 't4', title: '窗外的雨', artist: 'Demo', album: '夜航', duration: 12, rate: 0.75 }
    ],
    'mock-2': [
      { id: 't5', title: 'Afternoon', artist: 'Demo Band', album: 'Living Room', duration: 9, rate: 1 },
      { id: 't6', title: 'Blue Chair', artist: 'Demo Band', album: 'Living Room', duration: 12, rate: 0.75 },
      { id: 't7', title: 'Slow Coffee', artist: 'Demo Band', album: 'Living Room', duration: 9, rate: 1.15 }
    ],
    'mock-3': [
      { id: 't8', title: 'Rain on Glass', artist: 'Demo Piano', album: 'Rain', duration: 9, rate: 0.75 },
      { id: 't9', title: 'Sunday', artist: 'Demo Piano', album: 'Rain', duration: 9, rate: 1 },
      { id: 't10', title: 'Dusk', artist: 'Demo Piano', album: 'Rain', duration: 12, rate: 0.75 }
    ]
  };

  /* ---------------- 后端：mock / Subsonic 兼容（道理鱼多数版本是这个家族） ---------------- */
  function MockBackend() { this.kind = 'mock'; }

  MockBackend.prototype.playlists = function (cb) {
    var out = [];
    for (var i = 0; i < MOCK_PLAYLISTS.length; i++) {
      var p = MOCK_PLAYLISTS[i];
      out.push({ id: p.id, name: p.name, count: p.count, cover: mockCover(i, p.name) });
    }
    cb(null, out);
  };

  MockBackend.prototype.tracks = function (plId, cb) {
    var list = MOCK_TRACKS[plId] || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      out.push({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        duration: t.duration, cover: mockCover(i, t.title), rate: t.rate, mock: true
      });
    }
    cb(null, out);
  };

  MockBackend.prototype.streamUrl = function (t, cb) {
    /* mock 用同一段合成音；rate 决定听起来的高低（演示用，别当音质） */
    cb(null, toneUri(), t.rate || 1);
  };

  /* ---- Subsonic 兼容（Navidrome / Gonic / 道理鱼某些版本） ---- */
  function SubBackend(cfg) {
    this.kind = cfg.kind || 'subsonic';
    this.base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    this.user = cfg.user || '';
    this.pass = cfg.pass || '';
  }

  SubBackend.prototype.authQs = function () {
    /* Subsonic：u=用户 p=enc:十六进制密码（明文 p 有些服务器已禁用，enc: 最稳） */
    return 'u=' + encodeURIComponent(this.user) +
      '&p=enc:' + hexUtf8(this.pass) +
      '&v=1.16.1&c=HomeControl&f=json';
  };

  SubBackend.prototype.apiUrl = function (method, extra) {
    return this.base + '/rest/' + method + '?' + this.authQs() + (extra ? '&' + extra : '');
  };

  SubBackend.prototype.call = function (method, extra, cb) {
    var self = this;
    httpGet(this.apiUrl(method, extra), function (err, code, text) {
      if (err) { cb(err); return; }
      if (code !== 200) { cb('HTTP ' + code); return; }
      var o;
      try { o = JSON.parse(text); } catch (e) { cb('返回不是 JSON'); return; }
      var resp = o['subsonic-response'] || o['Subsonic-response'];
      if (!resp) { cb('不是 Subsonic 接口'); return; }
      if (resp.status && resp.status !== 'ok') {
        cb((resp.error && resp.error.message) || ('接口错误 ' + (resp.error && resp.error.code || '?')));
        return;
      }
      cb(null, resp);
    });
  };

  SubBackend.prototype.ping = function (cb) {
    this.call('ping', '', function (err) { cb(err || null); });
  };

  SubBackend.prototype.playlists = function (cb) {
    var self = this;
    this.call('getPlaylists', '', function (err, resp) {
      if (err) { cb(err); return; }
      var raw = (resp.playlists && resp.playlists.playlist) || [];
      if (!raw.length) { cb(null, []); return; }
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var p = raw[i];
        out.push({
          id: String(p.id), name: p.name || '未命名歌单', count: num(p.songCount, 0),
          cover: self.coverUrl(p.coverArt || p.id)
        });
      }
      cb(null, out);
    });
  };

  SubBackend.prototype.tracks = function (plId, cb) {
    var self = this;
    this.call('getPlaylist', 'id=' + encodeURIComponent(plId), function (err, resp) {
      if (err) { cb(err); return; }
      var raw = (resp.playlist && resp.playlist.entry) || [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i];
        out.push({
          id: String(s.id), title: s.title || '未命名', artist: s.artist || '',
          album: s.album || '', duration: num(s.duration, 0),
          cover: self.coverUrl(s.coverArt || s.id), rate: 1
        });
      }
      cb(null, out);
    });
  };

  SubBackend.prototype.coverUrl = function (id) {
    if (!id) return '';
    return this.apiUrl('getCoverArt', 'id=' + encodeURIComponent(id) + '&size=300');
  };

  SubBackend.prototype.streamUrl = function (t, cb) {
    cb(null, this.apiUrl('stream', 'id=' + encodeURIComponent(t.id)), 1);
  };

  /* ---- 道理鱼（Daoliyu）原生 REST：不是 Subsonic，走 /api/* + Bearer ----
     登录 POST /api/auth/login {email,username,password} -> {token}
     歌单 GET /api/playlists/web/mine -> 数组
     曲目 GET /api/playlists/{id}/tracks?skip=&take= -> {items:[{order,track}]}
     封面 GET /api/cover?path=<coverArtPath>&size=300
     音频 GET /api/tracks/{id}/stream?token=  （<audio> 直接当 src，不吃 CORS） */
  function DaoliyuBackend(cfg) {
    this.kind = 'daoliyu';
    var base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    if (/\/api$/i.test(base)) base = base.slice(0, -4);
    this.base = base;
    this.user = cfg.user || '';
    this.pass = cfg.pass || '';
    this.token = '';
  }

  DaoliyuBackend.prototype.login = function (cb) {
    var self = this;
    var body = JSON.stringify({ email: this.user, username: this.user, password: this.pass });
    httpReq('POST', this.base + '/api/auth/login', null, body, function (err, code, text) {
      if (err) { cb(err); return; }
      var o = null;
      try { o = JSON.parse(text); } catch (e) { }
      if (!o || !o.token) { cb(errText(o, code)); return; }
      self.token = String(o.token);
      cb(null);
    });
  };

  DaoliyuBackend.prototype.auth = function (cb) {
    if (this.token) { cb(null); return; }
    this.login(cb);
  };

  /* 访问一个 /api 接口；401 时清 token 重登一次 */
  DaoliyuBackend.prototype.api = function (method, path, body, cb) {
    var self = this;
    this.auth(function (err) {
      if (err) { cb(err); return; }
      var headers = { 'Authorization': 'Bearer ' + self.token };
      httpReq(method, self.base + path, headers, body, function (e2, code, text) {
        if (e2) { cb(e2); return; }
        if (code === 401) {
          self.token = '';
          self.auth(function (e3) {
            if (e3) { cb(e3); return; }
            var h2 = { 'Authorization': 'Bearer ' + self.token };
            httpReq(method, self.base + path, h2, body, function (e4, c4, t4) {
              if (e4) { cb(e4); return; }
              if (c4 < 200 || c4 >= 300) { cb(errText(safeJson(t4), c4)); return; }
              cb(null, t4);
            });
          });
          return;
        }
        if (code < 200 || code >= 300) { cb(errText(safeJson(text), code)); return; }
        cb(null, text);
      });
    });
  };

  DaoliyuBackend.prototype.ping = function (cb) {
    var self = this;
    this.login(function (err) { cb(err || null); });
  };

  DaoliyuBackend.prototype.coverUrl = function (track) {
    if (!track) return '';
    if (track.coverArtUrl) return String(track.coverArtUrl);
    if (track.coverArtPath) {
      return this.base + '/api/cover?path=' + encodeURIComponent(String(track.coverArtPath)) + '&size=300';
    }
    return '';
  };

  DaoliyuBackend.prototype.playlists = function (cb) {
    var self = this;
    this.api('GET', '/api/playlists/web/mine', '', function (err, text) {
      if (err) { cb(err); return; }
      var arr = safeJson(text) || [];
      if (arr && !arr.length && arr.items) arr = arr.items;
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i] || {};
        out.push({
          id: String(p.id), name: p.name || '未命名歌单', count: num(p.trackCount, 0),
          cover: self.coverUrl({ coverArtUrl: p.coverArtUrl, coverArtPath: p.coverArtPath })
        });
      }
      cb(null, out);
    });
  };

  DaoliyuBackend.prototype.tracks = function (plId, cb) {
    var self = this;
    this.api('GET', '/api/playlists/' + encodeURIComponent(plId) + '/tracks?skip=0&take=200', '', function (err, text) {
      if (err) { cb(err); return; }
      var o = safeJson(text) || {};
      var items = o.items || (o.length ? o : []);
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i] && items[i].track ? items[i].track : items[i];
        if (!t || !t.id) continue;
        var artists = '';
        if (t.artists && t.artists.length) {
          var names = [];
          for (var k = 0; k < t.artists.length; k++) {
            var a = t.artists[k];
            names.push(a && a.artist ? (a.artist.name || '') : String(a && a.name || a || ''));
          }
          artists = names.join(' / ');
        } else if (t.artist) {
          artists = String(t.artist);
        }
        /* 曲目本身常不带封面：退回专辑封面（道理鱼的封面路径一般挂在 album 上） */
        var alb = t.album || {};
        out.push({
          id: String(t.id), title: t.title || '未命名', artist: artists,
          album: (alb.title || alb.name) || '',
          duration: num(t.durationSeconds, 0),
          cover: self.coverUrl({
            coverArtUrl: t.coverArtUrl || alb.coverArtUrl || '',
            coverArtPath: t.coverArtPath || alb.coverArtPath || alb.cover || ''
          }),
          rate: 1, raw: t
        });
      }
      cb(null, out);
    });
  };

  DaoliyuBackend.prototype.streamUrl = function (t, cb) {
    var self = this;
    this.auth(function (err) {
      if (err) { cb(err); return; }
      cb(null, self.base + '/api/tracks/' + encodeURIComponent(t.id) + '/stream?token=' +
        encodeURIComponent(self.token), 1);
    });
  };

  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function errText(o, code) {
    if (o) {
      if (o.error && typeof o.error === 'string') return o.error;
      if (o.message) return String(o.message);
      if (o.details && o.details.message) return String(o.details.message);
    }
    return 'HTTP ' + code;
  }

  function hexUtf8(s) {
    /* 把密码按 UTF-8 编成十六进制：encodeURIComponent 之后逐个 %XX 转 hex，纯 ASCII 原样 */
    var e = encodeURIComponent(String(s || '')), out = '';
    for (var i = 0; i < e.length; i++) {
      if (e.charAt(i) === '%') { out += e.substr(i + 1, 2).toUpperCase(); i += 2; }
      else {
        var c = e.charCodeAt(i).toString(16).toUpperCase();
        out += (c.length < 2 ? '0' : '') + c;
      }
    }
    return out;
  }

  function buildBackend() {
    var c = S.cfg || defaultCfg();
    if (c.kind === 'mock' || ((c.kind === 'daoliyu' || c.kind === 'subsonic') && !c.baseUrl)) {
      S.backend = new MockBackend();
      S.status = 'mock';
      S.statusText = '演示音源（未连服务器）';
      return;
    }
    if (c.kind === 'daoliyu') {
      /* 道理鱼是自家 REST：/api/* + Bearer，登录换 token */
      S.backend = new DaoliyuBackend(c);
      S.status = 'idle';
      S.statusText = '未连接';
      return;
    }
    S.backend = new SubBackend(c);
    S.status = 'idle';
    S.statusText = '未连接';
  }

  /* ---------------- 网络：优先原生桥（file:// 里没有 CORS） ---------------- */
  window.__musicHttpCb = function (id, out) {
    var cb = S.httpCbs[id];
    if (!cb) return;
    delete S.httpCbs[id];
    var o;
    try { o = JSON.parse(out || '{}'); } catch (e) { cb('返回解析失败'); return; }
    if (o && o.error) { cb(String(o.error)); return; }
    cb(null, num(o.status, 0), String(o.body == null ? '' : o.body));
  };

  function httpGet(url, cb) {
    httpReq('GET', url, null, '', cb);
  }

  /* method/headers/body 都可指定；WebView 里优先走原生桥（file:// 没有 CORS 问题） */
  function httpReq(method, url, headers, body, cb) {
    var b = bridge();
    if (b && b.httpReq) {
      var id = 'm' + (++S.cbSeq);
      S.httpCbs[id] = cb;
      try { b.httpReq(id, method || 'GET', url, JSON.stringify(headers || {}), body || ''); }
      catch (e) { delete S.httpCbs[id]; cb('桥接失败'); }
      return;
    }
    if (b && b.httpJson && (method || 'GET') === 'GET') {
      var id2 = 'm' + (++S.cbSeq);
      S.httpCbs[id2] = cb;
      try { b.httpJson(id2, url); }
      catch (e) { delete S.httpCbs[id2]; cb('桥接失败'); }
      return;
    }
    /* 桌面浏览器里调试用（WebView 里走不到这里） */
    try {
      var x = new XMLHttpRequest();
      x.open(method || 'GET', url, true);
      x.timeout = 12000;
      if (headers) { for (var k in headers) { if (headers.hasOwnProperty(k)) x.setRequestHeader(k, headers[k]); } }
      x.onload = function () { cb(null, x.status, x.responseText); };
      x.onerror = function () { cb('网络错误'); };
      x.ontimeout = function () { cb('超时'); };
      x.send(body || null);
    } catch (e2) { cb('请求失败'); }
  }

  /* ---------------- 播放器 ---------------- */
  function ensureAudio() {
    if (S.audio) return S.audio;
    var a = document.createElement('audio');
    a.preload = 'auto';
    a.volume = S.vol;
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onTime);
    a.addEventListener('ended', function () { next(); });
    a.addEventListener('play', function () {
      S.playing = true; paintTransport(); paintList(); startTick();
      if (S.track && S.status !== 'error' && S.status !== 'mock') setStatus('ok', '正在播放');
    });
    a.addEventListener('pause', function () {
      S.playing = false; paintTransport(); paintList();
      if (S.track && S.status !== 'error' && S.status !== 'mock') setStatus('ok', '已暂停');
    });
    a.addEventListener('error', function () {
      S.playing = false; paintTransport();
      setStatus('error', '播放失败（音频地址不可达）');
    });
    S.audio = a;
    return a;
  }

  function onTime() {
    var a = S.audio;
    if (!a || S.seekDrag) return;
    paintProgress();
  }

  function startTick() {
    if (S.tickTimer) return;
    S.tickTimer = setInterval(function () {
      if (!S.open && !S.playing) { clearInterval(S.tickTimer); S.tickTimer = null; return; }
      paintProgress();
    }, 500);
  }

  function playTrack(track, queue, index) {
    if (!track) return;
    if (queue) { S.queue = queue; S.qi = index >= 0 ? index : 0; }
    S.track = track;
    paintNow();
    paintList();
    setStatus(S.status === 'error' ? 'error' : (S.status === 'mock' ? 'mock' : 'ok'), S.status === 'mock' ? '演示音源 · ' + (track.artist || '') : '正在播放');
    S.backend.streamUrl(track, function (err, url, rate) {
      if (err || !url) { setStatus('error', err || '拿不到音频地址'); return; }
      var a = ensureAudio();
      try {
        a.pause();
        if (a.src !== url) a.src = url;
        if (rate && a.playbackRate !== rate) a.playbackRate = rate;
        a.currentTime = 0;
        a.volume = S.vol;
        var p = a.play();
        if (p && p.then) p.then(null, function () { /* 自动播放被拦：等用户点播放 */ });
      } catch (e) { setStatus('error', '播放器出错'); }
      paintNow(); paintProgress(); paintTransport();
    });
  }

  function toggle() {
    var a = ensureAudio();
    if (!S.track && S.queue.length) { playTrack(S.queue[0], S.queue, 0); return; }
    if (!S.track) { toast('先去右侧歌单里点一首'); return; }
    if (a.paused) {
      var p = a.play();
      if (p && p.then) p.then(null, function () { setStatus('error', '浏览器拦了自动播放，再点一次'); });
    } else {
      a.pause();
    }
  }

  function next() {
    if (!S.queue.length) return;
    var i = (S.qi + 1) % S.queue.length;
    playTrack(S.queue[i], null, i);
  }

  function prev() {
    if (!S.queue.length) return;
    if (S.audio && S.audio.currentTime > 3) { S.audio.currentTime = 0; return; }
    var i = (S.qi - 1 + S.queue.length) % S.queue.length;
    playTrack(S.queue[i], null, i);
  }

  function setVol(v) {
    S.vol = clamp(v, 0, 1);
    if (S.audio) S.audio.volume = S.vol;
    try { localStorage.setItem(VOL_KEY, String(S.vol)); } catch (e) { }
    paintVol();
  }

  /* ---------------- 数据加载 ---------------- */
  function loadPlaylists(force) {
    if (S.ready && !force) return;
    if (S.loading) return;
    if (!S.backend) buildBackend();
    S.loading = true;
    setStatus('connecting', S.status === 'mock' ? '载入演示歌单…' : '连接服务器…');
    paintList();
    S.backend.playlists(function (err, list) {
      S.loading = false;
      if (err) {
        setStatus('error', '连不上：' + err);
        S.playlists = [];
        S.ready = true;
        paintList();
        return;
      }
      S.playlists = list || [];
      S.ready = true;
      setStatus(S.status === 'mock' ? 'mock' : 'ok',
        S.status === 'mock' ? '演示音源 · ' + S.playlists.length + ' 个歌单' : '已连接 · ' + S.playlists.length + ' 个歌单');
      paintList();
    });
  }

  function openPlaylist(id) {
    var pl = null;
    for (var i = 0; i < S.playlists.length; i++) if (S.playlists[i].id === id) pl = S.playlists[i];
    if (!pl) return;
    S.crumb = pl.name;
    S.tracks = null;
    S.loading = true;
    paintCrumb();
    paintList('载入曲目…');
    S.backend.tracks(id, function (err, list) {
      S.loading = false;
      if (err) { setStatus('error', '读歌单失败：' + err); S.tracks = []; paintList(); return; }
      S.tracks = list || [];
      S.curPlaylist = id;
      paintList();
    });
  }

  function backToPlaylists() {
    S.tracks = null;
    S.crumb = '歌单';
    paintCrumb();
    paintList();
  }

  /* ---------------- 状态 ---------------- */
  function setStatus(kind, text) {
    S.status = kind;
    S.statusText = text || '';
    paintStatus();
    /* 连不上时右侧要出现「重试 / 音乐设置」 */
    if (kind === 'error') paintList();
  }

  /* ---------------- 渲染 ---------------- */
  function paintStatus() {
    var e = S.el.status;
    if (!e) return;
    e.className = 'm-status ' + (S.status === 'ok' ? 'ok' : (S.status === 'mock' ? 'mock' : (S.status === 'error' ? 'err' : '')));
    e.innerHTML = '<span class="dot"></span><span>' + esc(S.statusText || '') + '</span>';
  }

  function paintNow() {
    var e = S.el, t = S.track;
    if (!e.cover) return;
    if (!t) {
      e.cover.className = 'm-cover empty';
      e.cover.innerHTML = '<span class="m-cover-ph">' + (window.ICONS ? svg('music') : '') + '</span>';
      e.song.textContent = '未在播放';
      e.artist.textContent = '右侧点一首歌开始';
      e.album.textContent = '';
      e.dur.textContent = '0:00';
      e.pos.textContent = '0:00';
      setFill(e.fill, e.knob, 0);
      paintTransport();
      return;
    }
    e.cover.className = 'm-cover';
    e.cover.innerHTML = t.cover ? '<img src="' + esc(t.cover) + '" alt="">' : '';
    e.song.textContent = t.title || '未命名';
    e.artist.textContent = t.artist || '未知艺术家';
    e.album.textContent = t.album || '';
    e.dur.textContent = fmtTime(t.duration);
    if (S.audio && S.audio.duration && isFinite(S.audio.duration)) e.dur.textContent = fmtTime(S.audio.duration);
    paintTransport();
  }

  function paintTransport() {
    var e = S.el;
    if (!e.play) return;
    var playing = S.audio && !S.audio.paused;
    e.play.innerHTML = svg(playing ? 'pause' : 'play');
    e.play.className = 'm-btn m-play' + (playing ? ' on' : '');
    e.songWrap.className = 'm-meta' + (playing ? ' playing' : '');
  }

  function setFill(fill, knob, pct) {
    if (!fill || !knob) return;
    pct = clamp(num(pct, 0), 0, 100);
    fill.style.width = pct + '%';
    knob.style.left = pct + '%';
  }

  function paintProgress() {
    var e = S.el, a = S.audio;
    if (!e.pos) return;
    var d = a && isFinite(a.duration) ? a.duration : num(S.track && S.track.duration, 0);
    var p = a ? a.currentTime : 0;
    if (!isFinite(p)) p = 0;
    e.pos.textContent = fmtTime(p);
    if (d) e.dur.textContent = fmtTime(d);
    setFill(e.fill, e.knob, d ? (p / d * 100) : 0);
  }

  function paintVol() {
    var e = S.el;
    if (!e.volFill) return;
    setFill(e.volFill, e.volKnob, S.vol * 100);
    e.volPct.textContent = Math.round(S.vol * 100) + '%';
  }

  function paintCrumb() {
    var e = S.el;
    if (!e.crumb) return;
    e.crumb.innerHTML = (S.tracks ? '<button class="m-back" data-mact="back">' + svg('back') + '<span>歌单</span></button>' : '') +
      '<span class="m-crumb-t">' + esc(S.crumb) + '</span>';
  }

  function paintList(loadingText) {
    var e = S.el;
    if (!e.list) return;
    if (loadingText) { e.list.innerHTML = '<div class="m-empty">' + esc(loadingText) + '</div>'; return; }
    if (S.status === 'error' && !S.playlists.length) {
      e.list.innerHTML = '<div class="m-empty"><div class="m-empty-t">没有连上音乐服务器</div>' +
        '<div class="m-empty-d">' + esc(S.statusText) + '</div>' +
        '<button class="btn" data-mact="retry">重试</button>' +
        '<button class="btn" data-mact="open-cfg">音乐设置</button></div>';
      return;
    }
    if (S.tracks) {
      if (!S.tracks.length) { e.list.innerHTML = '<div class="m-empty">这个歌单是空的</div>'; return; }
      var h = '';
      var curId = S.track ? S.track.id : '';
      for (var i = 0; i < S.tracks.length; i++) {
        var t = S.tracks[i];
        var on = t.id === curId ? ' on' : '';
        h += '<button class="m-song' + on + '" data-mact="track" data-idx="' + i + '">' +
          '<span class="m-song-ico">' + svg(on && S.audio && !S.audio.paused ? 'wave' : 'play') + '</span>' +
          '<span class="m-song-main"><span class="m-song-t">' + esc(t.title || '未命名') + '</span>' +
          '<span class="m-song-a">' + esc((t.artist || '') + (t.album ? ' · ' + t.album : '')) + '</span></span>' +
          '<span class="m-song-d">' + fmtTime(t.duration) + '</span></button>';
      }
      e.list.innerHTML = h;
      return;
    }
    if (!S.playlists.length) {
      e.list.innerHTML = '<div class="m-empty">还没有歌单<br><span class="m-empty-d">在音乐服务里建一个歌单，这里就会出现</span></div>';
      return;
    }
    var out = '';
    for (var j = 0; j < S.playlists.length; j++) {
      var p = S.playlists[j];
      out += '<button class="m-pl" data-mact="pl" data-id="' + esc(p.id) + '">' +
        '<span class="m-pl-cover">' + (p.cover ? '<img src="' + esc(p.cover) + '" alt="">' : svg('music')) + '</span>' +
        '<span class="m-pl-main"><span class="m-pl-n">' + esc(p.name || '未命名歌单') + '</span>' +
        '<span class="m-pl-c">' + (num(p.count, 0) ? p.count + ' 首' : '') + '</span></span>' +
        '<span class="m-pl-go">' + svg('chev') + '</span></button>';
    }
    e.list.innerHTML = out;
  }

  /* ---------------- 手势：右滑拉出 / 左滑收起 ---------------- */
  function pageWidth() {
    return window.innerWidth || document.documentElement.clientWidth || 1024;
  }

  function applyX(x, animate) {
    var m = S.el.page;
    if (!m) return;
    S.dx = x;
    m.style.transition = animate ? '' : 'none';
    m.style.transform = 'translate3d(' + Math.round(x) + 'px,0,0)';
    var scrim = S.el.scrim;
    if (scrim) {
      var p = clamp((pageWidth() + x) / pageWidth(), 0, 1);
      scrim.style.opacity = String(p * 0.92);
      scrim.style.pointerEvents = p > 0.02 ? 'auto' : 'none';
    }
  }

  function open(animate) {
    var w = pageWidth();
    S.open = true;
    document.body.className = (document.body.className || '').replace(/\bmusic-open\b/g, '').trim() + ' music-open';
    applyX(0, animate !== false);
    paintVol();
    paintNow();
    paintProgress();
    if (!S.ready && !S.loading) loadPlaylists();
    startTick();
    act('open');
  }

  function close(animate) {
    var w = pageWidth();
    S.open = false;
    document.body.className = (document.body.className || '').replace(/\bmusic-open\b/g, '').trim();
    applyX(-w, animate !== false);
    act('close');
  }

  /* 拖出过程中 S.open 仍是 false（页面还没真打开），只做视觉跟随；
     打开与否在 onTouchEnd 里一次性决定。否则拖到一半 S.open 变 true，
     document 上的 touchmove 守卫会直接 return，手势后半段全部丢失。 */
  function prepareOpen() {
    document.body.className = (document.body.className || '').replace(/\bmusic-open\b/g, '').trim() + ' music-open';
    paintVol(); paintNow(); paintProgress();
    if (!S.ready && !S.loading) loadPlaylists();
    startTick();
  }

  function pull(dx) {
    if (dx <= 0 || S.open) return;
    if (!S.pulling) { S.pulling = true; prepareOpen(); }
    var w = pageWidth();
    applyX(clamp(-w + dx, -w, 0), false);
  }

  function release(dx, vx) {
    var w = pageWidth();
    var v = num(vx, 0);
    /* dx：正=往右拖（打开方向），负=往左拖（收起方向）；S.open 仍是拖动前的状态 */
    var frac = S.open ? clamp((w + clamp(dx, -w, 0)) / w, 0, 1) : clamp(dx / w, 0, 1);
    var goOpen;
    if (dx > 90 || v > 0.45) goOpen = true;
    else if (dx < -90 || v < -0.45) goOpen = false;
    else goOpen = frac > 0.5;
    if (goOpen) open(true); else close(true);
    paintVol();
  }

  /* 只认「从屏幕左边缘往右滑」：手指必须落在左边 28 CSS px 内起手。
     这样屏幕中间的卡片亮度条、房间/场景横向滚动条怎么拖都不会把页面拽出来。 */
  var EDGE_PULL = 28;

  /* 主屏上有些控件自己就要横着拖：卡片亮度条（.t-bar）、场景/房间那两条横向滚动条
     .toolbar、设置弹层里的滑条（input.slider）。落在这些上面时也不能启动手势。 */
  var GRABBY = ['t-bar', 'tbar', 'slider', 'sheet', 'sheet-inner', 'mask', 'view', 'dim',
    'toast', 'edit-bar', 'toolbar', 'music', 'm-scrim'];

  function isGrabby(node) {
    while (node && node !== document.body) {
      var tag = node.nodeName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      var c = node.className;
      if (typeof c === 'string' && c) {
        var s = ' ' + c + ' ';
        for (var i = 0; i < GRABBY.length; i++) {
          if (s.indexOf(' ' + GRABBY[i] + ' ') >= 0) return true;
        }
      }
      node = node.parentNode;
    }
    return false;
  }

  function onTouchStart(ev) {
    if (!ev.touches || ev.touches.length !== 1) { S.g = null; return; }
    var t = ev.touches[0];
    S.pulling = false;
    /* 只在「没打开」这一侧拦：打开之后整页都是我们自己的，滑条由 bindBars 处理 */
    if (!S.open && isGrabby(ev.target)) { S.g = null; return; }
    S.g = {
      x0: t.clientX, y0: t.clientY, t0: Date.now(), x: t.clientX, mode: '', dx: 0,
      edge: t.clientX <= EDGE_PULL
    };
  }

  function onTouchMove(ev) {
    var g = S.g;
    if (!g || !ev.touches || ev.touches.length !== 1) return;
    var t = ev.touches[0];
    var dx = t.clientX - g.x0;
    var dy = t.clientY - g.y0;
    g.x = t.clientX;
    if (!g.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.25) { g.mode = 'v'; return; }
      if (dx > 0 && !S.open && g.edge) g.mode = 'pull';
      else if (dx < 0 && S.open) g.mode = 'close';
      else { g.mode = 'no'; return; }
      if (g.mode === 'pull' || g.mode === 'close') {
        if (window.__PANEL_CANCEL_TAP__) window.__PANEL_CANCEL_TAP__();
      }
    }
    if (g.mode === 'pull') {
      if (ev.preventDefault) ev.preventDefault();
      g.dx = dx;
      pull(dx);
    } else if (g.mode === 'close') {
      if (ev.preventDefault) ev.preventDefault();
      var w = pageWidth();
      var x = clamp(dx, -w, 0);
      g.dx = x;
      applyX(x, false);
    }
  }

  function onTouchEnd(ev) {
    var g = S.g;
    S.g = null;
    S.pulling = false;
    if (!g || !g.mode) return;
    var dx = g.x - g.x0;
    var dt = Math.max(120, Date.now() - g.t0);
    var vx = dx / dt;   /* px/ms，够用了 */
    if (g.mode === 'pull' || g.mode === 'close') {
      release(dx, vx);
      act((g.mode === 'pull' ? 'pull' : 'close') + ' dx=' + Math.round(dx));
    }
  }

  /* ---------------- 页面上的点击 / 拖动 ---------------- */
  function onPageClick(ev) {
    var t = ev.target;
    var btn = closestAct(t);
    if (!btn) return;
    var a = btn.getAttribute('data-mact');
    if (a === 'toggle') { toggle(); return; }
    if (a === 'next') { next(); return; }
    if (a === 'prev') { prev(); return; }
    if (a === 'back') { backToPlaylists(); return; }
    if (a === 'pl') { openPlaylist(btn.getAttribute('data-id')); return; }
    if (a === 'track') {
      var i = num(btn.getAttribute('data-idx'), -1);
      if (i >= 0 && S.tracks) playTrack(S.tracks[i], S.tracks, i);
      return;
    }
    if (a === 'retry') { S.ready = false; loadPlaylists(true); return; }
    if (a === 'open-cfg') { close(); if (window.__PANEL_OPEN_MUSIC_CFG__) window.__PANEL_OPEN_MUSIC_CFG__(); return; }
    if (a === 'close') { close(); return; }
  }

  function closestAct(node) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-mact')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function ratioAt(node, clientX) {
    var r = node.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1);
  }

  function bindBars() {
    var e = S.el;
    /* 进度条：按下即定位，拖动跟手（松手才 seek，避免一路狂 seek） */
    if (e.bar) {
      e.bar.addEventListener('touchstart', function (ev) {
        if (!S.audio || !isFinite(S.audio.duration)) return;
        S.seekDrag = true;
        var p = ratioAt(e.bar, ev.touches[0].clientX);
        setFill(e.fill, e.knob, p * 100);
        ev.preventDefault();
      }, false);
      e.bar.addEventListener('touchmove', function (ev) {
        if (!S.seekDrag) return;
        var p = ratioAt(e.bar, ev.touches[0].clientX);
        setFill(e.fill, e.knob, p * 100);
        e.pos.textContent = fmtTime(p * (S.audio ? S.audio.duration : 0));
        ev.preventDefault();
      }, false);
      e.bar.addEventListener('touchend', function (ev) {
        if (!S.seekDrag) return;
        S.seekDrag = false;
        var p = ratioAt(e.bar, (ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientX : 0));
        if (S.audio && isFinite(S.audio.duration)) {
          try { S.audio.currentTime = p * S.audio.duration; } catch (x) { }
        }
        paintProgress();
      }, false);
      e.bar.addEventListener('touchcancel', function () { S.seekDrag = false; paintProgress(); }, false);
    }
    if (e.vol) {
      e.vol.addEventListener('touchstart', function (ev) {
        S.volDrag = true;
        setVol(ratioAt(e.vol, ev.touches[0].clientX));
        ev.preventDefault();
      }, false);
      e.vol.addEventListener('touchmove', function (ev) {
        if (!S.volDrag) return;
        setVol(ratioAt(e.vol, ev.touches[0].clientX));
        ev.preventDefault();
      }, false);
      e.vol.addEventListener('touchend', function () { S.volDrag = false; }, false);
      e.vol.addEventListener('touchcancel', function () { S.volDrag = false; }, false);
    }
  }

  /* ---------------- 对外接口 ---------------- */
  function attach() {
    var page = $('music'), scrim = $('mScrim');
    if (!page || !scrim) return;
    var e = S.el;
    e.page = page; e.scrim = scrim;
    e.status = $('mStatus');
    e.cover = $('mCover'); e.song = $('mSong'); e.artist = $('mArtist'); e.album = $('mAlbum');
    e.songWrap = $('mMeta');
    e.bar = $('mBar'); e.fill = $('mFill'); e.knob = $('mKnob');
    e.pos = $('mPos'); e.dur = $('mDur');
    e.play = $('mPlay');
    e.vol = $('mVol'); e.volFill = $('mVolFill'); e.volKnob = $('mVolKnob'); e.volPct = $('mVolPct');
    e.crumb = $('mCrumb'); e.list = $('mList');

    S.cfg = readCfg();
    S.vol = readVol();
    buildBackend();

    page.addEventListener('click', onPageClick, false);
    bindBars();
    /* 页面自己的触摸：只用来「左滑收起」，落点在按钮/滑条上时不抢 */
    page.addEventListener('touchstart', function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-mact') === 'track') { /* 允许，歌也能左滑收起 */ }
      onTouchStart(ev);
    }, false);
    page.addEventListener('touchmove', function (ev) {
      if (S.seekDrag || S.volDrag) return;
      onTouchMove(ev);
    }, { passive: false });
    page.addEventListener('touchend', onTouchEnd, false);
    page.addEventListener('touchcancel', function () { S.g = null; }, false);

    document.addEventListener('touchstart', function (ev) {
      if (S.open) return;
      onTouchStart(ev);
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', function (ev) {
      if (S.open) return;
      onTouchMove(ev);
    }, { passive: false, capture: true });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', function () { S.g = null; }, true);

    var handle = $('mHandle');
    if (handle) {
      handle.addEventListener('click', function () { open(true); });
      handle.addEventListener('touchstart', function (ev) { if (ev.stopPropagation) ev.stopPropagation(); }, false);
    }
    if (e.cover) e.cover.innerHTML = '<span class="m-cover-ph">' + svg('music') + '</span>';
    var back = $('mBack');
    if (back) back.innerHTML = svg('back');
    paintVol(); paintCrumb(); paintList(); paintStatus(); paintNow(); paintTransport();
    applyX(-pageWidth(), false);
    window.addEventListener('resize', function () {
      if (!S.open) applyX(-pageWidth(), false);
    });
    /* 让其它模块可以「打开音乐设置」 */
    window.MusicUI.ready = true;
  }

  function svg(name) {
    var I = window.ICONS || {};
    var d = I[name];
    if (!d) return '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  window.MusicUI = {
    attach: attach,
    open: function () { open(true); },
    close: function () { close(true); },
    toggle: function () { if (S.open) close(true); else open(true); },
    isOpen: function () { return S.open; },
    pull: pull,
    release: release,
    cfg: function () { return S.cfg || readCfg(); },
    saveCfg: saveCfg,
    status: function () { return { status: S.status, text: S.statusText, ready: S.ready, playlists: S.playlists.length }; },
    playlists: function () { return S.playlists; },
    playing: function () { return S.track; },
    next: next, prev: prev, togglePlay: toggle
  };
})();
