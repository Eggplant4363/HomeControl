/* 中控屏主逻辑 —— 目标环境 Chromium 57：不使用可选链、不使用 flex gap */
(function () {
  'use strict';

  var cfg = window.PANEL_CONFIG;
  var ICONS = window.ICONS;
  var BOOT_T0 = Date.now();  /* 启动耗时：脚本开始 → 首屏渲染完 */
  /* camera 实体的 state 是 idle/streaming/recording，不是 on/off */
  var CAM_STATE = { idle: '待机', streaming: '传输中', recording: '录制中', unavailable: '离线' };

  var el = {};
  var toastTimer = null;
  var S = { lastErr: '', lastProbe: null,
    states: {},
    room: cfg.defaultRoom || cfg.rooms[0].id,
    items: [],
    tileEls: [],
    sig: '',
    backend: null,
    sheetItem: null,
    sheetEntity: null,
    dragging: false,
    lpTimer: null,
    lpFired: false,
    pctDrag: null,
    pctFired: false,
    dimOn: false,
    dimTimer: null,
    status: { connected: false, text: '连接中…' },
    real: false,
    names: null,
    editing: false,
    editBarEl: null,
    edit: null,
    sheetShow: null,
    tileSelItem: null,
    layoutReady: true,
    layoutBuilding: false
  };

  var HVAC = { off: '已关闭', cool: '制冷', heat: '制热', heat_cool: '冷暖', auto: '自动', dry: '除湿', fan_only: '送风', unavailable: '不可用' };
  var FAN_NAME = { auto: '自动', low: '低', medium: '中', high: '高', middle: '中', silent: '静音' };
  var COVER_STATE = { open: '已打开', closed: '已关闭', opening: '打开中…', closing: '关闭中…' };
  var WEATHER = {
    sunny: ['晴', 'sun'], 'clear-night': ['晴', 'moon'], partlycloudy: ['多云', 'cloud'],
    cloudy: ['阴', 'cloud'], rainy: ['雨', 'rain'], pouring: ['大雨', 'rain'],
    lightning: ['雷雨', 'rain'], 'lightning-rainy': ['雷雨', 'rain'], snowy: ['雪', 'rain'],
    fog: ['雾', 'cloud'], windy: ['大风', 'cloud'], 'windy-variant': ['大风', 'cloud']
  };
  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* ---------------- 工具 ---------------- */
    function $(id) { return document.getElementById(id); }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function svg(name) {
      var d = ICONS[name] || ICONS.gear;
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
    }
    function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function stateOf(id) { var e = S.states[id]; return e ? e.state : 'unavailable'; }
    function attrsOf(id) { var e = S.states[id]; return e && e.attributes ? e.attributes : {}; }
    /* ---- 能力判断：真实 HA 里同一类实体支持的属性差异很大，按 supported_* 属性决定 UI ---- */
    function supportedModes(attrs) {
      var m = attrs.supported_color_modes;
      if (m && m.length) return m.join(',');
      return '';
    }
    function hasBrightness(attrs) {
      var s = supportedModes(attrs);
      if (s) return s.indexOf('onoff') < 0;
      return attrs.brightness != null || attrs.color_mode != null;
    }
    function hasColorTemp(attrs) {
      var s = supportedModes(attrs);
      if (s) return s.indexOf('color_temp') > -1;
      return attrs.min_mireds != null && attrs.max_mireds != null;
    }
    /* ---- 彩色灯：rgb/hs/xy 模式才显示取色，preset 走 light.turn_on + rgb_color ---- */
    var COLOR_PRESETS = [
      { name: '暖黄', rgb: [255, 176, 80] },
      { name: '暖白', rgb: [255, 214, 170] },
      { name: '正白', rgb: [255, 244, 229] },
      { name: '青绿', rgb: [110, 231, 183] },
      { name: '天蓝', rgb: [96, 165, 250] },
      { name: '蓝紫', rgb: [147, 130, 255] },
      { name: '品红', rgb: [244, 114, 182] },
      { name: '暖红', rgb: [248, 113, 113] }
    ];
  
    function colorModes(attrs) {
      var s = supportedModes(attrs);
      if (!s) return '';
      return s;
    }
  
      function hasColor(attrs) {
    var m = colorModes(attrs);
    if (m) return m.indexOf('hs') > -1 || m.indexOf('rgb') > -1 || m.indexOf('xy') > -1;
    return attrs.hs_color != null || attrs.rgb_color != null;
  }

  function rgbCss(rgb) {
    if (!rgb || rgb.length < 3) return '';
    var out = [];
    for (var i = 0; i < 3; i++) {
      var v = num(rgb[i], 0);
      v = Math.max(0, Math.min(255, Math.round(v)));
      out.push(v);
    }
    return out.join(',');
  }

  function curRgb(attrs) {
    if (attrs.rgb_color) return attrs.rgb_color;
    var hs = attrs.hs_color;
    if (hs && hs.length >= 2) return hsvToRgb(num(hs[0], 0), num(hs[1], 0) / 100, num(attrs.brightness, 255) / 255);
    return null;
  }

  function hsvToRgb(h, s, v) {
    h = ((num(h, 0) % 360) + 360) % 360;
    var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function swRow(attrs) {
    var cur = curRgb(attrs), curCss = cur ? rgbCss(cur) : '';
    var html = '';
    COLOR_PRESETS.forEach(function (p) {
      var css = rgbCss(p.rgb);
      html += '<button class="sw' + (css === curCss ? ' on' : '') + '" data-act="color:' + css + '" title="' + p.name + '" ' +
        'style="background:rgb(' + css + ')"></button>';
    });
    return '<div class="ctl-label">颜色 <b data-role="s-color">' + (curCss ? '自定义' : '未设置') + '</b></div>' +
      '<div class="sw-row">' + html + '</div>';
  }

  function setColor(id, rgbStr) {
    var parts = String(rgbStr || '').split(',');
    if (parts.length < 3) return;
    var rgb = [num(parts[0], 0), num(parts[1], 0), num(parts[2], 0)];
    var attrs = attrsOf(id);
    var data = { entity_id: id, rgb_color: rgb };
    if (attrs.brightness == null) data.brightness = 255;
    actLog('color ' + rgbStr);
    patch(id, 'on', { rgb_color: rgb, hs_color: rgbToHs(rgb) });
    callService('light', 'turn_on', data).then(refreshSheet, function () { toast('设置颜色失败'); });
  }

  function rgbToHs(rgb) {
    var r = num(rgb[0], 0) / 255, g = num(rgb[1], 0) / 255, b = num(rgb[2], 0) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d > 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    var s = max === 0 ? 0 : d / max * 100;
    return [Math.round(h * 10) / 10, Math.round(s * 10) / 10];
  }

  function tempStep(attrs) {
    var s = num(attrs.target_temp_step, 0.5);
    return s > 0 ? s : 0.5;
  }
  /** climate 的目标温度能力：supported_features 位 1=TARGET_TEMPERATURE，位 2=TARGET_TEMPERATURE_RANGE
   *  没有这些位的空调（如新风、只能开关/换模式的盘管）不该出现温度控件 */
  function climateTempCaps(attrs) {
    var f = attrs.supported_features;
    if (f == null) {
      return {
        single: attrs.temperature != null,
        range: attrs.target_temp_low != null || attrs.target_temp_high != null
      };
    }
    var n = num(f, 0);
    return {
      single: (n & 1) === 1,
      range: (n & 2) === 2 || attrs.target_temp_low != null || attrs.target_temp_high != null
    };
  }

  /** heat_cool 双设定点：HA 用 target_temp_low / target_temp_high */
  function dualTarget(attrs) {
    var caps = climateTempCaps(attrs);
    if (!caps.range) return null;
    var lo = attrs.target_temp_low, hi = attrs.target_temp_high;
    if (lo == null && hi == null) return null;
    return { low: num(lo, 20), high: num(hi, 26) };
  }
function hasBrightness(attrs) {
    var s = supportedModes(attrs);
    if (s) return s.indexOf('onoff') < 0;
    return attrs.brightness != null || attrs.color_mode != null;
  }

var COLOR_PRESETS = [
    { name: '暖黄', rgb: [255, 176, 80] },
    { name: '暖白', rgb: [255, 214, 170] },
    { name: '正白', rgb: [255, 244, 229] },
    { name: '青绿', rgb: [110, 231, 183] },
    { name: '天蓝', rgb: [96, 165, 250] },
    { name: '蓝紫', rgb: [147, 130, 255] },
    { name: '品红', rgb: [244, 114, 182] },
    { name: '暖红', rgb: [248, 113, 113] }
  ];

  

  function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });  function svg(name) {
      var d = ICONS[name] || ICONS.gear;
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
   

  

  

  

  function supportedModes(attrs) {
      var m = attrs.supported_color_modes;
      if (m && m.length) return m.join(',');
      return '';  function hasColorTemp(attrs) {
      var s = supportedModes(attrs);
      if (s) return s.indexOf('color_temp') > -1;
      return attrs.min_mireds != null && attrs.max_mireds != null;  


    }


    }

   }


    }

  function hasPosition(attrs) {
    var sf = attrs.supported_features;
    if (sf == null) return attrs.current_position != null;
    return (sf & 4) === 4; /* CoverEntityFeature.SET_POSITION */
  }

  function fmtTemp(v) {
    var n = Math.round(num(v, 0) * 2) / 2;
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }
  function lightPct(attrs) { return Math.max(1, Math.round(num(attrs.brightness, 255) / 255 * 100)); }

  /* ---------------- 卡片百分比进度条 ----------------
     有些器件天生带一个 0–100 的量（灯的亮度、以后的音量/开合度），卡片上把它画成
     一条进度条，手指直接拖就能改。pctMeta() 是唯一的能力判断入口：有百分比才出条，
     也顺便告诉调用方该往哪个 HA 服务写回。 */
  function pctMeta(tile, attrs) {
    if (!tile) return null;
    var a = attrs || {};
    if (tile.type === 'light' && hasBrightness(a)) {
      return { pct: lightPct(a), domain: 'light', service: 'turn_on', key: 'brightness_pct' };
    }
    return null;
  }
  /** 手指横坐标 → 1..100。贴边就取整到边上；0 不给（0% 等于关灯，会误关）。 */
  function pctFromX(x, left, width) {
    var w = num(width, 0);
    if (!(w > 0)) return null;
    var p = Math.round((num(x, 0) - num(left, 0)) / w * 100);
    if (p < 1) p = 1;
    if (p > 100) p = 100;
    return p;
  }

  /* Chromium 57 的 SVGElement.matches 不可靠（点 svg 图标时 closest 会失效），
     这里用 class 字符串 / getAttribute 手工向上查找。 */
  function hasClass(n, cls) {
    var c = n.getAttribute ? n.getAttribute('class') : null;
    return !!c && (' ' + c + ' ').indexOf(' ' + cls + ' ') > -1;
  }
  function closest(node, cls, attr) {
    while (node && node !== document) {
      if (node.nodeType === 1) {
        if (cls && hasClass(node, cls)) return node;
        if (attr && node.getAttribute && node.getAttribute(attr) != null) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function findItem(id) {
    for (var i = 0; i < S.items.length; i++) if (S.items[i].tile.entity === id) return S.items[i];
    return null;
  }
  /* 轻提示；带 action 时右侧出现一个可点的动作（用于「撤销」） */
  var toastUndo = null;
  function toast(text, actText, actFn) {
    el.toast.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = text;
    el.toast.appendChild(span);
    toastUndo = null;
    if (actText) {
      var act = document.createElement('b');
      act.className = 'toast-act';
      act.setAttribute('data-act', 'toast-undo');
      act.textContent = actText;
      el.toast.appendChild(act);
      toastUndo = actFn || null;
    }
    el.toast.className = actText ? 'toast show act' : 'toast show';

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.className = 'toast';
      toastUndo = null;
    }, actText ? Math.max(2, num(prefs().undo, 5)) * 1000 : 2200);
  }

  /* ---------------- 语义 ---------------- */
  /** 设备掉线时 HA 给 unavailable / unknown；不能当成「关」来显示 */
  function isNa(st) { return st === 'unavailable' || st === 'unknown'; }
  /** automation 实体：卡片上的「开/关」其实是「启用/禁用」，点一下也不该是开关语义 */
  function isAuto(tile) { return String(tile.entity || '').indexOf('automation.') === 0; }
  function isOn(tile) {
    var st = stateOf(tile.entity), attrs = attrsOf(tile.entity);
    if (tile.type === 'light' || tile.type === 'switch') return st === 'on';
    if (tile.type === 'climate') return st !== 'off' && st !== 'unavailable';
    if (tile.type === 'cover') return st !== 'closed' && st !== 'unavailable' && num(attrs.current_position, st === 'open' ? 100 : 0) > 0;
    var dc = attrs.device_class;
    if (dc === 'motion' || dc === 'occupancy' || dc === 'smoke' || dc === 'gas') return st === 'on';
    return false;
  }

  function accentFor(tile) {
    var st = stateOf(tile.entity), attrs = attrsOf(tile.entity);
    if (tile.type === 'camera') return '104,190,255';
    if (tile.type === 'light') {
      var rgb = curRgb(attrs);
      if (st === 'on' && rgb && hasColor(attrs)) return rgbCss(rgb);
      return '255,177,64';
    }
    if (tile.type === 'switch') return '86,142,247';
    if (tile.type === 'cover') return '158,140,255';
    if (tile.type === 'climate') {
      if (st === 'heat') return '255,138,101';
      if (st === 'dry') return '120,214,178';
      if (st === 'fan_only') return '150,170,255';
      return '86,199,240';
    }
    var dc = attrs.device_class;
    if (dc === 'temperature') return '255,138,101';
    if (dc === 'humidity') return '79,195,247';
    if (dc === 'motion' || dc === 'occupancy') return '126,217,87';
    if (dc === 'smoke' || dc === 'gas') return '255,96,96';
    return '126,214,255';
  }

  function iconFor(tile) {
    var dc = attrsOf(tile.entity).device_class;
    if (tile.type === 'camera') return 'cam';
    if (tile.type === 'light') return 'bulb';
    if (tile.type === 'switch') return 'plug';
    if (tile.type === 'climate') return 'snow';
    if (tile.type === 'cover') return 'curtain';
    if (dc === 'temperature') return 'thermo';
    if (dc === 'humidity') return 'drop';
    if (dc === 'motion' || dc === 'occupancy') return 'motion';
    if (dc === 'smoke' || dc === 'gas') return 'smoke';
    return 'thermo';
  }

  function binarySensor(tile) {
    var dc = attrsOf(tile.entity).device_class;
    return dc === 'motion' || dc === 'occupancy' || dc === 'smoke' || dc === 'gas' ||
      dc === 'door' || dc === 'window' || dc === 'moisture';
  }

  function valHtml(tile, st, attrs) {
    if (tile.type === 'camera') {
      if (isNa(st)) return '离线';
      return CAM_STATE[st] || '待机';
    }
    if (tile.type === 'light') {
      if (isNa(st)) return '离线';
      if (st !== 'on') return '关';
      return hasBrightness(attrs) ? lightPct(attrs) + '<span class="u">%</span>' : '开';
    }
    if (tile.type === 'switch') {
      if (isNa(st)) return '离线';
      if (isAuto(tile)) return st === 'on' ? '启用' : '禁用';
      if (st !== 'on') return '关';
      if (attrs.power != null) return Math.round(num(attrs.power, 0)) + '<span class="u">W</span>';
      return '开';
    }
    if (tile.type === 'climate') {
      if (isNa(st)) return '离线';
      if (st === 'off') return '关';
      var dt = dualTarget(attrs);
      if (dt) return fmtTemp(dt.low) + '–' + fmtTemp(dt.high) + '<span class="u">°C</span>';
      var caps = climateTempCaps(attrs);
      if (!caps.single) return HVAC[st] || st;
      return fmtTemp(attrs.temperature) + '<span class="u">°C</span>';
    }
    if (tile.type === 'cover') {
      if (st === 'unavailable') return '—';
      if (!hasPosition(attrs)) return (st === 'closed' ? '关' : '开');
      return Math.round(num(attrs.current_position, st === 'closed' ? 0 : 100)) + '<span class="u">%</span>';
    }
    if (st === 'unavailable') return '—';
    if (binarySensor(tile)) {
      var dc = attrs.device_class;
      if (dc === 'motion' || dc === 'occupancy') return st === 'on' ? '有人' : '无人';
      if (dc === 'smoke') return st === 'on' ? '报警' : '正常';
      if (dc === 'moisture') return st === 'on' ? '漏水' : '干燥';
      return st === 'on' ? '开' : '关';
    }
    return String(st) + (attrs.unit_of_measurement ? '<span class="u">' + esc(attrs.unit_of_measurement) + '</span>' : '');
  }

  function valClass(tile, st) {
    if (tile.type === 'light' || tile.type === 'switch') return st === 'on' ? 't-val lit' : 't-val muted';
    if (tile.type === 'climate') return st === 'off' ? 't-val muted' : 't-val lit';
    if (tile.type === 'cover') return 't-val small';
    if (binarySensor(tile)) return st === 'on' ? 't-val small lit' : 't-val small muted';
    return 't-val';
  }

  function subText(tile, st, attrs) {
    if (isNa(st)) return '不可用';
    if (isAuto(tile)) return '点按触发';
    if (tile.type === 'camera') return '摄像头 · ' + (CAM_STATE[st] || st);
    if (tile.type === 'light') return st === 'on' ? '已开启' : '已关闭';
    if (tile.type === 'switch') {
      if (st !== 'on') return st === 'unavailable' ? '不可用' : '已关闭';
      return attrs.power != null ? '功率 ' + Math.round(num(attrs.power, 0)) + ' W' : '已开启';
    }
    if (tile.type === 'climate') {
      if (st === 'off') return '已关闭';
      var cur = attrs.current_temperature;
      return (HVAC[st] || st) + (cur != null ? ' · ' + num(cur, 0).toFixed(1) + '°' : '');
    }
    if (tile.type === 'cover') {
      return (COVER_STATE[st] || st) + (attrs.current_position != null ? ' · ' + Math.round(num(attrs.current_position, 0)) + '%' : '');
    }
    var dc = attrs.device_class;
    if (dc === 'temperature') return '温度传感器';
    if (dc === 'humidity') return '湿度传感器';
    if (dc === 'motion' || dc === 'occupancy') return '人体感应';
    if (dc === 'smoke') return '烟雾报警';
    if (dc === 'moisture') return '水浸感应';
    return '传感器';
  }

  /* ---------------- 卡片 ---------------- */
  /* 百分比进度条骨架：i = 已填充部分，b = 拖动钮。位置都读 CSS 变量 --pct，
     JS 只改一个值（setBarPct），比同时改 width/left 两处省一次样式计算。 */
  function barHtml() {
    return '<div class="t-bar" data-role="pbar" data-pct="0">' +
      '<i data-role="bar"></i><b class="t-knob"></b></div>';
  }

  /** 进度条画到某个百分比。拖动中每帧都会调用，值没变就不写 DOM。 */
  function setBarPct(bar, pct) {
    if (!bar) return;
    var p = num(pct, 0);
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    if (bar.getAttribute('data-pct') === String(p)) return;
    bar.setAttribute('data-pct', String(p));
    bar.style.setProperty('--pct', p + '%');
  }

  function midHtml(tile) {
    if (tile.type === 'camera') {
      return '<div class="cam-thumb" data-cam="' + esc(tile.entity) + '"></div>';
    }
    if (tile.type === 'climate') {
      var cat = climateTempCaps(attrsOf(tile.entity));
      if (dualTarget(attrsOf(tile.entity)) || (!cat.single && !cat.range)) {
        return '<div class="t-val" data-role="val"></div><div class="t-ctl"></div>';
      }
      return '<div class="t-val" data-role="val"></div>' +
        '<div class="t-ctl"><button class="t-step" data-act="temp-">' + svg('minus') + '</button>' +
        '<span class="t-set" data-role="set"></span>' +
        '<button class="t-step" data-act="temp+">' + svg('plus') + '</button></div>';
    }
    if (tile.type === 'cover') {
      return '<div class="t-val" data-role="val"></div>' +
        '<div class="t-ctl"><button class="t-step" data-act="cover-open">' + svg('up') + '</button>' +
        '<span class="t-set" data-role="set"></span>' +
        '<button class="t-step" data-act="cover-close">' + svg('down') + '</button></div>';
    }
    if (tile.type === 'light') {
      /* 条的骨架无条件渲染：卡片常常先于 HA 首个状态包画出来，
         那时还判断不出这盏灯能不能调，等状态到了再由 updateTile 决定显示/隐藏 */
      return '<div class="t-val" data-role="val"></div>' + barHtml();
    }
    return '<div class="t-val" data-role="val"></div>';
  }

  /* 摄像头快照：HA 的 camera 实体带 entity_picture（已签名的 /api/camera_proxy/...），
     没有就自己拼 http base + /api/camera_proxy/<id>?token=<长期令牌>。
     注意：<img> 不能带 Authorization 头，所以必须用 URL 里的令牌。 */
  function camSrc(id) {
    var attrs = attrsOf(id);
    var ha = S.ha || readHaFile() || {};
    var base = haHttpBase(ha.url || (cfg.ha && cfg.ha.url) || '');
    var pic = attrs && attrs.entity_picture;
    if (pic) {
      pic = String(pic);
      if (pic.indexOf('http') === 0 || pic.indexOf('data:') === 0) return pic;
      return base + pic;
    }
    if (!base) return '';
    return base + '/api/camera_proxy/' + encodeURIComponent(id) + '?token=' +
      encodeURIComponent(normalizeToken(ha.token || (cfg.ha && cfg.ha.token) || ''));
  }

  /* 实时画面：go2rtc（或任意 MJPEG 源）。
     Chromium 57 不能跑 WebRTC/HLS，但能直接 <img> 播 multipart/x-mixed-replace 的 MJPEG。
     源地址在 panel/js/config.js 的 camStream 里按实体配；没配就走快照。 */
  function camLiveUrl(id) {
    var m = (cfg && cfg.camStream) || {};
    if (m[id]) return String(m[id]);
    var attrs = attrsOf(id) || {};
    if (attrs.mjpeg_url) return String(attrs.mjpeg_url);
    return '';
  }

  function camStamp(src) {
    if (!src) return '';
    if (src.indexOf('data:') === 0) return src;   /* 内联图片不能再加查询串 */
    return src + (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + (new Date().getTime());
  }

  /* 卡片缩略图：8 秒刷新一次（只在真实模式下有后端可拉） */
  function camPaint() {
    if (!el.grid || !el.grid.querySelectorAll) return;
    var nodes = el.grid.querySelectorAll('.cam-thumb');
    for (var i = 0; i < nodes.length; i++) {
      var box = nodes[i];
      var id = box.getAttribute('data-cam');
      var node = box.getElementsByTagName('img')[0];
      if (!node) {
        node = document.createElement('img');
        node.className = 'cam-img';
        node.alt = '';
        node.onerror = function () { this.parentNode.className = 'cam-thumb dead'; };
        node.onload = function () { this.parentNode.className = 'cam-thumb'; };
        box.appendChild(node);
      }
      var live = camLiveUrl(id);
      if (live) {
        box.className = 'cam-thumb live';
        if (node.getAttribute('data-live') !== live) {
          node.setAttribute('data-live', live);
          node.src = live;                 /* MJPEG 不需要破缓存时间戳 */
        }
      } else {
        box.className = 'cam-thumb';
        node.removeAttribute('data-live');
        var src = camStamp(camSrc(id));
        if (src) node.src = src;
      }
    }
  }

  function camPaintBig() {
    var img = el.sheetInner && el.sheetInner.querySelector ? el.sheetInner.querySelector('.cam-big') : null;
    if (!img) return;
    var id = S.sheetEntity;
    if (!id) return;
    img.src = camStamp(camSrc(id));
  }

  function camBigLoop(on) {
    clearInterval(S.camBigTimer);
    S.camBigTimer = null;
    if (on) S.camBigTimer = setInterval(camPaintBig, 1200);
  }

  function tileHtml(item) {
    var tile = item.tile;
    var naCls = isNa(stateOf(tile.entity)) ? ' na' : '';
    var span = cardSpan(tile.entity, num(prefs().cols, 4));
    var rows = S.editing ? rowSpan(tile.entity) : 1;
    var notAdded = S.editing && !cardVisible(tile.entity);
    var grabbable = S.editing && !notAdded;
    return '<div class="tile' + naCls + (notAdded ? ' not-added' : '') + (span > 1 ? ' span-' + span : '') + (rows > 1 ? ' rows-' + rows : '') + '" data-entity="' + esc(tile.entity) + '"' +
      (span > 1 ? ' data-span="' + span + '"' : '') + (rows > 1 ? ' data-rows="' + rows + '"' : '') + '>' +
      '<div class="tile-head">' +
      (S.editing
        ? '<div class="t-ico-wrap"><div class="t-edit-ico" data-role="ico" data-icon="' + esc(iconFor(tile)) + '">' + svg(iconFor(tile)) + '</div></div>'
        : '<div class="t-ico-wrap"><div class="t-icon" data-role="ico" data-icon="' + esc(iconFor(tile)) + '">' + svg(iconFor(tile)) + '</div></div>') +
      (item.room ? '<div class="tile-room">' + esc(item.room) + '</div>' : '') +
      (S.editing
        ? ''
        : '<button class="t-more" data-act="sheet">' + svg('dots') + '</button>') +
      '</div>' +
      (S.editing
        ? '<div class="t-tools">' +
            (notAdded ? '<button class="t-tool t-add" data-act="card-add">+ 添加</button>' : '') +
            '<span class="t-size">' + spanLabel(tile.entity) + (rows > 1 ? ' · 高 ' + rows : '') + '</span>' +
          '</div>'
        : '') +
      '<div class="tile-mid">' + midHtml(tile) + '</div>' +
      '<div class="tile-foot"><div class="t-name">' + esc(displayName(tile)) + '</div>' +
      '<div class="t-sub" data-role="sub"></div></div>' +
      (grabbable ? '<div class="t-grip" data-grip="' + esc(tile.entity) + '"></div>' : '') +
      '</div>';
  }

  /** 卡片头部那个宽度按钮显示的字：1× / 2× / 整行 */
  function spanLabel(entity) {
    return spanText(cardSpan(entity, 99), num(prefs().cols, 4));
  }

  function updateTile(node, item) {
    if (!node) return;
    var tile = item.tile, st = stateOf(tile.entity), attrs = attrsOf(tile.entity);
    /* 保留 span-N（卡片宽度）与 selected（编辑态选中），否则每次状态推送都会把宽度/选中抹掉 */
    var sp = cardSpan(tile.entity, num(prefs().cols, 4));
    var rw = rowSpan(tile.entity);
    var tcls = 'tile type-' + tile.type + (isOn(tile) ? ' on' : '') + (isNa(st) ? ' na' : '') + (sp > 1 ? ' span-' + sp : '') + (rw > 1 ? ' rows-' + rw : '');
    if (S.tileSel === node && node.className.indexOf('selected') >= 0) tcls += ' selected';
    if (node.className !== tcls) node.className = tcls;
    var tacc = accentFor(tile);
    if (node.getAttribute('data-accent') !== tacc) {
      node.setAttribute('data-accent', tacc);
      node.style.setProperty('--accent', tacc);
    }

    /* 图标与数值只在真的变了才写 DOM：每 6 秒一次的状态推送不该反复重建节点 */
    var ico = node.querySelector('[data-role="ico"]');
    if (ico) {
      var icoName = iconFor(tile);
      if (ico.getAttribute('data-icon') !== icoName) {
        ico.setAttribute('data-icon', icoName);
        ico.innerHTML = svg(icoName);
      }
    }

    var val = node.querySelector('[data-role="val"]');
    if (val) {
      var vcls = valClass(tile, st);
      var vhtml = valHtml(tile, st, attrs);
      if (val.className !== vcls) val.className = vcls;
      if (val.innerHTML !== vhtml) val.innerHTML = vhtml;
    }

    /* 百分比进度条：关着就画到 0（但条还在，点一下就能把灯调亮）。
       正在被手指拖的那一条不跟服务器回包走，否则拖到一半会被拉回去。
       不支持调光的灯（onoff）把条藏掉——骨架是渲染时就画好的，所以这里只切显隐。 */
    var pbar = node.querySelector('[data-role="pbar"]');
    if (pbar) {
      var pm = pctMeta(tile, attrs);
      if (!pm) {
        if (pbar.style.display !== 'none') pbar.style.display = 'none';
      } else {
        if (pbar.style.display === 'none') pbar.style.display = '';
        /* 拖动中：按实体判断（DOM 可能已被重建）
           刚松手 1.2s 内：HA 会把 brightness 的过渡中间值一条条推回来，
           照画就会出现「松手后自己往回弹」，所以给一个静默窗口 */
        var dragNow = S.pctDrag && S.pctDrag.entity === tile.entity;
        var holding = S.pctHold && S.pctHold.entity === tile.entity && Date.now() < S.pctHold.until;
        if (!dragNow && !holding) setBarPct(pbar, st === 'on' ? pm.pct : 0);
      }
    }

    var sub = node.querySelector('[data-role="sub"]');
    if (sub) {
      var stxt = subText(tile, st, attrs);
      /* 名称与状态现在同一行：传感器那种「人体感应 | 人体感应」的重复就没必要了 */
      if (stxt && stxt === displayName(tile)) stxt = '';
      if (sub.textContent !== stxt) sub.textContent = stxt;
    }

    var set = node.querySelector('[data-role="set"]');
    if (set) {
      if (tile.type === 'climate') {
        var cur = num(attrs.current_temperature, NaN);
        set.textContent = isNaN(cur) ? '设定温度' : '室温 ' + cur.toFixed(1) + '°';
      } else if (tile.type === 'cover') {
        set.textContent = hasPosition(attrs) ? '位置 ' + Math.round(num(attrs.current_position, 0)) + '%' : '';
      }
    }
  }

  /* ---------------- 列表渲染 ---------------- */
  /* 记住上次看的房间：每天凌晨静默重载后不该跳回「全部」 */
  function savedRoom() {
    try { return localStorage.getItem('hc.room') || ''; } catch (e) { return ''; }
  }
  function saveRoom(id) {
    try { localStorage.setItem('hc.room', id); } catch (e) { }
  }

  /* ---- 房间可见性：墙上只看常用的几个房间，其余在设置里关掉 ---- */
  var HIDDEN_KEY = 'hc.hidden';

  function hiddenRooms() {
    try {
      var raw = localStorage.getItem(HIDDEN_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveHidden(list) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(list || [])); } catch (e) { }
  }

  /* ---------------- 面板设置（显示/交互/屏幕） ---------------- */
  var PREFS_KEY = 'hc.prefs';
  var PREF_DEF = { cols: 4, allCards: false, size: 'md', sensors: true, offline: false, tap: 'toggle', undo: 5, autoDim: true, bright: 100, night: true, burn: true };

  function prefs() {
    var out = {}, k;
    for (k in PREF_DEF) out[k] = PREF_DEF[k];
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        for (k in PREF_DEF) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
      }
    } catch (e) { }
    return out;
  }

  function prefVal(raw) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw !== '' && isFinite(raw)) return num(raw, 0);
    return raw;
  }

  function setPref(key, raw) {
    if (!(key in PREF_DEF)) return;
    var val = prefVal(raw), p = prefs();
    p[key] = val;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { }
    actLog('pref ' + key + '=' + val);
    applyPrefs();
  }

  function resetPrefs() {
    try { localStorage.removeItem(PREFS_KEY); } catch (e) { }
    actLog('pref reset');
    applyPrefs();
  }

  /** 偏好里跟「正在运行」有关的几项：亮度、防烧屏、自动调暗 */
  function applyPrefs() {
    var p = prefs();
    if (p.burn) {
      if (!S.shiftTimer) startPixelShift();
    } else if (S.shiftTimer) {
      clearInterval(S.shiftTimer); S.shiftTimer = null;
      var app = document.getElementById('app');
      if (app) app.style.transform = '';
    }
    if (p.autoDim) { if (!S.dimOn) scheduleDim(); } else { clearTimeout(S.dimTimer); }
    setBacklight(p.bright >= 100 ? -1 : num(p.bright, 100) / 100);
  }

  function visibleRooms(rooms, hidden) {
    var out = [];
    var hid = hidden || [];
    for (var i = 0; i < (rooms || []).length; i++) {
      var r = rooms[i];
      if (!r || !r.id) continue;
      if (hid.indexOf(r.id) > -1) continue;
      out.push(r);
    }
    return out;
  }

  function roomById(id) {
    for (var i = 0; i < cfg.rooms.length; i++) if (cfg.rooms[i].id === id) return cfg.rooms[i];
    return null;
  }

  /* ---------- 编辑：默认不添加任何设备 ----------
     编辑状态存在 localStorage['hc.edit']：
       added  { "实体ID": 1 }                  —— 用户手动加进来的卡（默认一张都没有）
       order  [ "实体ID", ... ]                 —— 自定义顺序（只决定先后，与列数无关）
       span   { "实体ID": 2|3 }                 —— 这张卡横跨几列（不写就是 1）
     「默认不添加任何设备」：allCards=false 时，没在 added 里的设备一律不显示。 */
  var EDIT_KEY = 'hc.edit';

  function readEdit() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(EDIT_KEY) || 'null'); } catch (e) { }
    if (!o || typeof o !== 'object') o = {};
    return {
      added: (o.added && typeof o.added === 'object') ? o.added : {},
      order: Array.isArray(o.order) ? o.order.slice() : [],
      span: (o.span && typeof o.span === 'object') ? o.span : {},
      rows: (o.rows && typeof o.rows === 'object') ? o.rows : {}
    };
  }

  function writeEdit(e) {
    S.edit = null;
    try { localStorage.setItem(EDIT_KEY, JSON.stringify(e || {})); } catch (err) { }
  }

  function editState() {
    if (!S.edit) S.edit = readEdit();
    return S.edit;
  }

  function cardVisible(entity) {
    var p = prefs();
    if (p.allCards) return true;
    return !!editState().added[entity];
  }

  /** 卡片横跨几列（1~3），编辑里可改；列数不够时自动压到当前列数 */
  function cardSpan(entity, cols) {
    var n = num(editState().span[entity], 1);
    if (n < 1) n = 1;
    if (cols && n > cols) n = cols;
    return n;
  }

  /** 卡片宽度的可选项：1× ~ N×（N = 当前每行卡片数），最后一档显示「整行」 */
  /** 卡片占几行（1~2），磁贴式拉伸用 */
  function rowSpan(entity) {
    var n = num(editState().rows && editState().rows[entity], 1);
    if (n < 1) n = 1;
    if (n > 2) n = 2;
    return n;
  }

  function spanOptions(cols) {
    var n = num(cols, 4);
    if (n < 1) n = 1;
    if (n > 6) n = 6;
    var out = [];
    for (var i = 1; i <= n; i++) out.push({ v: i, t: i === n ? (n === 1 ? '1×' : '整行') : (i + '×') });
    return out;
  }

  /** 宽度标签：整行（= 当前列数）显示「整行」，其余显示 N× */
  function spanText(v, cols) {
    var n = num(v, 1);
    var c = num(cols, 4);
    if (c > 1 && n >= c) return '整行';
    return n + '×';
  }

  /** 排序：先按自定义顺序，没排过的按「设备名/实体名」稳定排序，保证切列数不会乱 */
  function sortCards(list) {
    var ord = editState().order, pos = {};
    for (var i = 0; i < ord.length; i++) pos[ord[i]] = i;
    list.sort(function (a, b) {
      var ea = a.tile.entity, eb = b.tile.entity;
      var pa = pos[ea] === undefined ? 1e9 : pos[ea];
      var pb = pos[eb] === undefined ? 1e9 : pos[eb];
      if (pa !== pb) return pa - pb;
      var ka = (a.tile.name || '') + '\u0000' + ea;
      var kb = (b.tile.name || '') + '\u0000' + eb;
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
    return list;
  }

  function itemsFor(room) {
    var out = [];
    if (S.real && !S.layoutReady) return out;
    if (room === 'all') {
      visibleRooms(cfg.rooms, hiddenRooms()).forEach(function (r) {
        r.tiles.forEach(function (t) { out.push({ tile: t, room: r.name }); });
      });
    } else {
      var r = roomById(room) || visibleRooms(cfg.rooms, hiddenRooms())[0] || cfg.rooms[0];
      r.tiles.forEach(function (t) { out.push({ tile: t, room: '' }); });
    }
    var p = prefs();
    out = out.filter(function (it) {
      var t = it.tile || {};
      if (!cardVisible(t.entity)) return false;
      if (!p.sensors && t.type === 'sensor') return false;
      if (p.offline && isNa(stateOf(t.entity))) return false;
      return true;
    });
    return sortCards(out);
  }

  /** 每行几张：直接用内联样式写死列数，不依赖 .cols-N 类（跨列卡让网格列数卡住时也不至于塌） */
  /** 卡片大小 → 行高（老 WebView 下 grid-auto-rows 会被内联样式覆盖，所以这里必须同步写死） */
  function rowHeight() {
    var sz = prefs().size;
    return sz === 'sm' ? 150 : (sz === 'lg' ? 228 : 186);
  }

  function setColumns(node, cols) {
    if (!node) return;
    var h = rowHeight() + 'px';
    node.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    node.style.gridAutoFlow = 'row';
    node.style.gridAutoRows = h;
    node.style.gridTemplateRows = 'repeat(auto-fill, ' + h + ')';
    node.setAttribute('data-cols', String(cols));
    node.setAttribute('data-size', prefs().size || 'md');
  }

  /** 只改「每行几张/卡片大小」时用：换类名，不重建 60~70 张卡片 */
  function gridClassOnly() {
    if (!el.grid) return;
    var pf = prefs();
    var cols = num(pf.cols, 4);
    if (cols < 3 || cols > 6) cols = 4;
    var size = (pf.size === 'sm' || pf.size === 'lg') ? pf.size : 'md';
    var items = S.items || [];
    setColumns(el.grid, cols);
    el.grid.className = items.length ? ('grid cols-' + cols + ' size-' + size + (items.length > 8 ? ' dense' : '') + (S.editing ? ' editing' : '')) : 'grid';
  }

  function renderGrid(force) {
    S.renderCount = (S.renderCount || 0) + 1;
    var items = itemsFor(S.room);
    var sig = S.room + '|' + (S.editing ? 'E' : 'N') + '|' + items.map(function (it) {
      return it.tile.entity + ':' + cardSpan(it.tile.entity, num(prefs().cols, 4));
    }).join(',');
    S.items = items;
    if (!force && sig === S.sig) {
      for (var i = 0; i < items.length; i++) updateTile(S.tileEls[i], items[i]);
      return;
    }
    S.sig = sig;
    if (!items.length) {
      var hint;
      if (!prefs().allCards && !editAddCount()) {
        hint = '<div class="empty-main">还没有添加设备</div><div class="empty-sub">点右上角 ✎ 进入编辑，再点「+ 添加卡片」从列表里挑设备</div>';
      } else if (S.real && !S.layoutReady) {
        hint = '<div class="empty-main">正在连接 Home Assistant…</div><div class="empty-sub">连不上时长按右上角状态胶囊，改地址与令牌；短按可重连</div>';
      } else {
        hint = '<div class="empty-main">这里还没有设备</div>';
      }
      /* 编辑模式：即使一张都没有，也要能进编辑去加 */
      if (S.editing) hint = '<div class="empty-main">编辑中：这块屏还没有卡片</div><div class="empty-sub">点工具条上的「+ 添加卡片」，从列表里挑要放上去的设备</div>';
      var eCols = num(prefs().cols, 4);
      if (eCols < 3 || eCols > 6) eCols = 4;
      el.grid.className = 'grid cols-' + eCols + (S.editing ? ' editing' : '');
      setColumns(el.grid, eCols);
      el.grid.innerHTML = '<div class="empty">' + hint + '</div>';
      S.tileEls = [];
      renderEditBar();
      return;
    }
    /* 超过两屏（8 张）就切成可滚动网格，行高固定，往下滑还能看到剩下的 */
    var pf = prefs();
    var cols = num(pf.cols, 4);
    if (cols < 3 || cols > 6) cols = 4;
    var size = (pf.size === 'sm' || pf.size === 'lg') ? pf.size : 'md';
    el.grid.className = 'grid cols-' + cols + ' size-' + size + (items.length > 8 ? ' dense' : '') + (S.editing ? ' editing' : '');
    var html = '';
    for (var k = 0; k < items.length; k++) html += tileHtml(items[k]);
    /* 编辑模式：末尾留一个「+」空格子，点它从列表里挑设备 */
    if (S.editing) html += '<button class="tile t-empty" id="addTile" data-act="edit-add">＋ 添加卡片</button>';
    el.grid.innerHTML = html;
    S.tileEls = [];
    setColumns(el.grid, cols);
    for (var j = 0; j < el.grid.children.length; j++) {
      if (el.grid.children[j].id === 'addTile') continue;
      S.tileEls.push(el.grid.children[j]);
    }
    for (var m = 0; m < items.length; m++) updateTile(S.tileEls[m], items[m]);
    if (hasCamTile()) setTimeout(camPaint, 30);
    renderEditBar();
    if (!S.editing) return;
    if (S.tileSelItem) {
      var keep = S.tileSelItem;
      S.tileSel = null;
      var again = findItem(keep.tile.entity);
      if (again) {
        for (var n = 0; n < S.tileEls.length; n++) {
          if (S.tileEls[n].getAttribute('data-entity') === keep.tile.entity) { selectTile(S.tileEls[n], again); break; }
        }
      }
    }
  }

  /* ---------- 编辑模式 ---------- */

  /** 当前 HA 里所有可放的设备（真实模式的 registry / mock 模式的 cfg.rooms），不按「已添加」过滤 */
  function allCards() {
    var out = [];
    if (S.real && !S.layoutReady) return out;
    visibleRooms(cfg.rooms, hiddenRooms()).forEach(function (r) {
      (r.tiles || []).forEach(function (t) { if (t && t.entity) out.push({ tile: t, room: r.name }); });
    });
    var seen = {};
    return out.filter(function (it) {
      if (seen[it.tile.entity]) return false;
      seen[it.tile.entity] = 1;
      return true;
    });
  }

  function editAddCount() {
    var e = editState(), n = 0;
    for (var k in e.added) if (e.added[k]) n++;
    return n;
  }

  function editAddAll(all) {
    var e = editState(), list = allCards();
    e.added = {};
    if (all) list.forEach(function (it) { e.added[it.tile.entity] = 1; });
    e.order = list.map(function (it) { return it.tile.entity; });
    writeEdit(e);
    actLog('edit all=' + (all ? list.length : 0));
    renderGrid(true);
    if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml();
    else if (S.sheetShow === 'add') el.sheetInner.innerHTML = addSheetHtml();
  }

  function editToggle(entity) {
    var e = editState();
    if (e.added[entity]) delete e.added[entity];
    else e.added[entity] = 1;
    writeEdit(e);
    actLog('edit toggle ' + entity + ' -> ' + (e.added[entity] ? 'on' : 'off'));
    renderGrid(true);
    /* 只有编辑帮助面板打开时才重写它；否则会把选中的卡片工具条/内容顶掉 */
    if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml();
  }

  /** 卡片在「当前顺序」里前后挪一格（跨房间也按顺序数组来，切列数不会乱） */
  function editMove(entity, dir) {
    var e = editState();
    var list = allCards();
    var order = e.order.slice();
    var seen = {};
    order.forEach(function (id) { seen[id] = 1; });
    list.forEach(function (it) { if (!seen[it.tile.entity]) order.push(it.tile.entity); });
    var i = order.indexOf(entity);
    if (i < 0) return;
    var j = i + (dir > 0 ? 1 : -1);
    if (j < 0 || j >= order.length) return;
    if (e.added[entity] === undefined) e.added[entity] = 1;
    if (e.added[order[j]] === undefined) e.added[order[j]] = 1;
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    e.order = order;
    writeEdit(e);
    actLog('edit move ' + entity + ' ' + dir);
    renderGrid(true);
    el.sheetInner.innerHTML = editSheetHtml();
  }

  /** 卡片占几列（1/2/3），列数不够时压到当前列数 */
  function editSpan(entity, n) {
    var e = editState();
    var cols = num(prefs().cols, 4);
    var v = num(n, 1);
    if (v > cols) v = cols;
    if (v <= 1) delete e.span[entity]; else e.span[entity] = v;
    writeEdit(e);
    actLog('edit span ' + entity + ' ' + v);
    renderGrid(true);
    el.sheetInner.innerHTML = editSheetHtml();
  }

  /* ---------- 添加卡片（类似手机桌面：点「+」从列表里挑） ---------- */
  function addSheetHtml() {
    var list = allCards();
    var h = '<div class="cfg-head">添加卡片</div>' +
      '<div class="cfg-desc">点一行就把它加到这块屏上，想加几个就点几个，加完点「完成」。</div>';
    if (!list.length) {
      h += '<div class="cfg-desc">' + (S.real && !S.layoutReady ? '正在读取设备…' : '还没有读到任何设备（先连上 Home Assistant）') + '</div>';
    } else {
      var lastRoom = null;
      h += '<div class="ed-list">';
      list.forEach(function (it) {
        var rn = it.room || '未分配房间';
        if (rn !== lastRoom) { h += '<div class="ed-room">' + esc(rn) + '</div>'; lastRoom = rn; }
        var on = cardVisible(it.tile.entity);
        h += '<button class="ed-row' + (on ? ' on' : '') + '" data-act="add-toggle:' + esc(it.tile.entity) + '">' +
          '<span class="ed-box">' + (on ? '✓' : '') + '</span>' +
          '<span class="ed-name">' + esc(displayName(it.tile)) + '</span>' +
          '<span class="ed-id">' + esc(it.tile.entity) + '</span></button>';
      });
      h += '</div>';
    }
    h += '<div class="cfg-actions">' +
      '<button class="btn" data-act="add-room">加本房间全部</button>' +
      '<button class="btn primary" data-act="add-done">完成</button>' +
      '</div>';
    return h;
  }

  function spanSheetHtml(item) {
    var cols = num(prefs().cols, 4);
    var cur = cardSpan(item.tile.entity, 99);
    var h = '<div class="cfg-head">卡片宽度</div>' +
      '<div class="cfg-desc">' + esc(displayName(item.tile)) + ' 现在占 ' + spanText(cur, cols) +
      '；最多 ' + cols + ' 列（跟随「每行卡片」设置）。</div>' +
      '<div class="ed-list">';
    spanOptions(cols).forEach(function (o) {
      var on = o.v === cur;
      h += '<button class="ed-row' + (on ? ' on' : '') + '" data-act="card-span-set:' + o.v + '">' +
        '<span class="ed-box">' + (on ? '✓' : '') + '</span>' +
        '<span class="ed-name">' + o.t + '</span>' +
        '<span class="ed-id">占 ' + o.v + ' / ' + cols + ' 列</span></button>';
    });
    h += '</div>' +
      '<div class="cfg-actions"><button class="btn primary" data-act="span-close">返回</button></div>';
    return h;
  }

  function openSpanSheet(item) {
    if (!item) return;
    S.sheetShow = 'span';
    S.sheetItem = item;
    S.sheetEntity = item.tile.entity;
    el.sheetInner.innerHTML = spanSheetHtml(item);
    if (el.sheetInner) el.sheetInner.scrollTop = 0;
    S.sheetOpenedAt = Date.now();
    freezeGrid(true);
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    actLog('span sheet open ' + item.tile.entity);
  }

  function openAddSheet() {
    S.sheetShow = 'add';
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = addSheetHtml();
    if (el.sheetInner) el.sheetInner.scrollTop = 0;
    S.sheetOpenedAt = Date.now();
    freezeGrid(true);
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    actLog('add sheet open');
  }

  /** 添加/移除一张卡；不动其它卡片的顺序。sheet 只在添加面板里时刷新 */
  function addToggle(entity) {
    var e = editState();
    if (e.added[entity]) {
      delete e.added[entity];
      actLog('add off ' + entity);
    } else {
      e.added[entity] = 1;
      var ord = e.order ? e.order.slice() : [];
      if (ord.indexOf(entity) < 0) ord.push(entity);
      e.order = ord;
      actLog('add on ' + entity);
    }
    writeEdit(e);
    actLog('DBG store=' + (function () { var m = 'ok'; var v = 'nil'; try { localStorage.setItem('hc.dbg', String(Date.now())); localStorage.setItem('hc.dbg2', 'x'); v = localStorage.getItem('hc.dbg2') || 'nil'; localStorage.removeItem('hc.dbg'); localStorage.removeItem('hc.dbg2'); } catch (x) { m = 'err:' + x.message; } return m + ' read=' + v + ' edit=' + (function(){ try { return localStorage.getItem(EDIT_KEY) ? 'yes' : 'no'; } catch(t) { return 'e'; } })(); })());
    renderGrid(true);
    if (S.sheetShow === 'add') el.sheetInner.innerHTML = addSheetHtml();
  }

  /** 编辑模式里拖/点箭头把卡片往前或往后挪；和相邻卡片交换 */
  function moveCard(entity, dir) {
    var e = editState();
    var list = itemsFor(S.room);
    var ids = list.map(function (it) { return it.tile.entity; });
    var i = ids.indexOf(entity);
    if (i < 0) return;
    var j = i + (dir > 0 ? 1 : -1);
    if (j < 0 || j >= ids.length) return;
    var order = e.order ? e.order.slice() : [];
    /* 只把当前房间的可见顺序落到 order 的开头，其它房间的顺序保持不变 */
    var rest = order.filter(function (id) { return ids.indexOf(id) < 0; });
    ids[i] = ids[j]; ids[j] = entity;
    e.order = ids.concat(rest);
    writeEdit(e);
    actLog('move ' + entity + ' ' + dir);
    renderGrid(true);
  }

  /** 磁贴式拉伸：一次写入列跨度（1..N）与行跨度（1..2） */
  function resizeCard(entity, c, r) {
    var e = editState();
    var cols = num(prefs().cols, 4);
    var cv = num(c, 1); if (cv < 1) cv = 1; if (cv > cols) cv = cols;
    var rv = num(r, 1); if (rv < 1) rv = 1; if (rv > 2) rv = 2;
    if (cv <= 1) delete e.span[entity]; else e.span[entity] = cv;
    if (rv <= 1) delete e.rows[entity]; else e.rows[entity] = rv;
    writeEdit(e);
    actLog('resize ' + entity + ' ' + cv + 'x' + rv);
    renderGrid(true);
  }

  /** 编辑模式下左右停靠：占满整行 / 占两列 / 占一列 */
  function setSpan(entity, n) {
    var e = editState();
    var cols = num(prefs().cols, 4);
    var v = num(n, 1);
    if (v > cols) v = cols;
    if (v <= 1) delete e.span[entity]; else e.span[entity] = v;
    writeEdit(e);
    actLog('span ' + entity + ' ' + v);
    if (S.sheetShow === 'span' && S.sheetItem) {
      el.sheetInner.innerHTML = spanSheetHtml(S.sheetItem);
      return;
    }
    renderGrid(true);
  }

  function editReset() {
    writeEdit({});
    actLog('edit reset');
    renderGrid(true);
    if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml();
  }

  /** 编辑模式下的工具条（在网格上方，不占卡片位置） */
  /** 编辑卡片时打开的帮助面板：这里只讲怎么改，不再把全部设备铺出来 */
  function editSheetHtml() {
    var n = editAddCount();
    return '<div class="cfg-head">编辑卡片</div>' +
      '<div class="cfg-desc">这块屏上现在有 ' + n + ' 张卡片。编辑模式下每张卡都变成可编辑的样子：</div>' +
      '<div class="ed-help">' +
      '<div class="ed-h"><b>◀ ▶</b><span>调顺序，和前一张 / 后一张交换</span></div>' +
      '<div class="ed-h"><b>1× / 2× / 整行</b><span>点一下改宽度，三种宽度循环</span></div>' +
      '<div class="ed-h"><b>✕</b><span>从这块屏上移除这张卡</span></div>' +
      '<div class="ed-h"><b>+ 添加卡片</b><span>顶栏右边，打开列表挑新设备</span></div>' +
      '</div>' +
      '<div class="cfg-actions">' +
      '<button class="btn" data-act="edit-add">添加卡片</button>' +
      '<button class="btn" data-act="edit-reset">全部清空</button>' +
      '<button class="btn primary" data-act="edit-done">完成</button>' +
      '</div>';
  }

  function openEditSheet() {
    S.sheetShow = 'edit';
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = editSheetHtml();
    if (el.sheetInner) el.sheetInner.scrollTop = 0;
    S.sheetOpenedAt = Date.now();
    freezeGrid(true);
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    actLog('edit sheet open');
  }

  function editTabOn() {
    var r = roomById(S.room);
    if (!r) { toast('先在顶栏选一个房间'); return; }
    var e = editState(), n = 0;
    (r.tiles || []).forEach(function (t) { if (t && t.entity && !e.added[t.entity]) { e.added[t.entity] = 1; n++; } });
    var ord = e.order.slice(), seen = {};
    ord.forEach(function (id) { seen[id] = 1; });
    (r.tiles || []).forEach(function (t) { if (t && t.entity && !seen[t.entity]) { ord.push(t.entity); seen[t.entity] = 1; } });
    e.order = ord;
    writeEdit(e);
    actLog('edit tab on ' + r.id + ' +' + n);
    renderGrid(true);
    if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml();
    toast('已添加「' + r.name + '」的 ' + n + ' 张卡');
  }

  function editTabOff() {
    var r = roomById(S.room);
    if (!r) return;
    var e = editState(), n = 0;
    (r.tiles || []).forEach(function (t) { if (t && t.entity && e.added[t.entity]) { delete e.added[t.entity]; n++; } });
    writeEdit(e);
    actLog('edit tab off ' + r.id + ' -' + n);
    renderGrid(true);
    if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml();
    toast('已移除「' + r.name + '」的 ' + n + ' 张卡');
  }

  function enterEdit() {
    S.editing = true;
    S.edit = null;
    actLog('edit enter');
    renderGrid(true);
    el.grid.scrollTop = 0;
    toast('编辑模式：点卡片加/删，✓ 是已添加');
  }

  /** 编辑模式下选中一张卡（null = 取消）；选中时这张卡才显示自己的工具按钮 */
  function selectTile(node, item) {
    var all = document.querySelectorAll('.tile.selected');
    for (var i = 0; i < all.length; i++) all[i].className = all[i].className.replace(/\s*selected/g, '');
    var bar = document.getElementById('tileBar');
    if (!node || !item) {
      S.tileSel = null;
      S.tileSelItem = null;
      if (bar) bar.className = 'tile-bar';
      return;
    }
    S.tileSel = node;
    S.tileSelItem = item;
    node.className = node.className + ' selected';
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'tileBar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<div class="tb-name">' + esc(displayName(item.tile)) + '</div>' +
      '<button class="t-tool" data-act="card-move-left">◀</button>' +
      '<button class="t-tool" data-act="card-move-right">▶</button>' +
      '<button class="t-tool t-span" data-act="card-span" data-hold="card-span-list">' + spanLabel(item.tile.entity) + '</button>' +
      '<button class="t-tool t-del" data-act="card-remove">✕ 移除</button>';
    bar.className = 'tile-bar show';
    actLog('select ' + item.tile.entity);
  }

  /** 选中卡片的工具条：点按钮就作用在选中的那张卡上 */
  function onTileBarClick(ev) {
    var btn = ev.target;
    while (btn && btn !== document && !(btn.getAttribute && btn.getAttribute('data-act'))) btn = btn.parentNode;
    if (!btn || btn === document) return;
    if (!S.tileSel || !S.tileSelItem) return;
    ev.stopPropagation();
    doAct(btn.getAttribute('data-act'), S.tileSelItem);
  }

  /** 调试：在设备上生成 x y 与可点位置（编辑模式卡片带 data-act 时用） */
  window.__HC_TAP__ = function () {
    var out = { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio, items: [] };
    var list = document.querySelectorAll('[data-act]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      out.items.push({ act: el.getAttribute('data-act'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').slice(0, 24) });
    }
    return JSON.stringify(out);
  };
  window.__HC_TAPLIST__ = function (rows) {
    var list = document.querySelectorAll(rows);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      out.push({ i: i, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (list[i].textContent || '').slice(0, 20) });
    }
    return JSON.stringify(out);
  };

  function exitEdit() {
    S.editing = false;
    if (S.sheetShow === 'add' || S.sheetShow === 'edit') closeSheet();
    actLog('edit exit');
    renderGrid(true);
    if (S.editBarEl) { S.editBarEl.className = 'edit-bar'; S.editBarEl.innerHTML = ''; }
    selectTile(null, null);
    el.grid.scrollTop = 0;
    toast('已保存');
  }

  function renderEditBar() {
    if (!el.grid) return;
    var bar = S.editBarEl;
    if (!bar) {
      var host = el.grid.parentNode;
      if (!host) return;
      bar = document.createElement('div');
      bar.className = 'edit-bar';
      host.insertBefore(bar, el.grid);
      S.editBarEl = bar;
    }
    if (!S.editing) { bar.className = 'edit-bar'; bar.innerHTML = ''; return; }
    var n = editAddCount(), total = allCards().length;
    if (S.real && !S.layoutReady) { bar.className = 'edit-bar'; bar.innerHTML = ''; return; }
    bar.className = 'edit-bar show';
    bar.innerHTML = '<div class="eb-info">编辑中 · ' + n + ' 张卡片</div>' +
      '<button class="eb-btn" data-act="edit-add">+ 添加卡片</button>' +
      '<button class="eb-btn primary" data-act="edit-done">完成</button>';
  }

  /* 网格里是否有摄像头卡（有就立刻补一次缩略图，不必等 8 秒轮询） */
  function hasCamTile() {
    if (!el.grid || !el.grid.querySelector) return false;
    for (var i = 0; i < (S.items || []).length; i++) {
      if (S.items[i] && S.items[i].tile && S.items[i].tile.type === 'camera') return true;
    }
    return false;
  }

  function updateByEntity(id) {
    for (var i = 0; i < S.items.length; i++) {
      if (S.items[i].tile.entity === id) updateTile(S.tileEls[i], S.items[i]);
    }
  }

  /** 场景条：最多 MAX_SCENE_CHIPS 个，多出来的塞进「更多」弹层
      真实 HA 里 script.* 经常十几条，全铺在顶栏会把房间 tab 挤没 */
  var MAX_SCENE_CHIPS = 6;
  function sceneChips(list, max) {
    var arr = list || [];
    var n = max || MAX_SCENE_CHIPS;
    if (arr.length <= n) return { visible: arr.slice(), more: [] };
    return { visible: arr.slice(0, n - 1), more: arr.slice(n - 1) };
  }

  function renderScenes() {
    var html = '';
    if (S.real && !S.layoutReady) { el.scenes.innerHTML = ''; return; }
    var split = sceneChips(cfg.scenes);
    split.visible.forEach(function (s) {
      html += '<div class="chip" data-scene="' + esc(s.entity) + '">' + svg(s.icon) + esc(s.name) + '</div>';
    });
    if (split.more.length) {
      html += '<div class="chip" data-scene-more="1">' + svg('dots') + '更多 ' + split.more.length + '</div>';
    }
    /* 场景多了就允许横向滑动，别把房间 tab 挤没 */
    el.scenes.className = cfg.scenes.length > 4 ? 'scenes scrollable' : 'scenes';
    el.scenes.innerHTML = html;
  }

  /** 全部场景/脚本的弹层（从「更多」进） */
  function sceneSheetHtml() {
    var html = '<div class="sheet-title">场景与脚本</div>' +
      '<div class="sheet-desc">共 ' + cfg.scenes.length + ' 个，点一行立即执行。</div>';
    cfg.scenes.forEach(function (s) {
      html += '<div class="s-item" data-act="scene-run" data-entity="' + esc(s.entity) + '">' +
        '<div class="s-ico">' + svg(s.icon) + '</div>' +
        '<div class="s-main"><div class="s-name">' + esc(s.name) + '</div>' +
        '<div class="s-sub">' + esc(s.entity) + '</div></div></div>';
    });
    return html;
  }

  function renderTabs() {
    var html = '<div class="tab" data-room="all">' + svg('home') + '全部</div>';
    if (S.real && !S.layoutReady) { el.tabs.innerHTML = ''; return; }
    visibleRooms(cfg.rooms, hiddenRooms()).forEach(function (r) {
      html += '<div class="tab" data-room="' + esc(r.id) + '">' + svg(r.icon || 'sofa') + esc(r.name) + '</div>';
    });
    /* 用一层 inner 承载：放得下时 margin-left:auto 靠右，放不下时从左边开始并可横向滑动 */
    el.tabs.innerHTML = '<div class="tabs-inner">' + html + '</div>';
    layoutTabs();
    setTimeout(layoutTabs, 60);
    setTimeout(layoutTabs, 400);
    markTabs();
  }

  /* 放得下就靠右（margin-left:auto），放不下就左对齐、从第一个 tab 开始可横向滑动 */
  function layoutTabs() {
    var inner = el.tabs.firstChild;
    if (!inner) return;
    var fits = inner.scrollWidth <= el.tabs.clientWidth - 2;
    inner.style.marginLeft = fits ? 'auto' : '0';
    el.tabs.scrollLeft = 0;
  }

  function markTabs() {
    var inner = el.tabs.firstChild;
    var tabs = inner ? inner.children : [];
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-room') === S.room;
      tabs[i].className = 'tab' + (on ? ' active' : '');
      /* 选中的 tab 滑动到可视区内（房间多的场景） */
      if (on) {
        var left = tabs[i].offsetLeft;
        if (left < el.tabs.scrollLeft || left + tabs[i].offsetWidth > el.tabs.scrollLeft + el.tabs.clientWidth) {
          el.tabs.scrollLeft = left - 12;
        }
      }
    }
  }

  /* ---------------- 操作 ---------------- */
  /* 每个用户动作打一行日志：logcat 里能证明"点到了"，出问题时也能复盘 */
  function countStates(states) {
    var n = 0;
    for (var k in states) if (Object.prototype.hasOwnProperty.call(states, k)) n++;
    return n;
  }

  function actLog(what) {
    var b = window.AndroidBridge;
    if (b && b.log) { try { b.log('ACT ' + what); } catch (e) { } }
  }

  function callService(domain, service, data) {
    if (!S.backend) return Promise.reject(new Error('未就绪'));
    return S.backend.call(domain, service, data).then(null, function (err) {
      toast('操作失败：' + ((err && err.message) || err));
      throw err;
    });
  }

  function patch(id, state, attrs) {
    var e = S.states[id];
    if (!e) { e = S.states[id] = { entity_id: id, state: '', attributes: {} }; }
    if (state != null) e.state = state;
    if (attrs) for (var k in attrs) e.attributes[k] = attrs[k];
    updateByEntity(id);
  }

  function triggerAutomation(id, tile) {
    actLog('trigger ' + id);
    var name = (tile && displayName(tile)) || id;
    callService('automation', 'trigger', { entity_id: id }).then(function () {
      toast('已触发 · ' + name);
    }, function () {
      toast('触发失败 · ' + name);
    });
  }

  function toggle(id, tile) {
    actLog('toggle ' + id);
    var st = stateOf(id);
    if (isNa(st)) { toast('设备离线，无法操作'); return; }
    var next = st === 'on' ? 'off' : 'on';
    var name = (tile && displayName(tile)) || id.split('.')[1] || id;
    patch(id, next, null);
    callService(id.split('.')[0], 'toggle', { entity_id: id }).then(function () {
      /* 墙上触摸屏容易误触，给 5 秒撤销窗口 */
      toast((next === 'on' ? '已开启 · ' : '已关闭 · ') + name, '撤销', function () {
        actLog('undo toggle ' + id);
        callService(id.split('.')[0], st === 'on' ? 'turn_on' : 'turn_off', { entity_id: id });
        toast('已撤销');
      });
    }, function () {
      patch(id, st, null);
    });
  }

  function adjustTemp(id, delta, which) {
    var attrs = attrsOf(id);
    var step = tempStep(attrs);
    var caps = climateTempCaps(attrs);
    var noTemp = !caps.single && !caps.range;
    if (noTemp) {
      var heroMode = (st === 'off' || st === 'unavailable') ? '关' : (HVAC[st] || st);
      return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' + heroMode + '</div>' +
        '<div class="hero-sub">' + (isNaN(cur) ? '' : '室温 ' + cur.toFixed(1) + '°C · ') + (HVAC[st] || st) + '</div></div>' +
        '<div class="ctl-label">模式</div><div class="opts">' + modeHtml + '</div>' +
        (fans.length ? '<div class="ctl-label">风速</div><div class="opts">' + fanHtml + '</div>' : '');
    }
    var dual = dualTarget(attrs);
    if (dual) {
      /* heat_cool：分别调上/下限，之间至少留一个步长 */
      var lo = dual.low, hi = dual.high;
      if (which === 'low') lo = Math.min(hi - step, lo + delta);
      else hi = Math.max(lo + step, hi + delta);
      lo = Math.round(lo / step) * step;
      hi = Math.round(hi / step) * step;
      patch(id, null, { target_temp_low: lo, target_temp_high: hi });
      refreshSheet();
      callService('climate', 'set_temperature', {
        entity_id: id, target_temp_low: lo, target_temp_high: hi
      }).then(null, function () {
        patch(id, null, { target_temp_low: dual.low, target_temp_high: dual.high });
      });
      return;
    }
    var cur = num(attrs.temperature, 24);
    var next = Math.round((cur + delta) / step) * step;
    next = Math.round(next * 100) / 100;
    patch(id, null, { temperature: next });
    refreshSheet();
    callService('climate', 'set_temperature', { entity_id: id, temperature: next })
      .then(null, function () { patch(id, null, { temperature: cur }); });
  }

  function coverCmd(id, service) {
    if (service === 'open_cover') patch(id, 'opening', null);
    else if (service === 'close_cover') patch(id, 'closing', null);
    else if (service === 'stop_cover') patch(id, num(attrsOf(id).current_position, 0) > 0 ? 'open' : 'closed', null);
    refreshSheet();
    callService('cover', service, { entity_id: id }).then(null, function () {});
  }

  function setMode(id, mode) {
    var prev = stateOf(id);
    patch(id, mode, null);
    refreshSheet();
    callService('climate', 'set_hvac_mode', { entity_id: id, hvac_mode: mode })
      .then(null, function () { patch(id, prev, null); });
  }

  function setFan(id, fan) {
    var prev = attrsOf(id).fan_mode;
    patch(id, null, { fan_mode: fan });
    refreshSheet();
    callService('climate', 'set_fan_mode', { entity_id: id, fan_mode: fan })
      .then(null, function () { patch(id, null, { fan_mode: prev }); });
  }

  function doAct(act, item) {
    /* 编辑模式下的三个批量动作（顶栏工具条也走这里） */
    if (act === 'edit-done') { exitEdit(); return; }
    if (act === 'edit-add') { openAddSheet(); return; }
    if (act === 'edit-reset') { editReset(); return; }
    if (act === 'card-remove') { addToggle(item.tile.entity); toast('已移除 · ' + displayName(item.tile)); return; }
    if (act === 'card-move-left') { moveCard(item.tile.entity, -1); return; }
    if (act === 'card-move-right') { moveCard(item.tile.entity, 1); return; }
    if (act === 'card-span') {
      var cCols = num(prefs().cols, 4);
      var cNow = num(cardSpan(item.tile.entity, 99), 1);
      setSpan(item.tile.entity, cNow >= cCols ? 1 : cNow + 1);
      return;
    }
    if (act.indexOf('card-span-set:') === 0) {
      setSpan(item.tile.entity, num(act.slice(14), 1));
      return;
    }
    if (act === 'card-span-list') { openSpanSheet(item); return; }
    if (act === 'span-close') { closeSheet(); return; }
    if (act.indexOf('add-toggle:') === 0) { addToggle(act.slice(11)); return; }
    if (act === 'scene-run') {
      var ent = item && item.entity;
      if (!ent) return;
      actLog('scene run ' + ent);
      callService(ent.split('.')[0], 'turn_on', { entity_id: ent })
        .then(function () { toast('已执行：' + (item.name || ent)); closeSheet(); })
        .then(null, function () {});
      return;
    }
    var tile = item.tile, id = tile.entity;
    if (act === 'sheet') return openSheet(item);
    if (act.indexOf('color:') === 0) return setColor(id, act.slice(6));
    if (act === 'temp-') return adjustTemp(id, -tempStep(attrsOf(id)));
    if (act === 'temp+') return adjustTemp(id, tempStep(attrsOf(id)));
    if (act === 'templow-') return adjustTemp(id, -tempStep(attrsOf(id)), 'low');
    if (act === 'templow+') return adjustTemp(id, tempStep(attrsOf(id)), 'low');
    if (act === 'temphigh-') return adjustTemp(id, -tempStep(attrsOf(id)), 'high');
    if (act === 'temphigh+') return adjustTemp(id, tempStep(attrsOf(id)), 'high');
    if (act === 'cover-open') return coverCmd(id, 'open_cover');
    if (act === 'cover-close') return coverCmd(id, 'close_cover');
    if (act === 'cover-stop') return coverCmd(id, 'stop_cover');
    if (act === 'toggle') return toggle(id, tile);
    if (act === 'cam-refresh') { camPaintBig(); toast('已刷新画面'); return; }
    if (act === 'auto-run') return triggerAutomation(id, tile);
    if (act === 'auto-on') return autoEnable(id, tile, true);
    if (act === 'auto-off') return autoEnable(id, tile, false);
  }

  function autoEnable(id, tile, on) {
    actLog((on ? 'enable ' : 'disable ') + id);
    callService('automation', on ? 'turn_on' : 'turn_off', { entity_id: id });
    patch(id, on ? 'on' : 'off', null);
    toast((on ? '已启用 · ' : '已禁用 · ') + ((tile && displayName(tile)) || id));
  }

  function primary(item) {
    var tile = item.tile;
    if (prefs().tap === 'sheet') return openSheet(item);
    if (isAuto(tile)) triggerAutomation(tile.entity, tile);
    else if (tile.type === 'light' || tile.type === 'switch') toggle(tile.entity, tile);
    else openSheet(item);
  }

  /* ---------------- 弹层 ---------------- */
  function openSheet(item) {
    S.sheetOpenedAt = Date.now();
    if (item && item.entity) actLog('sheet ' + item.entity);
    S.sheetItem = item;
    S.sheetEntity = item.tile.entity;
    renderSheet();
    freezeGrid(true);
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    var slot = el.sheetInner.querySelector ? el.sheetInner.querySelector('.spark-slot') : null;
    if (slot) loadSpark(slot, slot.getAttribute('data-spark'));
    camBigLoop(!!(el.sheetInner.querySelector && el.sheetInner.querySelector('.cam-big')));
  }

  function renameHtml(tile) {
    return '<div class="sheet-title">重命名</div>' +
      '<div class="sheet-desc">只改这台屏上显示的名字，不会同步回 Home Assistant。留空表示用回默认名称。</div>' +
      '<div class="rn-row"><input class="rn-in" id="rnIn" type="text" value="' + esc(displayName(tile)) + '"></div>' +
      '<div class="cfg-actions"><button class="btn primary" data-act="rename-save">保存</button>' +
      '<button class="btn" data-act="rename-cancel">取消</button></div>';
  }

  function openRename() {
    var it = S.sheetItem;
    if (!it || !it.tile) return;
    el.sheetInner.innerHTML = renameHtml(it.tile);
    S.sheetOpenedAt = Date.now();
    freezeGrid(true);
    actLog('rename open ' + it.tile.entity);
  }

  function saveRename() {
    var it = S.sheetItem;
    if (!it || !it.tile) return;
    var box = el.sheetInner.querySelector ? el.sheetInner.querySelector('#rnIn') : null;
    var v = box ? String(box.value || '').trim() : '';
    setName(it.tile.entity, v);
    renderGrid(true);
    closeSheet();
    toast(v ? ('已重命名：' + v) : '已恢复默认名称');
  }

  function closeSheet() {
    camBigLoop(false);
    S.sheetItem = null;
    S.sheetEntity = null;
    el.mask.className = 'mask';
    el.sheet.className = 'sheet';
    /* 关掉时就把内层清空：下次打开只做一次「写入 + 布局」，
       而不是「旧内容先排一遍、新内容再排一遍」 */
    if (el.sheetInner) {
      el.sheetInner.scrollTop = 0;
      setTimeout(function () {
        if (el.sheet && el.sheet.className.indexOf('show') < 0) {
          el.sheetInner.innerHTML = '';
        }
      }, 260);
    }
    document.body.className = '';
    freezeGrid(false);
  }

  function row(k, v) {
    return '<div class="info-row"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  function plainVal(tile, st, attrs) {
    if (tile.type === 'light') return st === 'on' ? lightPct(attrs) + '%' : '关';
    if (tile.type === 'switch') return st === 'on' ? '开' : '关';
    if (tile.type === 'climate') return st === 'off' ? '关' : fmtTemp(attrs.temperature) + ' °C';
    if (tile.type === 'cover') return Math.round(num(attrs.current_position, 0)) + '%';
    if (binarySensor(tile)) {
      var dc = attrs.device_class;
      if (dc === 'motion' || dc === 'occupancy') return st === 'on' ? '有人' : '无人';
      if (dc === 'smoke') return st === 'on' ? '报警' : '正常';
      return st === 'on' ? '开' : '关';
    }
    return String(st) + (attrs.unit_of_measurement ? ' ' + attrs.unit_of_measurement : '');
  }

  /** 自动化：这里只做「执行 / 启用 / 禁用」，不做开关，避免把「禁用自动化」当成关灯 */
  function automationSheet(tile, id, st, attrs) {
    var on = st === 'on';
    var last = attrs.last_triggered ? String(attrs.last_triggered).replace('T', ' ').slice(0, 16) : '从未';
    return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' + (isNa(st) ? '离线' : (on ? '已启用' : '已禁用')) + '</div>' +
      '<div class="hero-sub">点卡片 = 立即执行一次，不会关闭自动化</div></div>' +
      '<div class="info-list">' + row('上次触发', last) + row('实体 ID', id) + '</div>' +
      '<div class="opts">' +
      '<button class="btn primary" data-act="auto-run">立即执行</button>' +
      '<button class="btn" data-act="' + (on ? 'auto-off' : 'auto-on') + '">' + (on ? '禁用' : '启用') + '</button>' +
      '</div>';
  }

  /** 摄像头详情：大图 + 1.2 秒轮询；离线就明说「无画面」，不画假图 */
  function cameraSheet(tile, id, st, attrs) {
    var live = camLiveUrl(id);
    var raw = camSrc(id);
    var ok = !isNa(st) && !!(live || raw);
    var src = ok ? (live || raw) : '';
    var stage = ok
      ? '<img class="cam-big' + (live ? ' cam-live' : '') + '" data-role="cam-big" src="' + esc(live ? live : camStamp(src)) + '" alt="">' +
        (live ? '<div class="cam-badge">实时 · MJPEG</div>' : '')
      : '<div class="cam-off"><div class="cam-off-t">' + (S.real ? '摄像头没有画面' : '模拟模式没有摄像头') + '</div>' +
        '<div class="cam-off-d">' + (S.real ? 'HA 里这个实体现在是 ' + st + '：确认摄像头通电、录像机在线，或看 HA 里其它集成是否正常。' : '接上真实 HA 后，这里会显示实时快照。') + '</div></div>';
    return '<div class="cam-stage">' + stage + '</div>' +
      '<div class="info-list">' +
      row('状态', isNa(st) ? '离线' : (CAM_STATE[st] || st)) +
      row('实体 ID', id) +
      (attrs.entity_picture ? row('快照来源', 'entity_picture（HA 签名链接）') : row('快照来源', 'camera_proxy + 长期令牌')) +
      '</div>' +
      '<div class="opts">' + (ok ? '<button class="btn" data-act="cam-refresh">' + (live ? '重连画面' : '立即刷新') + '</button>' : '') + '</div>';
  }

  /* 把 [{t,v}] 采样映射成 SVG 坐标；纯函数，便于离线单测 */
  function historyPoints(list, w, h, pad) {
    pad = num(pad, 8);
    var pts = [];
    var i, it;
    for (i = 0; i < (list || []).length; i++) {
      it = list[i];
      if (!it) continue;
      var v = parseFloat(it.v), t = parseFloat(it.t);
      if (isNaN(v) || isNaN(t)) continue;
      pts.push({ t: t, v: v });
    }
    if (pts.length < 2) return { points: '', min: 0, max: 0, first: 0, last: 0, n: pts.length };
    var min = pts[0].v, max = pts[0].v;
    for (i = 1; i < pts.length; i++) {
      if (pts[i].v < min) min = pts[i].v;
      if (pts[i].v > max) max = pts[i].v;
    }
    var spanT = (pts[pts.length - 1].t - pts[0].t) || 1;
    var flat = (max - min) < 0.0001;
    var spanV = flat ? 1 : (max - min);
    var out = [];
    for (i = 0; i < pts.length; i++) {
      var x = pad + (pts[i].t - pts[0].t) / spanT * (w - pad * 2);
      var y = flat ? h / 2 : h - pad - (pts[i].v - min) / spanV * (h - pad * 2);
      out.push(Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10);
    }
    return {
      points: out.join(' '), min: min, max: max,
      first: pts[0].v, last: pts[pts.length - 1].v, n: pts.length
    };
  }

  function sparkHtml(list, unit) {
    var r = historyPoints(list, 320, 70, 8);
    if (!r.points) return '<div class="spark-empty">暂无历史数据</div>';
    var u = unit ? esc(unit) : '';
    return '<div class="spark-wrap">' +
      '<svg class="spark" viewBox="0 0 320 70" preserveAspectRatio="none">' +
      '<polyline points="' + r.points + '"/></svg>' +
      '<div class="spark-meta"><span>最低 ' + r.min + u + '</span><span>最高 ' + r.max + u +
      '</span><span>' + r.n + ' 个点</span></div></div>';
  }

  function isNumberSensor(tile, attrs) {
    if (tile.type !== 'sensor') return false;
    var dc = attrs.device_class || '';
    return dc === 'temperature' || dc === 'humidity' || dc === 'illuminance' ||
      dc === 'carbon_dioxide' || dc === 'pm25' || dc === 'power' || dc === 'pressure' || dc === 'battery';
  }

  function loadSpark(box, id) {
    if (!box || !S.backend || !S.backend.restHistory) return;
    var unit = (attrsOf(id) || {}).unit_of_measurement || '';
    S.backend.restHistory(id, 12, function (list) {
      box.innerHTML = sparkHtml(list, unit);
    }, function () {
      box.innerHTML = '<div class="spark-empty">暂无历史数据</div>';
    });
  }

  function sensorSheet(tile, id, st, attrs) {
    var rows = row('当前值', plainVal(tile, st, attrs)) + row('实体 ID', id) + row('设备类型', attrs.device_class || '—');
    var spark = isNumberSensor(tile, attrs) ? '<div class="spark-slot" data-spark="' + esc(id) + '">加载曲线…</div>' : '';
    var head = '<div class="sheet-hero"><div class="hero-val">' + esc(plainVal(tile, st, attrs)) + '</div></div>';
    return head + spark + rows;
  }

  function lightSheet(tile, id, st, attrs) {
    var on = st === 'on';
    var pct = on ? lightPct(attrs) : 0;
    var hasBri = hasBrightness(attrs);
    var hasCt = hasColorTemp(attrs);
    if (!hasBri) pct = 0;
    var cool = 0;
    if (hasCt) {
      var min = num(attrs.min_mireds, 153), max = num(attrs.max_mireds, 500);
      var mireds = num(attrs.color_temp, min);
      cool = Math.round((max - mireds) / Math.max(1, max - min) * 100);
      cool = Math.max(0, Math.min(100, cool));
    }
    return '<div class="sheet-hero">' +
      '<div class="hero-val" data-role="s-val">' + (on ? (hasBri ? pct + '<span class="u">%</span>' : '开') : '关') + '</div>' +
      '<div class="hero-sub">' + (on ? '已开启' : '已关闭') + '</div>' +
      '<button class="hero-btn' + (on ? ' on' : '') + '" data-act="toggle">' + svg('power') + '</button></div>' +
      (hasBri ? '<div class="ctl-label">亮度 <b data-role="s-bpct">' + pct + '%</b></div>' +
        '<input class="slider" type="range" min="1" max="100" value="' + pct + '" data-role="brightness" style="--pct:' + pct + '%">' : '') +
      (hasCt ? '<div class="ctl-label">色温 <b data-role="s-ct">' + (100 - cool) + '%</b></div>' +
        '<input class="slider" type="range" min="0" max="100" value="' + (100 - cool) + '" data-role="ct" style="--pct:' + (100 - cool) + '%">' : '') +
      (hasColor(attrs) ? swRow(attrs) : '');
  }

  function climateSheet(tile, id, st, attrs) {
    var cur = num(attrs.current_temperature, NaN);
    var tgt = num(attrs.temperature, 24);
    var modes = attrs.hvac_modes || ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'];
    var fans = attrs.fan_modes || [];
    var modeHtml = '', fanHtml = '';
    modes.forEach(function (m) {
      modeHtml += '<button class="opt' + (st === m ? ' on' : '') + '" data-act="mode:' + m + '">' +
        (m === 'off' ? '关闭' : (HVAC[m] || m)) + '</button>';
    });
    fans.forEach(function (f) {
      fanHtml += '<button class="opt' + (attrs.fan_mode === f ? ' on' : '') + '" data-act="fan:' + f + '">' +
        (FAN_NAME[f] || f) + '</button>';
    });
    var caps = climateTempCaps(attrs);
    var noTemp = !caps.single && !caps.range;
    if (noTemp) {
      var heroMode = (st === 'off' || st === 'unavailable') ? '关' : (HVAC[st] || st);
      return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' + heroMode + '</div>' +
        '<div class="hero-sub">' + (isNaN(cur) ? '' : '室温 ' + cur.toFixed(1) + '°C · ') + (HVAC[st] || st) + '</div></div>' +
        '<div class="ctl-label">模式</div><div class="opts">' + modeHtml + '</div>' +
        (fans.length ? '<div class="ctl-label">风速</div><div class="opts">' + fanHtml + '</div>' : '');
    }
    var dual = dualTarget(attrs);
    if (dual) {
      var hero = st === 'off' || st === 'unavailable' ? '关' : fmtTemp(dual.low) + '–' + fmtTemp(dual.high) + '<span class="u">°C</span>';
      return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' + hero + '</div>' +
        '<div class="hero-sub">' + (isNaN(cur) ? '' : '室温 ' + cur.toFixed(1) + '°C · ') + (HVAC[st] || st) + '</div></div>' +
        '<div class="temp-row"><button class="round" data-act="templow-">' + svg('minus') + '</button>' +
        '<span style="display:inline-block;width:16px"></span>' +
        '<button class="round" data-act="templow+">' + svg('plus') + '</button>' +
        '<div class="hero-sub" style="margin-left:auto">制热下限 ' + fmtTemp(dual.low) + '°C</div></div>' +
        '<div class="temp-row"><button class="round" data-act="temphigh-">' + svg('minus') + '</button>' +
        '<span style="display:inline-block;width:16px"></span>' +
        '<button class="round" data-act="temphigh+">' + svg('plus') + '</button>' +
        '<div class="hero-sub" style="margin-left:auto">制冷上限 ' + fmtTemp(dual.high) + '°C</div></div>' +
        '<div class="ctl-label">模式</div><div class="opts">' + modeHtml + '</div>' +
        (fans.length ? '<div class="ctl-label">风速</div><div class="opts">' + fanHtml + '</div>' : '');
    }
    return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' +
      (st === 'off' || st === 'unavailable' ? '关' : fmtTemp(tgt) + '<span class="u">°C</span>') + '</div>' +
      '<div class="hero-sub">' + (isNaN(cur) ? '' : '室温 ' + cur.toFixed(1) + '°C · ') + (HVAC[st] || st) + '</div></div>' +
      '<div class="temp-row"><button class="round" data-act="temp-">' + svg('minus') + '</button>' +
      '<span style="display:inline-block;width:22px"></span>' +
      '<button class="round" data-act="temp+">' + svg('plus') + '</button>' +
      '<div class="hero-sub" style="margin-left:auto">设定 ' + fmtTemp(tgt) + '°C' + (attrs.fan_mode ? ' · 风速 ' + (FAN_NAME[attrs.fan_mode] || attrs.fan_mode) : '') + '</div></div>' +
      '<div class="ctl-label">模式</div><div class="opts">' + modeHtml + '</div>' +
      (fans.length ? '<div class="ctl-label">风速</div><div class="opts">' + fanHtml + '</div>' : '');
  }

  function coverSheet(tile, id, st, attrs) {
    var pos = Math.round(num(attrs.current_position, st === 'closed' ? 0 : 100));
    var posOk = hasPosition(attrs);
    var heroTxt = posOk ? pos + '<span class="u">%</span>' : (st === 'closed' ? '关' : '开');
    return '<div class="sheet-hero"><div class="hero-val" data-role="s-val">' + heroTxt + '</div>' +
      '<div class="hero-sub">' + (COVER_STATE[st] || st) + '</div></div>' +
      (posOk ? '<div class="ctl-label">开合度 <b data-role="s-pos">' + pos + '%</b></div>' +
        '<input class="slider" type="range" min="0" max="100" value="' + pos + '" data-role="position" style="--pct:' + pos + '%">' : '') +
      '<div class="opts" style="margin-top:16px">' +
      '<button class="opt" data-act="cover-open">打开</button>' +
      '<button class="opt" data-act="cover-stop">暂停</button>' +
      '<button class="opt" data-act="cover-close">关闭</button></div>';
  }

  function renderSheet() {
    var item = S.sheetItem;
    if (!item) return;
    var tile = item.tile, id = tile.entity;
    var st = stateOf(id), attrs = attrsOf(id);
    var body;
    if (tile.type === 'light') body = lightSheet(tile, id, st, attrs);
    else if (tile.type === 'climate') body = climateSheet(tile, id, st, attrs);
    else if (isAuto(tile)) body = automationSheet(tile, id, st, attrs);
    else if (tile.type === 'cover') body = coverSheet(tile, id, st, attrs);
    else if (tile.type === 'camera') body = cameraSheet(tile, id, st, attrs);
    else body = sensorSheet(tile, id, st, attrs);

    el.sheetInner.innerHTML =
      '<div class="sheet-head"><div><div class="sheet-name">' + esc(displayName(tile)) + '</div>' +
      '<div class="sheet-room">' + esc((item.room ? item.room + ' · ' : '') + id) + '</div></div>' +
      (tile && tile.entity ? '<button class="sheet-rename" data-act="rename-open" title="重命名">' + svg('edit') + '</button>' : '') +
      '<button class="sheet-close" data-act="close">' + svg('close') + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>';

    el.sheet.style.setProperty('--accent', accentFor(tile));
    bindSheetInputs();
  }

  function refreshSheet() {
    if (!S.sheetEntity || S.dragging) return;
    renderSheet();
  }

  function bindSheetInputs() {
    var inputs = el.sheetInner.querySelectorAll('input[type=range]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('input', onSliderInput);
      inputs[i].addEventListener('change', onSliderCommit);
      inputs[i].addEventListener('touchstart', function () { S.dragging = true; });
      inputs[i].addEventListener('touchend', function () { S.dragging = false; });
      inputs[i].addEventListener('mousedown', function () { S.dragging = true; });
      inputs[i].addEventListener('mouseup', function () { S.dragging = false; });
    }
  }

  function onSliderInput(ev) {
    var r = ev.target, role = r.getAttribute('data-role'), v = parseInt(r.value, 10);
    r.style.setProperty('--pct', v + '%');
    var item = S.sheetItem;
    if (!item) return;
    var id = item.tile.entity;
    if (role === 'brightness') {
      patch(id, 'on', { brightness: Math.round(v * 255 / 100) });
      var sv = el.sheetInner.querySelector('[data-role="s-val"]');
      if (sv) sv.innerHTML = v + '<span class="u">%</span>';
      var lb = el.sheetInner.querySelector('[data-role="s-bpct"]');
      if (lb) lb.textContent = v + '%';
    } else if (role === 'position') {
      patch(id, null, { current_position: v });
      var sv2 = el.sheetInner.querySelector('[data-role="s-val"]');
      if (sv2) sv2.innerHTML = v + '<span class="u">%</span>';
      var lb2 = el.sheetInner.querySelector('[data-role="s-pos"]');
      if (lb2) lb2.textContent = v + '%';
    } else if (role === 'ct') {
      var lb3 = el.sheetInner.querySelector('[data-role="s-ct"]');
      if (lb3) lb3.textContent = v + '%';
    }
  }

  function onSliderCommit(ev) {
    var r = ev.target, role = r.getAttribute('data-role'), v = parseInt(r.value, 10);
    var item = S.sheetItem;
    if (!item) return;
    var id = item.tile.entity;
    if (role === 'brightness') {
      callService('light', 'turn_on', { entity_id: id, brightness_pct: v }).then(null, function () {});
    } else if (role === 'position') {
      callService('cover', 'set_cover_position', { entity_id: id, position: v }).then(null, function () {});
    } else if (role === 'ct') {
      var attrs = attrsOf(id);
      var min = num(attrs.min_mireds, 153), max = num(attrs.max_mireds, 500);
      var mireds = Math.round(max - (max - min) * (v / 100));
      callService('light', 'turn_on', { entity_id: id, color_temp: mireds }).then(null, function () {});
    }
  }

  /* ---------------- 顶栏 ---------------- */
  function tick() {
    S.tickCount = (S.tickCount || 0) + 1;
    if (S.tickCount % 600 === 0) checkMemGuard(false);
    var d = new Date();
    if (el.dimTime) el.dimTime.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    el.time.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    el.date.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + WD[d.getDay()];
    maybeNightlyReload();
  }

  function renderWeather() {
    var w = null;
    for (var id in S.states) if (id.indexOf('weather.') === 0) { w = S.states[id]; break; }
    if (!w) { el.weather.innerHTML = ''; return; }
    var info = WEATHER[w.state] || [w.state, 'cloud'];
    var attrs = w.attributes || {};
    var temp = attrs.temperature != null ? '<span class="w-temp">' + Math.round(num(attrs.temperature, 0)) + '°</span>' : '';
    el.weather.innerHTML = svg(info[1]) + '<span>' + esc(info[0]) + '</span>' + temp;
  }

  function setStatus(st) {
    /* 未配置时后端会推「模拟数据」，这里保持「未配置」更符合事实 */
    if (S.unconfigured && st && !S.real) st = { connected: st.connected, text: '未配置 · 长按右上角' };
    S.status = st;
    el.status.className = 'status' + (S.unconfigured && !S.real ? ' warn' : (st.connected ? ' ok' : ''));
    el.statusText.textContent = st.text;
  }

  /** 首次上墙：提示怎么接真 HA（只弹一次，避免每次重启都烦人） */
  var GUIDE_KEY = 'hc.guide.v1';

  function guideSheetHtml() {
    return '<div class="cfg-head">先把这块屏接到 Home Assistant</div>' +
      '<div class="cfg-desc">三步就好，之后面板上所有设备都来自你自己的 HA。</div>' +
      '<div class="g-step"><b>1</b><div><span class="g-t">在 HA 里建一个长期访问令牌</span>' +
      '<span class="g-d">HA 网页 → 左下角用户名 → 安全 → 长期访问令牌 → 创建</span></div></div>' +
      '<div class="g-step"><b>2</b><div><span class="g-t">把地址和令牌填进这块屏</span>' +
      '<span class="g-d">地址写 <code>192.168.1.10:8123</code> 这样就行，协议和路径会自动补</span></div></div>' +
      '<div class="g-step"><b>3</b><div><span class="g-t">保存后会先探活再连接</span>' +
      '<span class="g-d">令牌不对会直接提示，不用等到连上才发现</span></div></div>' +
      '<div class="cfg-actions">' +
      '<button class="btn primary" data-act="guide-config">填地址和令牌</button>' +
      '<button class="btn" data-act="guide-demo">先看模拟数据</button>' +
      '<button class="btn" data-act="close">关闭</button>' +
      '</div>';
  }

  function openGuideSheet() {
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = guideSheetHtml();
    S.sheetOpenedAt = Date.now();
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    actLog('open guide');
  }

  function dismissGuide() {
    try { localStorage[GUIDE_KEY] = '1'; } catch (e) { }
  }

  function maybeShowGuide() {
    if (!S.unconfigured) return;
    var seen = false;
    try { seen = localStorage[GUIDE_KEY] === '1'; } catch (e) { }
    if (seen) return;
    setTimeout(function () { if (!S.sheetItem && el.sheet.className.indexOf('show') === -1) openGuideSheet(); }, 1200);
  }

  function firstRunHint() {
    var KEY = 'hc.hint.v1';
    try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, '1'); } catch (e) { return; }
    actLog('first-run hint');
    toast('还没接 Home Assistant：长按右上角状态胶囊填地址与令牌', null, null);
  }

  function onStates(states) {
    if (!S.firstStatesAt) {
      S.firstStatesAt = Date.now();
      actLog('first states ' + (S.firstStatesAt - BOOT_T0) + 'ms · 实体 ' + countStates(states));
    }
    S.states = states;
    renderWeather();
    if (S.real && !S.layoutReady) { applyAutoLayout(); return; }
    renderGrid(false);
    refreshSheet();
  }

  /* ---------------- 上墙省电：空闲变暗 / 夜间调暗（防烧屏，也避免半夜刺眼） ---------------- */
  function dimCfg() {
    var d = cfg.dim || {};
    return {
      idleSec: d.idleSec == null ? 90 : d.idleSec,
      nightStart: d.nightStart == null ? 23 : d.nightStart,
      nightEnd: d.nightEnd == null ? 7 : d.nightEnd,
      nightIdleSec: d.nightIdleSec == null ? 20 : d.nightIdleSec,
      level: d.level == null ? 0.88 : d.level,
      nightLevel: d.nightLevel == null ? 0.95 : d.nightLevel
    };
  }

  function isNight() {
    if (!prefs().night) return false;
    var c = dimCfg(), h = new Date().getHours();
    return c.nightStart <= c.nightEnd ? (h >= c.nightStart && h < c.nightEnd)
      : (h >= c.nightStart || h < c.nightEnd);
  }

  function scheduleDim() {
    if (!prefs().autoDim) return;
    var c = dimCfg();
    var sec = isNight() ? c.nightIdleSec : c.idleSec;
    clearTimeout(S.dimTimer);
    if (sec <= 0) return;
    S.dimTimer = setTimeout(enterDim, sec * 1000);
  }

  /* 背光：只作用本窗口，退出时传 -1 恢复系统亮度 */
  function setBacklight(v) {
    var b = window.AndroidBridge;
    if (b && b.setBrightness) { try { b.setBrightness(v); } catch (e) { } }
  }

  function enterDim() {
    actLog('dim enter');
    setBacklight(num(dimCfg().brightness, 0.35));
    if (S.sheetItem || S.sheetEntity) { scheduleDim(); return; }
    var c = dimCfg();
    var night = isNight();
    if (el.dim) {
      el.dim.style.background = 'rgba(0,0,0,' + (night ? c.nightLevel : c.level) + ')';
      el.dim.className = 'dim show';
    }
    S.dimOn = true;
    if (el.dimTime) {
      var d = new Date();
      el.dimTime.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
  }

  function exitDim() {
    if (S.dimOn) actLog('dim exit');
    var pb = num(prefs().bright, 100);
    setBacklight(pb >= 100 ? -1 : pb / 100);
    if (!S.dimOn) return;
    S.dimOn = false;
    if (el.dim) el.dim.className = 'dim';
    scheduleDim();
  }

  /* 夜间静默重载：老设备内存有限，长期点亮容易越用越卡，每天 reload 一次释放 WebView */
  function maybeNightlyReload() {
    var h = cfg.reloadHour == null ? 4 : cfg.reloadHour;
    var d = new Date();
    if (d.getHours() !== h) return;
    var key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    try {
      if (localStorage.getItem('hc.reload') === key) return;
      localStorage.setItem('hc.reload', key);
    } catch (e) { return; }
    setTimeout(function () { location.reload(); }, 4000);
  }
  /* 防烧屏：整体位移。像素级偏移看不出来，但静态的时钟/卡片边框不会一直压在同一个物理像素上 */
function startPixelShift() {
  if (!prefs().burn) return;
  var bi = cfg.burnIn || {};
  var every = num(bi.shiftEverySec, 300);
  var max = num(bi.maxShift, 2);
  var app = document.getElementById('app');
  if (!app || every <= 0 || max <= 0) return;
  var step = function () {
    var dx = Math.round((Math.random() * 2 - 1) * max);
    var dy = Math.round((Math.random() * 2 - 1) * max);
    if (!dx && !dy) dx = max;
    /* 缩一点点盖住位移留下的边，不然边缘会露出 1~2px 底色 */
    app.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.01)';
    actLog('shift ' + dx + ',' + dy);
  };
  step();
  S.shiftTimer = setInterval(step, every * 1000);
}

