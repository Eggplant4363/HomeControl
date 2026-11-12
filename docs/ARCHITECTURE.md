# 架构（ARCHITECTURE）

一句话：**一个把自己设为默认桌面的原生 Activity，里面装一个 WebView；面板的全部业务逻辑在 JS 里，Java 只做「壳」——网络代理、文件读写、系统能力、看门狗。** HA 是唯一真相源，平板是显示器。

写这份文档时的版本：`0.7.11 / versionCode 48`（`tools/build.ps1 -VersionCode/-VersionName` 控制）。

---

## 1. 两层职责

| 层 | 位置 | 负责 | 不负责 |
| --- | --- | --- | --- |
| 面板 | `panel/`（HTML/CSS/JS，Chromium 57 兼容，无构建、无依赖） | 渲染、交互、布局规则、HA 协议、音乐源、自注册 | 系统权限、背光、文件路径校验、TLS 决策 |
| 壳 | `app/src/com/homecontrol/panel/`（Java，无第三方依赖） | WebView 装载、HTTP 代理、配置文件读写、音量/背光/电池/网络、看门狗、防烧屏窗口属性、逃生口 | 任何业务渲染 |

两边只靠一个对象通信：`addJavascriptInterface(new Bridge(this), "AndroidBridge")`（`MainActivity.java:144` 起的 `initWebView`）。JS 调 Java 是同步方法调用；Java 回调 JS 只有一个通道：`ui.post` 里 `web.evaluateJavascript(...)`。

### JS 侧文件

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `panel/js/backend.js` | ~560 | HA 连接：WebSocket 主通道 + REST 兜底梯子（WS 不通时轮询 `GET /api/states`）+ 历史 `GET /api/history`；指数退避重连 |
| `panel/js/app.js` | ~4468 | 卡片渲染、弹层、手势、亮度条、自注册、诊断页、夜间调暗 |
| `panel/js/layout.js` | ~8.3KB | 按 HA registry 的 area/device 自动生成房间与卡片 |
| `panel/js/music.js` | ~1932 | 负一屏音乐：演示 / 道理鱼 / Subsonic 三种音源 |
| `panel/js/config.js` | ~14KB | 阈值与调优参数（`dim`、`reloadHour`、实体上限、每类限流） |
| `panel/js/icons.js` | ~5.6KB | 内联 SVG 图标 |
| `panel/css/app.css` | ~1135 行 | Chromium 57 能正确渲染的样式（`gap` 不能用，见 `tools/lint-css.js`） |

**为什么拆不开**：`app.js` 里所有状态都在一个 `S` 对象上（`window.HC.S`），弹层/卡片/手势互相读写它。拆分方案写在 [docs/REFACTOR.md](docs/REFACTOR.md)（纯搬迁，不改行为）。

### Java 侧文件

| 文件 | 职责 |
| --- | --- |
| `MainActivity.java`（~1085 行） | 壳的全部：见下面 §3 |
| `TlsPolicy.java`（新，163 行） | TLS 策略：局域网 trustAll、域名真校验（自带 ISRG 锚） |
| `BootReceiver.java` | 开机/QUICKBOOT 自启（MIUI 拒绝后台自启广播，靠 `CATEGORY_HOME` 角色兜住） |
| `app/src_debug/com/homecontrol/panel/MockHaServer.java` | **只有 debug 变体编译**（849 行假 HA，`127.0.0.1:8123`），release dex 里不存在这个类 |

---

## 2. 页面地址与配置目录

### 页面从哪来

1. `debug.flag` 存在 → 读 `/sdcard/HomeControl/url.txt`（`MainActivity.java:257 resolveUrl()`），可以指向 `file:///sdcard/HomeControl/panel/index.html`（开发期热更新）或 `http://pc:8787/...`。
2. 否则 → 固定 `file:///android_asset/panel/index.html`（APK 内的资产）。

**为什么 url.txt 只在 debug 生效**：这个文件在世界可读的 `/sdcard` 里。正式版读它等于让任何能碰这台平板文件系统的人决定面板跑哪段 JS。

