# 性能（PERFORMANCE）

这台平板是 **Intel Atom x5-Z8350 + 512MB RAM + Chromium 57**，所以性能预算和 PC 完全不同：一次整表 innerHTML 重建、一次同步的 SSL 配置读取、一次 8 秒一次的摄像头 JPEG 拉取，在这上面都是看得见的开销。这一轮的做法是：**先量，再改，改完再量**。测量方法本身也值得记下来，因为 Chromium 57 上很多常规工具不可用。

---

## 1. 怎么量（Chromium 57 的可用手段）

| 手段 | 用途 | 57 上的坑 |
| --- | --- | --- |
| CDP `Runtime.evaluate`（`tools/lib/cdp.js`） | 函数级计时：`var t=performance.now(); … ; return Math.round(performance.now()-t)` | `Profiler.stop` 返回的报文里**没有 `profile` 字段** → CPU profile 在 57 上不可用，只能函数级计时 |
| `MutationObserver` 记 mutation 数 | 判定「稳态有没有在写 DOM」 | 注入 setter 包装要防套娃：同一页面跑两次探针会 `Maximum call stack size exceeded` |
| `__PANEL_TEST__.stats()` | `renders` / `entityEvents` / `tiles` / `entities` | `statesRef` 是**函数**不是对象（`Object.keys()` 得 0） |
| `android_meminfo` | Java heap / PSS 趋势（反复点「更多」看是否线性涨） | 需要 app 在前台 |
| logcat `HomePanel` | 心跳间隔 >300ms = UI 线程被挤占；`first states Nms` | 息屏时 screencap 全黑，先 `input keyevent KEYCODE_WAKEUP` 再截 |

一次性探针放 `backup/tmp/`，**不放 `build/`**——`tools/build.ps1` 会 wipe `build/`（本轮被抹掉过两次，第二次报 `Cannot find module`）。

### 基线（改之前，MI PAD 2 `A3P4661B1BA6`，debug 包）

```
env: tiles=3  dom=157  heapMB=10  svgPaths=27  musicRows=0
stats(): {"renders":3,"entityEvents":18335,"tiles":3,"entities":1264}
静置 15s：innerHTML 写入 0 次、textContent 1.5ms、mutation 0
```

**结论：空闲路径本来就是增量的**（`renderGrid` 的 sig、`updateTile` 的值守卫一直在生效），所以稳态浪费不在渲染上，而在**周期性任务**：摄像头每 8s 拉 JPEG、`.rev` 每 1.5s 一次桥 stat、曲线历史批量请求、每 300s 整页重栅格，以及 Java 侧每次请求新建线程 + 每次 SSL 错误重读配置。因此这一轮的改动重点是「少做不该做的事」，不是「把渲染写得更聪明」。

---

## 2. 批次 A：`panel/js/app.js` + `app.css`（16 条，低风险）