function bindDim() {
    /* 唤醒的那一下不能穿透到下面的卡片：唤醒后 400ms 内的指针事件一律吞掉 */
    var swallowUntil = 0;
    var guard = function (ev) {
      if (new Date().getTime() < swallowUntil) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        return true;
      }
      return false;
    };
    var wake = function (ev) {
      if (guard(ev)) return;
      if (S.dimOn) {
        swallowUntil = new Date().getTime() + 400;
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        exitDim();
        return;
      }
      scheduleDim();
    };
    document.addEventListener('touchstart', wake, true);
    document.addEventListener('touchend', wake, true);
    document.addEventListener('mousedown', wake, true);
    document.addEventListener('mouseup', wake, true);
    document.addEventListener('click', wake, true);
    document.addEventListener('keydown', wake, true);
    window.addEventListener('blur', function () { scheduleDim(); });
    scheduleDim();
  }
  /* ---------------- 连接设置（长按右上角状态胶囊打开） ---------------- */
  function cfgSheetHtml() {
    var f = readHaFile() || {};
    var url = haHttpBase(f.url ? String(f.url) : ((cfg.ha && cfg.ha.url) || ''));
    var tok = f.token ? String(f.token) : ((cfg.ha && cfg.ha.token) || '');
    var canSave = !!(window.AndroidBridge && window.AndroidBridge.writeText);
    return '<div class="cfg-head">连接设置</div>' +
      '<div class="cfg-desc">填 Home Assistant 地址与长期访问令牌，保存后立即重连。' +
      (canSave ? '' : '（当前页面不在壳 App 内，无法保存）') + '</div>' +
      '<div class="cfg-row"><div class="cfg-k">地址</div>' +
      '<input class="cfg-in" id="cfgUrl" type="text" onfocus="this.select()" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="http://192.168.1.10:8123" value="' + esc(url) + '"></div>' +
      '<div class="cfg-row"><div class="cfg-k">令牌</div>' +
      '<input class="cfg-in" id="cfgToken" type="text" onfocus="this.select()" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="长期访问令牌" value="' + esc(tok) + '"></div>' +
      '<div class="cfg-actions">' +
      '<button class="btn primary" data-act="cfg-save">保存并重连</button>' +
      '<button class="btn" data-act="cfg-mock">改用模拟数据</button>' +
      '<button class="btn" data-act="close">取消</button></div>';
  }

  function openConfigSheet() {
    actLog('open config');
    S.sheetOpenedAt = Date.now();
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = cfgSheetHtml();
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
  }

  function saveConfig() {
    var b = window.AndroidBridge;
    if (!b || !b.writeText) { toast('只能在壳 App 内保存配置'); return; }
    /* 存盘/探活都是同步网络调用，先把提示画出来再干活，否则按下去像卡死 */
    toast('正在保存并测试连接…');
    var u = normalizeHa(document.getElementById('cfgUrl').value);
    var t = normalizeToken(document.getElementById('cfgToken').value);
    if (!u || !t) { toast('地址和令牌都要填'); return; }
    var ok = false;
    try { ok = b.writeText(HA_FILE, JSON.stringify({ url: u, token: t })); } catch (e) { ok = false; }
    if (!ok) { toast('保存失败，请检查存储权限'); return; }
    var pr = { status: 0 };
    if (window.__HC_NO_PROBE__ !== true) pr = probeHa(haHttpBase(u), t);
    if (pr.status === 200) {
      toast('令牌有效，已保存，正在重连…');
      setTimeout(function () { location.reload(); }, 700);
    } else if (pr.status === 401 || pr.status === 403) {
      toast('已保存，但令牌被拒绝，请检查令牌');
      S.lastProbe = pr;
    } else if (pr.error) {
      toast('已保存，但连不上这个地址（' + pr.error + '）');
      S.lastProbe = pr;
    } else {
      toast('已保存（' + probeText(pr) + '），正在重连…');
      setTimeout(function () { location.reload(); }, 900);
    }
  }

  function clearConfig() {
    var b = window.AndroidBridge;
    if (!b || !b.removeFile) { toast('只能在壳 App 内修改配置'); return; }
    var ok = false;
    try { ok = b.removeFile(HA_FILE); } catch (e) { ok = false; }
    toast(ok ? '已切回模拟数据，正在重载…' : '删除失败');
    if (ok) setTimeout(function () { location.reload(); }, 700);
  }
  /* ---------------- 自动布局（接真实 HA 时按分区生成房间） ---------------- */
  var HA_FILE = '/sdcard/HomeControl/ha.json';

  function readHaFile() {
    var b = window.AndroidBridge;
    if (!b || !b.readText) return null;
    var raw = '';
    try { raw = b.readText(HA_FILE); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /** 把用户随手填的地址揉成 WS 端点：
      192.168.1.10:8123            → ws://192.168.1.10:8123/api/websocket
      http://ha:8123/              → ws://ha:8123/api/websocket
      https://ha.example.com       → wss://ha.example.com/api/websocket
      ws://ha:8123/api/websocket   → 原样（只规整协议与结尾）
      令牌里的空白（复制时常带的换行）一并去掉。 */
  function normalizeHa(rawUrl) {
    var u = String(rawUrl == null ? '' : rawUrl).trim();
    if (!u) return '';
    u = u.replace(/^ws(s?):\/\//i, 'HTTP$1://');         /* 统一成 http(s) 再处理，最后换回来 */
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    /* 主机名不区分大小写（HA.local / ha.local 是同一台），路径保持原样 */
    u = u.replace(/^([a-z]+:\/\/)([^\/]+)/i, function (m, scheme, host) {
      return scheme + host.toLowerCase();
    });
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/api\/websocket$/i, '');
    return u.replace(/^http(s?):\/\//i, function (m, s) { return s ? 'wss://' : 'ws://'; }) + '/api/websocket';
  }

  /** WS 端点 → 给人看的 http 地址（诊断页/探活用） */
  function haHttpBase(wsUrl) {
    var u = String(wsUrl == null ? '' : wsUrl).trim();
    if (!u) return '';
    return u.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
      .replace(/\/api\/websocket\/?$/i, '').replace(/\/+$/, '');
  }

  function normalizeToken(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, '');
  }

  /* ---------- 设备名称：清洗 + 自定义覆盖 ---------- */
  var NAMES_KEY = 'hc.names';

  function readNameStore() {
    try {
      var raw = localStorage[NAMES_KEY];
      var o = raw ? JSON.parse(raw) : null;
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }

  function writeNameStore(o) {
    try { localStorage[NAMES_KEY] = JSON.stringify(o || {}); } catch (e) { }
  }

  function namesFor(ha) {
    var out = {};
    var f = (ha && ha.names) || null;
    if (f && typeof f === 'object') {
      for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k) && f[k]) out[k] = String(f[k]);
    }
    var local = readNameStore();
    for (var id in local) if (Object.prototype.hasOwnProperty.call(local, id) && local[id]) out[id] = String(local[id]);
    return out;
  }

  var GENERIC_NAME = /^(灯|灯带|开关|插座|静音|提示音|勿扰|温度|湿度|亮度|状态|模式|按键|左键|右键|中键|一键|二键|三键|四键|开\/关|开\/关机|开关机|接触状态|电量|档位)$/;

  /* 显示名：自定义覆盖 > 清洗后的实体名；通用名用设备名补上下文（鱼缸 + 灯 → 鱼缸灯） */
  function displayName(tile) {
    if (!tile) return '';
    var id = tile.entity || '';
    var ov = S.names && S.names[id];
    if (ov) return ov;
    var n = String(tile.name || '').trim();
    var d = String(tile.dev || '').trim();
    if (!n) return d || id.split('.')[1] || id;
    if (!d) return n;
    var same = n.toLowerCase() === d.toLowerCase();
    if (GENERIC_NAME.test(n)) {
      /* 设备名已经以这个词结尾就别再叠（厕所灯 + 灯 → 厕所灯，不要「厕所灯灯」） */
      if (n === '灯' || n === '灯带') {
        return d.length > n.length && d.slice(-n.length) === n ? d : d + n;
      }
      return d === n || d.slice(-(n.length + 1)) === ' ' + n ? d : d + ' ' + n;
    }
    if (same) return d;
    if (n.toLowerCase().indexOf(d.toLowerCase()) === 0) {
      var rest = n.slice(d.length).replace(/^[\s·-]+/, '');
      return rest ? d + ' ' + rest : d;
    }
    return n;
  }

  function setName(id, name) {
    var store = readNameStore();
    var v = String(name || '').trim();
    if (v) store[id] = v; else delete store[id];
    writeNameStore(store);
    S.names = namesFor(S.ha || {});
    actLog('rename ' + id + ' -> ' + (v || '(default)'));
  }

  function clearNames() {
    writeNameStore({});
    S.names = namesFor(S.ha || {});
    actLog('rename reset');
  }

  function resolveHa() {
    var ha = {
      url: (cfg.ha && cfg.ha.url) || '',
      token: (cfg.ha && cfg.ha.token) || '',
      autoLayout: cfg.autoLayout !== false
    };
    var f = readHaFile();
    if (f) {
      if (f.url) ha.url = String(f.url).trim();
      if (f.token) ha.token = String(f.token).trim();
      if (f.autoLayout === false) ha.autoLayout = false;
    }
    ha.token = normalizeToken(ha.token);
    ha.url = normalizeHa(ha.url);
    ha.names = (f && f.names) || null;
    ha.ready = !!(ha.url && ha.token);
    return ha;
  }

  function applyAutoLayout() {
    if (S.layoutBuilding) return;
    S.layoutBuilding = true;
    var b = S.backend;
    var empty = [];
    function req(type) {
      if (!b || !b.requestCmd) return Promise.resolve(empty);
      return b.requestCmd({ type: type }).then(function (r) { return r || empty; }, function () { return empty; });
    }
    Promise.all([
      req('config/area_registry/list'),
      req('config/device_registry/list'),
      req('config/entity_registry/list')
    ]).then(function (res) {
      var built = null;
      try {
        built = window.Layout.build(S.states, res[0], res[1], res[2]);
      } catch (e) {
        built = null;
      }
      if (built && built.rooms && built.rooms.length) {
        cfg.rooms = built.rooms;
        if (built.scenes && built.scenes.length) cfg.scenes = built.scenes;
        var keep = savedRoom();
        var exists = false;
        (cfg.rooms || []).forEach(function (r) { if (r.id === keep) exists = true; });
        S.room = exists ? keep : 'all';
        S.sig = '';
        S.layoutReady = true;
        renderScenes();
        renderTabs();
        markTabs();
      }
      S.layoutReady = true;
      S.layoutBuilding = false;
      renderGrid(true);
      refreshSheet();
    }, function () {
      S.layoutReady = true;
      S.layoutBuilding = false;
      renderGrid(true);
    });
  }

  /* ---------------- 壳 App 桥接 ---------------- */
  function heartbeat() {
    var b = window.AndroidBridge;
    if (b && b.heartbeat) b.heartbeat();
  }

  function watchReload() {
    var b = window.AndroidBridge;
    if (!b || !b.mtime) return;
    var path = '/sdcard/HomeControl/panel/.rev';
    var last = b.mtime(path);
    setInterval(function () {
      var m = b.mtime(path);
      if (!m) return;
      if (!last) { last = m; return; }
      if (m !== last) { last = m; if (location.reload) location.reload(); }
    }, 1500);
  }

  /* ---------------- 事件绑定 ---------------- */
  /* 用壳 App 的原生 HTTP 探一下地址/令牌：200=通、401/403=令牌错、error=连不上 */
  function probeHa(url, token) {
    var b = window.AndroidBridge;
    if (!b || !b.httpProbe) return { error: 'noBridge' };
    var raw = '';
    try { raw = b.httpProbe(String(url), String(token || '')); } catch (e) { return { error: 'bridge' }; }
    var r = {};
    try { r = JSON.parse(raw || '{}'); } catch (e) { return { error: 'parse' }; }
    return r;
  }

  function probeText(r) {
    if (!S.real) return '模拟模式（不连 HA）';
    if (!r) return '未测试';
    if (r.error) return '连不上（' + r.error + '）';
    if (r.status === 200) return '正常 · 令牌有效';
    if (r.status === 401 || r.status === 403) return '令牌被拒绝（HTTP ' + r.status + '）';
    if (r.status === 404) return '地址不对（HTTP 404，检查是否漏了端口）';
    return 'HTTP ' + r.status;
  }
  /* ---------------- 诊断面板（长按左上角时间） ---------------- */
  function maskToken(tk) {
    if (!tk) return '（未设置）';
    var s = String(tk);
    return s.length <= 6 ? '••••' : '••••' + s.slice(-4);
  }

  /* 设备自己连在哪个网：上墙后最容易出错的就是「平板连错了 Wi-Fi」 */
  function netText() {
    var b = window.AndroidBridge;
    if (!b || !b.netInfo) return '—';
    var r = null;
    try { r = JSON.parse(b.netInfo()); } catch (e) { return '—'; }
    if (!r) return '—';
    return (r.ip || '无 IP') + (r.ssid ? ' · ' + r.ssid : ' · 未连 Wi-Fi');
  }

  /** 长时间挂墙看有没有内存/DOM 泄漏：节点数只涨不跌就要查渲染路径 */
  /** DOM 节点基线：挂墙长跑时用来自检「有没有越画越多」 */
  function nodeCount() { return document.getElementsByTagName('*').length; }
  function checkMemGuard(manual) {
    if (!S.nodeBase) S.nodeBase = nodeCount();
    var ratio = num((cfg.memGuard && cfg.memGuard.ratio), 1.6);
    var extra = num((cfg.memGuard && cfg.memGuard.extra), 80);
    var n = nodeCount();
    var limit = Math.round(S.nodeBase * ratio) + extra;
    if (manual || n > limit) actLog('mem ' + n + '/' + S.nodeBase + ' limit ' + limit + (n > limit ? ' RELOAD' : ''));
    if (n > limit) {
      S.nodeBase = n;
      toast('页面节点异常增多，正在重载…');
      setTimeout(function () { location.reload(); }, 1200);
    }
  }
  function memText() {
    var nodes = 0;
    try { nodes = nodeCount(); } catch (e) { }
    S.memSamples = (S.memSamples || 0) + 1;
    S.memFirst = S.memFirst || nodes;
    return nodes + ' 节点（首次 ' + S.memFirst + '） · 渲染 ' + (S.renderCount || 0) + ' 次';
  }

  function appVer() {
    try {
      var b = window.AndroidBridge;
      if (!b || !b.info) return '（web 预览）';
      var d = JSON.parse(b.info() || '{}');
      return (d.ver || '?') + ' · ' + (d.model || '?');
    } catch (e) { return '?'; }
  }

  function diagRows() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/Chrome\/[\d.]+/);
    var ha = readHaFile() || {};
    var mode = S.real ? '真实 HA' : '模拟数据';
    var conn = S.status ? (S.status.connected ? '已连接' : (S.status.text || '未连接')) : '—';
    var tiles = 0;
    (cfg.rooms || []).forEach(function (r) { tiles += (r.tiles || []).length; });
    var url = ha.url || (cfg.ha && cfg.ha.url) || '—';
    var rows = [
      ['模式', mode],
      ['版本', appVer()],
      ['HA 地址', haHttpBase(url) || '（未设置）'],
      ['令牌', maskToken(ha.token)],
      ['连接', conn],
      ['连通测试', probeText(S.lastProbe)],
      ['布局', S.real ? ((cfg.rooms || []).length + ' 个房间 / ' + tiles + ' 张卡') : ((cfg.rooms || []).length + ' 个房间 / ' + tiles + ' 张卡')],
      ['实体', String(Object.keys(S.states || {}).length) + ' 个'],
      ['内存', memText()],
      ['网络', netText()],
      ['视口', window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x'],
      ['内核', (m ? m[0] : '未知') + ' / ' + (ua.indexOf('wv') > -1 ? 'WebView' : '浏览器')],
      ['最近错误', S.lastErr || '无']
    ];
    var html = '';
    rows.forEach(function (r) {
      html += '<div class="diag-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
    });
    return html;
  }

  function diagSheetHtml() {
    return '<div class="cfg-head">设备与连接诊断</div>' +
      '<div class="cfg-desc">上墙后出问题时，先看这里；这几行可以直接念出来。</div>' +
      '<div class="diag">' + diagRows() + '</div>' +
      '<div class="cfg-actions">' +
      '<button class="btn primary" data-act="diag-reload">重新加载</button>' +
      '<button class="btn" data-act="diag-cache">清缓存并重载</button>' +
      '<button class="btn" data-act="diag-probe">测试连接</button>' +
      '<button class="btn" data-act="diag-cfg">连接设置</button>' +
      '<button class="btn" data-act="diag-panel">设置</button>' +
      '<button class="btn" data-act="diag-mock">回模拟数据</button>' +
      '<button class="btn" data-act="close">关闭</button>' +
      '</div>';
  }

  function refreshDiagProbe() {
    var ha = readHaFile() || {};
    var box = el.sheetInner.querySelector('.diag');
    if (!box) return;
    checkMemGuard(true);
    if (!S.real) { S.lastProbe = null; box.innerHTML = diagRows(); return; }
    var url = haHttpBase(ha.url || (cfg.ha && cfg.ha.url) || '');
    var token = normalizeToken(ha.token || (cfg.ha && cfg.ha.token) || '');
    var pr = probeHa(url, token);
    S.lastProbe = pr;
    box.innerHTML = diagRows();
  }

  var SEG_LABEL = {};
  var SEG_OPTS = {};

  function segRow(label, key, opts) {
    SEG_LABEL[key] = label;
    SEG_OPTS[key] = opts;
    var cur = prefs()[key], h = '';
    opts.forEach(function (o) {
      var on = String(o.v) === String(cur);
      h += '<button class="seg' + (on ? ' on' : '') + '" data-act="pref" data-key="' + esc(key) +
        '" data-val="' + esc(String(o.v)) + '">' + esc(o.t) + '</button>';
    });
    return '<div class="set-row" data-row="' + esc(key) + '"><div class="set-k">' + esc(label) + '</div><div class="set-v">' + h + '</div></div>';
  }

  /** 只重画某一行的选项（重建整张弹层在老机器上会卡一下） */
  function repaintSegRow(key) {
    var host = settingsHost();
    if (!host) return;
    var node = host.querySelector ? host.querySelector('[data-row="' + key + '"]') : null;
    if (!node) return;
    node.innerHTML = segRowInline(key);
  }

  function segRowInline(key) {
    var cur = prefs()[key], opts = SEG_OPTS[key] || [], h = '';
    opts.forEach(function (o) {
      var on = String(o.v) === String(cur);
      h += '<button class="seg' + (on ? ' on' : '') + '" data-act="pref" data-key="' + esc(key) +
        '" data-val="' + esc(String(o.v)) + '">' + esc(o.t) + '</button>';
    });
    return '<div class="set-k">' + esc(SEG_LABEL[key] || key) + '</div><div class="set-v">' + h + '</div>';
  }

  /** 点设置项后只更新这一行的按钮状态，不重建整张弹层（老机器上重建会明显卡一下） */
  function syncSegRows(key) {
    var host = settingsHost();
    var cur = prefs()[key], btns = (host && host.querySelectorAll) ? host.querySelectorAll('.seg') : [];
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-key') !== key) continue;
      var on = String(b.getAttribute('data-val')) === String(cur);
      b.className = on ? 'seg on' : 'seg';
    }
  }

  function panelSheetHtml() {
    var p = prefs();
    var html = '<div class="sheet-title">设置</div>' +
      '<div class="sheet-desc">这些设置只记在这台平板上，改完立刻生效。卡片最大宽度 = 每行卡片数（' + num(prefs().cols, 4) + ' 列）。编辑卡片时拖右下角的小箭头，就能像磁贴一样拉伸大小。</div>';

    html += '<div class="set-sec">显示</div>' +
      segRow('每行卡片', 'cols', [{ v: 3, t: '3' }, { v: 4, t: '4' }, { v: 5, t: '5' }, { v: 6, t: '6' }]) +
      segRow('卡片大小', 'size', [{ v: 'sm', t: '紧凑' }, { v: 'md', t: '标准' }, { v: 'lg', t: '大' }]) +
      segRow('传感器卡片', 'sensors', [{ v: true, t: '显示' }, { v: false, t: '隐藏' }]) +
      segRow('离线设备', 'offline', [{ v: true, t: '隐藏' }, { v: false, t: '保留' }]);

    html += '<div class="set-sec">交互</div>' +
      segRow('点一下卡片', 'tap', [{ v: 'toggle', t: '直接开关' }, { v: 'sheet', t: '打开面板' }]) +
      segRow('误触撤销', 'undo', [{ v: 3, t: '3 秒' }, { v: 5, t: '5 秒' }, { v: 8, t: '8 秒' }]);

    html += '<div class="set-sec">屏幕</div>' +
      segRow('空闲自动调暗', 'autoDim', [{ v: true, t: '开' }, { v: false, t: '关' }]) +
      segRow('唤醒亮度', 'bright', [{ v: 40, t: '40%' }, { v: 70, t: '70%' }, { v: 100, t: '100%' }]) +
      segRow('夜间调暗', 'night', [{ v: true, t: '开' }, { v: false, t: '关' }]) +
      segRow('防烧屏位移', 'burn', [{ v: true, t: '开' }, { v: false, t: '关' }]);

    html += '<div class="set-sec">房间（不显示就不进顶栏和「全部」）</div>';
    var hid = hiddenRooms();
    cfg.rooms.forEach(function (r) {
      var off = hid.indexOf(r.id) > -1;
      html += '<div class="p-row"><div class="p-name">' + svg(r.icon || 'sofa') + esc(r.name) + '</div>' +
        '<button class="p-sw' + (off ? '' : ' on') + '" data-act="room-toggle:' + esc(r.id) + '">' +
        (off ? '已隐藏' : '显示中') + '</button></div>';
    });

    html += '<div class="set-sec">负一屏（主屏往右滑）</div>' +
      '<div class="set-row"><div class="set-k">音乐</div><div class="set-v">' +
      '<button class="btn" data-act="music-cfg">' + esc(musicKindLabel(musicNow().kind)) + ' · 设置</button>' +
      '<button class="btn" data-act="music-open">打开</button></div></div>';

    html += '<div class="set-sec">卡片</div>' +
      '<div class="cfg-actions"><button class="btn primary" data-act="edit-open">编辑卡片</button>' +
      '<button class="btn" data-act="edit-reset">清空所有卡片</button></div>' +
      '<div class="set-sec">其它</div>' +
      '<button class="btn" data-act="names-reset">恢复默认名称</button>' +
      '<button class="btn" data-act="room-reset">恢复默认房间</button>' +
      '<button class="btn" data-act="pref-reset">恢复默认设置</button></div>' +
      '<div class="cfg-actions"><button class="btn" data-act="open-cfg">HA 地址与令牌</button>' +
      '<button class="btn" data-act="panel-reload">重新加载面板</button>' +
      '<button class="btn primary" data-act="close">完成</button></div>';
    return html;
  }

  /** 弹层打开时，把后面那张大网格暂时冻住：遮罩挡住了它，重绘它纯属浪费 */
  function freezeGrid(on) {
    if (!el.grid) return;
    el.grid.style.visibility = on ? 'hidden' : '';
    if (el.editBar) el.editBar.style.visibility = on ? 'hidden' : '';
    if (el.topbar) el.topbar.style.visibility = on ? 'hidden' : '';
    if (el.toolbar) el.toolbar.style.visibility = on ? 'hidden' : '';
    /* 弹层打开时整块背景换成不透明纯黑：HwUI 走「颜色填充」快路径，
       不再为了 .58 的遮罩去合成后面那张大网格 */
    if (el.app) el.app.style.background = on ? '#03060b' : '';
    document.body.className = on ? 'sheet-open' : '';
  }

  /* ---------- 整页设置视图（替代 fixed 弹层，见 README「设置页滚动」） ---------- */
  /* 设置页的宿主：整页视图优先，没有 #view（老结构/兜底）时退回 fixed 弹层 */
  /** 只改被点击那一行按钮的选中态（不重建 DOM，老机器上也不会丢焦点） */
  function markSeg(key, btn) {
    var row = btn && btn.parentNode;
    if (!row || !row.children) return;
    for (var i = 0; i < row.children.length; i++) {
      var b = row.children[i];
      if (!b || b.className === undefined) continue;
      var on = b === btn;
      var cls = 'seg' + (on ? ' on' : '');
      if (b.className !== cls) b.className = cls;
    }
  }

  function settingsHost() {
    return (S.sheetShow === 'panel' && el.view) ? el.view : el.sheetInner;
  }

  function openSettingsView() {
    if (!el.view) { openPanelSheet(); return; }
    S.sheetShow = 'panel';
    S.sheetItem = null;
    S.sheetEntity = null;
    S.sheetOpenedAt = Date.now();
    freezeGrid(true);
    el.view.innerHTML = panelSheetHtml();
    el.view.className = 'view show';
    el.view.scrollTop = 0;
    actLog('settings view open');
  }

  function closeSettingsView() {
    if (!el.view) { closeSheet(); return; }
    S.sheetShow = null;
    el.view.className = 'view';
    setTimeout(function () {
      if (el.view && el.view.className.indexOf('show') < 0) el.view.innerHTML = '';
    }, 60);
    freezeGrid(false);
    actLog('settings view close');
  }

  function openPanelSheet() {
    S.sheetItem = null;
    S.sheetEntity = null;
    freezeGrid(true);
    el.sheetInner.innerHTML = panelSheetHtml();
    if (el.sheetInner) el.sheetInner.scrollTop = 0;
    S.sheetOpenedAt = Date.now();
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
  }

  function toggleRoom(id) {
    var hid = hiddenRooms();
    var i = hid.indexOf(id);
    if (i > -1) hid.splice(i, 1); else hid.push(id);
    saveHidden(hid);
    actLog('room ' + id + ' ' + (i > -1 ? 'show' : 'hide'));
    /* 只改这一行的按钮，不重建整张弹层 */
    var host = settingsHost();
    var btn = (host && host.querySelector) ? host.querySelector('.p-sw[data-act="room-toggle:' + id + '"]') : null;
    if (btn) {
      var off = hid.indexOf(id) > -1;
      btn.className = 'p-sw' + (off ? '' : ' on');
      btn.innerHTML = off ? '已隐藏' : '显示中';
    } else {
      if (host) host.innerHTML = panelSheetHtml();
      S.sheetOpenedAt = Date.now();
    }
    renderTabs();
    if (S.room !== 'all' && hid.indexOf(S.room) > -1) { S.room = 'all'; markTabs(); }
    renderGrid(true);
  }

  function openSceneSheet() {
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = sceneSheetHtml();
    S.sheetOpenedAt = Date.now();
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
  }

  function openDiagSheet() {
    freezeGrid(true);
    if (el.app) el.app.style.background = '#03060b';
    S.sheetItem = null;
    S.sheetEntity = null;
    el.sheetInner.innerHTML = diagSheetHtml();
    freezeGrid(true);
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    /* 探活会阻塞几秒，先出页面再测，避免弹层迟迟不出现 */
    setTimeout(refreshDiagProbe, 80);
  }

  function reloadSoon(why) {
    toast(why || '正在重新加载…');
    setTimeout(function () { location.reload(); }, 600);
  }
  /* 编辑工具条：按钮在 #editBar 里，不一定和 el.grid 同父，单独用事件委托
     挂在 document 上，避免绑在还不在文档里的元素上导致点了没反应 */
  function onEditBarClick(ev) {
    var node = ev.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-act')) break;
      node = node.parentNode;
    }
    if (!node || node === document) return;
    var a = node.getAttribute('data-act');
    if (a !== 'edit-add' && a !== 'edit-done') return;
    ev.stopPropagation();
    if (a === 'edit-add') { openAddSheet(); return; }
    if (a === 'edit-done') { exitEdit(); return; }
  }

