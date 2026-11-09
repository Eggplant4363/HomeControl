// tools/patch-theme-mijia.js — 明亮皮肤照米家：绿色调底 + 半透明白卡 + 开着的图标是实心强调色圆钮
const fs = require('fs');
const f = 'D:/Document/Project/HomeControl/panel/css/app.css';
let s = fs.readFileSync(f, 'utf8');
const CRLF = s.indexOf('\r\n') >= 0;
const L = (t) => (CRLF ? t.replace(/\n/g, '\r\n') : t);
let hits = 0;
function rep(a, b) {
  const A = L(a), B = L(b);
  if (s.indexOf(A) < 0) throw new Error('MISS: ' + a.slice(0, 60));
  s = s.replace(A, B); hits++;
}

/* 1) 深色皮肤：卡片不透明 + 开着的图标字色走深底（实心圆钮上是深色字） */
rep('  --bg: #121212; --bg-rgb: 18,18,18; --bg-deep: #0e0e10; --bg-deep-rgb: 14,14,16;',
  '  --bg: #121212; --bg-rgb: 18,18,18; --bg-deep: #0e0e10; --bg-deep-rgb: 14,14,16;\n  --card-a: 1; --glyph-on: rgb(var(--bg-rgb));');

/* 2) 明亮皮肤整块换成米家绿调 */
rep(`html.hc-light {
  /* 明亮皮肤：中性色阶 = Tailwind zinc 阶（50/100/200/300/400…），
     文本层级按 Material 的 black/.87 / .54 / .38 思路，强调色走 tone 档（亮皮肤 tone 42）。 */
  --bg: #fafafa; --bg-rgb: 250,250,250; --bg-deep: #f4f4f5; --bg-deep-rgb: 244,244,245;
  --bg-2: #f4f4f5; --bg-3: #e4e4e7; --bg-4: #d4d4d8;
  --card-rgb: 255,255,255; --card-2-rgb: 250,250,251; --line-rgb: 228,228,231;
  --surf: 24,24,27;
  --text-hi: #09090b; --text-1: #18181b; --text-2: #3f3f46; --text-3: #52525b;
  --text-4: #71717a; --text-5: #a1a1aa;
  --accent-hex: #006cc7; --accent-rgb: 0,108,199;
  --accent-soft: #0059b0; --accent-soft-rgb: 0,89,176;
  --acc-ink: #ffffff;
  --acc-c: 208,238,255; --acc-line: 124,155,204;
  --wash-a: .10; --wash-border-a: .50; --wash-glow-a: .05; --wash-icon-a: .12;
  --badge-a: .16; --badge-border-a: .35;
  --ok: #7b5e40; --ok-rgb: 123,94,64; --ok-soft: #7b5e40; --ok-tint-rgb: 250,232,214;
  --warn: #b5441a; --warn-rgb: 181,68,26; --warn-soft: #b5441a;
  --err: #cc2935; --err-rgb: 204,41,53; --err-soft: #cc2935;
  --lyric-rgb: 24,24,27;
  --accent: 0,108,199; --track: #d4d4d8; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.05), 0 1px 2px 0 rgba(0,0,0,.12);
}`,
`html.hc-light {
  /* 明亮皮肤：照米家（Mi Home）的明亮模式——页面底是淡绿调，卡片是半透明白，
     开着的控件是实心强调色圆钮（白字），亮度条走暖黄。
     色阶取自米家截图：底 #eef3ea / 卡白 .82 / 文本墨灰 #2b3129~#7d8578 /
     强调绿 #2e9e6b（米家的开=绿），暖黄 #e08a1e 走亮度条。 */
  --bg: #eef3ea; --bg-rgb: 238,243,234; --bg-deep: #e7ede5; --bg-deep-rgb: 231,237,229;
  --bg-2: #f3f7f0; --bg-3: #dde5d9; --bg-4: #c9d6c2;
  --card-rgb: 255,255,255; --card-2-rgb: 248,251,246; --card-a: .82; --line-rgb: 206,218,204;
  --glyph-on: #ffffff;
  --surf: 24,24,27;
  --text-hi: #212820; --text-1: #2b3129; --text-2: #4c5347; --text-3: #6b7266;
  --text-4: #7d8578; --text-5: #9aa294;
  --accent-hex: #2e9e6b; --accent-rgb: 46,158,107;
  --accent-soft: #27895c; --accent-soft-rgb: 39,137,92;
  --acc-ink: #ffffff;
  --acc-c: 214,238,226; --acc-line: 150,190,168;
  --wash-a: .10; --wash-border-a: .50; --wash-glow-a: .05; --wash-icon-a: .12;
  --badge-a: .16; --badge-border-a: .35;
  --ok: #276b47; --ok-rgb: 39,107,71; --ok-soft: #276b47; --ok-tint-rgb: 224,242,232;
  --warn: #b5441a; --warn-rgb: 181,68,26; --warn-soft: #b5441a;
  --err: #cc2935; --err-rgb: 204,41,53; --err-soft: #cc2935;
  --lyric-rgb: 24,24,27;
  --accent: 46,158,107; --track: #dce5db; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.05), 0 1px 2px 0 rgba(0,0,0,.10);
}`);

/* 3) 卡片背景走 --card-a（明亮半透明、深色不透明） */
rep('  background: rgba(var(--card-rgb),1);\n  border: 1px solid rgba(var(--line-rgb),.5);',
  '  background: rgba(var(--card-rgb), var(--card-a));\n  border: 1px solid rgba(var(--line-rgb),.5);');

/* 4) 图标底座改成圆（米家的开关就是圆钮） */
rep('.t-icon {\n  width: 38px; height: 38px; border-radius: 12px;',
  '.t-icon {\n  width: 38px; height: 38px; border-radius: 50%;');

/* 5) 开着的图标 = 实心强调色圆钮（米家的开=绿色圆钮，白字） */
rep('/* 开着的卡片：只有图标变强调色（tone 档实体色，对卡片底 ≥4.5:1） */\n.tile.on .t-icon { color: rgb(var(--accent)); }',
  '/* 开着的卡片：只有图标变成实心强调色圆钮（照米家），卡片底保持平面 */\n.tile.on .t-icon { background: rgb(var(--accent)); color: var(--glyph-on); }');

fs.writeFileSync(f, s);
console.log('mijia light skin ok, ' + hits + ' patches');