| # | 改动 | 原来会做什么 |
| --- | --- | --- |
| A1 | `svg(name)` 加 `svgCache` | 每张卡片每个图标都重新拼一整段 `<svg viewBox…>` 串 |
| A2 | `camPaint()` 顶部 `if (S.dimOn) return;` | 暗屏（夜间模式）整夜每 8s 拉一张 JPEG 并解码，屏幕根本没显示 |
| A3 | `sparkPaint()` 顶部 `if (S.dimOn) return;` | 同上，每 20s 一批历史请求 |
| A4 | `sparkDraw(id, html)` 改成按 id 查节点表（`sparkNodes`，detached 则重建；`renderGrid` 置 null） | 每条曲线回调回来都重新遍历整个网格找 `.t-spark` |
| A5 | `cardSpan(entity, cols, tile)` 加可选 `tile` 参数；`tileHtml`/`renderGrid` sig 传 `it.tile`；`updateTile` 用 `cellRows(tile)` 不再 `rowSpan(entity)` 反查 | 每个实体事件都做一次 entity→tile 反查 |
| A6 | `renderWeather()` 加 `weatherSig` | 每帧扫一遍全实体 + 无条件写 innerHTML |
| A7 | `applyTheme(name)` 加 `themeLight`，皮肤没变不 `renderGrid(true)` | boot 里首帧之后 `applyPrefs` 又整网格重建一次 |
| A8 | 删死代码 `legacyThemeAcc`（30 行 HSL 压暗分支，无调用者） | 只是体积 |
| A9 | `renderSheet()`：markup 先拼成字符串，`html === S.sheetHtml` 就 return | 弹层开着时**每个状态事件**都重排整块 + 重绑 5 个 listener |
| A10 | `dimCfg()` 透传 `brightness`（原来 `enterDim` 的 `num(dimCfg().brightness, 0.35)` 恒走兜底） | 这是功能 bug：`config.js` 的 `dim.brightness` 形同虚设 |
| A11 | **删 `watchReload()`** 与 boot 里的调用 | 每 1.5s 一次桥 `mtime('/sdcard/HomeControl/panel/.rev')`，正式包里 `.rev` 永远不存在 → 一辈子白跑；开发热更新由文件尾部的 `watchDevReload()`（每 2s，60s 内没等到就自停）承担 |
| A12 | `startPixelShift()` 的 `step()` 顶部 `if (S.dimOn) return;` | 暗屏时整页重栅格（防烧屏的位移）没有意义 |
| A13 | `openDiagSheet()` 删重复的第二次 `freezeGrid(true)` | 两次冻结 + 两次解锁 |
| A14 | `sortCards(list)` 预计算 `item._k` / `item._p` | 比较器每次拼 `name+'\u0000'+entity`，排序 O(n log n) 次拼串 |
| A15 | `sparkPaint()` 并发上限 2（数 `S.sparkBusy` 里在飞的数量） | 一次 20s 批量发 N 条 `restHistory`，每条都是新线程 + 新 TLS 握手 |
| A16 | `app.css`：`.sheet` / `.sheet-inner` 的 `will-change: transform` 改成只在 `.sheet.show` 时挂 | 弹层 99% 的时间不存在，却常驻一个独立合成层 |

## 3. 批次 B：`panel/js/music.js`（6 条）

| # | 改动 | 原来会做什么 |
| --- | --- | --- |
| B1 | 行级播放标记：`onRow` + `rowNode(i)`（只认 `data-mact` 为 `track`/`libtrack`）+ `paintRow(b,on)` + `markPlaying()` + `resetRowMark()`；`audio.onplay`/`onpause` 不再 `paintList()` | 播放/暂停/封面就绪都整表重建（`LIB_MAX_ROWS=1500` 行 = 每次 1500 行 innerHTML） |
| B2 | `paintLib()` 与歌曲列表写完后 `resetRowMark()` | 保证行号索引和当前 DOM 一致 |
| B3 | `queueCoverRepaint` 的合并回调改成 `paintNow(); if (S.view === 'pl') paintList();` | 封面就绪时「歌曲 / 所有歌曲」视图根本不显示封面，却重绘整表 |
| B4 | 封面失败退避 `coverFail`（失败记时间，600s 内不再重试，成功清掉） | 一张拉不到的封面每 250ms 合并批次里被反复重拉 |
| B5 | `loadLibPage` 开头 `if (S.lib.items.length >= LIB_MAX_ROWS) { paintList(); return; }`，push 循环也封顶 | 点「更多」绕过上限，items 能涨到 5002 条（512MB 的机器上这是真内存问题） |
| B6 | `mapTrack` 删 `raw: t`；`streamUrl` 的 fmt 用 `String(t.format||'').toLowerCase()` | 每条曲目保留服务端裸 JSON（整份 `/api/tracks` 响应被复制进内存） |

## 4. 批次 C：`app/src/com/homecontrol/panel/MainActivity.java`（12 条）

约束：`javac -source 8 -target 8`、`d8 --min-api 21`（`tools/build.ps1`），所以只能用 Java 8 语法 + SDK 22 的 API。