### 配置目录与白名单

面板只被允许读写 `/sdcard/HomeControl/` 里的东西。实现：`configRoot()` 把 `CONFIG_DIR` 取 **canonical** 再比对（`MainActivity.java:340`）——`/sdcard` 在这台设备上是 symlink，canonical 会解析成 `/storage/emulated/0/HomeControl/`；直接拿字符串常量比较会把一切读写判死（踩过：logcat 每 1.5s `mtime denied`，实体掉到 39 走模拟数据）。

- `safeConfigPath(path)`（`:355`）：`getCanonicalPath()` → 必须落在 `configRoot()` 前缀内；`mtime` / `writeText` / `removeFile` / `readText` 全走它。
- `readConfig(path)`（`:319`）：拒绝、缺失、目录一律返回 `""`（≤65536B），面板用 `if (!txt)` 判断。

面板实际用到的文件（全仓库 grep 出来的调用点）：`ha.json`（`app.js:3152` 写 / `:3186` 读 / `:3175` 删）、`music.json`（`music.js:166` 读 / `:204` 写）、`/sdcard/HomeControl/panel/.rev`（`app.js:3364`、`:4283` 读 mtime，热更新信号）。

### debug.flag 开关矩阵

| 能力 | debug.flag 存在 | 不存在（正式版） |
| --- | --- | --- |
| WebView CDP（:9222） | 开（`setWebContentsDebuggingEnabled`） | 不开 |
| 读 `url.txt` | 读 | 只用 assets 里的面板 |
| 起假 HA `MockHaServer` | 且 `/sdcard/HomeControl/mockha.enabled` 存在才起 | 类都不在包里 |
| 谁写这个文件 | `tools/push.ps1` / `tools/deploy.ps1`（开发路径） | `push.ps1 -Prod` / `deploy.ps1 -Prod` 删掉它 |

**为什么用文件而不是编译期常量**：同一份 APK 既能当开发机又能当上墙机器；而调试端口开在生产包上等于给同网段的人一个「往面板注入 JS」的入口（配合注入就能调 `writeText`/`readText`，所以白名单 + 关端口要一起才有意义）。

---

## 3. MainActivity 的职责清单（按行号）

| 行 | 干什么 |
| --- | --- |
| `:84 onCreate` | 窗口 flag（KEEP_SCREEN_ON / SHOW_WHEN_LOCKED / TURN_SCREEN_ON）、装 WebView、手势排除区（`:234 applyGestureExclusion`，避开 MIUI 全面屏手势）、看门狗、加载 |
| `:120 debugEnabled` | `debug.flag` 是否存在（静态，缓存） |
| `:129 maybeStartMockHa` | debug 门控 + 反射 `MockHaServer`（release 变体里这个类不存在，反射失败只是打日志） |
| `:144 initWebView` | JS 接口、console→logcat、SSL 错误回调（`:209`）、mixed content 允许（局域网 http 页面连 ws 需要） |
| `:257 resolveUrl` | debug 才读 url.txt |
| `:285 configuredHosts` / `:295 hostOf` / `:303 sslHostAllowed` | 从 `ha.json.url`、`music.json.base`、prefs 里的 URL 抽出主机名，用于「只放行面板自己配置的服务器」的 SSL 例外 |
| `:319 readConfig` / `:340 configRoot` / `:355 safeConfigPath` | 文件白名单 |
| `:365 loadPanel` / `:375 scheduleRetry` | 加载失败重试：3s×3 然后每 10s，**最多 10 次**后停在横幅「已停止自动重试」而不是无限重试 |
| `:420 startWatchdog` / `:455 screenInteractive` | 见 §5 |
| `:499 onKeyDown` | 1.5s 内两次 BACK → 打开系统设置（默认桌面被替换时的后路） |
| `:540 Bridge` | JS 桥：`log` `heartbeat` `getVolume` `setVolume` `reload` `info` `netInfo` `battery` `devUrl` `mtime` `writeText` `removeFile` `readText` `setBrightness` `trustAll`(`:765`) `applyTls`(`:778`) `openHa`(`:791`) `restCall`(`:818`) `rest`(`:857`) `httpProbe`(`:878`) `httpJson`(`:903`) `httpReq`(`:909`) `httpGetText`(`:929`) `httpBinary`(`:936`) `httpBytes`(`:956`) `httpText`(`:1017`) `exitApp`(`:1081`) |

