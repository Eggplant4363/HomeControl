// tools/patch-version-45.js — 版本升到 0.7.8 / versionCode 45
const fs = require('fs');
const ps1 = 'D:/Document/Project/HomeControl/tools/build.ps1';
let a = fs.readFileSync(ps1, 'utf8');
a = a.replace('--version-code 44', '--version-code 45');
a = a.replace(/--version-name "0\.7\.7"/, '--version-name "0.7.8"');
fs.writeFileSync(ps1, a);

const md = 'D:/Document/Project/HomeControl/README.md';
let m = fs.readFileSync(md, 'utf8');
if (!/versionName 0\.7\.7` \/ `versionCode 44/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.7` \/ `versionCode 44/, 'versionName 0.7.8` / `versionCode 45');
fs.writeFileSync(md, m);
console.log('version 0.7.8 / 45 ok');
