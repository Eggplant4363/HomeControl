// tools/patch-theme-mijia-ctl.js — 控件颜色照米家：开=绿色圆钮，亮度条=暖黄，关=灰（不再跟实体强调色）
const fs = require('fs');
const f = 'D:/Document/Project/HomeControl/panel/css/app.css';
let s = fs.readFileSync(f, 'utf8');
const CRLF = s.indexOf('\r\n') >= 0;
const L = (t) => (CRLF ? t.replace(/\n/g, '\r\n') : t);
function rep(a, b) {
  const A = L(a), B = L(b);
  if (s.indexOf(A) < 0) throw new Error('MISS: ' + a.slice(0, 60));
  s = s.replace(A, B);
}

/* 深色皮肤：开=绿圆钮（米家夜间的绿），条=暖黄，钮=白 */
rep('  --card-a: 1; --glyph-on: rgb(var(--bg-rgb));',
  '  --card-a: 1; --glyph-on: rgb(var(--bg-rgb));\n  --ctl-on: 63,208,138; --ctl-bar: 255,183,90;');

/* 明亮皮肤：开=深绿圆钮（白字 ≥5:1），条=米家暖黄 */
rep('  --card-rgb: 255,255,255; --card-2-rgb: 248,251,246; --card-a: .82; --line-rgb: 206,218,204;\n  --glyph-on: #ffffff;',
  '  --card-rgb: 255,255,255; --card-2-rgb: 248,251,246; --card-a: .82; --line-rgb: 206,218,204;\n  --glyph-on: #ffffff;\n  --ctl-on: 34,142,95; --ctl-bar: 246,166,66;');

/* 开着的图标 = 统一绿色圆钮 */
rep('.tile.on .t-icon { background: rgb(var(--accent)); color: var(--glyph-on); }',
  '.tile.on .t-icon { background: rgb(var(--ctl-on)); color: var(--glyph-on); }');

/* 亮度条 = 统一暖黄 */
rep('  background: rgb(var(--bar-fill));',
  '  background: rgb(var(--ctl-bar));');

/* 拖动钮两皮肤都用白（米家），边框走皮肤变量 */
rep('  --accent: 46,158,107; --track: #dce5db; --knob: #ffffff; --bar-fill: 246,166,66;\n  --knob-border: rgba(24,24,27,.16);',
  '  --accent: 46,158,107; --track: #dce5db; --knob: #ffffff; --bar-fill: 246,166,66;\n  --knob-border: rgba(24,24,27,.16);');
rep('  --accent: 118,202,255; --track: #2b2b30; --knob: rgb(var(--accent)); --bar-fill: var(--accent);\n  --knob-border: rgba(var(--card-rgb),.92);',
  '  --accent: 118,202,255; --track: #2b2b30; --knob: #ffffff; --bar-fill: var(--ctl-bar);\n  --knob-border: rgba(255,255,255,.28);');

fs.writeFileSync(f, s);
console.log('mijia control colors ok');