`Bridge` 里的网络方法都是「在 `ui.post` 之外的线程跑 `HttpURLConnection`，结果用 `web.evaluateJavascript` 回调」——WebView 自己的网络栈跑不了带 Bearer 令牌的 HA REST（跨域 + 混合内容），所以由壳代跑。

---

## 4. TLS（`TlsPolicy.java`）

两类主机两套规则，这是这次重构里最实质的一处：以前 `trustAll()` 被用在**所有**连接上，包括公网 `https://daoliyu.cchong.cc`（带 Basic 凭据），任何中间人都能截走账号密码。

- **局域网**（`isPrivateHost()`：`localhost` / IPv4 字面量 / IPv6 字面量）：trustAll + hostname verifier 恒 `true`。自建 HA 常自签证书，信任边界就是这台设备所在的网络。
- **域名**：走 `TlsPolicy.context()`（系统信任库优先，失败后用 APK 里的锚补验一次：`app/certs/isrgrootx1.pem`、`app/certs/isrg-root-x2.pem`，构建时拷进 `assets/certs/`）。逐环验签名 + `checkValidity()`，最后一环必须落在自带锚上，否则抛 `CertificateException`。
  - 为什么需要自带锚：MI PAD 2 的 Android 5.1 信任库里没有 ISRG 根证书（Let's Encrypt 2019 之后才进 Android 信任库），所以「真校验」在这块板上原本只能靠 trustAll 假装。
  - 实测链：`CN=*.cchong.cc` ← `YE2` ← `Root YE` ← `ISRG Root X2` ←（交叉签）`ISRG Root X1`，4 环，PC JDK17 与平板都验过（`build/TlsTest.java` 是复现脚本）。
- **WebView 那条通道**（负一屏音频流、`wss://`）用不了 Java 的锚（Chromium 有自己的信任库，Android 5.1 里根本没有 ISRG 根）。所以 `onReceivedSslError`（`MainActivity.java:209`）按**主机范围**放行：局域网 + 面板自己配置的服务器（`sslHostAllowed` 从 `ha.json` 的 `url`、`music.json` 的 `base`、弹层里填的地址抽主机；`schemeHost` 手工解析，因为 `java.net.URL` 不认 `ws:`/`wss:`），其余一律 `cancel()`。**不看错误码**：同一张 LE 证书在 https 页面里 Chromium 报 2（不受信任），在 WebSocket 握手里报 3，Chromium 57 的分类不可靠，护栏是主机白名单本身。实测：`wss://homeass.cchong.cc` 现在 `proceed 3` 并且实时推送通（`first states 433ms`）；配成第三方站点（badssl）时 Java 侧 REST 仍严格拒绝（`SSLHandshakeException: untrusted root`）。Java 侧的真校验在 `TlsPolicy`：逐环验签 + 有效期 + 主机名。

---

## 5. 看门狗与自愈

| 参数 | 值 | 位置 |
| --- | --- | --- |
| JS 心跳 | 4s | `panel/js/app.js` 的 `setInterval(heartbeat,4000)` → `Bridge.heartbeat()` |
| 检查周期 | 15s | `MainActivity.java:420 startWatchdog` |
| 卡死阈值 | `BEAT_STALL_MS = 45000` | `:66` |
| 首帧宽限 | `FIRST_BEAT_MS = 180000` | `:67`（`everBeat` 之前不判卡死；慢网络下 `first states` 实测可到 35s） |
| 屏幕门 | `screenInteractive()`（API≥20 `isInteractive()`，否则 `isScreenOn()`） | `:455` |