| # | 改动 | 原来会做什么 |
| --- | --- | --- |
| C1 | `netPool = Executors.newFixedThreadPool(2)` 取代 5 处 `new Thread(...).start()`（`rest`、`httpText`、`httpBytes`、`httpProbe`、`updNet`）；`onDestroy` 里 `shutdownNow()` | 每个请求一条新线程；自注册每分钟 4–5 个 POST + 兜底轮询每 15s，在 Atom 上每次完整 TCP/TLS 握手 0.3–1.5s |
| C2 | `tlsPolicy()` 懒建（双检锁），`initWebView` 不再同步 `new TlsPolicy(this)` | `onCreate` 里同步初始化系统信任库 + 解析两个 PEM 锚 → boot 多 100–300ms |
| C3 | `debugEnabled()` 加 60s TTL 缓存 | boot 路径上 3 次 `/sdcard` stat |
| C4 | 看门狗 tick 开头 `if (isFinishing()) return;`；熄屏分支改成 `lastBeat = now; ui.postDelayed(this, 30000L); return;` | **隐性 bug**：熄屏分支原先直接 `return`，看门狗从此不再跑（页面若在熄屏期间卡死，永远不会被救回来）。现在熄屏期间每 30s 检查一次且不判卡死 |
| C5 | `onDestroy` 加 `ui.removeCallbacksAndMessages(null)` | 看门狗/重试 Runnable 自续期，Activity 销毁后还在跑 |
| C6 | `configuredHosts()` 改成 `Set<String>`，按 `fileLen(ha.json)+7*fileLen(music.json)` 缓存；删掉 `hostOf()` 的每次 `Pattern.compile`，换成手工扫引号的 `addHost()` + `cutBetween` | **UI 线程**上的 SSL 错误回调每次读两个 `/sdcard` 文件（10–40ms）+ 编译 3 个正则；MI PAD 2 缺 ISRG 根，`cchong.cc` 的每个新连接（WS 握手、每条音频流、每张封面）都走这条路 |
| C7 | `sslHostAllowed()` 查集合（并允许「已经验过的主机」`verifiedHosts`，由 `rememberVerifiedHost` 记小写） | 同上，从每次回调里的一次全量解析变成一次 `contains` |
| C8 | `contentLength(c)` helper（>0 且 <8MB 才用）→ `ByteArrayOutputStream(contentLength(c)+64)`；成功路径不再 `disconnect()` | `/api/states` 560KB：BAOS 反复翻倍 + `toByteArray()` 再复制 + `new String` ≈ 5–6MB 瞬态分配；`disconnect()` 杀掉了 keep-alive，于是每次请求都重新握手 |
| C9 | 桥回调去双重转义：`org.json.JSONObject.quote(out)` → 直接嵌 `out`（`__restCb`、`__musicHttpCb`、`__musicBinaryCb`）；JS 侧配套 `parseOut()`/`typeof raw === 'string' ? JSON.parse(raw) : raw` | 560KB payload 被转义成 ~1.3MB 字符串塞进 `evaluateJavascript`，JS 再两次 `JSON.parse`。现在 ~600KB 对象、一次 parse。`update.js` 的回调仍走 `quote(payload)`，所以它不用改 |
| C10 | `httpBytes` 截断不再当成功（`truncated` → `{"error":"too-large"}` + logcat `httpBinary truncated`） | 原先 >1.5MB 时 `break` 后把**半张 JPEG 的 base64** 当有效封面返回 |
| C11 | `netInfo()` 60s TTL 缓存 | 每次枚举网卡 + `WifiManager.getConnectionInfo()`（MIUI 上几十 ms），自注册每分钟调一次 |
| C12 | `httpProbe` 超时 6000/6000 → 2500/2500 | 这是**同步**桥调用：网络不通时页面 JS 被冻结最长 12s（现在最长 5s） |

## 5. 改后数字（MI PAD 2，debug 包 versionCode 57 / 0.7.20，pid 3063）

```
{"mtime20":15, "netInfo1":3, "battery1":1, "renderGrid3":0, "svg500":0,
 "prefs200":2, "camPaint2":0, "sparkPaint2":0, "tiles":3, "musicRows":1, "mlistRedraw2":1}   （单位 ms）
```

- `svg500` = 0ms（A1 缓存生效，改前是每次拼串）；`camPaint2` / `sparkPaint2` = 0ms（A2/A3 早退生效）
- `netInfo1` 3ms（C11 命中缓存，改前每次几十 ms）
- `prefs200` 2ms（原有缓存，未改，作为对照）
- `check-rest.js` 并发 5 条 → `{"got":5,"codes":[200,200,200,200,200]}`（证明 C9 的嵌对象契约可用）
- 门禁：`node --check` 三个文件通过；`tools/lint-es5.js` → `ALL PASS (7 files, 0 modern-syntax hit, 5 style note)`；`tools/lint-css.js` → `ALL PASS`；`tools/test-ui.js` → `ALL PASS (251 checks)`；构建 debug 189KB / release 173KB（release 的 dex 不含 `MockHaServer`）
- 两台部署回归：MI PAD 2 `SECURITY OK 9/9`、`REST OK`、`TEMP OK`；Pad 5 `10.10.1.188:36161` DEPLOY OK、实体 1264

