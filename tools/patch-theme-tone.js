// tools/patch-theme-tone.js — 按业界 token 体系重做皮肤：
//   中性色阶取 Tailwind zinc/gray 阶，文本层级取 Material(MDC) 的 0.87/0.6/0.38 思路，
//   强调色按 CIELAB tone 映射（Material 3：亮皮肤 tone 40 档、暗皮肤 tone 80 档），
//   亮态卡片改成 container 色（亮 tone 92 / 暗 tone 26），按钮走 filled / tonal / outline。
// 注意：panel 下文件是 CRLF，先归一成 LF 做替换，写回时还原 CRLF。
const fs = require('fs');

/* ---------- CIELAB tone 工具 ---------- */
function s2l(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function l2s(c) { var v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(255, v * 255))); }
function rgbToLab(r, g, b) {
  var R = s2l(r), G = s2l(g), B = s2l(b);
  var X = 0.4122 * R + 0.7152 * G + 0.0722 * B, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = 0.0193 * R + 0.2358 * G + 1.0888 * B;
  function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116; }
  var fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToRgb(L, a, bb) {
  var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  function g(t) { return t > 0.206893 ? t * t * t : (116 * t - 16) / 903.296; }
  var X = g(fx) * 0.95047, Y = g(fy), Z = g(fz) * 1.08883;
  return [l2s(3.2406 * X - 1.5349 * Y - 0.4902 * Z), l2s(-0.9689 * X + 1.8758 * Y + 0.0719 * Z), l2s(0.0762 * X - 0.2151 * Y + 1.0796 * Z)];
}
function inGamut(r, g, b) { return r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255; }
/* 保色相与饱和度方向，把 L* 定到 tone/100；超出 sRGB 色域就按二分收缩 chroma */
function toneMap(r, g, b, tone, chromaScale) {
  var lab = rgbToLab(r, g, b), L = tone;
  var C = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]) * (chromaScale === undefined ? 1 : chromaScale);
  var h = Math.atan2(lab[2], lab[1]);
  var lo = 0, hi = C, out = labToRgb(L, 0, 0);
  if (C < 1) return out;
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2, c = labToRgb(L, mid * Math.cos(h), mid * Math.sin(h));
    if (inGamut(c[0], c[1], c[2])) { lo = mid; out = c; } else { hi = mid; }
  }
  return out;
}
function hex(r, g, b) { return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''); }
function triple(r, g, b) { return r + ',' + g + ',' + b; }
function lum(r, g, b) { var R = s2l(r), G = s2l(g), B = s2l(b); return 0.2126 * R + 0.7152 * G + 0.0722 * B; }
function contrast(c1, c2) { var a = lum(c1[0], c1[1], c1[2]) + 0.05, b = lum(c2[0], c2[1], c2[2]) + 0.05; return (Math.max(a, b) / Math.min(a, b)).toFixed(2); }

/* ---------- 皮肤默认强调色（HA 蓝 hue≈200）按 tone 取档 ---------- */
var sky = [3, 169, 244];                       // #03a9f4
var darkAcc = toneMap(sky[0], sky[1], sky[2], 78, 1);   // 暗皮肤 tone 78
var lightAcc = toneMap(sky[0], sky[1], sky[2], 42, 1);  // 亮皮肤 tone 42
var darkInk = toneMap(sky[0], sky[1], sky[2], 12, 0.6); // 暗皮肤 filled 按钮上的墨色
var lightC = toneMap(sky[0], sky[1], sky[2], 92, 0.5);
var darkC = toneMap(sky[0], sky[1], sky[2], 26, 0.5);
var lightLine = toneMap(sky[0], sky[1], sky[2], 62, 0.5);
var darkLine = toneMap(sky[0], sky[1], sky[2], 58, 0.5);
var okDark = toneMap(76, 175, 80, 78, 1), okLight = toneMap(46, 125, 50, 42, 1);
var warnDark = toneMap(255, 167, 38, 80, 1), warnLight = toneMap(178, 106, 0, 44, 1);
var errDark = toneMap(239, 83, 80, 74, 1), errLight = toneMap(198, 40, 40, 45, 1);

