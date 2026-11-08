// tools/patch-theme-ha.js — 按 Home Assistant 的主题 token 方式重做两套皮肤
// HA dark: bg #181818 / card #282828 / text #e0e0e0 / #a0a0a0 / divider #444 / accent #0d7ec0
// HA light: bg #fafafa / card #ffffff / text #000000 / #525252 / divider #e0e0e0 / accent #03a9f4
// 卡片改成 HA 那种「纯色卡 + 阴影」，去掉水洗渐变与光晕；滑条轨道/钮走 --track/--knob。
const fs = require('fs');
const p = 'D:/Document/Project/HomeControl/panel/css/app.css';
let s = fs.readFileSync(p, 'utf8');
const hadCRLF = s.indexOf('\r\n') >= 0;
if (hadCRLF) s = s.replace(/\r\n/g, '\n');

function block(start, newText) {
  const i = s.indexOf(start);
  if (i < 0) throw new Error('missing ' + start);
  const j = s.indexOf('}', i);
  if (j < 0) throw new Error('no close for ' + start);
  s = s.slice(0, i) + newText + s.slice(j + 1);
}

function rep(old, nw) {
  if (s.indexOf(old) < 0) throw new Error('missing: ' + old.slice(0, 60));
  s = s.replace(old, nw);
}

block(':root {\n', `:root {
  /* 深色皮肤（HA dark 取值） */
  --bg: #181818; --bg-rgb: 24,24,24; --bg-deep: #111111; --bg-deep-rgb: 17,17,17;
  --bg-2: #212121; --bg-3: #2b2b2b; --bg-4: #333333;
  --card-rgb: 40,40,40; --card-2-rgb: 44,44,44; --line-rgb: 68,68,68;
  --surf: 255,255,255;
  --text-hi: #ffffff; --text-1: #e0e0e0; --text-2: #c9c9c9; --text-3: #a0a0a0;
  --text-4: #808080; --text-5: #6f6f6f;
  --accent-hex: #0d7ec0; --accent-rgb: 13,126,192; --accent-soft: #5fbde6; --accent-soft-rgb: 95,189,230;
  --wash-a: .14; --wash-border-a: .55; --wash-glow-a: .08; --wash-icon-a: .16;
  --badge-a: .22; --badge-border-a: .40;
  --ok: #4caf50; --ok-rgb: 76,175,80; --ok-soft: #81c784; --ok-tint-rgb: 30,58,32;
  --warn: #ffa726; --warn-rgb: 255,167,38; --warn-soft: #ffcc80;
  --err: #ef5350; --err-rgb: 239,83,80; --err-soft: #ff8a80;
  --lyric-rgb: 224,224,224;
  --track: #3a3a3a; --knob: #ffffff;
  --shadow: 0 2px 2px 0 rgba(0,0,0,.2), 0 1px 2px 0 rgba(0,0,0,.3);
}
`);

block('html.hc-light {\n', `html.hc-light {
  /* 明亮皮肤（HA light 取值） */
  --bg: #fafafa; --bg-rgb: 250,250,250; --bg-deep: #f2f2f2; --bg-deep-rgb: 242,242,242;
  --bg-2: #efefef; --bg-3: #e6e6e6; --bg-4: #dedede;
  --card-rgb: 255,255,255; --card-2-rgb: 252,252,252; --line-rgb: 224,224,224;
  --surf: 26,26,26;
  --text-hi: #000000; --text-1: #1a1a1a; --text-2: #3f3f3f; --text-3: #595959;
  --text-4: #757575; --text-5: #8a8a8a;
  --accent-hex: #03a9f4; --accent-rgb: 3,169,244; --accent-soft: #0277b6; --accent-soft-rgb: 2,119,182;
  --wash-a: .10; --wash-border-a: .50; --wash-glow-a: .05; --wash-icon-a: .12;
  --badge-a: .16; --badge-border-a: .35;
  --ok: #2e7d32; --ok-rgb: 46,125,50; --ok-soft: #2e7d32; --ok-tint-rgb: 207,233,210;
  --warn: #b26a00; --warn-rgb: 178,106,0; --warn-soft: #9a5b00;
  --err: #c62828; --err-rgb: 198,40,40; --err-soft: #a92a2a;
  --lyric-rgb: 26,26,26;
  --track: #dedede; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.05), 0 1px 2px 0 rgba(0,0,0,.12);
}
`);

rep(`  background: linear-gradient(158deg, rgba(var(--card-2-rgb),.96), rgba(var(--card-rgb),.96));
  border: 1px solid rgba(var(--surf),.055);`,
    `  background: rgba(var(--card-rgb),1);
  border: 1px solid rgba(var(--line-rgb),.5);
  box-shadow: var(--shadow);`);

rep(`.tile.on {
  background: linear-gradient(158deg, rgba(var(--accent), var(--wash-a)), rgba(var(--card-rgb),.97) 68%);
  border-color: rgba(var(--accent), var(--wash-border-a));
}`,
    `.tile.on {
  background: rgba(var(--card-rgb),1);
  border-color: rgba(var(--accent), var(--wash-border-a));
}`);

rep(`  background: rgba(var(--surf),.085);
  box-shadow: inset 0 1px 2px rgba(0,0,0,.28);`,
    `  background: var(--track);
  box-shadow: inset 0 1px 2px rgba(0,0,0,.18);`);

rep(`  background: var(--text-2); box-shadow: 0 2px 7px rgba(0,0,0,.38);`,
    `  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38);`);

rep(`  background: var(--text-hi); box-shadow: 0 3px 10px rgba(0,0,0,.45);`,
    `  background: var(--knob); box-shadow: 0 3px 10px rgba(0,0,0,.45);`);

fs.writeFileSync(p, hadCRLF ? s.replace(/\n/g, '\r\n') : s);
console.log('patched ok');