## 5b. 第二轮（候选里挑出来的三条，Pad 5 `10.10.1.188:36161` 实测）

- **定时器合并**：原来 7 个各自独立的定时器（tick 1s / 看门狗 5s / camPaint 8s / heartbeat 4s / sparkPaint 20s / battGuard 30s / reportSelf 60s）合成一个 1s 主循环按 `beat % N` 分频（`panel/js/app.js` boot 里）。定时器条数是 Chromium 57 上的实打实开销，分频后回调落在同一帧。
  验证：桥的 `info().beatAge`（新增字段，见下）每 5 秒采样 = `3632 → 699 → 1917 → 3040 ms`，全部 < 4600ms → heartbeat 仍按 4 秒在跑，看门狗语义没变（45000ms 阈值远没碰到）；logcat 30s 内 `watchdog reload` 0 次。
  坑：**不能靠包装 `AndroidBridge.heartbeat` 来数次数**（Chromium 57 上给 Java 注入对象赋方法不生效，`wrap: wrapped` 但计数恒 0）→ 改成读桥自己的 `beatAge`。
- **心跳可观测**：`Bridge.info()` 多一个 `beatAge`（距上次心跳的毫秒，`-1` = 从来没跳过）。诊断页与回归脚本用它判断 JS 定时器还活着；页面卡住时它会一路涨到看门狗阈值。
- **`camSrc` 缓存**：`camAuthOf()` 把 `haHttpBase` + 归一化令牌算一次（改 HA 配置会重载面板，所以不用失效逻辑），原来每块摄像头卡片每 8 秒重读 localStorage + 两次 regex + encodeURIComponent。
- **封面在 Java 侧缩放**（候选 3，已落地）：`Bridge.downscale(byte[], int max)` —— `BitmapFactory` 先 `inJustDecodeBounds` 量尺寸，`inSampleSize` 取 2 的幂直到 ≤512px，再 `JPEG q78` 重编码；`httpBinary` 在 `mime` 是 `image/*` 且原始 >120KB 时走它，并把返回的 `mime` 改成 `image/jpeg`（不然 JS 按原 mime 解 data URI 会失败）。失败回退原图。

## 6. 有意不动的东西（这些已经是对的，别再"优化"）

`renderGrid` 的 sig 增量、`updateTile` 的「变了才写 DOM」、`tileChild` 节点缓存、`setBarPct` 的 `data-pct/data-bw` 守卫、`gridClassOnly`、`pctHold` 1.2s 防抖、`tick` 的 textContent 守卫、`whoSig` 防头像重载、弹层开着时跳过 cam/spark、`freezeGrid`、自注册回环守卫（`selfWriteAt` 2s + `last_updated`）、`tileMap` O(1) 索引、`prefs()/hiddenRooms()/editState()` 的 raw 缓存、`toneOf` 记忆化、封面 LRU(`COVER_CAP=60`) + 250ms 合并重绘、`restCbs` 按 id 查表 + 12s 超时、WS 指数退避、REST 兜底梯子与 15s 周期、`emitEntity` 浅拷贝、`startTick` 自停、服务端 randomBatch、recent 去重、负一屏手势全套、`isFinite(duration)+durationSeconds` 兜底、SSL 主机白名单策略、自升级流程、转码判定（mp3/m4a/aac/wav/ogg 直连，否则 `/transcode?format=mp3&bitrate=192`）、半高卡（1×½）全套、`layout.build`、编辑态全量重建（编辑本来就要全量）、debug.flag 门控、`safeConfigPath()`/`configRoot()` canonical 白名单、`TlsPolicy.context()` 真校验、看门狗 `screenInteractive` 门 + `FIRST_BEAT_MS=180000`/`BEAT_STALL_MS=45000`/`MAX_RETRY=10`、`LOAD_NO_CACHE`、release 不含 MockHaServer 的反射流程、自升级流式落盘、亮度只作用本窗口、`setSystemGestureExclusionRects`、`largeHeap=true`。

## 7. 下一轮候选（本轮没做，理由写清楚）

