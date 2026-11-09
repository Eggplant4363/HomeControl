// tools/patch-version-42.js — 版本升到 0.7.5 / versionCode 42
const fs = require('fs');
const ps1 = 'D:/Document/Project/HomeControl/tools/build.ps1';
let a = fs.readFileSync(ps1, 'utf8');
a = a.replace('--version-code 41', '--version-code 42');
a = a.replace(/--version-name "0\.7\.4"/, '--version-name "0.7.5"');
fs.writeFileSync(ps1, a);

const md = 'D:/Document/Project/HomeControl/README.md';
let m = fs.readFileSync(md, 'utf8');
if (!/versionName 0\.7\.4` \/ `versionCode 41/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.4` \/ `versionCode 41/, 'versionName 0.7.5` / `versionCode 42');
fs.writeFileSync(md, m);
console.log('version 0.7.5 / 42 ok');
