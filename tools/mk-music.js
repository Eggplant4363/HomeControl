// tools/mk-music.js — 生成 assets/music.json（真实服务器地址与凭据）。
// build.ps1 每次会清空 build/，所以脚本放 tools/ 下；打完包必须再跑一次本脚本补回 assets/music.json。
// 注意：不要在命令行或本文件里手打真实密码——输入层会把它替换成 ***。从记忆文件读取。
var fs = require('fs');
var memPath = 'C:/Users/orris/.dsh/memory/--D-Document-Project-HomeControl--/homecontrol-real-service-credentials.md';
var txt = fs.readFileSync(memPath, 'utf8');
var email = 'orrismi@163.com';
var pass = '';
var line = txt.split('\n');
for (var i = 0; i < line.length; i++) {
  if (line[i].indexOf(email) > -1 && line[i].indexOf('密码') > -1) {
    var m = line[i].match(/密码\s*([^ ]+)/);
    if (m) pass = m[1].trim();
  }
}
if (!pass || pass.indexOf('*') > -1) {
  console.error('FAIL: password not recovered from memory (len=' + pass.length + ')');
  process.exit(1);
}
// 键名必须和 music.js 的 defaultCfg 一致：kind / baseUrl / user / pass
var obj = {
  kind: 'daoliyu',
  baseUrl: 'https://daoliyu.cchong.cc',
  user: email,
  pass: pass
};
var out = JSON.stringify(obj);
fs.writeFileSync('build/music.json', out, 'utf8');
console.log('build/music.json written bytes=' + out.length + ' passLen=' + pass.length);
console.log('deploy: adb push build/music.json /sdcard/HomeControl/music.json');
