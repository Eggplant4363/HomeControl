/* 从记忆文件取道理鱼密码，写 build/music.json（build.ps1 每次清空 build/，所以打完包要重跑：node tools/mk-music.js） */
const fs = require('fs');
const mem = 'C:/Users/orris/.dsh/memory/--D-Document-Project-HomeControl--/homecontrol-real-service-credentials.md';
const text = fs.readFileSync(mem, 'utf8');
const pass = (text.match(/密码\s*`([^`]+)`/) || text.match(/pass(?:word)?\s*[:=]\s*"?([^"\s`]+)/i) || [])[1] || '';
if (!pass) { console.error('没从记忆文件里取到密码'); process.exit(1); }
fs.writeFileSync('build/music.json', JSON.stringify({ kind: 'daoliyu', baseUrl: 'https://daoliyu.cchong.cc', user: 'orrismi@163.com', pass: pass }));
console.log('music.json 写好，passLen=' + pass.length);
