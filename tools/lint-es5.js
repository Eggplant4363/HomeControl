/* 检查面板脚本是否只用了 Chromium 57 能跑的语法。
   目标设备 WebView = Chrome/57（2017），下列写法会直接在设备上报 SyntaxError，
   而在 PC 上的 Node 里却是合法的 —— 所以必须单独把关。

   运行：node tools\lint-es5.js   （退出码 0 = 全部通过） */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['panel/js/config.js', 'panel/js/icons.js', 'panel/js/layout.js',
  'panel/js/backend.js', 'panel/js/music.js', 'panel/js/app.js'];

/* 每条规则：正则 + 说明 + 允许的例外（有些字符出现在字符串/注释里是合法的，宁可人工复核） */
const RULES = [
  [/=>/, '箭头函数（Chrome 45+ 有，但项目统一 ES5 风格，避免混用）'],
  [/\?\?/, '空值合并 ??（Chrome 80+）'],
  [/\?\./, '可选链 ?.（Chrome 80+）'],
  [/\bclass\s+[A-Za-z_$]/, 'class 声明（Chrome 49+ 有，但项目统一 ES5 风格）'],
  [/\basync\s+function|\bawait\s/, 'async/await（Chrome 55+ 有，但项目未使用，注意别混入）'],
  [/\bconst\b|\blet\b/, 'const/let（Chrome 49+ 有，但项目统一 var）'],
  [/\bObject\.(entries|values|fromEntries)\s*\(/, 'Object.entries/values/fromEntries（Chrome 54/54/73）'],
  [/\.includes\s*\(/, 'Array/String.includes（Chrome 47/41，但字符串 includes 需 41+，谨慎）'],
  [/\.padStart\s*\(|\.padEnd\s*\(/, 'padStart/padEnd（Chrome 57 才支持 padStart，57 可用但避免）'],
  [/\.flat\s*\(|\.flatMap\s*\(/, 'Array.flat/flatMap（Chrome 69+）'],
  [/\bPromise\.(allSettled|any)\s*\(/, 'Promise.allSettled/any（Chrome 76+）'],
  [/\bnew\s+Map\s*\(|\bnew\s+Set\s*\(/, 'Map/Set（Chrome 38+ 可用，但项目未使用）'],
  [/\.at\s*\(/, 'Array.at（Chrome 92+）'],
  [/\bglobalThis\b/, 'globalThis（Chrome 71+）'],
  [/\bBigInt\b|\b\d+n\b/, 'BigInt（Chrome 67+）'],
  [/\bimport\s|\bexport\s+(default|const|function)/, 'ES module 语法（file:// + 57 不支持）'],
  [/\.\.\./, '展开/剩余参数（Chrome 46+ 有，但项目统一不用）'],
  [/\bget\s+[A-Za-z_$]+\s*\(\)\s*{|\bset\s+[A-Za-z_$]+\s*\(/, 'getter/setter（Chrome 49+，项目不用）']
];

/* 这些文件是「故意」写现代语法的：只跑在 Node 里，不进设备 */
const SKIP = new Set(['tools/']);

let failures = 0;
let checked = 0;

/* 简单地把字符串字面量、注释里的内容抹掉，减少误报（正则不追求完备，够用即可） */
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const code = strip(src);
  const lines = src.split(/\r?\n/);
  const codeLines = code.split('\n');
  checked++;
  codeLines.forEach((line, idx) => {
    RULES.forEach(([re, why]) => {
      if (re.test(line)) {
        failures++;
        console.log('  FAIL  ' + rel + ':' + (idx + 1) + '  ' + why);
        console.log('        ' + (lines[idx] || '').trim().slice(0, 120));
      }
    });
  });
}

/* 附带检查：设备加载的是 /sdcard 副本，assets 里那份只是兜底，两者最好一致。
   以前只比 app.js —— 结果 music.js / app.css 早就分叉了也没人发现，现在整棵树逐文件比。 */
const A_DIR = path.join(ROOT, 'panel');
const B_DIR = path.join(ROOT, 'app/assets/panel');
function walkFiles(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) walkFiles(full, rel, out);
    else out.push(rel);
  }
  return out;
}
if (fs.existsSync(B_DIR)) {
  const files = walkFiles(A_DIR, '', []);
  const diffs = [];
  for (const rel of files) {
    const mine = path.join(A_DIR, rel);
    const other = path.join(B_DIR, rel);
    if (!fs.existsSync(other)) { diffs.push(rel + '（assets 里缺）'); continue; }
    if (!fs.readFileSync(mine).equals(fs.readFileSync(other))) diffs.push(rel);
  }
  if (diffs.length) {
    console.log('  WARN  app/assets/panel 与 panel/ 不一致：' + diffs.join(', '));
    console.log('        （重新 build 会同步；设备实际读 /sdcard 副本，assets 只是兜底）');
  } else {
    console.log('  PASS  app/assets/panel 与 panel/ 内容一致（' + files.length + ' 个文件）');
  }
}

console.log(failures === 0 ? '\nALL PASS (' + checked + ' files, 0 modern-syntax hit)' : '\n' + failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
