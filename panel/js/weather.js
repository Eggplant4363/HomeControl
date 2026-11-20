/* 天气（ES5，Chromium 57 可用）：给待机页（熄屏大时钟那一屏）显示「15° 多云」
 *
 * 数据来源，按优先级：
 *   1) HA 里的 weather.* 实体（有 temperature 属性就用它，状态映射成中文）
 *   2) HA 里第一个有经纬度的 person.* / device_tracker.*（「我所在位置的天气」）
 *   3) HA 的 zone.home 经纬度
 *   4) 都没有就不显示 —— 宁可空着，也不要显示别的地方的天气。
 *
 * 2)/3) 走 open-meteo（免费、不要 key、支持 file:// 页面）：平板经 Java 桥 updNet 抓
 * https://api.open-meteo.com/v1/forecast?…，浏览器预览里退回 fetch()。
 * 结果按 15 分钟缓存（存 HCStore 的 hc.weather），熄屏页每画一次都不会重新发请求。
 */
(function (w) {
  'use strict';

  var KEY = 'hc.weather';
  var TTL = 15 * 60 * 1000;
  var cache = null;          /* { at, t, text, icon, hi, lo, place } */
  var pending = false;
  var statesFn = null;
  var seq = 0;
  var netCb = {};

  /* ---------------- 桥 / 网络 ---------------- */
  var prevNet = w.__hcUpdNetCb;
  w.__hcUpdNetCb = function (id, out) {
    var f = netCb[id];
    if (f) {
      delete netCb[id];
      f(null, out);
      return;
    }
    if (typeof prevNet === 'function') prevNet(id, out);
  };

  function httpGet(url, cb) {
    var b = w.AndroidBridge;
    var done = false;
    function finish(err, out) {
      if (done) return;
      done = true;
      cb(err, out);
    }
    /* 网络卡住时不能让 pending 永远为真，12 秒后放弃（下次待机页还会再试） */
    var guard = w.setTimeout ? w.setTimeout(function () { finish(new Error('超时')); }, 12000) : null;
    function clear() { if (guard && w.clearTimeout) w.clearTimeout(guard); }
    if (b && b.updNet) {
      var id = 'wx' + (++seq);
      netCb[id] = function (err2, out2) { clear(); finish(err2, out2); };
      try {
        b.updNet(id, url, '{}');
      } catch (e) {
        delete netCb[id];
        clear();
        finish(e);
      }
      return;
    }
    if (typeof w.fetch === 'function') {
      try {
        w.fetch(url).then(function (r) { return r.text(); }).then(function (t) {
          clear();
          finish(null, t);
        })['catch'](function (e) { clear(); finish(e); });
        return;
      } catch (e) { }
    }
    clear();
    finish(new Error('没有可用的网络通道'));
  }

  /* ---------------- 天气码 → 中文 ---------------- */
  var WMO = {
    0: ['晴', 'sun'], 1: ['晴间多云', 'sun'], 2: ['多云', 'cloud'], 3: ['阴', 'cloud'],
    45: ['雾', 'cloud'], 48: ['雾凇', 'cloud'],
    51: ['毛毛雨', 'rain'], 53: ['毛毛雨', 'rain'], 55: ['毛毛雨', 'rain'],
    56: ['冻雨', 'rain'], 57: ['冻雨', 'rain'],
    61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
    66: ['冻雨', 'rain'], 67: ['冻雨', 'rain'],
    71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['雪粒', 'snow'],
    80: ['阵雨', 'rain'], 81: ['阵雨', 'rain'], 82: ['强阵雨', 'rain'],
    85: ['阵雪', 'snow'], 86: ['强阵雪', 'snow'],
    95: ['雷阵雨', 'rain'], 96: ['雷阵雨', 'rain'], 99: ['雷阵雨', 'rain']
  };

  /* HA 的天气状态 → 中文/图标 */
  var HA_STATE = {
    'clear-night': ['晴', 'moon'], clear: ['晴', 'sun'], sunny: ['晴', 'sun'],
    'partlycloudy': ['多云', 'cloud'], cloudy: ['阴', 'cloud'],
    fog: ['雾', 'cloud'], hail: ['冰雹', 'rain'], lightning: ['雷雨', 'rain'],
    'lightning-rainy': ['雷阵雨', 'rain'], pouring: ['大雨', 'rain'],
    rainy: ['雨', 'rain'], snowy: ['雪', 'snow'], 'snowy-rainy': ['雨夹雪', 'snow'],
    windy: ['大风', 'cloud'], 'windy-variant': ['大风', 'cloud'], exceptional: ['异常', 'cloud']
  };

  function wmoText(code) {
    var a = WMO[Number(code)];
    return a ? { text: a[0], icon: a[1] } : { text: '', icon: 'cloud' };
  }

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function round1(n) { return Math.round(n); }

  /* ---------------- 状态来源 ---------------- */
  function bindStates(fn) { statesFn = fn; }

  /** app.js 的 S.states 是 { entity_id: state } 的对象；也允许直接给数组（测试用） */
  function states() {
    var s = null;
    try { s = statesFn ? statesFn() : null; } catch (e) { return []; }
    if (!s) return [];
    if (typeof s.length === 'number' && typeof s !== 'string') return s;
    var out = [], k;
    for (k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k)) out.push(s[k]);
    }
    return out;
  }

  function attr(e, k) { return e && e.attributes ? e.attributes[k] : null; }

  /** HA 里的 weather 实体（有就用它，不再请求外网） */
  function fromHaWeather() {
    var list = states();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || String(e.entity_id || '').indexOf('weather.') !== 0) continue;
      if (e.state === 'unavailable' || e.state === 'unknown') continue;
      var m = HA_STATE[e.state] || ['', 'cloud'];
      var t = num(attr(e, 'temperature'));
      if (t === null) continue;
      return {
        t: round1(t), feel: null, text: m[0], icon: m[1],
        hi: null, lo: null, place: String(attr(e, 'friendly_name') || ''), src: 'ha'
      };
    }
    return null;
  }

  /** 坐标：设置里手填 > HA 里的人所在地 > zone.home */
  function coords() {
    var p = null;
    try { p = w.HCStore ? w.HCStore.getJSON('prefs', {}) : null; } catch (e) { }
    var manual = p && p.wxPos ? String(p.wxPos) : '';
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(manual);
    if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), place: '手动' };
    var list = states(), i, e;
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (!e) continue;
      var id = String(e.entity_id || '');
      if (id.indexOf('person.') !== 0 && id.indexOf('device_tracker.') !== 0) continue;
      var la = num(attr(e, 'latitude')), lo = num(attr(e, 'longitude'));
      if (la === null || lo === null) continue;
      return { lat: la, lon: lo, place: String(attr(e, 'friendly_name') || '') };
    }
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (!e || String(e.entity_id || '') !== 'zone.home') continue;
      var zl = num(attr(e, 'latitude')), zo = num(attr(e, 'longitude'));
      if (zl !== null && zo !== null) return { lat: zl, lon: zo, place: '家' };
    }
    return null;
  }

  function urlFor(c) {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + c.lat +
      '&longitude=' + c.lon +
      '&current_weather=true&daily=temperature_2m_max,temperature_2m_min' +
      '&timezone=auto&forecast_days=1';
  }

  /* ---------------- 缓存 ---------------- */
  function loadCache() {
    try {
      var v = w.HCStore ? w.HCStore.getJSON(KEY, null) : null;
      if (v && v.at && typeof v.t === 'number') cache = v;
    } catch (e) { }
  }

  function saveCache(d) {
    cache = d;
    try { if (w.HCStore) w.HCStore.setJSON(KEY, d); } catch (e) { }
  }

  function fresh() { return !!(cache && (Date.now() - cache.at) < TTL); }

  /* ---------------- 抓取 ---------------- */
  function refresh(cb) {
    if (pending) { if (cb) cb(false); return; }
    if (fresh()) { if (cb) cb(true); return; }
    var ha = fromHaWeather();
    if (ha) {
      ha.at = Date.now();
      saveCache(ha);
      if (cb) cb(true);
      return;
    }
    var c = coords();
    if (!c) { if (cb) cb(false); return; }
    pending = true;
    httpGet(urlFor(c), function (err, out) {
      pending = false;
      if (err || !out) { if (cb) cb(false); return; }
      var r = null;
      try { r = typeof out === 'string' ? JSON.parse(out) : out; } catch (e) { }
      if (!r) { try { r = JSON.parse(String(out && out.body)); } catch (e2) { } }
      if (!r || !r.current_weather) { if (cb) cb(false); return; }
      var cw = r.current_weather, m = wmoText(cw.weathercode);
      /* 夜里晴天画月亮 */
      if (m.icon === 'sun' && Number(cw.is_day) === 0) m = { text: m.text, icon: 'moon' };
      var daily = r.daily || {};
      var hi = daily.temperature_2m_max && daily.temperature_2m_max.length ? num(daily.temperature_2m_max[0]) : null;
      var lo = daily.temperature_2m_min && daily.temperature_2m_min.length ? num(daily.temperature_2m_min[0]) : null;
      saveCache({
        at: Date.now(), t: round1(num(cw.temperature) || 0), feel: null,
        text: m.text, icon: m.icon,
        hi: hi === null ? null : round1(hi), lo: lo === null ? null : round1(lo),
        place: c.place, src: 'open-meteo'
      });
      if (cb) cb(true);
    });
  }

  /* ---------------- 渲染 ---------------- */
  function text() {
    if (!cache) return '';
    var s = cache.t + '°';
    if (cache.text) s += ' ' + cache.text;
    if (cache.hi !== null && cache.lo !== null && cache.hi !== undefined) s += ' ' + cache.lo + '°/' + cache.hi + '°';
    return s;
  }

  function render() {
    var box = w.document ? w.document.getElementById('dimWx') : null;
    if (!box) return;
    var on = true;
    try {
      var p = w.HCStore ? w.HCStore.getJSON('prefs', {}) : {};
      on = !p || p.wxOn !== false;
    } catch (e) { }
    if (!on || !cache) { box.className = 'dim-wx off'; box.innerHTML = ''; return; }
    var icons = w.ICONS || {};
    var ico = icons[cache.icon] || icons.cloud || '';
    box.innerHTML = '<span class="dim-wx-ico">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + ico + '</svg></span>' +
      '<span>' + esc(text()) + '</span>';
    box.className = 'dim-wx';
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 待机页会用：有新鲜数据直接画，没有就先画旧的再去取 */
  function paint() {
    loadCache();
    render();
    if (!fresh()) {
      refresh(function () {
        render();
      });
    }
  }

  function ensure() { paint(); }

  function status() {
    return {
      at: cache ? cache.at : 0,
      t: cache ? cache.t : null,
      text: cache ? cache.text : '',
      place: cache ? cache.place : '',
      src: cache ? cache.src : '',
      fresh: fresh()
    };
  }

  function clear() {
    cache = null;
    try { if (w.HCStore) w.HCStore.setJSON(KEY, null); } catch (e) { }
    render();
  }

  /** 测试/离线截图用：直接塞一份数据并画出来 */
  function setData(o) {
    var d = o || {};
    cache = {
      at: Date.now(), t: typeof d.t === 'number' ? d.t : 15,
      text: d.text || '', icon: d.icon || 'cloud',
      hi: typeof d.hi === 'number' ? d.hi : null,
      lo: typeof d.lo === 'number' ? d.lo : null,
      place: d.place || '', src: 'stub'
    };
    render();
    return text();
  }

  w.HCWeather = {
    bindStates: bindStates,
    paint: paint,
    ensure: ensure,
    refresh: refresh,
    render: render,
    text: text,
    status: status,
    clear: clear,
    setData: setData,
    coords: coords,
    wmoText: wmoText,
    KEY: KEY,
    TTL: TTL
  };
})(window);