/* 设置页（整页视图）与所有弹层共用同一套 data-act 路由 */
  function onSheetClick(ev) {
      var actEl = closest(ev.target, null, 'data-act');
      if (!actEl) return;
      var act = actEl.getAttribute('data-act');
      if (act === 'diag-probe') { toast('正在测试连接…'); setTimeout(refreshDiagProbe, 60); return; }
      if (act === 'diag-reload') { reloadSoon('正在重新加载…'); return; }
      if (act === 'diag-cache') {
        try { localStorage.clear(); } catch (e) { }
        reloadSoon('已清缓存，正在重载…');
        return;
      }
      if (act === 'diag-cfg') { openConfigSheet(); return; }
      if (act === 'diag-mock') { clearConfig(); return; }
      if (act === 'guide-config') { dismissGuide(); openConfigSheet(); return; }
      if (act === 'guide-demo') { dismissGuide(); closeSheet(); toast('先看模拟数据；随时长按右上角填地址'); return; }
      if (act === 'cfg-save') { saveConfig(); return; }
      if (act === 'cfg-mock') { clearConfig(); return; }
      if (act === 'rename-open') { openRename(); return; }
    if (act === 'rename-save') { saveRename(); return; }
    if (act === 'rename-cancel') { closeSheet(); return; }
    if (act === 'names-reset') { clearNames(); renderGrid(true); var nh = settingsHost(); if (nh) nh.innerHTML = panelSheetHtml(); toast('已恢复默认名称'); return; }
    if (act === 'close') { if (S.sheetShow === 'panel' && el.view) closeSettingsView(); else closeSheet(); return; }
      if (act.indexOf('room-toggle:') === 0) { toggleRoom(act.slice(12)); return; }
      if (act === 'room-reset') {
        saveHidden([]);
        var rh = settingsHost();
        if (rh) rh.innerHTML = panelSheetHtml();
        renderTabs();
        renderGrid(true);
        toast('已恢复默认房间');
        return;
      }
      if (act === 'diag-panel') { if (el.view) closeSheet(); setTimeout(openSettingsView, 60); return; }
      if (act === 'edit-open') { openEditSheet(); return; }
      if (act === 'edit-add') { openAddSheet(); return; }
      if (act === 'add-done') { closeSheet(); setTimeout(function () { toast('已保存'); }, 60); return; }
      if (act === 'add-room') {
        var rr = roomById(S.room);
        if (rr) { (rr.tiles || []).forEach(function (t) { if (t && t.entity) addToggle(t.entity); }); }
        return;
      }
      if (act === 'edit-all-on') { editAddAll(true); if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml(); return; }
      if (act === 'edit-all-off') { editAddAll(false); if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml(); return; }
      if (act === 'edit-reset') { editReset(); if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml(); toast('编辑已恢复默认（一张卡都不显示）'); return; }
      if (act.indexOf('edit-toggle:') === 0) { editToggle(act.slice(12)); if (S.sheetShow === 'edit') el.sheetInner.innerHTML = editSheetHtml(); return; }
      if (act === 'edit-tab-on') { editTabOn(); return; }
      if (act === 'edit-tab-off') { editTabOff(); return; }
      if (act === 'edit-done') { closeSheet(); setTimeout(function () { renderGrid(true); toast('已保存'); }, 60); return; }
      if (act === 'edit-mode') { closeSheet(); setTimeout(enterEdit, 60); return; }
      if (act === 'edit-exit') { closeSheet(); setTimeout(exitEdit, 60); return; }
      if (act === 'edit-tab-on') { editTabOn(); return; }
      if (act === 'edit-tab-off') { editTabOff(); return; }
      if (act === 'pref') {
        var pkey = actEl.getAttribute('data-key');
        setPref(pkey, actEl.getAttribute('data-val'));
        markSeg(pkey, actEl);
        repaintSegRow(pkey);
        if (pkey === 'cols' || pkey === 'size') { gridClassOnly(); }
        if (pkey === 'size') { setColumns(el.grid, num(prefs().cols, 4)); }
        else if (pkey === 'allCards') renderGrid(true);
        else if (pkey === 'sensors' || pkey === 'offline') renderGrid(true);
        return;
      }
      if (act === 'pref-reset') {
        resetPrefs();
        ['cols', 'size', 'sensors', 'offline', 'tap', 'undo', 'autoDim', 'bright', 'night', 'burn'].forEach(repaintSegRow);
        gridClassOnly();
        renderTabs();
        toast('已恢复默认设置');
        return;
      }
      if (act === 'open-cfg') { openConfigSheet(); return; }
      if (act === 'music-cfg') { openMusicCfgSheet(); return; }
      if (act === 'music-open') {
        if (S.sheetShow === 'panel') closeSettingsView(); else closeSheet();
        setTimeout(function () { if (window.MusicUI) window.MusicUI.open(); }, 140);
        return;
      }
      if (act === 'music-kind') { S.musicKindSel = actEl.getAttribute('data-val'); markSeg('music', actEl); return; }
      if (act === 'music-save') { saveMusicCfg(false); return; }
      if (act === 'music-demo') { saveMusicCfg(true); return; }
      if (act === 'panel-reload') { reloadSoon('正在重新加载…'); return; }
      if (act === 'scene-run') {
        doAct('scene-run', {
          entity: actEl.getAttribute('data-entity'),
          name: actEl.getAttribute('data-entity')
        });
        return;
      }
      var item = S.sheetItem;
      if (!item) return;
      var id = item.tile.entity;
      if (act.indexOf('mode:') === 0) { setMode(id, act.slice(5)); return; }
      if (act.indexOf('fan:') === 0) { setFan(id, act.slice(4)); return; }
      doAct(act, item);
    
  }

  /* ---------------- 负一屏（panel/js/music.js）对接 ----------------
     音乐页自己管渲染和播放，这里只给它四样东西：toast、动作日志、
     「这次触摸别当成点卡片」的取消钩子、以及设置页的入口。 */
  function cancelPanelTap() {
    clearTimeout(S.lpTimer);
    clearTimeout(S.holdTimer);
    S.lpFired = true;
    clearTimeout(S.pullFiredTimer);
    S.pullFiredTimer = setTimeout(function () {
      S.lpFired = false;
      S.holdFired = false;
    }, 500);
  }

  function musicNow() {
    if (window.MusicUI && window.MusicUI.cfg) return window.MusicUI.cfg();
    return cfg.music || { kind: 'mock' };
  }

  function musicKindLabel(k) {
    if (k === 'daoliyu') return '道理鱼';
    if (k === 'subsonic') return 'Subsonic';
    return '演示音源';
  }

  function musicCfgSheetHtml() {
    var m = musicNow();
    var kind = S.musicKindSel || m.kind || 'mock';
    function kindBtn(v, t) {
      return '<button class="seg' + (kind === v ? ' on' : '') + '" data-act="music-kind" data-val="' + v + '">' + t + '</button>';
    }
    return '<div class="cfg-head">音乐 · 负一屏</div>' +
      '<div class="cfg-desc">主屏往右滑进入。连道理鱼或任何 Subsonic 兼容服务（Navidrome / Gonic / AirSonic 都行），' +
      '地址填到端口即可，例如 http://10.10.1.7:4533。演示音源不需要服务器。' +
      '</div>' +
      '<div class="set-row"><div class="set-k">音源</div><div class="set-v">' +
      kindBtn('mock', '演示') + kindBtn('daoliyu', '道理鱼') + kindBtn('subsonic', 'Subsonic') + '</div></div>' +
      '<div class="cfg-row"><div class="cfg-k">服务器</div>' +
      '<input class="cfg-in" id="mCfgUrl" type="text" onfocus="this.select()" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="http://192.168.1.10:4533" value="' + esc(m.baseUrl || '') + '"></div>' +
      '<div class="cfg-row"><div class="cfg-k">账号</div>' +
      '<input class="cfg-in" id="mCfgUser" type="text" onfocus="this.select()" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="用户名" value="' + esc(m.user || '') + '"></div>' +
      '<div class="cfg-row"><div class="cfg-k">密码</div>' +
      '<input class="cfg-in" id="mCfgPass" type="password" onfocus="this.select()" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="密码" value="' + esc(m.pass || '') + '"></div>' +
      '<div class="cfg-actions">' +
      '<button class="btn primary" data-act="music-save">保存并连接</button>' +
      '<button class="btn" data-act="music-demo">改用演示音源</button>' +
      '<button class="btn" data-act="close">取消</button></div>';
  }

  function openMusicCfgSheet() {
    if (S.sheetShow === 'panel') closeSettingsView();
    S.sheetOpenedAt = Date.now();
    S.sheetItem = null;
    S.sheetEntity = null;
    S.musicKindSel = null;
    el.sheetInner.innerHTML = musicCfgSheetHtml();
    el.mask.className = 'mask show';
    el.sheet.className = 'sheet show';
    actLog('open music cfg');
  }

  function saveMusicCfg(forceMock) {
    var kind = forceMock ? 'mock' : (S.musicKindSel || musicNow().kind || 'mock');
    var urlEl = document.getElementById('mCfgUrl');
    var userEl = document.getElementById('mCfgUser');
    var passEl = document.getElementById('mCfgPass');
    var baseUrl = urlEl ? String(urlEl.value || '').trim() : '';
    if (kind !== 'mock' && !baseUrl) { toast('先填音乐服务器地址'); return; }
    if (!window.MusicUI) { toast('音乐页没加载成功，重新加载面板试试'); return; }
    window.MusicUI.saveCfg({
      kind: kind,
      baseUrl: baseUrl,
      user: userEl ? String(userEl.value || '').trim() : '',
      pass: passEl ? String(passEl.value || '') : ''
    });
    S.musicKindSel = null;
    closeSheet();
    toast(kind === 'mock' ? '已切到演示音源' : ('已保存（' + musicKindLabel(kind) + '），正在连接…'));
    setTimeout(function () { if (window.MusicUI) window.MusicUI.open(); }, 220);
  }

  window.__PANEL_TOAST__ = function (t) { toast(t); };
  window.__PANEL_ACTLOG__ = function (w) { actLog(w); };
  window.__PANEL_CANCEL_TAP__ = cancelPanelTap;
  window.__PANEL_OPEN_MUSIC_CFG__ = function () { openMusicCfgSheet(); };

  function bindEvents() {
    document.addEventListener('click', onEditBarClick, false);
    document.addEventListener('click', onTileBarClick, false);
    if (false) {
      el.editBar.addEventListener('click', function (ev) {
        actLog('EB ' + (ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-act') : '?'));
        var b = closest(ev.target, 'eb-btn') || closest(ev.target, 'btn') || (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-act') ? ev.target : null);
        if (!b) return;
        var a = b.getAttribute('data-act');
        if (a === 'edit-all-on') { editAddAll(true); return; }
        if (a === 'edit-all-off') { editAddAll(false); return; }
        if (a === 'edit-done') { exitEdit(); return; }
      });
    }

    el.tabs.addEventListener('click', function (ev) {
      var tab = closest(ev.target, 'tab');
      if (!tab) return;
      var room = tab.getAttribute('data-room');
      if (room === S.room) return;
      S.room = room;
      saveRoom(room);
      markTabs();
      renderGrid(true);
      el.grid.scrollTop = 0;
    });

    el.scenes.addEventListener('click', function (ev) {
      var chip = closest(ev.target, 'chip');
      if (!chip) return;
      if (chip.getAttribute('data-scene-more')) { openSceneSheet(); return; }
      var entity = chip.getAttribute('data-scene');
      if (!entity) return;
      chip.className = 'chip active';
      var name = chip.textContent;
      setTimeout(function () { if (chip) chip.className = 'chip'; }, 1400);
      callService(entity.split('.')[0], 'turn_on', { entity_id: entity })
        .then(function () { toast('场景已执行：' + name); })
        .then(null, function () {});
    });

    el.grid.addEventListener('click', function (ev) {
      if (S.lpFired) return;
      /* 刚拖完拉伸手柄：这一次 click 是拖动产生的，不能当选中/开关处理 */
      if (S.gripFired) return;
      /* 刚拖/点过亮度条：那是「设置百分比」，绝不能再顺手把灯关掉 */
      if (S.pctFired) return;
      var tileEl = closest(ev.target, null, 'data-entity') || closest(ev.target, 'tile');
      if (!tileEl) { S.tileSel = null; return; }
      var idx = S.tileEls.indexOf(tileEl);
      if (idx < 0 || !S.items[idx]) return;
      var item = S.items[idx];
      var actEl = closest(ev.target, null, 'data-act');
      if (actEl && S.holdFired && actEl.getAttribute('data-hold')) {
        /* 长按已经处理过，这一次的 click 不再走短按逻辑 */
        S.holdFired = false;
        return;
      }
      if (actEl) {
        var actAttr = actEl.getAttribute('data-act');
        S.tileSel = S.editing ? tileEl : null;
        doAct(actAttr, item);
        if (S.sheetShow === 'add' || actAttr === 'edit-add' || actAttr.indexOf('add-toggle:') === 0) el.sheetInner.innerHTML = addSheetHtml();
        return;
      }
      /* 编辑模式：点卡片空白处＝选中这张卡（再点一次取消） */
      if (S.editing) { selectTile(S.tileSel === tileEl ? null : tileEl, item); return; }
      primary(item);
    });

    el.grid.addEventListener('touchstart', function (ev) {
      var tileEl = closest(ev.target, null, 'data-entity') || closest(ev.target, 'tile');
      /* 宽度按钮长按 → 全档列表（短按仍是 +1 循环） */
      var holdEl = closest(ev.target, null, 'data-hold');
      if (holdEl && tileEl) {
        clearTimeout(S.holdTimer);
        S.holdTimer = setTimeout(function () {
          S.holdFired = true;
          setTimeout(function () { S.holdFired = false; }, 700);
          var hidx = S.tileEls.indexOf(tileEl);
          if (hidx >= 0 && S.items[hidx]) doAct(holdEl.getAttribute('data-hold'), S.items[hidx]);
        }, 520);
      }
      if (!tileEl || S.editing || closest(ev.target, null, 'data-act')) return;
      clearTimeout(S.lpTimer);
      S.lpTimer = setTimeout(function () {
        S.lpFired = true;
        setTimeout(function () { S.lpFired = false; }, 900);
        var idx = S.tileEls.indexOf(tileEl);
        if (idx >= 0 && S.items[idx]) openSheet(S.items[idx]);
      }, 520);
    }, true);
    var cancelLp = function () { clearTimeout(S.lpTimer); clearTimeout(S.holdTimer); };
    el.grid.addEventListener('touchend', cancelLp, true);
    el.grid.addEventListener('touchcancel', cancelLp, true);
    el.grid.addEventListener('touchmove', cancelLp, true);

    /* ---------- 磁贴式拉伸：编辑态卡片右下角手柄 ---------- */
    function gripPoint(ev) {
      if (ev.touches && ev.touches.length) return ev.touches[0];
      if (ev.changedTouches && ev.changedTouches.length) return ev.changedTouches[0];
      return ev;
    }
    function gripDown(ev) {
      if (!S.editing) return;
      var g = closest(ev.target, null, 'data-grip');
      var tileEl = g ? closest(g, 'tile') : null;
      var entity = g ? g.getAttribute('data-grip') : null;
      var pt = gripPoint(ev);
      if (!pt) return;
      if (!tileEl || !entity) {
        tileEl = closest(ev.target, 'tile');
        if (!tileEl) return;
        var rc = tileEl.getBoundingClientRect();
        var zone = 88;
        if (pt.clientX < rc.right - zone || pt.clientY < rc.bottom - zone) return;
        entity = tileEl.getAttribute('data-entity');
        if (!entity) return;
      }
      var cols = num(prefs().cols, 4);
      var gap = 14;
      var gw = el.grid.clientWidth || 0;
      var colW = cols > 0 ? (gw - gap * (cols - 1)) / cols : 0;
      if (!(colW > 0)) colW = 120;
      S.grip = {
        entity: entity, el: tileEl,
        x0: pt.clientX, y0: pt.clientY,
        c0: cardSpan(entity, cols), r0: rowSpan(entity),
        stepX: colW + gap, stepY: rowHeight() + gap,
        cols: cols, c: cardSpan(entity, cols), r: rowSpan(entity)
      };
      S.gripFired = true;
      clearTimeout(S.lpTimer); clearTimeout(S.holdTimer);
      if (tileEl.className.indexOf('resizing') < 0) tileEl.className += ' resizing';
      actLog('grip down ' + entity);
      if (ev.cancelable) ev.preventDefault();
    }
    function gripMove(ev) {
      var st = S.grip;
      if (!st) return;
      var pt = gripPoint(ev);
      if (!pt) return;
      var dc = Math.round((pt.clientX - st.x0) / st.stepX);
      var dr = Math.round((pt.clientY - st.y0) / st.stepY);
      var c = st.c0 + dc; if (c < 1) c = 1; if (c > st.cols) c = st.cols;
      var r = st.r0 + dr; if (r < 1) r = 1; if (r > 2) r = 2;
      if (c === st.c && r === st.r) { if (ev.cancelable) ev.preventDefault(); return; }
      st.c = c; st.r = r;
      st.el.style.gridColumn = 'span ' + c;
      st.el.style.gridRow = 'span ' + r;
      var tag = st.el.querySelector('.t-size');
      if (tag) tag.innerHTML = spanText(c, st.cols) + (r > 1 ? ' · 高 ' + r : '');
      if (ev.cancelable) ev.preventDefault();
    }
    function gripUp(ev) {
      var st = S.grip;
      if (!st) return;
      S.grip = null;
      st.el.className = st.el.className.replace(/\s*resizing/g, '');
      st.el.style.gridColumn = '';
      st.el.style.gridRow = '';
      setTimeout(function () { S.gripFired = false; }, 400);
      if (ev && ev.cancelable) ev.preventDefault();
      if (st.c !== st.c0 || st.r !== st.r0) {
        resizeCard(st.entity, st.c, st.r);
      } else {
        var tag = st.el.querySelector('.t-size');
        if (tag) tag.innerHTML = spanText(st.c0, st.cols) + (st.r0 > 1 ? ' · 高 ' + st.r0 : '');
      }
      actLog('grip up ' + st.entity + ' ' + st.c + 'x' + st.r);
    }
    el.grid.addEventListener('touchstart', gripDown, true);
    el.grid.addEventListener('mousedown', gripDown, true);
    document.addEventListener('touchmove', gripMove, { passive: false, capture: true });
    document.addEventListener('mousemove', gripMove, true);
    document.addEventListener('touchend', gripUp, true);
    document.addEventListener('touchcancel', gripUp, true);
    document.addEventListener('mouseup', gripUp, true);

    /* ---------- 卡片百分比进度条：点/拖直接改亮度 ----------
       这三段在磁贴拉伸之后注册，所以拖动开始时能先一步清掉长按定时器
       （同一个 touchstart 上，长按监听器先跑、我们后跑，正好把它取消）。
       横坐标 → 百分比是纯函数 pctFromX()，离线单测可以直接断言。 */
    function pctPt(ev) {
      if (ev.touches && ev.touches.length) return ev.touches[0];
      if (ev.changedTouches && ev.changedTouches.length) return ev.changedTouches[0];
      return ev;
    }
    function pctAt(ev, bar) {
      var pt = pctPt(ev);
      if (!pt || pt.clientX == null) return null;
      var rc = bar.getBoundingClientRect();
      return pctFromX(pt.clientX, rc.left, rc.width);
    }
    /** 本地先画、再异步告诉 HA：手指看到的响应不受网络延迟影响 */
    function pctPaint(d, p) {
      d.pct = p;
      setBarPct(d.bar, p);
      patch(d.entity, 'on', { brightness: Math.round(p * 255 / 100) });
    }
    function pctSend(d, force) {
      var now = Date.now();
      if (!force && now - d.sentAt < 140) return;   /* 拖动中限流，别把 HA 打满 */
      d.sentAt = now;
      /* 发出去之后的一小段时间里，HA 推回来的中间值不覆盖本地手感：
         过渡灯会一条条回包，照画就会出现「松手后自己往回弹」 */
      S.pctHold = { entity: d.entity, until: now + 1500 };
      var data = { entity_id: d.entity };
      data[d.meta.key] = d.pct;
      callService(d.meta.domain, d.meta.service, data).then(null, function () { });
    }
    function barDown(ev) {
      if (S.editing) return;
      var bar = closest(ev.target, 't-bar');
      if (!bar || bar.getAttribute('data-role') !== 'pbar') return;
      var tileEl = closest(bar, 'tile');
      if (!tileEl) return;
      var idx = S.tileEls.indexOf(tileEl);
      var item = idx >= 0 ? S.items[idx] : null;
      if (!item) return;
      var entity = item.tile.entity;
      if (isNa(stateOf(entity))) return;
      var meta = pctMeta(item.tile, attrsOf(entity));
      if (!meta) return;
      var p = pctAt(ev, bar);
      if (p == null) return;
      S.pctDrag = { entity: entity, bar: bar, meta: meta, pct: meta.pct, sentAt: 0 };
      S.pctFired = true;
      clearTimeout(S.lpTimer);
      clearTimeout(S.holdTimer);
      if (bar.className.indexOf('dragging') < 0) bar.className = 't-bar dragging';
      actLog('pct down ' + entity + ' ' + p);
      pctPaint(S.pctDrag, p);
      pctSend(S.pctDrag, true);
      if (ev.cancelable) ev.preventDefault();
    }
    function barMove(ev) {
      var d = S.pctDrag;
      if (!d) return;
      var p = pctAt(ev, d.bar);
      if (p == null) return;
      if (p !== d.pct) pctPaint(d, p);
      pctSend(d, false);
      if (ev.cancelable) ev.preventDefault();
    }
    function barUp(ev) {
      var d = S.pctDrag;
      if (!d) return;
      S.pctDrag = null;
      pctSend(d, true);
      S.pctHold = { entity: d.entity, until: Date.now() + 1200 };
      d.bar.className = 't-bar';
      setTimeout(function () { S.pctFired = false; }, 400);
      actLog('pct up ' + d.entity + ' ' + d.pct);
      if (ev && ev.cancelable) ev.preventDefault();
    }
    el.grid.addEventListener('touchstart', barDown, true);
    el.grid.addEventListener('mousedown', barDown, true);
    document.addEventListener('touchmove', barMove, { passive: false, capture: true });
    document.addEventListener('mousemove', barMove, true);
    document.addEventListener('touchend', barUp, true);
    document.addEventListener('touchcancel', barUp, true);
    document.addEventListener('mouseup', barUp, true);

    el.mask.addEventListener('click', function () {
      /* 打开弹层的那一次触摸，其 click 可能在弹层已经出现之后才派发，
         落点就变成了遮罩 → 会「开了立刻关」，这里给 400ms 静默期 */
      if (S.sheetOpenedAt && Date.now() - S.sheetOpenedAt < 400) return;
      closeSheet();
    });
    el.toast.addEventListener('click', function (ev) {
      /* 带动作的 toast 整条都可以点：整条只有一个语义（撤销），
         不依赖点中那两个字（触屏上 20px 宽的目标太苛刻） */
      if (!toastUndo) return;
      var fn = toastUndo;
      toastUndo = null;
      el.toast.className = 'toast';
      fn();
    });

    /* 长按状态胶囊 → 连接设置（墙上不方便摸电脑时可直接在平板改配置） */
    var cfgTimer = null;
    var cfgPressAt = 0;
    var startCfg = function () { cfgPressAt = new Date().getTime(); clearTimeout(cfgTimer); cfgTimer = setTimeout(openConfigSheet, 800); };
    var cancelCfg = function () {
      clearTimeout(cfgTimer);
      var held = new Date().getTime() - cfgPressAt;
      if (cfgPressAt) actLog('capsule tap held=' + held);
      if (cfgPressAt && held < 700) {
        if (S.unconfigured) {
          /* 还没配置：短按胶囊直接进设置，比"重连"有意义 */
          openConfigSheet();
        } else if (S.real && S.backend && S.backend.reconnect) {
          toast('正在重新连接…');
          S.backend.reconnect();
        }
      }
      cfgPressAt = 0;
    };
    el.status.addEventListener('touchstart', startCfg, false);
    el.status.addEventListener('touchend', cancelCfg, false);
    el.status.addEventListener('touchmove', cancelCfg, false);
    el.status.addEventListener('touchcancel', cancelCfg, false);
    el.status.addEventListener('mousedown', startCfg, false);
    el.status.addEventListener('mouseup', cancelCfg, false);

    /* 长按左上角时间 → 设备/连接诊断（上墙后自己排查用） */
    var diagTimer = null;
    var startDiag = function () { clearTimeout(diagTimer); diagTimer = setTimeout(openDiagSheet, 800); };
    var stopDiag = function () { clearTimeout(diagTimer); };
    ['touchstart', 'mousedown'].forEach(function (ev) { el.time.addEventListener(ev, startDiag, false); });
    ['touchend', 'touchmove', 'touchcancel', 'mouseup'].forEach(function (ev) { el.time.addEventListener(ev, stopDiag, false); });

    el.sheet.addEventListener('click', onSheetClick);
    if (el.view) el.view.addEventListener('click', onSheetClick);
    if (el.view) el.view.addEventListener('pointerdown', function (e) {
      var t = closest(e.target, null, 'data-act');
      if (!t) return;
      t.className += ' hit';
      setTimeout(function () { t.className = t.className.replace(/ hit/g, ''); }, 160);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.keyCode === 27) closeSheet();
    });
  }

  /* ---------------- 启动 ---------------- */
  /* 自检钩子：url 带 ?selftest=hang 时，故意把主线程卡住 60 秒（只触发一次），
   用来在真机上验证壳 App 的看门狗能不能把假死的页面救回来。 */
/* 开发期热更新：tools\push.ps1 推完面板会顺便推一个 .rev 文件，
   这里轮询它的 mtime，一变就 reload —— 不用 force-stop 重启 App。
   （没有 .rev 说明不是开发机，直接不轮询。） */
function watchDevReload() {
  var b = window.AndroidBridge;
  if (!b || !b.mtime) return;
  var REV = '/sdcard/HomeControl/panel/.rev';
  var base = 0;
  try { base = b.mtime(REV); } catch (e) { base = 0; }
  var waited = 0;
  var timer = setInterval(function () {
    var m = 0;
    try { m = b.mtime(REV); } catch (e) { m = 0; }
    if (!base) {
      /* 冷启动时还没有 .rev：推送把它创建出来的那一刻就当一次更新（reload 一次），
         60 秒内始终没有就不再轮询，生产环境不会一直空转 */
      if (m) { base = m; actLog('hot reload (first)'); location.reload(); return; }
      waited += 2;
      if (waited >= 60) clearInterval(timer);
      return;
    }
    if (m && m !== base) {
      base = m;
      actLog('hot reload');
      location.reload();
    }
  }, 2000);
}

function selfTestHang() {
  try {
    if (!/[?&]selftest=hang/.test(location.search)) return;
    if (localStorage.getItem('hc.selftest.done') === '1') return;
    localStorage.setItem('hc.selftest.done', '1');
    if (window.AndroidBridge && AndroidBridge.log) AndroidBridge.log('SELFTEST hang start');
    var t0 = new Date().getTime();
    while (new Date().getTime() - t0 < 60000) { }
    if (window.AndroidBridge && AndroidBridge.log) AndroidBridge.log('SELFTEST hang end');
  } catch (e) { }
}

function boot() {
    window.onerror = function (msg, src, line, col) {
      S.lastErr = String(msg) + ' @' + line;
      if (window.AndroidBridge && AndroidBridge.log) AndroidBridge.log('JSERR ' + msg + ' @' + line + ':' + col + ' ' + (src || ''));
    };
    el.time = $('time'); el.date = $('date'); el.weather = $('weather');
    el.status = $('status'); el.statusText = $('statusText');
    el.gear = $('gear');
    el.editBtn = $('editBtn');
    el.editBar = $('editBar');
    el.scenes = $('scenes'); el.tabs = $('tabs'); el.grid = $('grid');
    el.mask = $('mask'); el.sheet = $('sheet'); el.sheetInner = $('sheetInner');
    el.toast = $('toast');
    el.dim = $('dim'); el.dimTime = $('dimTime');
    el.app = $('app');
    el.view = $('view');
    el.topbar = document.querySelector('.topbar');
    el.toolbar = document.querySelector('.toolbar');
    if (el.gear) {
      el.gear.innerHTML = svg('gear');
    if (el.editBtn) {
      el.editBtn.innerHTML = svg('edit');
      el.editBtn.addEventListener('click', function () { if (S.editing) exitEdit(); else enterEdit(); });
      el.editBtn.addEventListener('touchstart', function (ev) { ev.stopPropagation(); });
    }
      el.gear.addEventListener('click', function () { openSettingsView(); });
      el.gear.addEventListener('touchstart', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); }, false);
    }

    selfTestHang();
    watchDevReload();
    S.names = namesFor(cfg.ha || {});

    if (cfg.title) document.title = cfg.title;

    var ha = resolveHa();
    /* ha.json 里也可以带 camStream（部署时写一次即可，不用改面板源码） */
    if (ha && ha.camStream) {
      cfg.camStream = cfg.camStream || {};
      for (var cs in ha.camStream) { if (ha.camStream.hasOwnProperty(cs)) cfg.camStream[cs] = String(ha.camStream[cs]); }
    }
    S.ha = ha;                    /* 摄像头快照/名称覆盖都要用 */
    S.names = namesFor(ha);
    S.real = ha.ready && cfg.forceMock !== true;
    S.unconfigured = !ha.ready;   /* 没填地址/令牌：面板只是样例，不是连不上 */
    S.layoutReady = !S.real;
    S.room = savedRoom() || 'all';
    if (S.room !== 'all' && hiddenRooms().indexOf(S.room) > -1) S.room = 'all';

    renderScenes();
    renderTabs();
    bindEvents();
    renderGrid(true);
    setStatus({
      connected: false,
      text: S.real ? '连接 HA…' : (S.unconfigured ? '未配置 · 长按右上角' : '连接中…')
    });
    if (S.unconfigured) { firstRunHint(); maybeShowGuide(); }

    tick();
    setInterval(tick, 1000);

    /* 网络回来立刻重连：重启后 WiFi 常常比面板晚十几秒，别等指数退避 */
    window.addEventListener('online', function () {
      actLog('online → reconnect');
      if (S.real && S.backend && S.backend.reconnect) S.backend.reconnect();
    });
    /* 看门狗：连不上超过 20 秒就主动重连一次（只在本地面板、真实模式生效） */
    setInterval(function () {
      if (!S.real || !S.backend || !S.backend.reconnect) return;
      if (S.status && S.status.connected) { S.lastKick = 0; return; }
      var now = Date.now();
      if (!S.lastKick || now - S.lastKick > 20000) {
        S.lastKick = now;
        actLog('watchdog reconnect');
        S.backend.reconnect();
      }
    }, 5000);
    setTimeout(camPaint, 600);
    setInterval(camPaint, 8000);

    S.backend = S.real
      ? new window.HABackend({ url: ha.url, token: ha.token })
      : new window.MockBackend(cfg);
    S.backend.onStates(onStates);
    S.backend.onStatus(setStatus);
    S.backend.start();

    setInterval(heartbeat, 4000);
    watchReload();
    applyPrefs();
  bindDim();
  startPixelShift();
    /* 负一屏：音乐页自己接管右滑手势和渲染（panel/js/music.js） */
    if (window.MusicUI) window.MusicUI.attach();

    var bootEl = $('boot');
    if (bootEl) setTimeout(function () { bootEl.className = 'boot hide'; }, 260);

    actLog('boot ' + (Date.now() - BOOT_T0) + 'ms · 卡 ' + S.items.length + ' · 实体 ' + countStates(S.states));
  }

  /* 供离线单测（tools\test-ui.js）取用的纯函数，不影响运行时 */
  window.__PANEL_TEST__ = {
    isNa: isNa, isAuto: isAuto, hasBrightness: hasBrightness, hasPosition: hasPosition,
    climateTempCaps: climateTempCaps, dualTarget: dualTarget,
    valHtml: valHtml, subText: subText, midHtml: midHtml, tileHtml: tileHtml, iconFor: iconFor,
    pctMeta: pctMeta, pctFromX: pctFromX, barHtml: barHtml,
    setStates: function (o) { S.states = o || {}; },
    normalizeHa: normalizeHa, haHttpBase: haHttpBase, normalizeToken: normalizeToken,
    camLiveUrl: camLiveUrl, camSrc: camSrc, camStamp: camStamp, cfgRef: cfg,
    displayName: displayName, setName: setName, clearNames: clearNames, namesFor: namesFor,
    sceneChips: sceneChips, historyPoints: historyPoints, sparkHtml: sparkHtml,
    camSrc: camSrc, cameraSheet: cameraSheet, camStateText: function (st) { return CAM_STATE[st] || '待机'; },
    setReal: function (v) { S.real = !!v; },
    guideSheetHtml: guideSheetHtml, panelSheetHtml: panelSheetHtml, prefs: prefs, PREDEF: PREF_DEF,
    readEdit: readEdit, writeEdit: writeEdit, cardVisible: cardVisible, cardSpan: cardSpan,
    sortCards: sortCards, editToggle: editToggle, editSpan: editSpan, editMove: editMove,
    editAddAll: editAddAll, editSheetHtml: editSheetHtml, allCards: allCards, visibleRooms: visibleRooms, hiddenRooms: hiddenRooms, hasColor: hasColor, rgbCss: rgbCss, hsvToRgb: hsvToRgb, rgbToHs: rgbToHs, colorPresets: COLOR_PRESETS
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