console.log('darkAcc', hex.apply(null, darkAcc), 'vs card', contrast(darkAcc, [24, 24, 27]));
console.log('lightAcc', hex.apply(null, lightAcc), 'vs white', contrast(lightAcc, [255, 255, 255]));
console.log('darkInk', hex.apply(null, darkInk), 'vs darkAcc', contrast(darkInk, darkAcc));
console.log('lightC', hex.apply(null, lightC), 'vs lightAcc', contrast(lightAcc, lightC));
console.log('darkC', hex.apply(null, darkC), 'vs darkAcc', contrast(darkAcc, darkC));

/* ---------- CSS：两个皮肤块 ---------- */
var cssPath = 'D:/Document/Project/HomeControl/panel/css/app.css';
var raw = fs.readFileSync(cssPath, 'utf8');
var crlf = raw.indexOf('\r\n') >= 0;
var src = crlf ? raw.replace(/\r\n/g, '\n') : raw;

function rep(needle, repl) {
  if (src.indexOf(needle) < 0) throw new Error('MISS: ' + needle.slice(0, 60));
  src = src.replace(needle, repl);
}

rep(`:root {
  /* 深色皮肤（HA dark 取值） */
  --bg: #181818; --bg-rgb: 24,24,24; --bg-deep: #111111; --bg-deep-rgb: 17,17,17;
  --bg-2: #212121; --bg-3: #2b2b2b; --bg-4: #333333;
  --card-rgb: 40,40,40; --card-2-rgb: 44,44,44; --line-rgb: 68,68,68;
  --surf: 255,255,255;
  --text-hi: #ffffff; --text-1: #e0e0e0; --text-2: #c9c9c9; --text-3: #a0a0a0;
  --text-4: #808080; --text-5: #6f6f6f;
  --accent-hex: #0d7ec0; --accent-rgb: 13,126,192; --accent-soft: #5fbde6; --accent-soft-rgb: 95,189,230;
  --wash-a: .14; --wash-border-a: .55; --wash-glow-a: .08; --wash-icon-a: .16;
  --badge-a: .22; --badge-border-a: .40;
  --ok: #4caf50; --ok-rgb: 76,175,80; --ok-soft: #81c784; --ok-tint-rgb: 30,58,32;
  --warn: #ffa726; --warn-rgb: 255,167,38; --warn-soft: #ffcc80;
  --err: #ef5350; --err-rgb: 239,83,80; --err-soft: #ff8a80;
  --lyric-rgb: 224,224,224;
  --accent: 13,126,192; --track: #3a3a3a; --knob: #ffffff;
  --shadow: 0 2px 2px 0 rgba(0,0,0,.2), 0 1px 2px 0 rgba(0,0,0,.3);
}`, `:root {
  /* 深色皮肤：中性色阶 = Tailwind zinc 阶（950/900/800/700…），
     文本层级按 Material 的 white/.92 / .72 / .55 / .42，强调色走 tone 档（暗皮肤 tone 78）。 */
  --bg: #121212; --bg-rgb: 18,18,18; --bg-deep: #0e0e10; --bg-deep-rgb: 14,14,16;
  --bg-2: #202024; --bg-3: #27272a; --bg-4: #303036;
  --card-rgb: 24,24,27; --card-2-rgb: 31,31,34; --line-rgb: 63,63,70;
  --surf: 255,255,255;
  --text-hi: #ffffff; --text-1: #ececf1; --text-2: #b4b6bd; --text-3: #8b8d95;
  --text-4: #6b6d76; --text-5: #52545d;
  --accent-hex: ${hex.apply(null, darkAcc)}; --accent-rgb: ${triple.apply(null, darkAcc)};
  --accent-soft: ${hex.apply(null, toneMap(sky[0], sky[1], sky[2], 86, 0.9))}; --accent-soft-rgb: ${triple.apply(null, toneMap(sky[0], sky[1], sky[2], 86, 0.9))};
  --acc-ink: ${hex.apply(null, darkInk)};
  --acc-c: ${triple.apply(null, darkC)}; --acc-line: ${triple.apply(null, darkLine)};
  --wash-a: .14; --wash-border-a: .55; --wash-glow-a: .08; --wash-icon-a: .16;
  --badge-a: .18; --badge-border-a: .38;
  --ok: ${hex.apply(null, okDark)}; --ok-rgb: ${triple.apply(null, okDark)}; --ok-soft: ${hex.apply(null, toneMap(76, 175, 80, 86, 0.8))}; --ok-tint-rgb: ${triple.apply(null, toneMap(76, 175, 80, 24, 0.45))};
  --warn: ${hex.apply(null, warnDark)}; --warn-rgb: ${triple.apply(null, warnDark)}; --warn-soft: ${hex.apply(null, toneMap(255, 167, 38, 86, 0.8))};
  --err: ${hex.apply(null, errDark)}; --err-rgb: ${triple.apply(null, errDark)}; --err-soft: ${hex.apply(null, toneMap(239, 83, 80, 82, 0.8))};
  --lyric-rgb: 236,236,241;
  --accent: ${triple.apply(null, darkAcc)}; --track: #2b2b30; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.28), 0 1px 2px 0 rgba(0,0,0,.36);
}`);

