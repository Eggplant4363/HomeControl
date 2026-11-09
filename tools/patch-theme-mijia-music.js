// tools/patch-theme-mijia-music.js — 滑条圆钮去掉外框 + 音乐页按米家配色（绿=开、暖黄=条、白=钮）
const fs = require('fs');
const f = 'D:/Document/Project/HomeControl/panel/css/app.css';
let s = fs.readFileSync(f, 'utf8');
const CRLF = s.indexOf('\r\n') >= 0;
const L = (t) => (CRLF ? t.replace(/\n/g, '\r\n') : t);
let hits = 0;
function rep(a, b) {
  const A = L(a), B = L(b);
  if (s.indexOf(A) < 0) throw new Error('MISS: ' + a.slice(0, 70));
  s = s.replace(A, B); hits++;
}

/* 1) 设备亮度条的圆钮：去掉外框（米家的钮就是纯白圆点） */
rep('  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38); border: 2px solid var(--knob-border);',
  '  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38);');

/* 2) 音乐进度条：暖黄填充 + 纯白钮 */
rep('.m-bar .m-fill {\n  position: absolute; left: 0; top: 8px; bottom: 8px; width: 0; border-radius: 5px 0 0 5px;\n  background: linear-gradient(90deg, var(--accent-hex), var(--accent-soft));\n}',
  '.m-bar .m-fill {\n  position: absolute; left: 0; top: 8px; bottom: 8px; width: 0; border-radius: 5px 0 0 5px;\n  background: rgb(var(--bar-fill));\n}');
rep('.m-bar .m-knob {\n  position: absolute; top: 50%; left: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;\n  border-radius: 50%; background: var(--text-2); box-shadow: 0 2px 7px rgba(0,0,0,.42);\n}',
  '.m-bar .m-knob {\n  position: absolute; top: 50%; left: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;\n  border-radius: 50%; background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.35);\n}');

/* 3) 音量条同样走暖黄 + 白钮 */
rep('.m-vbar .m-fill { position: absolute; left: 0; top: 7px; bottom: 7px; width: 0; border-radius: 4px 0 0 4px; background: rgba(var(--line-rgb),.6); }',
  '.m-vbar .m-fill { position: absolute; left: 0; top: 7px; bottom: 7px; width: 0; border-radius: 4px 0 0 4px; background: rgb(var(--bar-fill)); }');
rep('.m-vbar .m-knob {\n  position: absolute; top: 50%; left: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px;\n  border-radius: 50%; background: var(--text-2); box-shadow: 0 2px 6px rgba(0,0,0,.4);\n}',
  '.m-vbar .m-knob {\n  position: absolute; top: 50%; left: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px;\n  border-radius: 50%; background: var(--knob); box-shadow: 0 2px 6px rgba(0,0,0,.32);\n}');

/* 4) 播放键：播放中 = 米家绿实心圆钮（白字），暂停 = 中性 */
rep('.m-play { width: 66px; height: 66px; background: rgba(var(--accent-rgb),.22); border-color: rgba(var(--accent-rgb),.5); color: var(--text-2); }',
  '.m-play { width: 66px; height: 66px; background: rgba(var(--surf),.07); border-color: rgba(var(--surf),.16); color: var(--text-2); }');
rep('.m-play.on { background: rgba(var(--accent-rgb),.34); border-color: rgba(var(--accent-soft-rgb),.68); }',
  '.m-play.on { background: rgb(var(--ctl-on)); border-color: rgb(var(--ctl-on)); color: var(--glyph-on); }');

/* 5) 模式/列表按钮激活态：绿色（米家的「开」就是绿） */
rep('.m-btn.on { background: rgba(var(--accent-rgb),.26); border-color: rgba(var(--accent-rgb),.55); color: var(--text-2); }',
  '.m-btn.on { background: rgba(var(--ctl-on),.20); border-color: rgba(var(--ctl-on),.5); color: rgb(var(--ctl-on)); }');

/* 6) 当前歌词、正在播放的行：绿色强调 */
rep('.m-lr.on { color: var(--accent-soft); font-weight: 600; font-size: 16px; }',
  '.m-lr.on { color: rgb(var(--ctl-on)); font-weight: 600; font-size: 16px; }');
rep('.m-song.on { background: rgba(var(--accent-rgb),.13); border-radius: 13px; border-bottom-color: transparent; }',
  '.m-song.on { background: rgba(var(--ctl-on),.12); border-radius: 13px; border-bottom-color: transparent; }');
rep('.m-song.on .m-song-ico { background: rgba(var(--accent-rgb),.24); color: var(--accent-soft); }',
  '.m-song.on .m-song-ico { background: rgba(var(--ctl-on),.22); color: rgb(var(--ctl-on)); }');

fs.writeFileSync(f, s);
console.log('mijia music palette ok, ' + hits + ' patches');
