/* 面板自升级：检查 GitHub Releases → 下载 APK → 交给系统安装器。
 *
 * 这一页是「墙面设备」唯一能自己变新的路径，所以每一步的状态都写进设置页，
 * 失败也把原因原样说出来（连不上 GitHub / 没有 release / 缺安装权限）。
 *
 * 协议（Java 侧 app/src/com/homecontrol/panel/MainActivity.java 的 Bridge）：
 *   AndroidBridge.updNet(cbId, url, headersJson)   → window.__hcUpdNetCb(cbId, {status, body} | {error})
 *   AndroidBridge.updDownload(cbId, url, fileName) → window.__hcUpdProg(cbId, pct) 反复回调，
 *                                                    完毕 window.__hcUpdDone(cbId, {path, bytes} | {error})
 *   AndroidBridge.updInstall(cbId, path)           → window.__hcUpdDone(cbId, {ok:true} | {error})
 *   AndroidBridge.updPerm()                        → 打开「安装未知应用」的系统设置
 * 浏览器里（tools/sim.js 预览）没有 AndroidBridge，只显示说明，不做无效请求。 */
(function () {
  'use strict';

  var DEFAULT_API = 'https://api.github.com/repos/Eggplant4363/HomeControl/releases/latest';
  var MAX_APK = 80 * 1024 * 1024;      /* 比这还大就别下了（防呆：别把 JSON 当 APK 写满磁盘） */

  /* 下载通道：直连 / 国内镜像（前缀转发 GitHub API+下载）/ 国内 HTTP 代理。
   * 配置落 /sdcard/HomeControl/update.json；镜像格式 https://<镜像>/https://github.com/… 。 */
  var CFG_FILE = '/sdcard/HomeControl/update.json';
  /* 内置镜像都实测过（API+APK 下载都 200）。ghproxy.net 下载通但 API 403、ghproxy.link 转义坏 URL，不内置。 */
  var BUILTIN = [
    { prefix: 'https://gh-proxy.com/', label: 'gh-proxy.com' }
  ];

  /* 自带轻提示：app.js 的 toast 是模块作用域（mqtt.js 踩过坑），这里直接操作 #toast 元素 */
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

  /** update.json 文本 → 归一化的通道配置（坏 JSON/没配 → 直连；代理缺主机也回直连） */
  function parseChannel(text) {
    var o = null;
    if (text) { try { o = JSON.parse(text); } catch (e) { o = null; } }
    var ch = (o && o.channel) || 'direct';
    var mir = normalizePrefix((o && o.mirror) || '');
    var ph = String((o && o.proxyHost) || '').trim();
    var pp = parseInt((o && o.proxyPort) || 0, 10) || 0;
    if (ch === 'mirror' && !mir) ch = 'direct';
    if (ch === 'proxy' && !ph) ch = 'direct';
    if (ch !== 'mirror') mir = '';
    if (ch !== 'proxy') { ph = ''; pp = 0; }   /* 回退直连时别留下残留的镜像/代理字段 */
    return { channel: ch, mirror: mir, proxyHost: ph, proxyPort: pp };
  }

  /** 镜像前缀：必须是 http(s):// 开头、以 / 结尾；不合法返回 '' */
  function normalizePrefix(s) {
    s = String(s || '').trim();
    if (!/^https?:\/\/[^\/]+\/?$/.test(s)) return '';
    if (s.charAt(s.length - 1) !== '/') s += '/';
    return s;
  }

  function readChannel() {
    var b = bridge();
    var raw = b ? b.readText(CFG_FILE) : '';
    return parseChannel(raw);
  }

  /** 按通道改写请求 URL：直连/代理原样（代理在 Java 侧做），镜像加前缀 */
  function applyChannel(cfg, url) {
    if (cfg.channel === 'mirror' && cfg.mirror) return cfg.mirror + url;
    return url;
  }

  /** 给 Java 桥的代理参数：'' = 不用代理 */
  function proxyJson(cfg) {
    if (cfg.channel === 'proxy' && cfg.proxyHost && cfg.proxyPort > 0) {
      return JSON.stringify({ host: cfg.proxyHost, port: cfg.proxyPort });
    }
    return '';
  }

  function builtinLabel(mir) {
    for (var i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].prefix === mir) return BUILTIN[i].label;
    return '';
  }

  function channelLabel(cfg) {
    if (cfg.channel === 'mirror') return builtinLabel(cfg.mirror) || ('镜像 ' + cfg.mirror);
    if (cfg.channel === 'proxy') return '代理 ' + cfg.proxyHost + ':' + cfg.proxyPort;
    return '直连 GitHub';
  }

  /** 写通道配置并重绘升级节；kind: direct | mirror | proxy */
  function setChannel(kind, opts) {
    opts = opts || {};
    var cfg = { channel: 'direct', mirror: '', proxyHost: '', proxyPort: 0 };
    if (kind === 'mirror') {
      cfg.mirror = normalizePrefix(opts.mirror);
      if (!cfg.mirror) { toast('镜像地址不合法（要 http(s)://开头）'); return; }
      cfg.channel = 'mirror';
    } else if (kind === 'proxy') {
      cfg.proxyHost = String(opts.proxyHost || '').trim();
      cfg.proxyPort = parseInt(opts.proxyPort || 0, 10) || 0;
      if (!cfg.proxyHost || cfg.proxyPort <= 0 || cfg.proxyPort > 65535) { toast('代理要填主机和端口（如 10.10.1.2:7890）'); return; }
      cfg.channel = 'proxy';
    }
    var b = bridge();
    if (!b || !b.writeText) { toast('没有原生桥，写不了 update.json'); return; }
    b.writeText(CFG_FILE, JSON.stringify(cfg));
    toast('下载通道：' + channelLabel(cfg));
    repaint();
  }

  var U = {
    phase: 'idle',      /* idle | checking | latest | found | downloading | ready | installing | error */
    ver: '',            /* 远端版本号（不带 v） */
    size: 0,            /* 远端 APK 字节数，0 = 未知 */
    digest: '',         /* 远端 APK 的 sha256（GitHub 提供，可能为空） */
    url: '',            /* 远端 APK 下载地址 */
    file: '',           /* 远端 APK 文件名 */
    path: '',           /* 下载到本机后的路径 */
    needPerm: false,
    retryMirror: false,    /* 直连下载超时→提示换镜像重试 */
    pct: 0,
    msg: ''
  };

  var seq = 0;
  var pending = {};

  function bridge() { return window.AndroidBridge || null; }
  function hasBridge() {
    var b = bridge();
    return !!(b && b.updNet && b.updDownload && b.updInstall);
  }

  function apiUrl() {
    /* 测试/自建镜像可以覆盖：window.__HC_UPDATE_API = 'http://…/release.json' */
    return window.__HC_UPDATE_API || DEFAULT_API;
  }

  function curVer() {
    try {
      var b = bridge();
      if (!b || !b.info) return '';
      var d = JSON.parse(b.info() || '{}');
      return d.ver || '';
    } catch (e) { return ''; }
  }

  /* ---------------- 纯函数（tools/test-ui.js 直接测） ---------------- */

  /** "v0.7.14" / "0.7.14 " / "release-0.7.14" → "0.7.14" */
  function normVer(s) {
    if (s == null) return '';
    var m = String(s).match(/\d+(?:\.\d+)*/);
    return m ? m[0] : '';
  }

  /** 逐段比数字：a<b → -1，相等 → 0，a>b → 1。缺段按 0 算（0.7 == 0.7.0） */
  function verCmp(a, b) {
    var pa = normVer(a).split('.'), pb = normVer(b).split('.');
    if (!normVer(a) || !normVer(b)) return 0;
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var va = parseInt(pa[i] || '0', 10) || 0;
      var vb = parseInt(pb[i] || '0', 10) || 0;
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  }

  /** 从 release 的 assets 里挑 APK：优先 .apk，多个就取大的 */
  function pickApk(assets) {
    if (!assets || !assets.length) return null;
    var best = null;
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      if (!a || !a.name) continue;
      if (!/\.apk$/i.test(a.name)) continue;
      if (!best || (a.size || 0) > (best.size || 0)) best = a;
    }
    if (!best) return null;
    return { name: best.name, url: best.browser_download_url || '', size: best.size || 0,
             digest: best.digest || '' };   /* GitHub 给的 sha256:…，用来验下载到的包 */
  }

  /** GitHub release JSON 文本 → {ver, url, size, name} / {error} */
  function parseRelease(text) {
    var o;
    try { o = JSON.parse(text || '{}'); } catch (e) { return { error: 'release 数据不是 JSON' }; }
    if (!o || typeof o !== 'object') return { error: 'release 数据为空' };
    if (o.message) return { error: String(o.message) };      /* 404 → "Not Found"，403 → rate limit */
    var ver = normVer(o.tag_name || o.name);
    if (!ver) return { error: '这个 release 没有版本号' };
    var apk = pickApk(o.assets);
    if (!apk || !apk.url) return { ver: ver, error: '这个 release 没挂 APK' };
    if (apk.size > MAX_APK) return { ver: ver, error: 'APK 太大（' + mb(apk.size) + '）' };
    return { ver: ver, url: apk.url, size: apk.size, name: apk.name, digest: apk.digest || '' };
  }

  function mb(n) {
    if (!n) return '未知大小';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
  }

  /* ---------------- 状态机 ---------------- */

  function repaint() {
    if (window.__hcUpdRepaint) window.__hcUpdRepaint();
  }

  function setPhase(phase, msg) {
    U.phase = phase;
    U.msg = msg || '';
    repaint();
  }

  function check() {
    if (U.phase === 'checking' || U.phase === 'downloading') return;
    if (!hasBridge()) { setPhase('error', '浏览器预览里没有升级通道，装到平板上再试'); return; }
    U.ver = ''; U.url = ''; U.size = 0; U.path = ''; U.pct = 0; U.digest = ''; U.retryMirror = false;
    setPhase('checking', '正在检查…');
    var id = 'chk' + (++seq);
    pending[id] = 'check';
    var cfg = readChannel();
    try {
      bridge().updNet(id, applyChannel(cfg, apiUrl()), '{"Accept":"application/vnd.github+json"}', proxyJson(cfg));
    } catch (e) {
      delete pending[id];
      setPhase('error', '调用升级通道失败：' + e);
    }
  }

  function onNet(id, out) {
    if (pending[id] !== 'check') return;
    delete pending[id];
    var o;
    try { o = JSON.parse(out || '{}'); } catch (e) { setPhase('error', '通道返回的不是 JSON'); return; }
    if (o.error) { setPhase('error', '连不上 GitHub（' + o.error + '）'); return; }
    if (o.status === 404) { setPhase('error', '仓库还没有发布任何版本'); return; }
    if (o.status === 403) { setPhase('error', 'GitHub 限流了，过一会儿再试'); return; }
    if (o.status && (o.status < 200 || o.status >= 300)) { setPhase('error', 'GitHub 返回 HTTP ' + o.status); return; }
    var r = parseRelease(o.body);
    if (r.error) { setPhase('error', r.error); return; }
    U.ver = r.ver; U.url = r.url; U.size = r.size; U.file = r.name; U.digest = r.digest || '';
    var cur = normVer(curVer());
    if (cur && verCmp(r.ver, cur) <= 0) { setPhase('latest', '已是最新（本地 v' + cur + '，GitHub 上 v' + r.ver + '）'); return; }
    setPhase('found', '发现新版本 v' + r.ver + '（' + mb(r.size) + '）');
  }

  function download() {
    if (U.phase === 'checking' || U.phase === 'downloading') return;
    if (!U.url) { check(); return; }
    if (!hasBridge()) { setPhase('error', '浏览器预览里没有升级通道'); return; }
    U.pct = 0;
    setPhase('downloading', '正在下载… 0%');
    var id = 'dl' + (++seq);
    pending[id] = 'download';
    var dcfg = readChannel();
    try {
      /* 下载 URL 也要按通道改写：镜像加前缀，代理交给 Java 侧。原来这里传的是原样 U.url，
         选了镜像/代理下载仍然直连 github.com，国内网络必然超时。 */
      bridge().updDownload(id, applyChannel(dcfg, U.url), U.file || 'update.apk', proxyJson(dcfg));
    } catch (e) {
      delete pending[id];
      setPhase('error', '下载没能开始：' + e);
    }
  }

  function onProg(id, pct) {
    if (pending[id] !== 'download') return;
    var p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (p === U.pct) return;
    U.pct = p;
    setPhase('downloading', '正在下载… ' + p + '%');
  }

  function onDone(id, out) {
    var kind = pending[id];
    if (!kind) return;
    delete pending[id];
    var o;
    try { o = JSON.parse(out || '{}'); } catch (e) { setPhase('error', '通道返回的不是 JSON'); return; }
    if (kind === 'download') {
      if (o.error) {
        var cfgNow = readChannel();
        var timedOut = /timeout|timed out|SocketTimeout/i.test(String(o.error));
        U.retryMirror = !!(timedOut && cfgNow.channel === 'direct');
        setPhase('error', '下载失败：' + o.error + (U.retryMirror
          ? '。直连 GitHub 下不动这台设备上的安装包（国内常见），点下面的按钮换 gh-proxy.com 重试'
          : ''));
        return;
      }
      U.path = o.path || '';
      U.pct = 100;
      if (!U.path) { setPhase('error', '下载完了但没拿到文件路径'); return; }
      verify(U.path, o.bytes || 0);
      return;
    }
    if (kind === 'install') {
      U.needPerm = false;
      if (o.error === 'need_permission') {
        /* Android 8+ 要先在系统里允许本应用「安装未知应用」。给两个按钮：
           去授权（跳系统页），回来点「继续安装」——不用重新检查/重新下载。 */
        U.needPerm = true;
        setPhase('error', '要在系统里允许这台设备安装应用：点「去授权」，回来后点「继续安装」');
        return;
      }
      if (o.error) { setPhase('error', '装不起来：' + o.error); return; }
      setPhase('installing', '安装器已打开，按屏幕提示完成安装');
    }
  }

  /** 装之前先确认：字节数、sha256、versionCode 三关都过。
   *  任一条不成立就会出现「装完还是旧版本」——与其让用户猜，不如直接说清哪一步不对。 */
  function verify(path, bytes) {
    var b = bridge();
    var cur = 0;
    try { cur = parseInt((JSON.parse((b && b.info && b.info()) || '{}').verCode) || 0, 10) || 0; } catch (e) { }
    var info = null;
    try { info = (b && b.updApkInfo) ? JSON.parse(b.updApkInfo(path) || '{}') : null; } catch (e) { info = null; }
    if (info && info.error) { setPhase('error', '读不出下载到的 APK（' + info.error + '）'); return; }
    if (U.size && bytes && Math.abs(bytes - U.size) > 1024) {
      setPhase('error', '下载到 ' + mb(bytes) + '，GitHub 上是 ' + mb(U.size) + '（包不完整或被换过），请重新下载');
      return;
    }
    var got = '';
    try { got = (b && b.updSha256) ? String(b.updSha256(path) || '') : ''; } catch (e) { got = ''; }
    var want = String(U.digest || '').toLowerCase().replace(/^sha256:/, '');
    if (want && got && want !== got.toLowerCase()) {
      setPhase('error', '下载到的包和 GitHub 上的不一致（sha256 ' + got.slice(0, 8) + '… ≠ ' + want.slice(0, 8) + '…），多半是缓存/镜像给错了，重新下载一次');
      return;
    }
    if (info && info.code && cur && info.code <= cur) {
      setPhase('error', '下载到的不是新版本：包是 v' + (info.ver || '?') + '（code ' + info.code + '），当前已经是 code ' + cur);
      return;
    }
    var tag = (info && info.ver) ? info.ver : U.ver;
    setPhase('ready', '下载完成 v' + tag + '（' + mb(bytes || U.size) + (want && got ? '，sha256 一致' : '') + '），点下面的按钮安装');
  }

  function install() {
    if (!U.path) { setPhase('error', '还没有下载好的安装包'); return; }
    if (!hasBridge()) { setPhase('error', '浏览器预览里没有升级通道'); return; }
    U.needPerm = false;
    setPhase('installing', '正在打开安装器…');
    var id = 'ins' + (++seq);
    pending[id] = 'install';
    try {
      bridge().updInstall(id, U.path);
    } catch (e) {
      delete pending[id];
      setPhase('error', '打不开安装器：' + e);
    }
  }

  function openPerm() {
    try { if (bridge() && bridge().updPerm) bridge().updPerm(); } catch (e) { }
    setPhase('error', '在系统里允许「安装未知应用」后，回来点「继续安装」');
  }

  function reset() {
    U.phase = 'idle'; U.ver = ''; U.url = ''; U.size = 0; U.file = '';
    U.path = ''; U.pct = 0; U.msg = ''; U.needPerm = false; U.retryMirror = false;
    repaint();
  }

  /* ---------------- 渲染 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function state() { return U; }

  function barHtml() {
    var w = Math.max(0, Math.min(100, U.pct));
    return '<div class="upd-bar"><i style="width:' + w + '%"></i></div>';
  }

  function sectionHtml() {
    var cur = curVer();
    /* 外面这层 #updSec 是给 app.js 的原地重绘用的：状态变了只换这一块，不重建整页设置（滚动位置不会跳） */
    var html = '<div class="upd-sec" id="updSec">' +
      '<div class="set-sec">升级</div>' +
      '<div class="set-row"><div class="set-k">当前版本</div><div class="set-v">' +
      '<b>' + esc(cur ? 'v' + cur : '（浏览器预览）') + '</b></div></div>';

    if (U.phase === 'idle') {
      html += '<div class="upd-note">从 GitHub 的 Release 取最新版，直接在这台平板上装。' +
        '设备要能连上 GitHub（国内网络可能需要给它一条出海通道）。</div>';
    } else if (U.phase === 'checking') {
      html += '<div class="upd-note">正在检查 GitHub 上的最新版本…</div>';
    } else if (U.phase === 'downloading') {
      html += '<div class="upd-note">' + esc(U.msg) + '</div>' + barHtml();
    } else if (U.phase === 'error') {
      html += '<div class="upd-note bad">' + esc(U.msg) + '</div>';
    } else {
      html += '<div class="upd-note' + (U.phase === 'latest' ? ' good' : '') + '">' + esc(U.msg) + '</div>';
    }

    /* 下载通道选择：GitHub 直连慢/连不上时换国内镜像（前缀转发 API+下载）或本机局域网 HTTP 代理 */
    var cfg = readChannel();
    var isDirect = cfg.channel === 'direct';
    var opt = function (id, label, act, active) {
      return '<button class="btn' + (active ? ' primary' : '') + '" data-act="' + esc(act) + '">' + esc(label) + '</button>';
    };
    html += '<div class="set-sec">下载通道</div>' +
      '<div class="sheet-desc">直连慢或连不上 GitHub 时换国内镜像（转发 API 和下载）或局域网 HTTP 代理；当前：' + esc(channelLabel(cfg)) + '</div>' +
      '<div class="cfg-actions">' +
      opt('direct', '直连 GitHub', 'upd-ch:direct', isDirect) +
      opt('gh1', 'gh-proxy.com', 'upd-ch:mirror:https://gh-proxy.com/', cfg.channel === 'mirror' && cfg.mirror === 'https://gh-proxy.com/') +
      '</div>' +
      '<div class="cfg-row"><div class="cfg-k">自定义镜像</div><input class="cfg-in" id="updMirror" value="' +
      esc(cfg.channel === 'mirror' && !builtinLabel(cfg.mirror) ? cfg.mirror : '') + '" placeholder="https://my-mirror.com/"></div>' +
      '<div class="cfg-actions"><button class="btn" data-act="upd-ch-custom">用这个镜像</button></div>' +
      '<div class="cfg-row"><div class="cfg-k">代理主机</div><input class="cfg-in" id="updProxyHost" value="' +
      esc(cfg.channel === 'proxy' ? cfg.proxyHost : '') + '" placeholder="10.10.1.2"></div>' +
      '<div class="cfg-row"><div class="cfg-k">代理端口</div><input class="cfg-in" id="updProxyPort" value="' +
      esc(cfg.channel === 'proxy' ? String(cfg.proxyPort) : '') + '" placeholder="7890"></div>' +
      '<div class="cfg-actions">' +
      '<button class="btn' + (cfg.channel === 'proxy' ? ' primary' : '') + '" data-act="upd-ch-proxy">用国内代理</button>' +
      '</div>';

    html += '<div class="cfg-actions">';
    if (U.phase === 'found') {
      html += '<button class="btn primary" data-act="upd-download">下载并安装 v' + esc(U.ver) + '</button>';
    } else if (U.phase === 'ready') {
      html += '<button class="btn primary" data-act="upd-install">立即安装</button>';
    } else if (U.phase === 'downloading' || U.phase === 'installing') {
      html += '<button class="btn" data-act="upd-none">请稍候…</button>';
    } else if (U.phase === 'error' && U.needPerm) {
      html += '<button class="btn primary" data-act="upd-install">继续安装</button>' +
        '<button class="btn" data-act="upd-perm">去授权</button>' +
        '<button class="btn" data-act="upd-check">重新检查</button>';
    } else if (U.phase === 'error' && U.retryMirror) {
      html += '<button class="btn primary" data-act="upd-retry-mirror">换 gh-proxy.com 重试</button>' +
        '<button class="btn" data-act="upd-check">检查更新</button>';
    } else if (U.phase === 'error' && /允许这台设备安装应用/.test(U.msg)) {
      html += '<button class="btn primary" data-act="upd-perm">去授权</button>' +
        '<button class="btn" data-act="upd-check">重新检查</button>';
    } else {
      html += '<button class="btn" data-act="upd-check">检查更新</button>';
    }
    html += '</div>';
    return html + '</div>';
  }

  /* ---------------- 导出 ---------------- */

  window.__hcUpdNetCb = function (id, out) { onNet(id, out); };
  window.__hcUpdProg = function (id, pct) { onProg(id, pct); };
  window.__hcUpdDone = function (id, out) { onDone(id, out); };

  window.HCUpdate = {
    check: check,
    download: download,
    install: install,
    openPerm: openPerm,
    reset: reset,
    state: state,
    sectionHtml: sectionHtml,
    curVer: curVer,
    hasBridge: hasBridge,
    /* 纯函数，给单测和排查用 */
    apiUrl: apiUrl,
    normVer: normVer,
    verCmp: verCmp,
    pickApk: pickApk,
    parseRelease: parseRelease,
    mb: mb,
    /* 下载通道（update.json） */
    setChannel: setChannel,
    readChannel: readChannel,
    parseChannel: parseChannel,
    applyChannel: applyChannel,
    proxyJson: proxyJson,
    channelLabel: channelLabel,
    normalizePrefix: normalizePrefix
  };
})();