rep(`html.hc-light {
  /* 明亮皮肤（HA light 取值） */
  --bg: #fafafa; --bg-rgb: 250,250,250; --bg-deep: #f2f2f2; --bg-deep-rgb: 242,242,242;
  --bg-2: #efefef; --bg-3: #e6e6e6; --bg-4: #dedede;
  --card-rgb: 255,255,255; --card-2-rgb: 252,252,252; --line-rgb: 224,224,224;
  --surf: 26,26,26;
  --text-hi: #000000; --text-1: #1a1a1a; --text-2: #3f3f3f; --text-3: #595959;
  --text-4: #757575; --text-5: #8a8a8a;
  --accent-hex: #03a9f4; --accent-rgb: 3,169,244; --accent-soft: #0277b6; --accent-soft-rgb: 2,119,182;
  --wash-a: .10; --wash-border-a: .50; --wash-glow-a: .05; --wash-icon-a: .12;
  --badge-a: .16; --badge-border-a: .35;
  --ok: #2e7d32; --ok-rgb: 46,125,50; --ok-soft: #2e7d32; --ok-tint-rgb: 207,233,210;
  --warn: #b26a00; --warn-rgb: 178,106,0; --warn-soft: #9a5b00;
  --err: #c62828; --err-rgb: 198,40,40; --err-soft: #a92a2a;
  --lyric-rgb: 26,26,26;
  --accent: 3,169,244; --track: #dedede; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.05), 0 1px 2px 0 rgba(0,0,0,.12);
}`, `html.hc-light {
  /* 明亮皮肤：中性色阶 = Tailwind zinc 阶（50/100/200/300/400…），
     文本层级按 Material 的 black/.87 / .54 / .38 思路，强调色走 tone 档（亮皮肤 tone 42）。 */
  --bg: #fafafa; --bg-rgb: 250,250,250; --bg-deep: #f4f4f5; --bg-deep-rgb: 244,244,245;
  --bg-2: #f4f4f5; --bg-3: #e4e4e7; --bg-4: #d4d4d8;
  --card-rgb: 255,255,255; --card-2-rgb: 250,250,251; --line-rgb: 228,228,231;
  --surf: 24,24,27;
  --text-hi: #09090b; --text-1: #18181b; --text-2: #3f3f46; --text-3: #52525b;
  --text-4: #71717a; --text-5: #a1a1aa;
  --accent-hex: ${hex.apply(null, lightAcc)}; --accent-rgb: ${triple.apply(null, lightAcc)};
  --accent-soft: ${hex.apply(null, toneMap(sky[0], sky[1], sky[2], 34, 1))}; --accent-soft-rgb: ${triple.apply(null, toneMap(sky[0], sky[1], sky[2], 34, 1))};
  --acc-ink: #ffffff;
  --acc-c: ${triple.apply(null, lightC)}; --acc-line: ${triple.apply(null, lightLine)};
  --wash-a: .10; --wash-border-a: .50; --wash-glow-a: .05; --wash-icon-a: .12;
  --badge-a: .16; --badge-border-a: .35;
  --ok: ${hex.apply(null, okLight)}; --ok-rgb: ${triple.apply(null, okLight)}; --ok-soft: ${hex.apply(null, okLight)}; --ok-tint-rgb: ${triple.apply(null, toneMap(46, 125, 50, 92, 0.5))};
  --warn: ${hex.apply(null, warnLight)}; --warn-rgb: ${triple.apply(null, warnLight)}; --warn-soft: ${hex.apply(null, warnLight)};
  --err: ${hex.apply(null, errLight)}; --err-rgb: ${triple.apply(null, errLight)}; --err-soft: ${hex.apply(null, errLight)};
  --lyric-rgb: 24,24,27;
  --accent: ${triple.apply(null, lightAcc)}; --track: #d4d4d8; --knob: rgb(var(--accent));
  --shadow: 0 2px 2px 0 rgba(0,0,0,.05), 0 1px 2px 0 rgba(0,0,0,.12);
}`);

