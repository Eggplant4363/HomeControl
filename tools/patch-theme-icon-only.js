// tools/patch-theme-icon-only.js — 开着的卡片不铺背景，只让图标变强调色
const fs = require('fs');
const f = 'D:/Document/Project/HomeControl/panel/css/app.css';
let s = fs.readFileSync(f, 'utf8');
const cr = /\r\n/g;
const before = s;

s = s.replace('.tile.on {\r\n  background: rgb(var(--acc-c));\r\n  border-color: rgba(var(--acc-line), .75);\r\n}',
  '.tile.on {\r\n  /* 开着的卡片不铺背景（用户要求）：只有图标变强调色 */\r\n}');

s = s.replace('.tile.on .t-icon { background: rgba(var(--accent), .16); color: rgb(var(--accent)); }',
  '.tile.on .t-icon { color: rgb(var(--acc-ink)); }');

if (s === before) throw new Error('no match');
fs.writeFileSync(f, s);
console.log('icon-only skin ok');
