/* README 升版本：0.7.8/45 → 0.7.9/46，并加一条 changelog */
const fs = require('fs');
const f = 'README.md';
let s = fs.readFileSync(f, 'utf8');
const eol = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
function rep(from, to) {
  const f2 = from.replace(/\n/g, eol), t2 = to.replace(/\n/g, eol);
  const n = s.split(f2).length - 1;
  if (n !== 1) throw new Error('MISS x' + n + ' :: ' + from.slice(0, 40));
  s = s.replace(f2, t2);
}
rep('版本号随构建更新：`versionName 0.7.8` / `versionCode 45`，诊断页第一行就能看到「版本 0.7.3 · MI PAD 2」。',
    '版本号随构建更新：`versionName 0.7.9` / `versionCode 46`，诊断页第一行就能看到「版本 0.7.9 · MI PAD 2」。');
rep('- 0.7.8：音乐页配色跟米家对齐（绿播放键/绿歌词/暖黄条/白钮），明亮皮肤不再被系统强行画暗。',
    `- 0.7.9：面板把自己注册进 Home Assistant（POST /api/states 建 5 个实体：状态/连接/电量/充电/夜间模式开关，开关可被 HA 反向控制皮肤）。${eol}- 0.7.8：音乐页配色跟米家对齐（绿播放键/绿歌词/暖黄条/白钮），明亮皮肤不再被系统强行画暗。`);
fs.writeFileSync(f, s);
console.log('README 0.7.9 / 46');
