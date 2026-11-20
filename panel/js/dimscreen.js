/* 空闲调暗（待机）页：大时钟 + 日期，有音乐在放时下面补一条「正在播放」。
 *
 * 渲染只读两处公开面：MusicUI 的 playing()/isPlaying()，以及音乐页自己已经在更新的
 * 进度节点（#mFill / #mPos / #mDur）——不碰 music.js 的内部状态，也不改它的播放逻辑。
 * 所有元素按 id 取，缺哪个就安静跳过（单元测试的 DOM stub 里也能跑）。
 *
 * 「轻触屏幕唤醒」那行文案已按用户要求整段删除：整个待机页点哪里都能醒。
 */
(function () {
  'use strict';

  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var timer = null;
  var coverSrc = '';
  var phDone = false;

  function $(id) { return document.getElementById(id); }

  /* 日期副行：11月18日 · 周二 */
  function dateText(d) {
    d = d || new Date();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + WD[d.getDay()];
  }

  function paintDate() {
    var e = $('dimDate');
    if (!e) return;
    var t = dateText();
    if (e.textContent !== t) e.textContent = t;
  }

  /* 封面占位：ICONS 里有音符就画 SVG，没有就退成一个文字音符 */
  function paintPlaceholder() {
    if (phDone) return;
    var e = $('dimCoverPh');
    if (!e) return;
    phDone = true;
    var I = window.ICONS || {};
    var d = I.music;
    if (!d) { e.textContent = '♪'; return; }
    e.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  /* 封面：src 变了才重新赋值，避免每秒一次 setAttribute 触发重新解码 */
  function paintCover(src) {
    var box = $('dimCover');
    var img = $('dimCoverImg');
    if (!box || !img) return;
    src = src ? String(src) : '';
    if (src === coverSrc) return;
    coverSrc = src;
    if (!src) {
      box.className = 'dim-cover';
      return;
    }
    img.onload = function () { box.className = 'dim-cover has'; };
    img.onerror = function () { box.className = 'dim-cover'; };
    img.src = src;
  }

  /* 进度：直接镜像音乐页那两个节点，省得自己去碰 <audio>（music.js 没对外暴露 position） */
  function mirrorProgress() {
    var bar = $('dimBar');
    var fill = $('mFill');
    if (bar && fill) {
      var w = (fill.style && fill.style.width) ? fill.style.width : '0%';
      if (bar.style && bar.style.width !== w) bar.style.width = w;
    }
    var pos = $('mPos');
    var dur = $('mDur');
    var ep = $('dimPos');
    var ed = $('dimDur');
    if (ep && pos) {
      var p = pos.textContent || '';
      if (ep.textContent !== p) ep.textContent = p;
    }
    if (ed && dur) {
      var d = dur.textContent || '';
      if (ed.textContent !== d) ed.textContent = d;
    }
  }

  function musicPlaying() {
    var mu = window.MusicUI;
    if (!mu) return false;
    try { return !!(mu.isPlaying && mu.isPlaying()); } catch (e) { return false; }
  }

  function currentTrack() {
    var mu = window.MusicUI;
    if (!mu || !musicPlaying()) return null;
    try { return mu.playing ? mu.playing() : null; } catch (e) { return null; }
  }

  /* 有没有「正在播放」这一条：同时切换 #dimNow 的 on 和 #dim 的 with-music。
   * 待机页默认把时间放在整屏正中（屏上只有时间），一旦底部来了「正在播放」，
   * with-music 把时间抬到上方让出位置——抬多高由 CSS 决定，JS 只管这个状态。 */
  function setNowPlaying(on) {
    var box = $('dimNow');
    if (box) {
      var cls = on ? 'dim-now on' : 'dim-now';
      if (box.className !== cls) box.className = cls;
    }
    var dim = $('dim');
    if (dim) {
      var has = (' ' + dim.className + ' ').indexOf(' with-music ') >= 0;
      if (on && !has) dim.className = dim.className ? dim.className + ' with-music' : 'with-music';
      if (!on && has) dim.className = (' ' + dim.className + ' ').replace(/ with-music /g, ' ').replace(/^\s+|\s+$/g, '');
    }
  }

  function paintMusic() {
    var box = $('dimNow');
    if (!box) return;
    var t = currentTrack();
    if (!t || (!t.title && !t.artist)) {
      setNowPlaying(false);
      return;
    }
    setNowPlaying(true);
    var ti = $('dimTitle');
    var ar = $('dimArtist');
    var title = String(t.title || '未知曲目');
    var artist = String(t.artist || t.album || '');
    if (ti && ti.textContent !== title) ti.textContent = title;
    if (ar && ar.textContent !== artist) ar.textContent = artist;
    paintCover(t.cover);
    mirrorProgress();
  }

  /* 歌词：时间与底部「正在播放」之间那块。只读 MusicUI.lyrics() / lyricLine()，
   * 当前行加下一行（上一行也有就给），文字没变就不动 DOM。 */
  function paintLyric() {
    var box = $('dimLyric');
    if (!box) return;
    var mu = window.MusicUI;
    var L = mu && mu.lyrics ? mu.lyrics() : null;
    var lines = L && L.lines ? L.lines : null;
    if (!lines || !lines.length || !musicPlaying()) {
      if (box.className !== 'dim-lyric') box.className = 'dim-lyric';
      return;
    }
    var idx = mu.lyricLine ? mu.lyricLine() : -1;
    if (idx < 0) idx = 0;
    if (idx >= lines.length) idx = lines.length - 1;
    var cur = $('dimLrNow');
    var prev = $('dimLrPrev');
    var next = $('dimLrNext');
    if (cur && cur.textContent !== lines[idx].text) cur.textContent = lines[idx].text;
    var ptxt = idx > 0 ? lines[idx - 1].text : '';
    var ntxt = idx + 1 < lines.length ? lines[idx + 1].text : '';
    if (prev && prev.textContent !== ptxt) prev.textContent = ptxt;
    if (next && next.textContent !== ntxt) next.textContent = ntxt;
    if (box.className !== 'dim-lyric on') box.className = 'dim-lyric on';
  }

  function paint() {
    paintDate();
    paintPlaceholder();
    paintMusic();
    paintLyric();
    /* 天气（panel/js/weather.js）：没数据时它会自己去取一次，回来再画 */
    if (window.HCWeather) window.HCWeather.paint();
  }

  function show() {
    paint();
    if (timer !== null) return;
    timer = setInterval(function () {
      paintDate();
      paintMusic();
      paintLyric();
    }, 1000);
  }

  function hide() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    setNowPlaying(false);
    var lb = $('dimLyric');
    if (lb) lb.className = 'dim-lyric';
  }

  window.DimScreen = {
    show: show,
    hide: hide,
    paint: paint,
    dateText: dateText,
    isOn: function () { return timer !== null; }
  };
})();
