/* 检查面板脚本是否只用了 Chromium 57 能跑的语法。
   目标设备 WebView = Chrome/57（2017），下列写法会直接在设备上报 SyntaxError，
   而在 PC 上的 Node 里却是合法的 —— 所以必须单独把关。

   运行：node tools\lint-es5.js            （默认查 panel/ 的脚本；退出码 0 = 全部通过）
        node tools\lint-es5.js <文件>…    （临时查别的文件，给自己测门禁本身用）

   门禁本身踩过一次坑：strip() 把正则字面量里的引号当字符串起点（`/[&<>"']/g`），
   吞掉中间整段代码，app.js 4469 行被剥成 1309 行 —— 于是真违规也报全 PASS。
   现在 strip() 认正则字面量，并且保留换行，行号与原文一一对应。 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = ['panel/js/config.js', 'panel/js/icons.js', 'panel/js/layout.js',
  'panel/js/backend.js', 'panel/js/music.js', 'panel/js/app.js'];
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

/* 每条规则：正则 + 说明 + 允许的例外（有些字符出现在字符串/注释里是合法的，宁可人工复核）
   只列 Chrome 57 会**报错或静默失效**的写法；ES5/ES6 里 57 能跑的走下面的 NOTES */
const RULES = [
  [/\?\?/, '空值合并 ??（Chrome 80+）'],
  [/\?\./, '可选链 ?.（Chrome 80+）'],
  [/\basync\s+function|\bawait\s/, 'async/await（Chrome 55+ 有，但项目未使用，注意别混入）'],
  [/\bObject\.(entries|values|fromEntries)\s*\(/, 'Object.entries/values/fromEntries（Chrome 54/54/73）'],
  [/\.flat\s*\(|\.flatMap\s*\(/, 'Array.flat/flatMap（Chrome 69+）'],
  [/\bPromise\.(allSettled|any)\s*\(/, 'Promise.allSettled/any（Chrome 76+）'],
  [/\.finally\s*\(/, 'Promise.prototype.finally（Chrome 69+）'],
  [/\.matchAll\s*\(/, 'String.matchAll（Chrome 74+）'],
  [/\.replaceAll\s*\(/, 'String.replaceAll（Chrome 85+）'],
  [/\.findLast(?:Index)?\s*\(/, 'Array.findLast/findLastIndex（Chrome 97+）'],
  [/\.at\s*\(/, 'Array.at（Chrome 92+）'],
  [/\bglobalThis\b/, 'globalThis（Chrome 71+）'],
  [/\bBigInt\b|\b\d+n\b/, 'BigInt（Chrome 67+）'],
  [/\bimport\s|\bexport\s+(default|const|function)/, 'ES module 语法（file:// + 57 不支持）'],
  [/\b(?:for\s*\(?:[^)]*\bof\b)/, 'for...of 遍历（Chrome 50+ 可用，但项目只用 for/i 与 forEach）']
];

/* 风格提示，不算失败（设备能跑，只是项目约定） */
const NOTES = [
  [/=>/, '箭头函数：Chrome 45+ 能跑，但项目统一 ES5 风格'],
  [/\bclass\s+[A-Za-z_$]/, 'class 声明：Chrome 49+ 能跑，但项目统一 ES5 风格'],
  [/\bconst\b|\blet\b/, 'const/let：Chrome 49+ 能跑，但项目统一 var'],
  [/\.\.\./, '展开/剩余参数：Chrome 46+ 能跑，但项目统一不用'],
  [/\bnew\s+Map\s*\(|\bnew\s+Set\s*\(/, 'Map/Set：Chrome 38+ 能跑，但项目未使用'],
  [/\bget\s+[A-Za-z_$]+\s*\(\)\s*\{|\bset\s+[A-Za-z_$]+\s*\([^)]*\)\s*\{/, 'getter/setter：ES5 合法，Chrome 49+ 能跑（项目里 SELF 用了，别当违规删）'],
  [/\.includes\s*\(/, 'Array/String.includes：Chrome 47/41 能跑，谨慎用（5.1 上没问题，57 也没问题）']
];

/* 抹掉字符串/模板/注释/正则字面量的内容，减少误报。
   换行一律保留（行号必须对得上原文），内容换成占位符。 */
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 上一个非空白字符：决定这个 `/` 是正则开头还是除法
  function prevChar() {
    for (let j = i - 1; j >= 0; j--) {
      const ch = src[j];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
      return ch;
    }
    return '';
  }
  const KEYWORDS = ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'throw', 'yield'];
  function regexAllowed() {
    const p = prevChar();
    if (p === '') return true;
    if (/[\w$)\]]/.test(p)) {
      // 前面是标识符/数字/闭括号：可能是除法，也可能是 `return /re/` 这类关键字结尾
      let j = i - 1;
      while (j >= 0 && /[\w$]/.test(src[j])) j--;
      const word = src.slice(j + 1, i);
      return KEYWORDS.indexOf(word) >= 0;
    }
    return true;
  }
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += quote === '`' ? '``' : '""';
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // 正则字面量：吃到未转义的 `/`（方括号里的 `/` 不算结束）；遇到换行则当除法处理
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\n') break;
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') { inClass = true; j++; continue; }
        if (ch === ']') { inClass = false; j++; continue; }
        if (ch === '/' && !inClass) { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        i = j;
        while (i < n && /[a-z]/.test(src[i])) i++;   // 修饰符 g/i/m/u/y/s
        out += 'RX';
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

let failures = 0;
let notes = 0;
let checked = 0;

for (const rel of FILES) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('  SKIP  ' + rel + '（不存在）'); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  const code = strip(src);
  const lines = src.split(/\r?\n/);
  const codeLines = code.split('\n');
  checked++;
  if (codeLines.length !== lines.length) {
    console.log('  BUG   ' + rel + '：strip 后行数变了（' + lines.length + ' → ' + codeLines.length + '），行号不可信');
    failures++;
  }
  codeLines.forEach((line, idx) => {
    RULES.forEach(([re, why]) => {
      if (re.test(line)) {
        failures++;
        console.log('  FAIL  ' + rel + ':' + (idx + 1) + '  ' + why);
        console.log('        ' + (lines[idx] || '').trim().slice(0, 120));
      }
    });
    NOTES.forEach(([re, why]) => {
      if (re.test(line)) {
        notes++;
        console.log('  note  ' + rel + ':' + (idx + 1) + '  ' + why);
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
if (!process.argv.slice(2).length && fs.existsSync(B_DIR)) {
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

console.log(failures === 0
  ? '\nALL PASS (' + checked + ' files, 0 modern-syntax hit, ' + notes + ' style note)'
  : '\n' + failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
