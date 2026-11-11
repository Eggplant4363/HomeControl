/* 图标集：24x24 线性 SVG，直接用 innerHTML 插入。笔画统一 1.85，圆头圆角 —— 卡片上的
   图标块在 3 米外只是一枚小方块，笔画太细就只剩一个轮廓。 */
window.ICONS = {
  edit: '<path d="M4 20h4L20 8l-4-4L4 16v4z"/><path d="M13.5 5.5l5 5"/>',
  check: '<path d="M5 13l4.5 4.5L19 6.8"/>',
  cam: '<path d="M4 8h3l1.2-2h7.6L17 8h3v10H4z"/><circle cx="12" cy="13" r="3"/>',
  /* 灯泡：一个 bulb + 两级灯座，标准照明符号 */
  bulb: '<path d="M12 3.6a5.4 5.4 0 0 0-3.4 9.6c.6.6.9 1.3.9 2.1h5c0-.8.3-1.5.9-2.1A5.4 5.4 0 0 0 12 3.6z"/><path d="M9.8 18.4h4.4"/><path d="M10.8 21.2h2.4"/>',
  /* 插座：两个插脚 + 机身 + 地线，开关类用 */
  plug: '<path d="M9.5 3.4v4.4M14.5 3.4v4.4"/><path d="M6.6 7.8h10.8v3.4a5.4 5.4 0 0 1-10.8 0V7.8z"/><path d="M12 16.6v4"/>',
  snow: '<path d="M12 2v20M3.5 6.5l17 11M20.5 6.5l-17 11"/>',
  curtain: '<path d="M3 4.5h18M5.5 4.5v15M18.5 4.5v15M8 8.5h8M8 12.5h8M8 16.5h8"/>',
  /* 温度计：细管 + 球泡，读数类通用 */
  thermo: '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/><path d="M12 15.6v-2.4"/>',
  drop: '<path d="M12 3.8c3.6 3.7 5.6 6.6 5.6 9a5.6 5.6 0 0 1-11.2 0c0-2.4 2-5.3 5.6-9z"/>',
  /* 人体感应：中间一个探头，两侧两道波（PIR 的标准画法，比小人清楚） */
  motion: '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M8.6 8.6a4.8 4.8 0 0 1 0 6.8M15.4 8.6a4.8 4.8 0 0 0 0 6.8"/>',
  /* 烟雾报警器：一个圆盘 + 上方两道烟 */
  smoke: '<circle cx="12" cy="13.4" r="6"/><path d="M12 11v2.4"/><path d="M9.4 6.2a3.4 3.4 0 0 1 5.2 0"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  home: '<path d="M3 11l9-7 9 7M6 10v11h12V10"/>',
  power: '<path d="M12 3v9M6.5 6.6a8 8 0 1 0 11 0"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16.5a5 5 0 0 1 6 0M12 20h.01"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  gear: '<circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="12" r="6.4"/><path d="M12 5.6v-3M12 21.4v-3M5.6 12h-3M21.4 12h-3M7.5 7.5L5.4 5.4M18.6 18.6l-2.1-2.1M16.5 7.5l2.1-2.1M5.4 18.6l2.1-2.1"/>',

  dots: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  sofa: '<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M4 11a2 2 0 0 0-2 2v4h20v-4a2 2 0 0 0-2-2M4 11h16M6 17v3M18 17v3"/>',
  bed: '<path d="M3 18v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8M3 14h18M7 8v4"/>',
  desk: '<path d="M3 8h18M5 8v12M19 8v12M8 8V5h8v3"/>',
  pot: '<path d="M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6zM8 10V7a4 4 0 0 1 8 0v3M4 10h16"/>',
  shower: '<path d="M4 12h12M10 12V6a4 4 0 0 1 8 0M7 16v1M10 18v1M13 16v1M16 18v1"/>',
  hanger: '<path d="M12 8a2.5 2.5 0 1 1 2.5-2.5M12 8v2M4 18l8-6 8 6z"/>',
  fan: '<path d="M12 12c1.5-4 3-5 4.5-4s.5 4-1.5 4.5M12 12c-1.5 4-3 5-4.5 4s-.5-4 1.5-4.5M12 12c-4 1.5-5 3-4 4.5s4 .5 4.5-1.5M12 12c4-1.5 5-3 4-4.5s-4-.5-4.5 1.5"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
  cloud: '<path d="M6.5 18.5a4.2 4.2 0 0 1 .2-8.4 5.6 5.6 0 0 1 10.8 1.6 3.6 3.6 0 0 1-.3 6.8z"/>',
  rain: '<path d="M6.5 15.5a4.2 4.2 0 0 1 .2-8.4 5.6 5.6 0 0 1 10.8 1.6 3.6 3.6 0 0 1-.3 6.8z"/><path d="M8 18.5v2M12 18.5v2.6M16 18.5v2"/>',
  /* 传感器专用：电量、功率、气压、门、窗 */
  battery: '<rect x="3.4" y="8.6" width="15.2" height="6.8" rx="2"/><path d="M20.6 11v2.4"/>',
  bolt: '<path d="M12.6 3.4 6.6 13h4.4l-1.6 7.6 6.6-9.6h-4.4z"/>',
  gauge: '<path d="M4.6 17a7.8 7.8 0 1 1 14.8 0z"/><path d="M12 12.6l3.4-3"/>',
  door: '<rect x="6" y="3.4" width="12" height="17.2" rx="2"/><path d="M15.2 12h1.4"/>',
  window: '<rect x="5" y="4.4" width="14" height="15.2" rx="2"/><path d="M12 4.4v15.2"/>',

  /* 负一屏 · 音乐 */
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M19 5v14L9 12z" fill="currentColor" stroke="none"/><rect x="5" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><rect x="16.6" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5h3.4L12 6v12L7.4 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  chev: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V10h-5.4"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shuffle: '<path d="M4 7h3.5l9 10H18M4 17h3.5l9-10H18"/><path d="M16 4.5l3 2.5-3 2.5M16 14.5l3 2.5-3 2.5"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-4a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v4a4 4 0 0 1-4 4H3"/>',
  repeatOne: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-4a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v4a4 4 0 0 1-4 4H3"/><path d="M11 10.5l2-1.5V15"/>'
};