逻辑：熄屏直接跳过（并把 `lastBeat` 更新为当前，防止亮屏那一下立刻判卡死）；首帧前只有超过 180s 才 reload；之后 45s 无心跳才 reload。

**为什么必须有屏幕门**：这个 Activity 带 `FLAG_SHOW_WHEN_LOCKED|TURN_SCREEN_ON`，熄屏时它仍然是 resumed 状态、没有 `onPause`；而 Doze 会冻结 WebView 的 JS 定时器。旧版因此在整夜熄屏期间每 45s reload 一次（真机实测过：00:46→00:56 连续 9 次）。上墙设备每天重启几百次 WebView，还顺带把 localStorage 的编辑布局打散。

真机两条验证：① `?selftest=hang` 让主线程卡死 60s → `watchdog: no heartbeat for 45s, reloading`；② 熄屏静置 110s → 0 条 watchdog/reload 日志。

---

## 6. 数据流

```
HA (http://10.10.1.7:8123)
   │  WebSocket /api/websocket（Bearer 令牌）── 主通道：auth_ok → get_states → subscribe_messages(state_changed)
   │  REST /api/states /api/services/<domain>/<service> /api/registry /api/history ── 兜底通道（WS 不通时）
   ▼
backend.js  ── 实体表 + registry（area/device）── layout.js 生成卡片 ── app.js 渲染
   │
   │  POST /api/states/<entity_id>（自注册，每分钟）：sensor.homecontrol_panel、
   │  binary_sensor.homecontrol_panel_connected、sensor.homecontrol_panel_battery、
   │  binary_sensor.homecontrol_panel_charging、switch.homecontrol_panel_dark_mode（双向）
   ▼
道理鱼 https://daoliyu.cchong.cc（REST + Basic，凭据在 /sdcard/HomeControl/music.json）
```

自注册的回环守卫：面板自己写过的实体，用 `attributes.last_updated` + 2000ms 窗口区分「HA 那边改了」与「我们自己写的」，否则皮肤开关会自己跟自己来回拨（`app.js:1087-1093`）。

---

## 7. 构建与产物

```
panel/            源真相（唯一被编辑的面板副本）
app/certs/*.pem   源真相（TLS 锚）
app/src/          壳（所有变体都编译）
app/src_debug/    只有 -Variant debug 才编译
        ↓ tools/build.ps1
app/assets/       构建产物：panel/* + certs/*.pem（每次先 wipe 再拷；已 gitignore）
        ↓ aapt2 compile/link → javac → d8 → zipalign → apksigner
dist/homecontrol.apk（debug，含假 HA） / dist/homecontrol-release.apk（release，不含）
```

`build.ps1` 七步：① 拷 panel+certs 进 assets；② `aapt2 compile`；③ `aapt2 link`；③b **把资产条目名里的 `\` 换成 `/`**（Windows 上 `aapt2 link -A` 写出的条目名带反斜杠，Android 只认 `/`，少了这步 `file:///android_asset/panel/index.html` 一律 `ERR_FILE_NOT_FOUND`）；④ `javac`（debug 变体额外编 `app/src_debug`）；⑤ `d8`；⑥ 塞 dex；⑦ `zipalign` + `apksigner`（`debug.keystore`）。

路径解析全部走 `tools/env.ps1`（`HC_ANDROID_SDK` / `HC_BUILD_TOOLS` / `HC_JAVA_HOME` / `HC_ADB` / `HC_DEVICE` 可覆盖）。**改过 .ps1 之后要补 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 ps1 会按 GBK 解析，中文注释会打断字符串/括号，报 `Unexpected token` 或 `The string is missing the terminator`。

**注意**：`build.ps1` 会 wipe `build/`。临时备份别放 `build/`（踩过：`build/ha-http.json` 设备配置备份被构建删掉），放 `backup/`。

---

## 8. 设备矩阵

