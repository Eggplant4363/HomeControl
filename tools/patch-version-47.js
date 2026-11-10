// tools/patch-version-47.js — 版本升到 0.7.10 / versionCode 47（音乐进度条可拖动）
const fs = require('fs');
let a = fs.readFileSync('tools/build.ps1', 'utf8');
if (/--version-code 47/.test(a)) { console.log('already 47'); process.exit(0); }
a = a.replace('--version-code 46', '--version-code 47');
a = a.replace(/--version-name "0\.7\.9"/, '--version-name "0.7.10"');
fs.writeFileSync('tools/build.ps1', a);

let m = fs.readFileSync('README.md', 'utf8');
if (!/versionName 0\.7\.9` \/ `versionCode 46/.test(m)) throw new Error('README version line not found');
m = m.replace(/versionName 0\.7\.9` \/ `versionCode 46/, 'versionName 0.7.10` / `versionCode 47');
m = m.replace(/版本 0\.7\.9 · MI PAD 2/, '版本 0.7.10 · MI PAD 2');
fs.writeFileSync('README.md', m);
console.log('version -> 0.7.10 / 47');
