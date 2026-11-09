// tools/patch-tile-power.js — 照米家：卡片上用电源按钮表达开/关，不再写「开/关」文字
const fs = require('fs');
const js = 'D:/Document/Project/HomeControl/panel/js/app.js';
const css = 'D:/Document/Project/HomeControl/panel/css/app.css';
let hits = 0;

let a = fs.readFileSync(js, 'utf8');
const CRLF = a.indexOf('\r\n') >= 0;
const L = (t) => (CRLF ? t.replace(/\n/g, '\r\n') : t);
function rep(oldv, newv, tag) {
  const O = L(oldv), N = L(newv);
  if (a.indexOf(O) < 0) throw new Error('MISS in ' + tag);
  a = a.replace(O, N); hits++;
}

rep(`  /** 自动化：这里只做「执行 / 启用 / 禁用」，不做开关，避免把「禁用自动化」当成关灯 */`,
  `  /** 米家式电源钮：灯/开关/温控用一颗圆钮表达开/关（自动化和窗帘不放，语义不同） */
  function powerable(tile) {
    if (tile.type === 'light' || tile.type === 'climate') return true;
    if (tile.type === 'switch') return !isAuto(tile);
    return false;
  }

  /** 自动化：这里只做「执行 / 启用 / 禁用」，不做开关，避免把「禁用自动化」当成关灯 */`, 'powerable');

rep(`        : '<button class="t-more" data-act="sheet">' + svg('dots') + '</button>') +`,
  `        : (powerable(tile)
            ? '<button class="t-power" data-act="toggle" title="开关">' + svg('power') + '</button>'
            : '') +
          '<button class="t-more" data-act="sheet">' + svg('dots') + '</button>') +`, 'head');

rep(`    if (tile.type === 'light') {
      if (isNa(st)) return '离线';
      if (st !== 'on') return '关';
      return hasBrightness(attrs) ? lightPct(attrs) + '<span class="u">%</span>' : '开';
    }
    if (tile.type === 'switch') {
      if (isNa(st)) return '离线';
      if (isAuto(tile)) return st === 'on' ? '启用' : '禁用';
      if (st !== 'on') return '关';
      if (attrs.power != null) return Math.round(num(attrs.power, 0)) + '<span class="u">W</span>';
      return '开';
    }
    if (tile.type === 'climate') {
      if (isNa(st)) return '离线';
      if (st === 'off') return '关';`,
  `    if (tile.type === 'light') {
      if (isNa(st)) return '离线';
      /* 开/关不写文字：电源钮就是状态；只有亮度这种真数值才显示 */
      return st === 'on' && hasBrightness(attrs) ? lightPct(attrs) + '<span class="u">%</span>' : '';
    }
    if (tile.type === 'switch') {
      if (isNa(st)) return '离线';
      if (isAuto(tile)) return st === 'on' ? '启用' : '禁用';
      /* 同上：开着且有功率才显示数值 */
      return st === 'on' && attrs.power != null ? Math.round(num(attrs.power, 0)) + '<span class="u">W</span>' : '';
    }
    if (tile.type === 'climate') {
      if (isNa(st)) return '离线';
      if (st === 'off') return '';`, 'valHtml');

rep(`      if (!hasPosition(attrs)) return (st === 'closed' ? '关' : '开');`,
  `      if (!hasPosition(attrs)) return '';`, 'cover val');

rep(`    if (tile.type === 'light') return st === 'on' ? '已开启' : '已关闭';
    if (tile.type === 'switch') {
      if (st !== 'on') return st === 'unavailable' ? '不可用' : '已关闭';
      return attrs.power != null ? '功率 ' + Math.round(num(attrs.power, 0)) + ' W' : '已开启';
    }
    if (tile.type === 'climate') {
      if (st === 'off') return '已关闭';`,
  `    if (tile.type === 'light') return '';
    if (tile.type === 'switch') {
      if (st !== 'on') return st === 'unavailable' ? '不可用' : '';
      return attrs.power != null ? '功率 ' + Math.round(num(attrs.power, 0)) + ' W' : '';
    }
    if (tile.type === 'climate') {
      if (st === 'off') return '';`, 'subText');

fs.writeFileSync(js, a);

let c = fs.readFileSync(css, 'utf8');
const CR2 = c.indexOf('\r\n') >= 0;
const L2 = (t) => (CR2 ? t.replace(/\n/g, '\r\n') : t);
function rep2(oldv, newv) {
  const O = L2(oldv), N = L2(newv);
  if (c.indexOf(O) < 0) throw new Error('MISS css: ' + oldv.slice(0, 40));
  c = c.replace(O, N); hits++;
}

rep2(`.t-more {
  margin-left: auto; width: 28px; height: 28px; padding: 0; border: 0;
  border-radius: 9px; background: rgba(var(--surf),.045); color: var(--text-4);
  display: flex; align-items: center; justify-content: center;
}`,
`.t-power {
  /* 米家那颗电源圆钮：开着=绿实心白字，关着=灰描边 */
  margin-left: auto; width: 34px; height: 34px; padding: 0;
  border: 1px solid rgba(var(--surf),.14); border-radius: 50%;
  background: rgba(var(--surf),.05); color: var(--text-4);
  display: flex; align-items: center; justify-content: center;
  transition: background .2s, color .2s, border-color .2s;
}
.t-power svg { width: 17px; height: 17px; }
.t-power:active { transform: scale(.92); }
.tile.on .t-power { background: rgb(var(--ctl-on)); border-color: rgb(var(--ctl-on)); color: var(--glyph-on); }
.tile.na .t-power { opacity: .45; }
.t-more {
  margin-left: 8px; width: 28px; height: 28px; padding: 0; border: 0;
  border-radius: 9px; background: rgba(var(--surf),.045); color: var(--text-4);
  display: flex; align-items: center; justify-content: center;
}`);

fs.writeFileSync(css, c);
console.log('tile power ok, ' + hits + ' patches');
