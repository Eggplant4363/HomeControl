// tools/patch-theme-mijia-bar.js — 明亮皮肤的亮度条改成米家的暖黄 + 白色拖动钮
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

rep('  --accent: 46,158,107; --track: #dce5db; --knob: rgb(var(--accent));',
  '  --accent: 46,158,107; --track: #dce5db; --knob: #ffffff; --bar-fill: 246,166,66;\n  --knob-border: rgba(24,24,27,.16);');

rep('  --accent: 118,202,255; --track: #2b2b30; --knob: rgb(var(--accent));',
  '  --accent: 118,202,255; --track: #2b2b30; --knob: rgb(var(--accent)); --bar-fill: var(--accent);\n  --knob-border: rgba(var(--card-rgb),.92);');

rep('  border-radius: inherit; border-top-right-radius: 0; border-bottom-right-radius: 0;\n  background: rgb(var(--accent));',
  '  border-radius: inherit; border-top-right-radius: 0; border-bottom-right-radius: 0;\n  background: rgb(var(--bar-fill));');

rep('  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38); border: 2px solid rgba(var(--card-rgb),.92);',
  '  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38); border: 2px solid var(--knob-border);');

fs.writeFileSync(f, s);
console.log('mijia bar ok');
