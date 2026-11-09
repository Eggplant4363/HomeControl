// tools/patch-version-41.js — 版本升到 0.7.4 / versionCode 41
const fs = require('fs');
const ps1 = 'D:/Document/Project/HomeControl/tools/build.ps1';
let a = fs.readFileSync(ps1, 'utf8');
a = a.replace('--version-code 40', '--version-code 41');
a = a.replace(/--version-name "0\.7\.3"/, '--version-name "0.7.4"');
fs.writeFileSync(ps1, a);

const md = 'D:/Document/Project/HomeControl/README.md';
let m = fs.readFileSync(md, 'utf8');
if (!/versionName 0\.7\.3` \/ `versionCode 40/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.3` \/ `versionCode 40/, 'versionName 0.7.4` / `versionCode 41');
fs.writeFileSync(md, m);
console.log('version 0.7.4 / 41 ok');
