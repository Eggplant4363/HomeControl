// tools/patch-version-44.js — 版本升到 0.7.7 / versionCode 44（关掉 WebView force-dark）
const fs = require('fs');
const ps1 = 'D:/Document/Project/HomeControl/tools/build.ps1';
let a = fs.readFileSync(ps1, 'utf8');
a = a.replace('--version-code 43', '--version-code 44');
a = a.replace(/--version-name "0\.7\.6"/, '--version-name "0.7.7"');
fs.writeFileSync(ps1, a);

const md = 'D:/Document/Project/HomeControl/README.md';
let m = fs.readFileSync(md, 'utf8');
if (!/versionName 0\.7\.6` \/ `versionCode 43/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.6` \/ `versionCode 43/, 'versionName 0.7.7` / `versionCode 44');
fs.writeFileSync(md, m);
console.log('version 0.7.7 / 44 ok');