| 设备 | 系统 | WebView | 通道 | 备注 |
| --- | --- | --- | --- | --- |
| MI PAD 2（latte，`A3P4661B1BA6`） | Android 5.1 / SDK 22，MIUI 9.6，user 构建无 root | Chromium 57（2017，不能升级） | USB adb；`adb tcpip 5555` + `adb connect 10.10.1.78:5555`（重启后 tcpip 失效，要重新插线跑一次） | 1024×768@2x；无 `pidof`；CDP 的 `/json/list` 不给 `webSocketDebuggerUrl`（只有 id）；信任库没有 ISRG 根 |
| Xiaomi Pad 5（nabu，`10.10.1.188:34049`） | Android 13 / SDK 33 | 新 Chromium | 无线调试：配对端口与连接端口是两个不同端口（`adb pair` + `adb connect`），guid `adb-a30703c6-OjSXZn` | targetSdk 22 → 装完要 `pm grant` 存储权限；Doze 会冻结定时器（看门狗门控同样适用，另加 `cmd deviceidle whitelist +com.homecontrol.panel`） |

面板布局存在 WebView 的 `localStorage['hc.edit']`（不在 `/sdcard`），所以新装一台平板是空布局，要在设备上「编辑 → ＋添加卡片」；MI PAD 2 的布局没法拷过去（没有 root，也拿不到别的 app 的 data 目录）。

---

## 9. 验证入口

| 入口 | 覆盖 | 需要 |
| --- | --- | --- |
| `node tools/lint-es5.js` | Chromium 57 语法闸门（6 文件）+ `panel/` 与 `app/assets/panel/` 一致性 | 无 |
| `node tools/lint-css.js` | Chromium 57 CSS 闸门（不报错但会变形的写法） | 无 |
| `node tools/test-ui.js` | 渲染规则纯函数（87 项） | 无 |
| `node tools/test-ha.js` | WS + REST + registry + 重连 + 历史（协议离线） | 无 |
| `node tools/check-security.js <serial>` | 真机桥白名单：`../` 穿越、目录读取、越权写必须被拒 | 设备 + debug.flag |
| `node tools/check-tls.js <serial>` | 真机 TLS：LAN 直通、公网 LE 走自带锚、自签与域名不匹配必须被拒 | 设备 + debug.flag |
| `node tools/check-rest.js <serial>` | 原生 REST 回调表：并发 5 个请求必须全部回调 | 设备 + debug.flag |
| `tools/deploy.ps1` / `tools/smoke.ps1` / `tools/verify.ps1` | 装 APK + 推面板 + 上墙验收（logcat `first states … 实体 N≥100` 作为验收） | 设备 |

---

## 10. 设计上的取舍（不是缺陷）

1. **不用 HA 官方前端**：这块板的 WebView 是 Chromium 57 且无法升级，HA 官方前端（2023+）跑不起来 → 自研轻量面板。
2. **不用 `adb reverse` 做热更新**：这台设备的 adbd 太老，`adb reverse` 报 `protocol fault` 还会打死 adb server → 改用「push 后写 `.rev` 时间戳 + 页面轮询 `mtime`」。
3. **设备 → PC 方向不通**：Windows 防火墙三个 profile 都开着且未放行入站（6 个端口全 `SocketTimeoutException`），加规则要管理员 → 协议验证用设备内假 HA（debug 变体）。
4. **没有 npm 依赖**：Node 的 npm 在这台机器上坏了（`Class extends value undefined`），所有工具脚本零依赖手写。
5. **不自动拉起被杀进程**：MIUI 拒绝第三方后台自启广播 → 靠「默认桌面」角色；没加 AlarmManager（force-stop 会清闹钟，且与双击返回键逃生口冲突）。
6. **配置放 `/sdcard`**：方便 `adb push` 与面板自己写；代价是世界可读（含长期令牌）。迁移到 app 私有目录是 REFACTOR.md 里的待办（要同时改 JS 读写点和 push/deploy）。
