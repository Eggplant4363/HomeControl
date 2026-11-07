/*
 * Chromium 57 兼容性检查（CSS 部分）。
 * 目标设备 WebView 是 Chrome/57，很多“看起来很正常”的写法在那儿是不生效的，
 * 而且不生效通常不报错——只是布局悄悄变形。所以用静态检查兜住。
 * 跑法：node tools\lint-css.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['panel/css/app.css'];

/* 属性级禁用/慎用清单：key 是 CSS 里出现的子串 */
const BANNED = [
  ['backdrop-filter', 'Chromium 57 不支持'],
  [':is(', '选择器 :is() 需 Chrome 88'],
  [':where(', '选择器 :where() 需 Chrome 88'],
  [':focus-visible', '需 Chrome 86'],
  ['aspect-ratio', '需 Chrome 88'],
  ['clamp(', '需 Chrome 79'],
  ['color-mix(', '需 Chrome 111'],
  ['conic-gradient(', '需 Chrome 69'],
  ['inset:', 'inset 简写需 Chrome 87'],
  ['overscroll-behavior', '需 Chrome 63'],
  ['scroll-snap', '需 Chrome 69'],
  [':has(', '需 Chrome 105'],
  ['inset-inline', '逻辑属性需 Chrome 69'],
  ['gap:', 'flex 容器的 gap 需 Chrome 84；grid 的 gap 简写需 Chrome 66（用 grid-gap）']
];

let bad = 0;
function report(file, line, msg, text) {
  bad++;
  console.log('  FAIL  ' + file + ':' + line + '  ' + msg);
  if (text) console.log('        ' + text.trim().slice(0, 120));
}

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const css = fs.readFileSync(abs, 'utf8');
  /* 先把注释整段抹成空白（保留换行，行号不变），避免注释里的关键词误报 */
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  const lines = stripped.split(/\r?\n/);

  /* 1. 关键字检查（逐行） */
  lines.forEach((ln, i) => {
    const raw = ln.trim();
    if (raw.startsWith('*') || raw.startsWith('/*')) return;
    for (const [needle, why] of BANNED) {
      if (ln.indexOf(needle) < 0) continue;
      /* gap 单独判断：只有 flex 容器才算违规，grid 的 gap 也提示用 grid-gap */
      if (needle === 'gap:') {
        if (!/(^|[^-\w])gap\s*:/.test(ln)) continue;
        const ctx = contextOf(lines, i);
        if (/display:\s*flex/.test(ctx)) report(rel, i + 1, 'flex 容器不能用 gap（' + why + '）', raw);
        else if (/display:\s*grid/.test(ctx)) report(rel, i + 1, 'grid 容器建议用 grid-gap（' + why + '）', raw);
        continue;
      }
      report(rel, i + 1, why, raw);
    }
  });
}

/* 找某一行所属规则块（往上找到起始 { 之后到该行） */
function contextOf(lines, idx) {
  let start = idx;
  for (let i = idx; i >= 0; i--) { if (lines[i].indexOf('{') >= 0) { start = i; break; } }
  return lines.slice(start, idx + 1).join('\n');
}

console.log('');
if (bad === 0) { console.log('ALL PASS (Chromium 57 CSS 兼容)'); process.exit(0); }
console.log('FAILED ' + bad + ' 处');
process.exit(1);