/* ---------- 亮态卡片：改成 container 色（Material 3 的选中态做法），去掉光晕 ---------- */
rep(`.tile.on {
  background: rgba(var(--card-rgb),1);
  border-color: rgba(var(--accent), var(--wash-border-a));
}
.tile.on::after {
  content: ''; position: absolute; right: -52px; top: -52px; width: 160px; height: 160px;
  border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(var(--accent), var(--wash-glow-a)), rgba(var(--accent), 0) 68%);
}`, `.tile.on {
  background: rgb(var(--acc-c));
  border-color: rgba(var(--acc-line), .75);
}
.tile.on::after { display: none; }`);

rep(`.tile.on .t-icon { background: rgba(var(--accent), var(--wash-icon-a)); color: rgb(var(--accent)); }`,
    `.tile.on .t-icon { background: rgba(var(--accent), .16); color: rgb(var(--accent)); }`);

/* 滑条钮：Material 做法是钮=强调色 + 一圈皮肤底色描边 */
rep(`  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38); border: 2px solid rgba(var(--card-rgb),.85);`,
    `  background: var(--knob); box-shadow: 0 2px 7px rgba(0,0,0,.38); border: 2px solid rgba(var(--card-rgb),.92);`);

/* ---------- app.js：themeAcc 换成 tone 映射，并给卡片补 container/line 变量 ---------- */
var jsPath = 'D:/Document/Project/HomeControl/panel/js/app.js';
var jraw = fs.readFileSync(jsPath, 'utf8');
var jcrlf = jraw.indexOf('\r\n') >= 0;
var jsrc = jcrlf ? jraw.replace(/\r\n/g, '\n') : jraw;

function jrep(needle, repl) {
  if (jsrc.indexOf(needle) < 0) throw new Error('MISS-JS: ' + needle.slice(0, 60));
  jsrc = jsrc.replace(needle, repl);
}

