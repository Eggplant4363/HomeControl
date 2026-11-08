/* 生成 build/music.json：密码从本地记忆文件取，不要在命令行里手打（手打会被打码成 ***） */
const fs = require('fs');
const mem = 'C:/Users/orris/.dsh/memory/--D-Document-Project-HomeControl--/homecontrol-real-service-credentials.md';
const t = fs.readFileSync(mem, 'utf8');
const m = t.match(/"pass":"([^"]+)"/);
if (!m) { console.log('pass not found in memory'); process.exit(1); }
const cfg = { kind: 'daoliyu', baseUrl: 'https://daoliyu.cchong.cc', user: 'orrismi@163.com', pass: m[1] };
fs.writeFileSync('build/music.json', JSON.stringify(cfg), 'utf8');
console.log('passLen=' + m[1].length + ' bytes=' + fs.statSync('build/music.json').size);
