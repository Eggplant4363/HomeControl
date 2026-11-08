// tools/patch-version-39.js — 版本升到 0.7.2 / 39，README 同步
const fs = require('fs');
const ps1 = 'D:/Document/Project/HomeControl/tools/build.ps1';
let a = fs.readFileSync(ps1, 'utf8');
a = a.replace('--version-code 38', '--version-code 39').replace('--version-name "0.7.1"', '--version-name "0.7.2"');
fs.writeFileSync(ps1, a);

const md = 'D:/Document/Project/HomeControl/README.md';
let m = fs.readFileSync(md, 'utf8');
if (!/versionName 0\.7\.1/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.1/, 'versionName 0.7.2').replace(/versionCode 38/, 'versionCode 39').replace(/版本 0\.7\.0/, '版本 0.7.2');
fs.writeFileSync(md, m);
console.log('version 0.7.2 / 39 ok');