jrep(`  /** 明亮皮肤下把卡片强调色改成「墨色」版（浅色实体色在白底上又淡又糊）。
      入参是 'r,g,b' 三元组：保住色相，把亮度压到 0.36、饱和度抬到至少 0.55，
      于是暖光从浑浊的棕黄变成深琥珀、蓝从淡蓝变成深靛。灰（饱和 < 0.18）不动。 */
  function themeAcc(triple) {
    if (!isLight()) return triple;`,
`  /* 按 CIELAB 把实体强调色映射到当前皮肤的 tone 档（Material 3 的做法：
      亮皮肤用 tone 42 档、暗皮肤用 tone 78 档，色相与饱和度方向保持不变，
      超出 sRGB 色域就收缩 chroma）。灰（chroma < 6）只换亮度不动色相。 */
  function labOf(r, g, b) {
    var R = srgbLin(r), G = srgbLin(g), B = srgbLin(b);
    var X = 0.4122 * R + 0.7152 * G + 0.0722 * B, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = 0.0193 * R + 0.2358 * G + 1.0888 * B;
    var f = function (t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116; };
    return [116 * f(Y) - 16, 500 * (f(X / 0.95047) - f(Y)), 200 * (f(Y) - f(Z / 1.08883))];
  }
  function labOut(L, a, bb) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    var g = function (t) { return t > 0.206893 ? t * t * t : (116 * t - 16) / 903.296; };
    var X = g(fx) * 0.95047, Y = g(fy), Z = g(fz) * 1.08883;
    var lin = function (c) { var v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(255, v * 255))); };
    return [lin(3.2406 * X - 1.5349 * Y - 0.4902 * Z), lin(-0.9689 * X + 1.8758 * Y + 0.0719 * Z), lin(0.0762 * X - 0.2151 * Y + 1.0796 * Z)];
  }
  function srgbLin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  /* 保色相、定 tone，色域外二分收缩 chroma */
  function toneOf(triple, tone, chromaScale) {
    var p = String(triple).split(',');
    if (p.length < 3) return triple;
    var lab = labOf(num(p[0], 0), num(p[1], 0), num(p[2], 0));
    var cs = chromaScale === undefined ? 1 : chromaScale;
    var C = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]) * cs;
    var h = Math.atan2(lab[2], lab[1]);
    var L = tone;
    if (C < 6) { var g0 = labOut(L, 0, 0); return g0[0] + ',' + g0[1] + ',' + g0[2]; }
    var lo = 0, hi = C, best = labOut(L, 0, 0);
    for (var i = 0; i < 22; i++) {
      var mid = (lo + hi) / 2, c = labOut(L, mid * Math.cos(h), mid * Math.sin(h));
      var ok = c[0] >= 0 && c[0] <= 255 && c[1] >= 0 && c[1] <= 255 && c[2] >= 0 && c[2] <= 255;
      if (ok) { lo = mid; best = c; } else { hi = mid; }
    }
    return best[0] + ',' + best[1] + ',' + best[2];
  }
  function themeAcc(triple) {
    return toneOf(triple, isLight() ? 42 : 78, 1);
  }
  /* 选中/亮态的容器色与描边色（亮皮肤 tone 92 / 暗皮肤 tone 26，chroma 压到一半） */
  function accContainer(triple) {
    return toneOf(triple, isLight() ? 92 : 26, 0.5);
  }
  function accLine(triple) {
    return toneOf(triple, isLight() ? 62 : 58, 0.5);
  }
  /* 旧实现（明亮皮肤把亮度压到 0.36）保留成死代码会被 lint 抱怨，这里直接删掉后续分支 */
  function legacyThemeAcc(triple) {
    if (!isLight()) return triple;`);

/* 卡片上补 container / line / ink 三个变量 */
jrep(`    var tacc = themeAcc(accentFor(tile));
    if (node.getAttribute('data-accent') !== tacc) {
      node.setAttribute('data-accent', tacc);
      node.style.setProperty('--accent', tacc);
    }`,
`    var tacc = themeAcc(accentFor(tile));
    if (node.getAttribute('data-accent') !== tacc) {
      var raw3 = accentFor(tile);
      node.setAttribute('data-accent', tacc);
      node.style.setProperty('--accent', tacc);
      node.style.setProperty('--acc-c', accContainer(raw3));
      node.style.setProperty('--acc-line', accLine(raw3));
    }`);

/* 弹层同样补 container 变量 */
jrep(`    el.sheet.style.setProperty('--accent', themeAcc(accentFor(tile)));`,
`    var rawA = accentFor(tile);
    el.sheet.style.setProperty('--accent', themeAcc(rawA));
    el.sheet.style.setProperty('--acc-c', accContainer(rawA));
    el.sheet.style.setProperty('--acc-line', accLine(rawA));`);

fs.writeFileSync(cssPath, crlf ? src.replace(/\n/g, '\r\n') : src);
fs.writeFileSync(jsPath, jcrlf ? jsrc.replace(/\n/g, '\r\n') : jsrc);
console.log('theme tone patch ok');
