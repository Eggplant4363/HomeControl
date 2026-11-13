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
  var MODE_KEY = 'hc.music.mode';
  var LIB_PAGE = 120;      /* 所有歌曲一次装 120 行 */
  var LIB_MAX_ROWS = 1500; /* 列表最多渲染这么多行，再多就靠随机 */
  var RECENT_MAX = 240;    /* 随机去重窗口：最近播过的 id 不再从随机批次里出现 */
  var RAND_REFILL = 12;    /* 随机批剩下 12 首时就在后台悄悄要下一批 */    /* {shuffle, repeat} —— 随机/循环的持久化 */

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
    view: 'pl',           /* pl | tracks | queue —— 右列现在看的是哪一个 */
    queue: [],
    qi: -1,
    order: [],            /* 播放顺序（曲目下标）：随机时是洗牌后的顺序 */
    src: '',              /* '' = 歌单，'lib' = 所有歌曲 */
    lib: { total: 0, items: [] },
    libBusy: false,
    randQ: [],            /* 随机批次：服务端给的随机曲目，用完再拿一批 */
    randBusy: false,
    recent: {},           /* 最近播过的 id，随机批次里滤掉，避免连着重播 */
    hist: [],             /* 随机模式的播放历史，上一首从这里退 */
    shuffle: false,
    repeat: 'off',        /* off | all | one */
    track: null,
    playing: false,
    vol: 0.7,
    tickTimer: null,
    seekDrag: false,
    volDrag: false,
    el: {},
    cbSeq: 0,
    httpCbs: {},
    binCbs: {},
    coverPend: {},
    lyrics: null,         /* {lines:[{t,text}]}，当前曲的歌词 */
    lyricIdx: -1,
    lyricPend: '',
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

  /* ---------------- 歌词（LRC） ---------------- */
  /* [mm:ss.xx]文本，一行可能有多个时间戳；[offset:] 是全局偏移（毫秒） */
  function parseLrc(text) {
    if (!text) return [];
    var lines = [];
    var offset = 0;
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    var off = /\[offset:\s*(-?\d+)\]/i.exec(text);
    if (off) offset = num(off[1], 0) / 1000;
    var rows = String(text).split(/\r?\n/);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.charAt(0) !== '[') continue;
      var text2 = row.replace(re, '');
      if (!text2 || /^\s*$/.test(text2)) continue;   /* 空行（纯间隔）不进列表 */
      var m2;
      re.lastIndex = 0;
      while ((m2 = re.exec(row)) !== null) {
        var t = num(m2[1], 0) * 60 + num(m2[2], 0) + num(m2[3], 0) / (m2[3].length === 3 ? 1000 : (m2[3].length === 2 ? 100 : 10)) + offset;
        if (t < 0) continue;
        lines.push({ t: t, text: text2 });
      }
    }
    lines.sort(function (a, b) { return a.t - b.t; });
    return lines;
  }

  /* 道理鱼返回 {trackId, candidates:[{id,sourceCode,syncType,lyrics}]}：优先带时间轴的，其次纯文本 */
  function pickLrc(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') { var only = parseLrc(payload); return only.length ? { lines: only, synced: true } : null; }
    var cands = payload.candidates || [];
    if (!cands.length && payload.lyrics) cands = [{ syncType: payload.syncType || 'PLAIN', lyrics: payload.lyrics }];
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i] || {};
      var lines = parseLrc(c.lyrics);
      if (!lines.length) continue;
      var cand = { lines: lines, synced: String(c.syncType || '').toUpperCase() === 'SYNCED' };
      if (cand.synced) return cand;
      if (!best) best = cand;
    }
    return best;
  }

  function lyricIdxAt(lines, t) {
    if (!lines || !lines.length) return -1;
    var lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t + 0.25) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return idx;
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
    var prevPass = S.cfg.pass || '';
    S.cfg = mergeCfg(defaultCfg(), o || {});
    /* 弹层里的密码框显示时打了码，留空表示「不改」，沿用已存的密码 */
    if (!o || o.pass === '' || o.pass === '***') S.cfg.pass = prevPass;
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

  /* 系统音量（Android AudioManager）。没有桥（桌面调试）时退回 audio 自己的音量。 */
  function sysVol() {
    var b = bridge();
    if (!b || !b.getVolume) return null;
    var v = num(b.getVolume(), -1);
    if (v < 0 || v > 1) return null;
    return v;
  }

  function readVol() {
    var s = sysVol();
    if (s !== null) return s;
    try {
      var v = localStorage.getItem(VOL_KEY);
      if (v !== null) return clamp(num(v, 0.7), 0, 1);
    } catch (e) { }
    var m = (window.PANEL_CONFIG && window.PANEL_CONFIG.music) || {};
    return clamp(num(m.volume, 70) / 100, 0, 1);
  }

  function readMode() {
    try {
      var o = JSON.parse(localStorage.getItem(MODE_KEY) || '');
      if (o && typeof o === 'object') {
        var rep = o.repeat === 'all' ? 'all' : (o.repeat === 'one' ? 'one' : 'off');
        /* 旧版两个按钮时代可能存过「随机+循环」的组合；一键四态里随机时循环必为 off */
        if (o.shuffle) rep = 'off';
        return { shuffle: !!o.shuffle, repeat: rep };
      }
    } catch (e) { }
    return { shuffle: false, repeat: 'off' };
  }

  function saveMode() {
    try { localStorage.setItem(MODE_KEY, JSON.stringify({ shuffle: S.shuffle, repeat: S.repeat })); } catch (e) { }
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

  MockBackend.prototype.libTracks = function (skip, take, cb) {
    var all = [];
    for (var i = 0; i < MOCK_PLAYLISTS.length; i++) {
      var list = MOCK_TRACKS[MOCK_PLAYLISTS[i].id] || [];
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        all.push({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, cover: mockCover(j, t.title), rate: t.rate, mock: true });
      }
    }
    cb(null, { total: all.length, items: all.slice(skip, skip + take) });
  };

  MockBackend.prototype.randomBatch = function (cb) {
    var all = [];
    for (var i = 0; i < MOCK_PLAYLISTS.length; i++) {
      var list = MOCK_TRACKS[MOCK_PLAYLISTS[i].id] || [];
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        all.push({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, cover: mockCover(j, t.title), rate: t.rate, mock: true });
      }
    }
    for (var k = all.length - 1; k > 0; k--) {
      var r = Math.floor(Math.random() * (k + 1));
      var tmp = all[k]; all[k] = all[r]; all[r] = tmp;
    }
    cb(null, all);
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
     登录 POST /api/auth/login {email,username,password} -> {token}（两个字段都要给同一个值）
     歌单 GET /api/playlists/web/mine -> 数组
     曲目 GET /api/playlists/{id}/tracks?skip=&take= -> {items:[{order,track}]}
     封面 GET /api/cover?path=&size=  —— 这个也要 Authorization，<img> 加不了头，
          所以走原生桥取字节转 base64（见 loadCover）
     音频 GET /api/tracks/{id}/stream?token= ；FLAC 原文件一首 85MB，平板放不动，
          非 mp3/aac/wav/ogg 一律走 GET /api/tracks/{id}/transcode?token=&format=mp3&bitrate=192 */
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
    var body = JSON.stringify({ email: this.user, username: this.user, password: this.pass, remember: true });
    if (window.AndroidBridge && window.AndroidBridge.log) {
      window.AndroidBridge.log('login user=' + this.user + ' passLen=' + this.pass.length + ' base=' + this.base);
    }
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

  DaoliyuBackend.prototype.origin = function () {
    var m = /^https?:\/\/[^/]+/i.exec(this.base);
    return m ? m[0] : this.base;
  };

  /* 封面：道理鱼的 /api/cover 也要 Authorization，<img> 加不了头 → 用原生桥取字节转 base64 */
  DaoliyuBackend.prototype.coverReqUrl = function (track) {
    if (!track) return '';
    var u = track.coverArtUrl;
    if (u) {
      if (/^https?:\/\//i.test(u)) return u;
      if (u.charAt(0) === '/') return this.origin() + u;
      return this.base + '/' + u;
    }
    if (track.coverArtPath) {
      return this.base + '/api/cover?path=' + encodeURIComponent(String(track.coverArtPath)) + '&size=300';
    }
    return '';
  };

  DaoliyuBackend.prototype.coverUrl = function (track) {
    /* 给别的后端用的签名；道理鱼的封面不能直接进 <img>（要鉴权头），走 loadCover */
    return this.coverReqUrl(track);
  };

  DaoliyuBackend.prototype.loadCover = function (track, cb) {
    var self = this;
    var url = this.coverReqUrl(track);
    if (!url) { cb(null, ''); return; }
    this.auth(function (err) {
      if (err) { cb(err); return; }
      httpBin('GET', url, { 'Authorization': 'Bearer ' + self.token }, function (e2, mime, b64) {
        if (e2 || !b64) { cb(e2 || '封面为空'); return; }
        cb(null, 'data:' + (mime || 'image/jpeg').split(';')[0] + ';base64,' + b64);
      });
    });
  };

  /* 歌词：GET /api/tracks/{id}/lyrics → {trackId, candidates:[…]}；服务端还会给歌词来源 */
  DaoliyuBackend.prototype.lyrics = function (track, cb) {
    var id = track && track.id;
    if (!id) { cb('没有曲目 id'); return; }
    this.api('GET', '/api/tracks/' + encodeURIComponent(String(id)) + '/lyrics', '', function (err, text) {
      if (err) { cb(err); return; }
      var o = safeJson(text);
      var picked = pickLrc(o);
      if (!picked) { cb('这首歌没有歌词'); return; }
      cb(null, picked);
    });
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
          cover: '', coverReq: { coverArtUrl: p.coverArtUrl, coverArtPath: p.coverArtPath }
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
        out.push(self.mapTrack(t));
      }
      cb(null, out);
    });
  };

  /* 一条曲目 -> 面板内部形状（歌单曲目和全库曲目同一套字段） */
  DaoliyuBackend.prototype.mapTrack = function (t) {
        var artists = '';
        /* 道理鱼已经拼好艺术家串（artistLabel 形如「杨坤 / 郭采洁」），优先用它 */
        if (t.artistLabel) {
          artists = String(t.artistLabel);
        } else if (t.artistName) {
          artists = String(t.artistName);
        } else if (t.artists && t.artists.length) {
          var names = [];
          for (var k = 0; k < t.artists.length; k++) {
            var a = t.artists[k];
            names.push(a && a.artist ? (a.artist.name || '') : String(a && a.name || a || ''));
          }
          artists = names.join(' / ');
        } else if (t.artist) {
          artists = String(t.artist);
        }
        /* 曲目封面常和专辑同一张：曲目没挂封面时退回专辑的封面路径 */
        var alb = t.album || {};
        return {
          id: String(t.id), title: t.title || '未命名', artist: artists,
          album: (alb.title || alb.name) || '',
          duration: num(t.durationSeconds, 0),
          cover: '',
          coverReq: {
            coverArtUrl: t.coverArtUrl || alb.coverArtUrl || '',
            coverArtPath: t.coverArtPath || alb.coverArtPath || alb.cover || ''
          },
          format: String(t.fileFormat || '').toLowerCase(),
          rate: 1
        };
  };

  DaoliyuBackend.prototype.streamUrl = function (t, cb) {
    var self = this;
    this.auth(function (err) {
      if (err) { cb(err); return; }
      var q = '?token=' + encodeURIComponent(self.token);
      var id = encodeURIComponent(t.id);
      var fmt = String(t.format || '').toLowerCase();
      var direct = fmt === 'mp3' || fmt === 'm4a' || fmt === 'aac' || fmt === 'wav' || fmt === 'ogg';
      if (direct) {
        cb(null, self.base + '/api/tracks/' + id + '/stream' + q, 1);
        return;
      }
      /* FLAC/ape 一首几十 MB，平板既放不动也可能解不了码：让服务器转 mp3 */
      cb(null, self.base + '/api/tracks/' + id + '/transcode' + q + '&format=mp3&bitrate=192', 1);
    });
  };

  /* 全库曲目：GET /api/tracks?skip=&take= -> {items,total,skip,take}（实测 total=5002，分页正常） */
  DaoliyuBackend.prototype.libTracks = function (skip, take, cb) {
    var self = this;
    this.api('GET', '/api/tracks?skip=' + skip + '&take=' + take, '', function (err, text) {
      if (err) { cb(err); return; }
      var o = safeJson(text) || {};
      var items = o.items || [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i] && items[i].track ? items[i].track : items[i];
        if (!t || !t.id) continue;
        out.push(self.mapTrack(t));
      }
      cb(null, { total: num(o.total, 0), items: out });
    });
  };

  /* 服务端随机：GET /api/tracks/random —— 实测不管 count 给多少都回 100 条随机曲目。
     这正是业界（Spotify/Apple Music）处理大库随机的做法：不把 5000 首拉下来再洗牌，
     而是让服务器给一批随机曲目，用完这批再拿下一批。 */
  DaoliyuBackend.prototype.randomBatch = function (cb) {
    var self = this;
    this.api('GET', '/api/tracks/random?count=100', '', function (err, text) {
      if (err) { cb(err); return; }
      var o = safeJson(text) || {};
      var items = o.items || [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i] && items[i].track ? items[i].track : items[i];
        if (!t || !t.id) continue;
        out.push(self.mapTrack(t));
      }
      cb(null, out);
    });
  };

  /* 原始流放不出时的兜底地址（平板缺解码器时用） */
  DaoliyuBackend.prototype.transcodeUrl = function (t, cb) {
    var self = this;
    this.auth(function (err) {
      if (err) { cb(err); return; }
      cb(null, self.base + '/api/tracks/' + encodeURIComponent(t.id) + '/transcode?token=' +
        encodeURIComponent(self.token) + '&format=mp3&bitrate=192', 1);
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
  /* 原生桥的回调现在直接嵌对象（以前 Java 用 org.json 把 payload 再转义一遍，
     560KB 的 /api/states 会变成 1.3MB 的字符串再被 JS 二次 parse）。
     老包仍传字符串，所以两种都接。 */
  function parseOut(v) {
    if (v == null) return {};
    if (typeof v === 'string') { try { return JSON.parse(v || '{}'); } catch (e) { return null; } }
    return v;
  }

  window.__musicHttpCb = function (id, out) {
    var cb = S.httpCbs[id];
    if (!cb) return;
    delete S.httpCbs[id];
    var o = parseOut(out);
    if (o === null) { cb('返回解析失败'); return; }
    if (o && o.error) { cb(String(o.error)); return; }
    cb(null, num(o.status, 0), String(o.body == null ? '' : o.body));
  };

  function httpGet(url, cb) {
    httpReq('GET', url, null, '', cb);
  }

  /* 取二进制转 base64（封面要鉴权头，<img> 加不了头）；cb(err, mime, b64) */
  window.__musicBinaryCb = function (id, out) {
    var cb = S.binCbs[id];
    if (!cb) return;
    delete S.binCbs[id];
    var o = parseOut(out);
    if (o === null) { cb('返回解析失败'); return; }
    if (o && o.error) { cb(String(o.error)); return; }
    if (!o.b64) { cb('没有数据'); return; }
    cb(null, String(o.mime || 'image/jpeg'), String(o.b64));
  };

  function httpBin(method, url, headers, cb) {
    var b = bridge();
    if (b && b.httpBinary) {
      var id = 'b' + (++S.cbSeq);
      S.binCbs[id] = cb;
      try { b.httpBinary(id, method || 'GET', url, JSON.stringify(headers || {})); }
      catch (e) { delete S.binCbs[id]; cb('桥接失败'); }
      return;
    }
    /* 桌面浏览器调试兜底 */
    try {
      var x = new XMLHttpRequest();
      x.open(method || 'GET', url, true);
      x.responseType = 'arraybuffer';
      x.timeout = 12000;
      if (headers) { for (var k in headers) { if (headers.hasOwnProperty(k)) x.setRequestHeader(k, headers[k]); } }
      x.onload = function () {
        var bytes = new Uint8Array(x.response || new ArrayBuffer(0));
        var bin = '', chunk = 8192;
        for (var j = 0; j < bytes.length; j += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + chunk, bytes.length)));
        }
        cb(null, x.getResponseHeader('Content-Type') || 'image/jpeg', btoa(bin));
      };
      x.onerror = function () { cb('网络错误'); };
      x.ontimeout = function () { cb('超时'); };
      x.send(null);
    } catch (e2) { cb('请求失败'); }
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

  /* 有原生桥时输出音量交给系统管（滑条拧的是 AudioManager），audio 元素本身保持满档 */
  function applyAudioVol() {
    if (!S.audio) return;
    var b = bridge();
    S.audio.volume = (b && b.setVolume) ? 1 : S.vol;
  }

  /* ---------------- 播放器 ---------------- */
  function ensureAudio() {
    if (S.audio) return S.audio;
    var a = document.createElement('audio');
    a.preload = 'auto';
    a.volume = (bridge() && bridge().setVolume) ? 1 : S.vol;
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onTime);
    a.addEventListener('ended', function () {
      /* 单曲循环：重放同一首；否则按播放顺序走下一首（循环关时走到头就停） */
      if (S.repeat === 'one' && S.track) {
        try { a.currentTime = 0; a.play(); } catch (e) { }
        return;
      }
      next();
    });
    a.addEventListener('play', function () {
      S.playing = true; paintTransport(); markPlaying(); startTick();
      if (S.track && S.status !== 'error' && S.status !== 'mock') setStatus('ok', '正在播放');
    });
    a.addEventListener('pause', function () {
      S.playing = false; paintTransport(); markPlaying();
      if (S.track && S.status !== 'error' && S.status !== 'mock') setStatus('ok', '已暂停');
    });
    a.addEventListener('error', function () {
      S.playing = false; paintTransport();
      /* 原始流放不出来（比如平板没有 FLAC 解码器）：让服务器转 mp3 再试一次 */
      if (S.track && S.backend && S.backend.transcodeUrl && S.lastUrl &&
          S.lastUrl.indexOf('/stream') >= 0 && !S.triedTranscode) {
        S.triedTranscode = true;
        act('stream failed, retry transcode');
        S.backend.transcodeUrl(S.track, function (e2, url2) {
          if (e2 || !url2) { setStatus('error', '播放失败（音频地址不可达）'); return; }
          var a2 = ensureAudio();
          S.lastUrl = url2;
          try {
            a2.src = url2; a2.currentTime = 0; applyAudioVol();
            var p2 = a2.play();
            if (p2 && p2.then) p2.then(null, function () { setStatus('error', '播放失败（转码也放不出）'); });
          } catch (e) { setStatus('error', '播放器出错'); }
          paintTransport();
        });
        return;
      }
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

  /** 播放顺序：随机 = 洗牌（当前曲排在最前），否则 = 从当前曲往后顺走 */
  function buildOrder(startIdx) {
    var n = S.queue.length;
    if (!n) { S.order = []; return; }
    var idx = [];
    for (var i = 0; i < n; i++) if (i !== startIdx) idx.push(i);
    if (S.shuffle) {
      for (var j = idx.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var tmp = idx[j]; idx[j] = idx[k]; idx[k] = tmp;
      }
    }
    S.order = [startIdx].concat(idx);
  }

  function playTrack(track, queue, index) {
    if (!track) return;
    if (queue) { S.queue = queue; S.qi = index >= 0 ? index : 0; }
    if (libMode() && S.shuffle) { S.order = []; } else { buildOrder(S.qi >= 0 ? S.qi : 0); }
    if (track) { S.hist.push(track); if (S.hist.length > 60) S.hist.shift(); }
    markRecent(track && track.id);
    S.track = track;
    S.lyrics = null; S.lyricIdx = -1; paintLyrics();
    paintNow();
    paintList();          /* 切歌要重建列表（当前行要挪位置），这里不是每事件路径 */
    setStatus(S.status === 'error' ? 'error' : (S.status === 'mock' ? 'mock' : 'ok'), S.status === 'mock' ? '演示音源 · ' + (track.artist || '') : '正在播放');
    var key = String(track.id);
    if (S.backend && S.backend.lyrics) {
      S.lyricPend = key;
      S.backend.lyrics(track, function (e2, picked) {
        if (S.lyricPend !== key) return;   /* 已经切歌，丢掉迟到结果 */
        S.lyricPend = '';
        if (e2 || !picked) { act('lyrics none: ' + e2); return; }
        S.lyrics = picked;
        paintLyrics();
        updateLyric();
      });
    }
    S.backend.streamUrl(track, function (err, url, rate) {
      if (err || !url) { setStatus('error', err || '拿不到音频地址'); return; }
      S.lastUrl = url;
      S.triedTranscode = false;
      var a = ensureAudio();
      try {
        a.pause();
        if (a.src !== url) a.src = url;
        if (rate && a.playbackRate !== rate) a.playbackRate = rate;
        a.currentTime = 0;
        applyAudioVol();
        var p = a.play();
        if (p && p.then) p.then(null, function () { /* 自动播放被拦：等用户点播放 */ });
      } catch (e) { setStatus('error', '播放器出错'); }
      paintNow(); paintProgress(); paintTransport();
    });
  }

  function toggle() {
    var a = ensureAudio();
    if (!S.track && S.queue.length) { playTrack(S.queue[0], S.queue, 0); return; }
    if (!S.track && libMode() && S.shuffle) { randomPick(function (t) { if (t) playTrack(t, null, -1); else toast('随机曲目没拿到'); }); return; }
    if (!S.track) { toast('先去右侧歌单里点一首'); return; }
    if (a.paused) {
      var p = a.play();
      if (p && p.then) p.then(null, function () { setStatus('error', '浏览器拦了自动播放，再点一次'); });
    } else {
      a.pause();
    }
  }

  /** 按 S.order 走下一首：循环关 = 走到头停下；列表循环 = 回到第一首 */
  function next() {
    if (libMode() && S.shuffle) {
      randomPick(function (t) { if (t) playTrack(t, null, -1); else setStatus('ok', '随机曲目没拿到'); });
      return;
    }
    if (!S.order.length) return;
    var pos = S.order.indexOf(S.qi);
    if (pos < 0) pos = 0;
    if (pos + 1 < S.order.length) { playTrack(S.queue[S.order[pos + 1]], null, S.order[pos + 1]); return; }
    if (S.repeat === 'all') { playTrack(S.queue[S.order[0]], null, S.order[0]); return; }
    setStatus('ok', '放到列表末尾了');
    paintTransport();
  }

  function prev() {
    if (libMode() && S.shuffle) {
      if (S.hist.length > 1) { S.hist.pop(); playTrack(S.hist[S.hist.length - 1], null, -1); }
      else if (S.audio) { try { S.audio.currentTime = 0; } catch (e) { } }
      return;
    }
    if (!S.order.length) return;
    if (S.audio && S.audio.currentTime > 3) { S.audio.currentTime = 0; return; }
    var pos = S.order.indexOf(S.qi);
    if (pos > 0) { playTrack(S.queue[S.order[pos - 1]], null, S.order[pos - 1]); return; }
    if (S.repeat === 'all') { playTrack(S.queue[S.order[S.order.length - 1]], null, S.order[S.order.length - 1]); return; }
    if (S.audio) { try { S.audio.currentTime = 0; } catch (e) { } }
  }

  /* ---------------- 播放模式 ---------------- */
  function modeLabel() {
    if (S.shuffle) return '播放模式：随机';
    if (S.repeat === 'one') return '播放模式：单曲循环';
    if (S.repeat === 'all') return '播放模式：列表循环';
    return '播放模式：顺序播放（点击切换）';
  }

  /** 一个按钮四态循环：顺序 → 列表循环 → 单曲循环 → 随机 → 顺序 */
  function cycleMode() {
    if (!S.shuffle && S.repeat === 'off') { S.repeat = 'all'; }
    else if (S.repeat === 'all') { S.repeat = 'one'; }
    else if (S.repeat === 'one') { S.repeat = 'off'; S.shuffle = true; }
    else { S.shuffle = false; }
    if (S.queue.length) buildOrder(S.qi >= 0 ? S.qi : 0);
    saveMode();
    paintTransport();
    toast(modeLabel());
    act('mode ' + (S.shuffle ? 'shuffle' : S.repeat));
  }

  function toggleShuffle() {
    S.shuffle = !S.shuffle;
    if (S.queue.length) buildOrder(S.qi >= 0 ? S.qi : 0);
    saveMode();
    paintTransport();
    toast(S.shuffle ? '随机播放：开' : '随机播放：关');
    act('shuffle ' + (S.shuffle ? 'on' : 'off'));
  }

  /** 循环按钮三档：关 → 列表循环 → 单曲循环 */
  function cycleRepeat() {
    S.repeat = S.repeat === 'off' ? 'all' : (S.repeat === 'all' ? 'one' : 'off');
    saveMode();
    paintTransport();
    toast(S.repeat === 'all' ? '循环：整个列表' : (S.repeat === 'one' ? '循环：单曲' : '循环：关'));
    act('repeat ' + S.repeat);
  }

  function openQueueView() {
    if (S.view === 'queue') {
      S.view = libMode() ? 'lib' : (S.tracks ? 'tracks' : 'pl');
      S.crumb = libMode() ? '所有歌曲' : (S.tracks ? (playlistName() || '歌单') : '歌单');
    } else {
      S.view = 'queue';
      S.crumb = '播放列表';
    }
    paintCrumb();
    paintList();
    paintTransport();
  }

  function playlistName() {
    for (var i = 0; i < S.playlists.length; i++) if (S.playlists[i].id === S.curPlaylist) return S.playlists[i].name;
    return '';
  }

  /* ---------------- 所有歌曲：分页装 + 服务端随机 ---------------- */
  function libMode() { return S.src === 'lib'; }

  function loadLibPage(skip) {
    if (S.libBusy || !S.backend || !S.backend.libTracks) return;
    if (skip >= S.lib.total) return;
    /* 封顶：列表只画前 LIB_MAX_ROWS 行，再装进来既看不见也占内存（一首带 raw 的曲目 ~1KB） */
    if (S.lib.items.length >= LIB_MAX_ROWS) { paintList(); return; }
    S.libBusy = true;
    S.backend.libTracks(skip, LIB_PAGE, function (err, res) {
      S.libBusy = false;
      if (err) { setStatus('error', '所有歌曲没加载出来：' + err); paintList(); return; }
      S.lib.total = num(res.total, S.lib.total);
      var items = res.items || [];
      for (var i = 0; i < items.length && S.lib.items.length < LIB_MAX_ROWS; i++) S.lib.items.push(items[i]);
      paintList();
    });
  }

  function openLibView() {
    S.view = 'lib';
    S.src = 'lib';
    S.tracks = null;
    S.curPlaylist = '';
    S.crumb = '所有歌曲';
    paintCrumb();
    if (!S.lib.items.length) {
      paintList('正在加载第一页…');
      loadLibPage(0);
    } else paintList();
  }

  function markRecent(id) {
    S.recent[String(id)] = 1;
    var c = 0;
    for (var k in S.recent) { if (S.recent.hasOwnProperty(k)) c++; }
    if (c > RECENT_MAX) S.recent = {};
  }

  /** 随机取一首：先吃手里这批；批快用完就后台补货；真用完了也不哑（兜底见下） */
  function randomPick(cb) {
    if (S.randQ.length) {
      cb(S.randQ.shift());
      if (S.randQ.length <= RAND_REFILL && !S.randBusy) refillRandom(null);
      return;
    }
    /* 手里没有：从已经装进来的全库页里随机垫一首（立刻有歌播），同时向服务器要下一批 */
    var filler = pickFromLibPages();
    refillRandom(function (ok) {
      if (ok && S.randQ.length) cb(S.randQ.shift());
      else if (filler) cb(filler);
      else cb(null);
    });
  }

  function refillRandom(done) {
    if (!S.backend || !S.backend.randomBatch) { if (done) done(false); return; }
    if (S.randBusy) { if (done) done(false); return; }
    S.randBusy = true;
    S.backend.randomBatch(function (err, list) {
      S.randBusy = false;
      if (err || !list || !list.length) { act('random batch failed: ' + (err || 'empty')); if (done) done(false); return; }
      pushBatch(list, false);
      /* 整批都被「最近播过」滤掉：放宽一次，允许重复，总比没歌强 */
      if (!S.randQ.length) pushBatch(list, true);
      if (done) done(true);
    });
  }

  function pushBatch(list, relax) {
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i].id);
      if (!relax && S.recent[id]) continue;
      S.randQ.push(list[i]);
      markRecent(id);
    }
  }

  function pickFromLibPages() {
    var items = S.lib.items;
    if (!items.length) return null;
    var pool = [];
    for (var i = 0; i < items.length; i++) { if (!S.recent[String(items[i].id)]) pool.push(items[i]); }
    if (!pool.length) pool = items;
    var t = pool[Math.floor(Math.random() * pool.length)];
    markRecent(String(t.id));
    return t;
  }

  function libRowHtml(t, i) {
    var on = S.track && t.id === S.track.id ? ' on' : '';
    return '<button class="m-song' + on + '" data-mact="libtrack" data-idx="' + i + '">' +
      '<span class="m-song-ico">' + svg(on && S.audio && !S.audio.paused ? 'wave' : 'play') + '</span>' +
      '<span class="m-song-main"><span class="m-song-t">' + esc(t.title || '未命名') + '</span>' +
      '<span class="m-song-a">' + esc((t.artist || '') + (t.album ? ' · ' + t.album : '')) + '</span></span>' +
      '<span class="m-song-d">' + fmtTime(t.duration) + '</span></button>';
  }

  /* 行级播放标记：以前每次播放/暂停都重建整张列表（LIB_MAX_ROWS=1500 时一次 3~6 万字符 innerHTML）。
     现在只改「上一行」和「当前行」两个节点的 class 与图标。全量重绘后 onRow 会作废重算。 */
  var onRow = -1;
  function rowNode(i) {
    var e = S.el;
    if (!e.list || i < 0 || !e.list.children || i >= e.list.children.length) return null;
    var b = e.list.children[i];
    if (!b || !b.getAttribute) return null;
    var act = b.getAttribute('data-mact');
    if (act !== 'track' && act !== 'libtrack') return null;
    return b;
  }
  function paintRow(b, on) {
    if (!b) return;
    b.className = 'm-song' + (on ? ' on' : '');
    var ico = b.querySelector ? b.querySelector('.m-song-ico') : null;
    if (ico) {
      var h = svg(on && S.audio && !S.audio.paused ? 'wave' : 'play');
      if (ico.innerHTML !== h) ico.innerHTML = h;
    }
  }
  /* 当前曲目在可见列表里的行号（歌单视图用 S.tracks，所有歌曲视图用 S.lib.items） */
  function currentRow() {
    if (!S.track) return -1;
    var list = S.view === 'lib' ? S.lib.items : S.tracks;
    if (!list || !list.length) return -1;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === S.track.id) return i;
    return -1;
  }
  function markPlaying() {
    var idx = currentRow();
    if (onRow >= 0 && onRow !== idx) paintRow(rowNode(onRow), false);
    paintRow(rowNode(idx), !!(S.track && S.audio && !S.audio.paused));
    onRow = idx;
  }
  function resetRowMark() { onRow = -1; markPlaying(); }

  function paintLib() {
    var e = S.el;
    var items = S.lib.items;
    var rows = Math.min(items.length, LIB_MAX_ROWS);
    var h = '';
    for (var i = 0; i < rows; i++) h += libRowHtml(items[i], i);
    if (items.length < S.lib.total) {
      h += '<div class="m-lib-more" data-mact="lib-more">还有 ' + (S.lib.total - items.length) + ' 首没装进来 · 点这里再装 ' + LIB_PAGE + ' 首</div>';
    } else {
      h += '<div class="m-lib-tip">全部 ' + S.lib.total + ' 首都已装好 · 开「随机」时不用装完，服务器直接给随机曲目</div>';
    }
    e.list.innerHTML = h;
    resetRowMark();
  }

  function setVol(v) {
    S.vol = clamp(v, 0, 1);
    var b = bridge();
    if (b && b.setVolume) {
      /* 负一屏的滑条直接拧安卓的系统音量（不弹系统音量条） */
      try { b.setVolume(S.vol); } catch (e) { }
      if (S.audio) S.audio.volume = 1;
    } else if (S.audio) {
      S.audio.volume = S.vol;
    }
    try { localStorage.setItem(VOL_KEY, String(S.vol)); } catch (e2) { }
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
        /* 墙上的屏不给人看 UnknownHostException：状态只写「连不上音乐服务」，
           具体异常留给开发者控制台。 */
        if (window.console && console.warn) console.warn('[music] ' + err);
        setStatus('error', '连不上音乐服务');
        S.playlists = [];
        S.ready = true;
        paintList();
        return;
      }
      S.playlists = list || [];
      S.ready = true;
      if (S.backend.libTracks && !S.lib.total) {
        S.backend.libTracks(0, 1, function (e3, res) {
          if (!e3 && res) { S.lib.total = num(res.total, 0); paintList(); }
        });
      }
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
    S.view = 'tracks';
    S.tracks = null;
    S.loading = true;
    paintCrumb();
    paintList('载入曲目…');
    S.backend.tracks(id, function (err, list) {
      S.loading = false;
      if (err) { setStatus('error', '读歌单失败：' + err); S.tracks = []; paintList(); return; }
      S.tracks = list || [];
      S.curPlaylist = id;
      paintCrumb();
      paintList();
    });
  }

  function backToPlaylists() {
    S.tracks = null;
    S.src = '';
    S.view = 'pl';
    S.crumb = '歌单';
    paintCrumb();
    paintList();
    paintTransport();
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

  /* ---------------- 封面解析：道理鱼的封面要鉴权头，只能异步取字节 ----------------
     以前每解析一张封面就 paintNow()+paintList() 全量重建整表（N 张 = N 次全量重绘），
     而且 base64 永久留在 item.cover 上（LIB_MAX_ROWS=1500 时能攒几十 MB，512MB 的平板最危险）。
     现在：重绘合并成一次（250ms 内到达的封面共用一次重绘），缓存有条数上限，超了丢最早的。 */
  var COVER_CAP = 60;
  var coverOrder = [];
  var coverRepaint = false;
  function queueCoverRepaint() {
    if (coverRepaint) return;
    coverRepaint = true;
    setTimeout(function () {
      coverRepaint = false;
      paintNow();
      /* 只有「歌单」视图的封面图在列表里；歌曲/所有歌曲视图不显示封面，别重绘整表 */
      if (S.view === 'pl') paintList();
    }, 250);
  }
  function evictCovers() {
    while (coverOrder.length > COVER_CAP) {
      var old = coverOrder.shift();
      if (old && old !== S.track) old.cover = '';
    }
  }
  var coverFail = {};
  function resolveCover(item) {
    if (!item || item.cover || !item.coverReq) return;
    var b = S.backend;
    if (!b || !b.loadCover) return;
    var key = String(item.coverReq.coverArtUrl || item.coverReq.coverArtPath || '');
    if (!key || S.coverPend[key]) return;
    var failedAt = coverFail[key];
    if (failedAt && new Date().getTime() - failedAt < 600000) return;
    S.coverPend[key] = true;
    b.loadCover(item.coverReq, function (err, src) {
      delete S.coverPend[key];
      if (err) { coverFail[key] = new Date().getTime(); return; }
      delete coverFail[key];
      if (err || !src) { act('cover failed ' + err); return; }
      item.cover = src;
      if (coverOrder.indexOf(item) < 0) coverOrder.push(item);
      evictCovers();
      queueCoverRepaint();
    });
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
    /* 封面没解析出来之前先放音符占位（道理鱼的封面是异步取的） */
    e.cover.innerHTML = t.cover ? '<img src="' + esc(t.cover) + '" alt="">'
      : '<span class="m-cover-ph">' + (window.ICONS ? svg('music') : '') + '</span>';
    resolveCover(t);
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
    if (e.queueBtn) { e.queueBtn.className = 'm-btn m-mini' + (S.view === 'queue' ? ' on' : ''); e.queueBtn.innerHTML = svg('list'); }
    /* 播放模式一键四态：顺序（压暗的循环图标）→ 列表循环 → 单曲循环 → 随机 */
    if (e.modeBtn) {
      var onMode = S.shuffle || S.repeat !== 'off';
      e.modeBtn.className = 'm-btn m-mini' + (onMode ? ' on' : '');
      e.modeBtn.innerHTML = svg(S.shuffle ? 'shuffle' : (S.repeat === 'one' ? 'repeatOne' : 'repeat'));
      e.modeBtn.setAttribute('aria-label', modeLabel());
    }
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
    updateLyric();
  }

  /* ---------------- 歌词渲染：只显示三行（上一行 / 当前行 / 下一行） ---------------- */
  function lyricIdxNow() {
    var L = S.lyrics && S.lyrics.lines;
    if (!L || !L.length) return -1;
    if (S.lyrics.synced) return lyricIdxAt(L, num(S.audio ? S.audio.currentTime : 0, 0));
    /* 纯文本歌词没有时间轴，按播放进度比例估一个位置 */
    var a = S.audio;
    var d = a && isFinite(a.duration) ? a.duration : num(S.track && S.track.duration, 0);
    var p = a ? a.currentTime : 0;
    if (!d) return 0;
    return Math.floor(clamp(p / d, 0, 1) * (L.length - 1));
  }

  function paintLyrics() {
    var e = S.el.lyrics;
    if (!e) return;
    var L = S.lyrics && S.lyrics.lines;
    if (!L || !L.length) {
      e.className = 'm-lyrics hide';
      e.innerHTML = '';
      S.lyricIdx = -1;
      return;
    }
    var idx = lyricIdxNow();
    if (idx < 0) idx = 0;
    S.lyricIdx = idx;
    e.className = 'm-lyrics';
    var h = '';
    for (var i = idx - 1; i <= idx + 1; i++) {
      if (i < 0 || i >= L.length) continue;
      var cls = 'm-lr' + (i === idx ? ' on' : (i === idx + 1 ? ' m-lr-soon' : ''));
      h += '<div class="' + cls + '">' + esc(L[i].text) + '</div>';
    }
    if (!S.lyrics.synced) h += '<div class="m-lrc-tip">纯文本歌词（没有时间轴）</div>';
    e.innerHTML = h;
  }

  function updateLyric() {
    var L = S.lyrics && S.lyrics.lines;
    if (!L || !L.length) return;
    if (lyricIdxNow() !== S.lyricIdx) paintLyrics();
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
    e.crumb.innerHTML = (S.view !== 'pl' ? '<button class="m-back" data-mact="back">' + svg('back') + '<span>' + esc(S.view === 'queue' ? (libMode() ? '所有歌曲' : (playlistName() || '歌单')) : '歌单') + '</span></button>' : '') +
      '<span class="m-crumb-t">' + esc(S.crumb) + '</span>';
  }

  /** 「正在播放列表」：当前曲在最前，后面是按随机/循环算出的播放顺序 */
  function paintQueue() {
    var e = S.el;
    if (libMode() && S.shuffle) {
      if (!S.track) { e.list.innerHTML = '<div class="m-empty">还没有开始播放<br><span class="m-empty-d">开随机后点播放键，服务器会给你一批随机曲目</span></div>'; return; }
      var hq = '<button class="m-song on" data-mact="noop">' +
        '<span class="m-song-ico">' + svg(S.audio && !S.audio.paused ? 'wave' : 'play') + '</span>' +
        '<span class="m-song-main"><span class="m-song-t">' + esc(S.track.title || '未命名') + '</span>' +
        '<span class="m-song-a">' + esc((S.track.artist || '') + (S.track.album ? ' · ' + S.track.album : '')) + '</span></span>' +
        '<span class="m-song-d">正在播</span></button>';
      var shown = Math.min(S.randQ.length, 40);
      for (var q = 0; q < shown; q++) {
        var rt = S.randQ[q];
        hq += '<button class="m-song" data-mact="noop"><span class="m-song-ico"><span class="m-q-n">' + (q + 1) + '</span></span>' +
          '<span class="m-song-main"><span class="m-song-t">' + esc(rt.title || '未命名') + '</span>' +
          '<span class="m-song-a">' + esc((rt.artist || '') + (rt.album ? ' · ' + rt.album : '')) + '</span></span>' +
          '<span class="m-song-d">' + fmtTime(rt.duration) + '</span></button>';
      }
      if (!shown) hq += '<div class="m-lib-tip">这批随机曲目快用完了，会自动再拿一批</div>';
      e.list.innerHTML = hq;
      return;
    }
    if (!S.order.length) {
      e.list.innerHTML = '<div class="m-empty">还没有开始播放<br><span class="m-empty-d">回歌单里点一首，这里就会出现播放列表</span></div>';
      return;
    }
    var h = '';
    for (var k = 0; k < S.order.length; k++) {
      var t = S.queue[S.order[k]];
      if (!t) continue;
      var cur = S.order[k] === S.qi;
      var ico = cur ? svg(S.audio && !S.audio.paused ? 'wave' : 'play') : '<span class="m-q-n">' + (k + 1) + '</span>';
      h += '<button class="m-song' + (cur ? ' on' : '') + '" data-mact="qtrack" data-pos="' + k + '">' +
        '<span class="m-song-ico">' + ico + '</span>' +
        '<span class="m-song-main"><span class="m-song-t">' + esc(t.title || '未命名') + '</span>' +
        '<span class="m-song-a">' + esc((t.artist || '') + (t.album ? ' · ' + t.album : '')) + '</span></span>' +
        '<span class="m-song-d">' + fmtTime(t.duration) + '</span></button>';
    }
    e.list.innerHTML = h;
  }

  function paintList(loadingText) {
    var e = S.el;
    if (!e.list) return;
    if (loadingText) { e.list.innerHTML = '<div class="m-empty">' + esc(loadingText) + '</div>'; return; }
    if (S.status === 'error' && !S.playlists.length) {
      e.list.innerHTML = '<div class="m-empty"><div class="m-empty-t">音乐服务没连上</div>' +
        '<div class="m-empty-d">检查「音乐设置」里的服务器地址，再点重试</div>' +
        '<button class="btn" data-mact="retry">重试</button>' +
        '<button class="btn" data-mact="open-cfg">音乐设置</button></div>';
      return;
    }
    if (S.view === 'queue') { paintQueue(); return; }
    if (S.view === 'lib') { paintLib(); return; }
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
      resetRowMark();
      return;
    }
    if (!S.playlists.length) {
      e.list.innerHTML = '<div class="m-empty">还没有歌单<br><span class="m-empty-d">在音乐服务里建一个歌单，这里就会出现</span></div>';
      return;
    }
    var out = '<button class="m-pl" data-mact="all">' +
      '<span class="m-pl-cover">' + svg('music') + '</span>' +
      '<span class="m-pl-main"><span class="m-pl-n">所有歌曲</span>' +
      '<span class="m-pl-c">' + (S.lib.total ? S.lib.total + ' 首 · 分页加载' : '全部歌单里的歌') + '</span></span>' +
      '<span class="m-pl-go">' + svg('chev') + '</span></button>';
    for (var j = 0; j < S.playlists.length; j++) {
      var p = S.playlists[j];
      out += '<button class="m-pl" data-mact="pl" data-id="' + esc(p.id) + '">' +
        '<span class="m-pl-cover">' + (p.cover ? '<img src="' + esc(p.cover) + '" alt="">' : svg('music')) + '</span>' +
        '<span class="m-pl-main"><span class="m-pl-n">' + esc(p.name || '未命名歌单') + '</span>' +
        '<span class="m-pl-c">' + (num(p.count, 0) ? p.count + ' 首' : '') + '</span></span>' +
        '<span class="m-pl-go">' + svg('chev') + '</span></button>';
    }
    e.list.innerHTML = out;
    for (var q = 0; q < S.playlists.length; q++) resolveCover(S.playlists[q]);
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
    var sv = sysVol();
    if (sv !== null) S.vol = sv;
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

  /* 只认「从屏幕左边缘往右滑」：手指落在左边 64 CSS px 内起手就算。
     热区比系统返回手势的边带（约 24dp）宽一截，这样在 Android 13 上从边缘
     往里带一点起手也能打开负一屏，不会刚碰到边就被系统当成返回。
     屏幕中间的卡片亮度条、房间/场景横向滚动条怎么拖都不会把页面拽出来。 */
  var EDGE_PULL = 64;

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
    if (a === 'queue') { openQueueView(); return; }
    if (a === 'mode') { cycleMode(); return; }
    if (a === 'shuffle') { toggleShuffle(); return; }
    if (a === 'repeat') { cycleRepeat(); return; }
    if (a === 'qtrack') {
      var k = num(btn.getAttribute('data-pos'), -1);
      if (k >= 0 && k < S.order.length) playTrack(S.queue[S.order[k]], null, S.order[k]);
      return;
    }
    if (a === 'back') {
      if (S.view === 'queue') {
        S.view = S.tracks ? 'tracks' : 'pl';
        S.crumb = S.view === 'tracks' ? (playlistName() || '歌单') : '歌单';
        paintCrumb(); paintList(); paintTransport();
      } else backToPlaylists();
      return;
    }
    if (a === 'pl') { openPlaylist(btn.getAttribute('data-id')); return; }
    if (a === 'all') { openLibView(); act('music open all songs'); return; }
    if (a === 'lib-more') { loadLibPage(S.lib.items.length); return; }
    if (a === 'libtrack') {
      var li = num(btn.getAttribute('data-idx'), -1);
      if (li >= 0 && S.lib.items[li]) playTrack(S.lib.items[li], S.lib.items, li);
      return;
    }
    if (a === 'track') {
      var i = num(btn.getAttribute('data-idx'), -1);
      if (i >= 0 && S.tracks) playTrack(S.tracks[i], S.tracks, i);
      return;
    }
    if (a === 'retry') { S.ready = false; loadPlaylists(true); return; }
    if (a === 'open-cfg') { close(); if (window.__PANEL_OPEN_MUSIC_CFG__) window.__PANEL_OPEN_MUSIC_CFG__(); return; }
    if (a === 'close') {
      /* 左上角那颗在歌单里是「回歌单列表」，不在歌单里才是收起负一屏 */
      if (S.tracks) { backToPlaylists(); act('music back to playlists'); }
      else { close(); }
      return;
    }
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

  /* 滑条通用拖动：pointer 事件优先（触屏+鼠标一套），不支持 PointerEvent 的老 WebView 退回 touch+mouse。
     按下即定位、拖动跟手（实时 seek，节流 220ms 免得一路狂 seek）、松手最终定位 */
  function bindDrag(host, opt) {
    var down = false, lastX = 0, lastScrub = 0;
    function xOf(ev) {
      if (ev.touches && ev.touches.length) return ev.touches[0].clientX;
      if (ev.changedTouches && ev.changedTouches.length) return ev.changedTouches[0].clientX;
      return ev.clientX;
    }
    function begin(ev) {
      if (!opt.ok()) return;
      down = true; lastX = xOf(ev); opt.drag(true);
      opt.value(ratioAt(host, lastX), false);
      ev.preventDefault();
      if (window.PointerEvent && host.setPointerCapture && ev.pointerId !== undefined) {
        try { host.setPointerCapture(ev.pointerId); } catch (x) { }
      }
    }
    function move(ev) {
      if (!down) return;
      lastX = xOf(ev);
      opt.value(ratioAt(host, lastX), false);
      ev.preventDefault();
    }
    function end(ev) {
      if (!down) return;
      down = false;
      opt.value(ratioAt(host, xOf(ev)), true);
      opt.drag(false);
    }
    function cancel() { if (!down) return; down = false; opt.drag(false); if (opt.cancel) opt.cancel(); }
    if (window.PointerEvent) {
      host.addEventListener('pointerdown', begin, false);
      host.addEventListener('pointermove', move, false);
      host.addEventListener('pointerup', end, false);
      host.addEventListener('pointercancel', cancel, false);
    } else {
      host.addEventListener('touchstart', begin, false);
      host.addEventListener('touchmove', move, false);
      host.addEventListener('touchend', end, false);
      host.addEventListener('touchcancel', cancel, false);
      host.addEventListener('mousedown', begin, false);
      document.addEventListener('mousemove', function (ev) { if (down) move(ev); }, false);
      document.addEventListener('mouseup', function (ev) { if (down) end(ev); }, false);
    }
  }

  function bindBars() {
    var e = S.el;
    /* 进度条：实时跟随，松手定稿；host 用整行容器（.m-progress），手指稍微偏出细条也能拖 */
    var pHost = e.bar ? (e.bar.parentNode || e.bar) : null;
    if (pHost) {
      var lastScrub = 0;
      var pDur = function () {
        if (S.audio && isFinite(S.audio.duration) && S.audio.duration > 0) return S.audio.duration;
        /* 流式 mp3 在 Chromium 里 duration 可能一直不是有限值，用服务器给的时长兜底 */
        return S.track ? (S.track.durationSeconds || S.track.duration || 0) : 0;
      };
      bindDrag(pHost, {
        ok: function () { return !!S.audio && pDur() > 0; },
        drag: function (v) { S.seekDrag = v; },
        cancel: function () { paintProgress(); },
        value: function (p, commit) {
          var dur = pDur();
          setFill(e.fill, e.knob, p * 100);
          e.pos.textContent = fmtTime(p * dur);
          if (commit) {
            try { S.audio.currentTime = p * dur; } catch (x) { }
            paintProgress();
            act('进度拖动 → ' + fmtTime(p * dur));
          } else if (Date.now() - lastScrub > 220) {
            lastScrub = Date.now();
            try { S.audio.currentTime = p * dur; } catch (x) { }
          }
        },
      });
    }
    if (e.vol) {
      bindDrag(e.vol, {
        ok: function () { return true; },
        drag: function (v) { S.volDrag = v; },
        value: function (p, commit) {
          setVol(p);
          if (commit) act('音量 → ' + Math.round(p * 100) + '%');
        },
      });
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
    e.prev = $('mPrev'); e.next = $('mNext');
    e.queueBtn = $('mQueue'); e.modeBtn = $('mMode');
    e.lyrics = $('mLyrics');
    e.vol = $('mVol'); e.volFill = $('mVolFill'); e.volKnob = $('mVolKnob'); e.volPct = $('mVolPct');
    e.crumb = $('mCrumb'); e.list = $('mList');

    S.cfg = readCfg();
    S.vol = readVol();
    var md = readMode();
    S.shuffle = md.shuffle; S.repeat = md.repeat;
    buildBackend();

    page.addEventListener('click', onPageClick, false);
    if (e.list) {
      e.list.addEventListener('scroll', function () {
        if (S.view !== 'lib' || S.libBusy) return;
        if (S.lib.items.length >= LIB_MAX_ROWS || S.lib.items.length >= S.lib.total) return;
        if (e.list.scrollTop + e.list.clientHeight >= e.list.scrollHeight - 140) loadLibPage(S.lib.items.length);
      }, false);
    }
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

    if (e.cover) e.cover.innerHTML = '<span class="m-cover-ph">' + svg('music') + '</span>';
    /* 上一首/下一首/音量的图标以前没人填，屏幕上就是三个空心圆 */
    if (e.prev) e.prev.innerHTML = svg('prev');
    if (e.next) e.next.innerHTML = svg('next');
    var volIco = $('mVolIco');
    if (volIco) volIco.innerHTML = svg('volume');
    paintVol(); paintCrumb(); paintList(); paintStatus(); paintNow(); paintTransport(); paintLyrics();
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
    view: function () { return S.view; },
    shuffle: function () { return S.shuffle; },
    repeat: function () { return S.repeat; },
    queueList: function () { return S.order.map(function (i) { return S.queue[i]; }); },
    openQueue: openQueueView, toggleShuffle: toggleShuffle, cycleRepeat: cycleRepeat, cycleMode: cycleMode,
    mode: function () { return { shuffle: S.shuffle, repeat: S.repeat, label: modeLabel() }; },
    next: next, prev: prev, togglePlay: toggle,
    openAll: function () { open(true); openLibView(); },
    libInfo: function () { return { view: S.view, src: S.src, loaded: S.lib.items.length, total: S.lib.total, randLeft: S.randQ.length, hist: S.hist.length } }
  };
})();