1. **`panel/js/app.js` 拆模块**（hc-util/hc-theme/hc-store/hc-grid/hc-sheet/hc-self/hc-dim/hc-settings/hc-gestures，共享状态仍挂 `window.HC.S`）——纯搬迁，收益是可维护性而不是性能；app.js 现在 4703 行 / 203KB，是最大资产。风险在于并行会话正在改 app.js。
2. **`MainActivity.java` 拆 `PanelWebView/PanelBridge/HttpGateway/Watchdog/DevUrlResolver`**——现在 1762 行，混了 10 个职责（外加电池保养与自升级）。
3. ~~封面在 Java 侧缩到 ≤512px~~ —— **已做**（§5b）。
4. ~~`updDownload` 先 HEAD 取长度~~ —— **不用做**：`updDownload` 已经有 `int total = c.getContentLength()`（GitHub CDN 的 GET 会给长度），进度条有分母。`update.js` 的下载重入锁仍然值得加（连点两次会起两条下载线程）。
5. **曲线历史串行队列（max 2）**与弹层开着时暂停批量历史请求（并发上限已做了一半）。
6. **配置从 `/sdcard/HomeControl/` 迁到 `getFilesDir()`**——世界可读的长期令牌；要同时改 `app.js` 读写、`music.js`、`push.ps1`、`safeConfigPath()` 白名单，工作量中等，属于安全而不是性能。**这是下一轮最该做的一条。**
7. ~~`subscribeEntities` 只在变化时写串~~ —— **不存在**：`panel/js/backend.js:163` 只发一次 `subscribe_events / state_changed`（全量订阅），过滤在 JS 的 `emitEntity` 里；没有每帧拼串这条路。
8. ~~定时器合并~~ —— **已做**（§5b）。暗屏整体降频没做：暗屏时 cam/spark 已经早退，剩下的只有 heartbeat（看门狗依据）与 1s tick（时钟本来就要走），再降频会牺牲自愈。
9. ~~`camSrc` 缓存 base+token~~ —— **已做**（§5b）。剩下没做：`selectTile/paintPicked` 的 `className` regex replace（编辑态小活）、`setColumns` 写 `gridTemplate` 后 `setTimeout(0)` 再读 `clientWidth`——都是小开销，改它们的风险大于收益。
10. `checkMemGuard` 的 `nodeCount` 每 10min 全 DOM 走查：**保留**，它是自愈护栏，不是热点。

## 8. 这一轮踩到的坑（也进了 `docs/REFACTOR.md` §5）

- Chromium 57 的 `/json/list` **不给 `webSocketDebuggerUrl`**（只给 `id`）→ CDP 连接要用 `ws://127.0.0.1:9222/devtools/page/<id>`。
- Android 5.1 **没有 `pidof`** → 取 pid 要回退解析 `ps` 第二列。
- 包 `Element.prototype.innerHTML` setter 的探针**重复注入会套娃** → `Maximum call stack size exceeded`。
- `app.js`/`music.js` 是 **CRLF**：node 脚本里用多行 `\n` 字面量做精确匹配会 0 命中（`Error: 未命中 1 处（实际 0）`），要先 normalize 或直接用 `edit` 工具。
- node 一次性脚本里写 Java 源码的 `'\n'` 必须写 `'\\n'`，否则模板字面量把它展开成真换行，javac 报「字符文字的行结尾不合法」。
- 非静态内部类里不能写 `static` 方法（`Bridge.contentLength` 踩过：「内部类MainActivity.Bridge中的静态声明非法」）。
- debug 与 release **不能共用 `build\classes`**（沙箱让那个目录删不干净）→ release 会泄漏上一轮 debug 的 `.class`（本次泄漏了 `MockHaServer`）。现在各变体一套目录：`build` / `build-release`。
- DSH 文件沙箱会把写进 `build/` 的文件做成 **reparse point**（`Target` 为空），`Remove-Item -Recurse` 遍历到它就抛 `Cannot bind argument to parameter 'Path' because it is null` → 逐项删并跳过 reparse point。
- `ZipFile::Open(Update)` 报 `being used by another process` → 先 `Remove-Item` 再 `Copy-Item`。
- `adb push <目录> <已存在的目标目录>` 会把目录本身放进去（`panel/panel/`）：推目录内容要用 `panel\.` 形式，改完先 `grep -c` 设备上那份副本确认更新了。
- `adb shell "echo … > 路径"` 经 cmd 转手**重定向不生效** → 设备上写文本文件用 `adb push <本地临时文件> <路径>`。
- `node tools/check-*.js` 打完结果会被 20s CDP 超时定时器吊住十几秒（不是错误）；批量跑时每条单独跑并直接读 stdout。
