# 重构（REFACTOR）

这一轮做的事：**先把两块审计（Java 壳 + tools/ 仓库卫生、panel JS 侧）读完，按「立刻安全的改动 → 结构性重构 → 文档」落地**。每处改动都有真机验证；没做的项留在 §4，写清楚为什么现在不动。

审计来源：两份 subagent 审计（Java 壳/tools/仓库卫生一份，panel JS 一份）。原始结论已进 git 之外的会话记录，本文档只留**结论 + 证据 + 处置**。

---

## 1. 已修（都有真机证据，设备 = MI PAD 2 `A3P4661B1BA6`，debug 变体 versionCode 57；**性能批次 A/B/C 见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)**，那一轮改的是热点而不是安全）

### P0 安全

| # | 问题（原状） | 处置 | 证据 |
| --- | --- | --- | --- |
| S1 | `readText(path)` 无校验：`new FileReader(path)`，能读任意世界可读文件（`/sdcard/Download/…`、其它 app 的对外可读路径） | `safeConfigPath()`：`getCanonicalPath()` 后必须落在 `configRoot()` 内；`mtime`/`writeText`/`removeFile`/`readText` 全走它；拒绝统一返回 `""` | `node tools/check-security.js A3P4661B1BA6` → SECURITY OK 9/9；logcat 有 `readText denied: /sdcard/HomeControl/../Download/x.txt`、`writeText denied: /sdcard/HomeControl/../Download/pwn.txt` |
| S2 | `writeText`/`removeFile` 的前缀门是字符串比较：`startsWith("/sdcard/HomeControl/")` 放行 `/sdcard/HomeControl/../Download/x`（前缀一样，路径不一样） | 同上（canonical 之后再比前缀） | 同上：`writeText` 穿越 → `false` |
| S3 | **生产 APK 无条件开 WebView CDP**（`setWebContentsDebuggingEnabled(true)`）：同网段任何人 `adb forward`/直连 :9222 就能往面板注入 JS，把 S1/S2 变成可交互的越权 | 改成 `debugEnabled()` 门控（`/sdcard/HomeControl/debug.flag` 存在才开）；`push.ps1 -Prod` / `deploy.ps1 -Prod` 删掉这个文件 | 开发部署后 `tools/check-*.js` 能连上 CDP；`-Prod` 后连不上（deploy 断言 debug.flag 不存在） |
| S4 | `url.txt`（世界可读）决定面板加载哪个 URL → 正式版上这是「换一段 JS 跑」的入口 | 只有 `debugEnabled()` 才读；正式版固定 `file:///android_asset/panel/index.html` | 删掉 debug.flag 后 `resolveUrl()` 不再走 url.txt |
| S5 | **`trustAll()` 用在所有 HTTPS 连接上**：`null` TrustManager + hostname verifier 恒 `true`，被 `openHa` 的 https 分支、`httpBytes`、`httpText` 引用；公网 `https://daoliyu.cchong.cc` 带 Basic 凭据在上面跑 → 任何中间人可截走账号密码。`onReceivedSslError` 对所有 https `handler.proceed()` | 新增 `app/src/com/homecontrol/panel/TlsPolicy.java`：局域网（`localhost`/IPv4/IPv6 字面量）才 trustAll；域名走系统信任库 + APK 自带 ISRG 锚逐环验签（最后一环必须落在自带锚）+ `checkValidity()`；WebView 按**主机范围**放行（局域网 + 面板自己配置的服务器），其余 cancel——**不看错误码**（Chromium 57 对同一张证书在 https 页面里报 2、在 WSS 握手里报 3）。锚源文件在 `app/certs/`，构建拷进 `assets/certs/` | `node tools/check-tls.js`：`http://10.10.1.7:8123 → {"status":200}`；`https://self-signed.badssl.com/ → SSLHandshakeException: untrusted root: CN=*.badssl.com`；`https://wrong-site.badssl.com/ → SSLHandshakeException: Certificate expired … 2018`；logcat `tls anchors: 2`；PC 侧复现 `build/TlsTest.java` 验真实链 4 环（`*.cchong.cc ← YE2 ← Root YE ← ISRG Root X2 ←(交叉签) ISRG Root X1`）全 OK |
| S7 | `sslHostAllowed` 用 `new java.net.URL(url).getHost()` 解析 SSL 错误的 URL —— **`java.net.URL` 不认 `ws:`/`wss:`**，抛异常被 `catch(Throwable) return false` 吞掉 → `wss://homeass.cchong.cc/api/websocket` 的证书错误一律被 cancel，Android 5.1 上 https 部署只剩 REST 兜底（实测 `first states 11.5s`，且每 2s 一次重试刷屏）；同时 `hostOf` 的正则只认 `https?://` | `schemeHost()` 手工解析（scheme 白名单 http/https/ws/wss → 去 userinfo → 截到 `/?#` → 去端口，IPv6 括号剥外层），`hostOf` 正则改成 `(?:https?|wss?)://` | 修后 logcat `ssl error proceed 3 wss://homeass.cchong.cc/api/websocket` + `first states 433ms · 实体 1264`（实时推送恢复）；配成 badssl 时 Java 侧仍 `rest failed: SSLHandshakeException: untrusted root` |
| S6 | 正式 APK 里打进了 849 行假 HA（`MockHaServer.java`，`TOKEN="test-token"` + ~6KB base64 JPEG），且由世界可读的 `/sdcard/HomeControl/mockha.enabled` 决定在 `127.0.0.1:8123` 起服务 | 类移到 `app/src_debug/`，只有 `-Variant debug` 才编译；`MainActivity` 用反射拿它（release 里类不存在只是打日志）；起服务还要 debug.flag | 用 zipfile 读 dex：debug 含 `Lcom/homecontrol/panel/MockHaServer;`，release **不含**；两个包都含 `assets/certs/*.pem` + `assets/panel/*`（10 个 asset） |

### P0 可靠性（上墙设备的两个「整夜在跑」问题）

| # | 问题 | 处置 | 证据 |
| --- | --- | --- | --- |
| R1 | **看门狗在熄屏时变成 reload 风暴**：Activity 带 `SHOW_WHEN_LOCKED|TURN_SCREEN_ON`，熄屏后它仍是 resumed、没有 `onPause`；Doze 冻结 WebView 的 JS 定时器（心跳在 `panel/js/app.js` 的 `setInterval(heartbeat,4000)`），于是每 45s 判「卡死」→ `web.reload()`。旧版在 Pad 5 上静置 10 分钟重载了 9 次（`00:46:21 → 00:56:52`），每次重载还会把 localStorage 的编辑布局抖一遍 | `MainActivity.java:446 startWatchdog` + `:481 screenInteractive()`：熄屏直接跳过并更新 `lastBeat`；新增 `everBeat`/`loadedAt` 首帧门控（`FIRST_BEAT_MS=180000`） | ① 旧行为复现：`?selftest=hang` → `watchdog: no heartbeat for 45s, reloading`；② 新行为：`input keyevent 26` 熄屏静置 110s → HomePanel 日志 24 行里 **0 条 watchdog/reload**，自注册的 `rest POST /api/states/…` 每 60s 仍在跑 |
| R2 | 首帧慢会被看门狗打断：`first states` 实测可到 35s（deploy 的验收轮询也按 40s 等），45s 阈值会把正在启动的页面 reload 掉，于是永远起不来 | 首帧前不判卡死，只给 180s 绝对上限 | `first states 460ms · 实体 1264`（真实 HA），启动期无 reload |
| R3 | `scheduleRetry` 无限重试（3s×3 之后每 10s 到永远）：网络不通时设备整夜重试，logcat 刷满，且永远停在白屏 | `MAX_RETRY=10` 后停在横幅「已停止自动重试（连按两次返回键进系统设置检查网络与 url.txt）」并 return | 断网场景停在横幅而不是无限重试 |
| R4 | `/sdcard` 是 symlink，canonical 解析成 `/storage/emulated/0/HomeControl/`；和常量 `CONFIG_DIR="/sdcard/HomeControl/"` 直接比前缀会把**所有**读写判死 | `configRoot()` 对 `CONFIG_DIR` 取 canonical 并补尾斜杠，缓存进 `configCanon` | 第一次部署后 logcat 每 1.5s `mtime denied: /sdcard/HomeControl/panel/.rev`、实体掉到 39（模拟数据）；修后实体 1262/1264、0 条 denied |

### P0 JS（两处，都在真机上跑过回归）

| # | 问题 | 处置 | 证据 |
| --- | --- | --- | --- |
| J1 | **原生 REST 回调是全局单槽**：`backend.js` 的 `window.__restCb` 每次 `rest()` 都被覆写，id 不匹配的响应静默丢弃。并发场景（温湿度曲线一次发 N 条 `restHistory`；自注册连发 5 个 POST；REST 兜底轮询；`call()` 的 REST 退路）只剩最后一个响应生效 → 被丢的回调永不触发：`sparkBusy[id]` 永久为 1（曲线再也不重试）、`call()` 的 Promise 永不 settle（失败回滚与 undo 不执行） | `panel/js/backend.js`：模块级 `var restCbs = {}`，`window.__restCb` 只装一次并按 id 查表删除；`fin(ok,code,data)` + done 守卫 + 12s 超时放手；Java 契约不变（`MainActivity.java:883 rest` 仍回调 `window.__restCb(cbId,out)`） | `node tools/check-rest.js`：修前并发 5 个 GET → `{"got":1,"codes":[200]}`（bug 是真的），修后 → `{"got":5,"codes":[200,200,200,200,200]}` REST OK |
| J2 | **Chromium 57 语法门禁自己是瞎的**：`tools/lint-es5.js` 的 `strip()` 把正则字面量里的引号当字符串起点（`/[&<>"']/g` 出现在 `app.js:58`、`music.js:68`），吞掉到下一个引号之间的全部代码——`app.js` 4469 行被剥成 **1309 行**，`app.js:1057-1061` 的 5 个 SELF getter 实测 0 命中 → 门禁报全 PASS 是假象；且 strip 吞换行，报错行号对不上原文 | 重写 `strip()`：按 prevChar + 关键字白名单判「除法 vs 正则」（`[\w$)\]]` 之后视为除法；方括号内的 `/` 不算结束；遇换行退回除法），并保留换行 → 行号与原文一一对应；行数变了就打 `BUG … 行号不可信` 并计失败。规则拆成 RULES（57 会报错/静默失效：`??`、`?.`、async/await、`Object.entries/values/fromEntries`、`flat/flatMap`、`Promise.allSettled/any`、`.finally`、`.matchAll`、`.replaceAll`、`findLast/findLastIndex`、`.at`、`globalThis`、`BigInt`、`import/export`、`for...of`）与 NOTES（箭头函数/class/const/let/`...`/Map/Set/getter/includes：57 能跑，只是不合风格，不算失败）。支持 `node tools/lint-es5.js <文件>…` 单查 | `ALL PASS (6 files, 0 modern-syntax hit, 5 style note)`；5 条 note 全在 `app.js:1057-1061`（SELF 的 getter，ES5 合法） |
| J3 | 音乐封面：每解析一张封面就把 base64 永久存进 `item.cover`，并且立刻 `paintNow()+paintList()` 整表重建 → N 张封面 = N 次全量重绘；配合 `LIB_MAX_ROWS=1500` 能在 512MB 的 MI PAD 2 上攒几十 MB 字符串 | `panel/js/music.js`：`COVER_CAP=60` + `coverOrder[]` LRU（`evictCovers()` 把最老的非当前曲清成 `cover=''`）+ `queueCoverRepaint()`（250ms 合并成一次重绘） | `node --check` 通过；真机 push 后 `JSB ACT first states 314ms · 实体 1264`、面板正常。**没做**行级 `img.src` 定位（需要 `data-idx` 映射，改动更大，见 §4） |
| J4 | `adjustTemp` 的 `if (noTemp)` 分支是从 `climateSheet` 粘进来的弹层 markup：引用本函数里不存在的 `st/cur/modeHtml/fans`，而且**动作函数**返回 HTML 字符串 → 没有设定温度的空调点一下加减号必 `ReferenceError` | 改成 `toast('这台空调没有可调的设定温度，用弹层选模式')` + `return`；`__PANEL_TEST__` 多导出一个 `adjustTemp` 以便真机验证 | `node tools/check-temp.js <serial>` → `{"err":null,"ret":"undefined","toastText":"这台空调没有可调的设定温度，用弹层选模式","toastShown":true}`，TEMP OK（真机 MI PAD 2，热更新后的 `/sdcard` 副本） |
| J5 | `app.js` 开头有一段**粘贴事故区**（原 `:205-255`）：重复的 `hasBrightness`（原 `:76`）、重复的 `COLOR_PRESETS`（原 `:87`）、`esc()` 函数体里嵌了三个死函数 `svg`/`supportedModes`/`hasColorTemp`、四个多余的 `}`。值相同所以当下不崩，但缩进已毁、影子声明容易改错（改一处另一处仍生效） | 整段删除（−51 行），保留 `:57`/`:76`/`:87` 的原定义 | `node --check` 通过；`lint-es5.js` `ALL PASS`；`test-ui.js` `ALL PASS (215 checks)`；真机 `first states 252ms · 实体 1264` |
| J6 | boot 里 `editBtn` 的 click 接线被嵌在 `if (el.gear)` 块内 → gear 不存在时**编辑按钮完全失效**（现在 `index.html` 有 gear，所以是潜伏 bug；接线顺序也被打乱） | `el.gear` 与 `el.editBtn` 拆成两个同级 `if`，缩进复原 | 真机热更新后面板正常，编辑按钮与齿轮各自可用（`editBtn` 的 handler 不再依赖 gear） |

### P1 结构性（tools/ 与构建）

| # | 问题 | 处置 |
| --- | --- | --- |
| T1 | **14 份手抄 WebSocket 握手 + Edge 启动样板**（`e2e-avatar/bulk/pc/pctbar/remove/rename/settings`、`probe-pbar/spark`、`shot-foot/gear/rename/settings`、`sim-shot`），每份各写一遍 WS 帧编解码、`msedge.exe` 路径探测、`/json/list` 轮询 | 全部改 `tools/lib/cdp.js`（CommonJS 共享库：`WS`、`adb`/`adbOut`、`httpGet`、`findEdge`、`openEdge`、`waitTarget`、`connectWebView`、`evaluate`/`wait`/`screenshot`/`closeAll`）。净删 **1353 行**，加 224 行；14 个文件 `node --check` 全绿；端口与 profile 保持原值；断言与 argv 语义不变 |
| T2 | `lib/cdp.js` 在真上的两个坑：① Android 5.1/Chromium 57 的 `/json/list` **不给** `webSocketDebuggerUrl`（只给 id）→ `new URL(undefined)` 抛 `TypeError: Invalid URL`；② Android 5.1 没有 `pidof` | `waitTarget` 接受 `webSocketDebuggerUrl || id`，`connectWebView` 按约定拼 `ws://127.0.0.1:<port>/devtools/page/<id>`；pid 先试 `pidof -s`，失败回退解析 `ps` 第二列 |
| T3 | `WS.call` 没有超时：平板重启后旧 socket 不再回帧 → 脚本永远挂住（这次 `check-tls` 就是这么挂的） | `call(method, params, timeoutMs)` 默认 20s，超时抛 `CDP 超时 …（平板上的面板进程可能已重启，重连一次）` |
| T4 | 硬编码路径：`build.ps1` 写死 android-sdk/build-tools/JDK，`deploy.ps1`/`push.ps1`/`verify.ps1`/`smoke.ps1` 各自写死 adb | 新增 `tools/env.ps1`（`$AndroidSdk/$BuildTools/$AndroidJar/$JavaHome/$Javac/$Keytool/$Adb/$Fastboot/$Device`；`HC_ANDROID_SDK`/`HC_BUILD_TOOLS`/`HC_JAVA_HOME`/`HC_ADB`/`HC_DEVICE` 可覆盖；找不到就 throw 指名该设哪个变量），四个脚本都 dot-source 它 |
| T5 | `push.ps1` 重写了一遍 `deploy.ps1` 的推送逻辑（两份会漂移） | `deploy.ps1` 复用 `push.ps1`；两边都支持 `-Serial`（命令行优先，否则 `$env:HC_DEVICE`/`ANDROID_SERIAL`）、`-Prod`（删 debug.flag + url.txt） |
| T6 | `targetSdk 22` 在 Android 13 上要手工 `pm grant`，全仓库没有一处 `pm grant`（装完面板读不到 `/sdcard`，只在 MIUI 权限页里靠人手点） | `push.ps1`/`deploy.ps1` 按 SDK 分流授权：`ro.build.version.sdk -ge 23` 才 `pm grant`（Android 5/6 没有运行时权限，`pm grant` 会报错，旧版把它算成 FAIL）；`deploy.ps1` 用 `dumpsys package` 断言 `WRITE_EXTERNAL_STORAGE granted=true` |
| T7 | `panel/` 与 `app/assets/panel/` 都被 git 跟踪 → 两份副本可以各自漂移且没人发现（构建每次都 wipe assets） | `git rm -r --cached app/assets/panel`（8 文件）+ `.gitignore` 加 `app/assets/panel/`、`app/assets/certs/`、`tools/build/`；`lint-es5.js` 仍然比对两边一致性（构建后应一致） |
| T8 | 一次性死脚本（`patch-version-39..47.js` 只是把 `build.ps1 --version-code N-1`→N 再改一行 README；`patch-theme-*`×6；`patch-ha-self.js`、`patch-tile-power.js`；`cdp57{,b,dbg,ev}.js` 4 份近重复的无-Origin WS 绕行；`cdp-ws.js/.ps1`；`name-report.js`） | 全部删除（git 历史保留）。版本号改由 `build.ps1 -VersionCode/-VersionName` 参数决定；主题补丁已落地在源码里；调试通道改走 `lib/cdp.js` |
| T9 | 仓库杂物：根目录 5 张 `pad2_*.png`（~7.4MB）+ `syspkgs.txt`、`tools/build/edge-rm`（~10MB Edge user-data-dir）、两个 probe png、工作树里的同步冲突副本 `app_UNKOWNPLAYER_…_Conflict.js`（202KB） | 删掉截图与杂物；冲突副本移到 `backup/conflict-copies/`（是另一个会话的产物，不直接删）。**必须移走**：`aapt2` 报 `error: failed to open file` 导致 link 失败——assets 里任何多余文件都会进 APK |
| T10 | `appVersion()` 标了 `@JavascriptInterface` 但是包级私有 → JS 永远看不到它（只在 `info()` 内部用） | 去掉注解（留着会让人以为它是对外接口） |
| T11 | 锚证书放在 `app/assets/certs/`（构建会 wipe assets）→ 每次构建就把锚删掉；而且下载回来的两个 PEM 其实是**损坏的**（内容是 `RS2R2R2…` 交错文本，`CertificateFactory` 报 `Could not parse certificate: Empty input`，设备侧 `tls anchors: 0`，于是「真校验」永远失败） | 锚移到源真相 `app/certs/`（`build.ps1` 负责拷进 assets），重新用 python `urllib` 按原始字节下载（1939B / 790B，正确 PEM 头 `-----BEGIN CERTIFICATE-----`）；修后设备 logcat `tls anchors: 2` |

---

## 2. 现在的验证矩阵（一次跑完）

```powershell
node tools\lint-es5.js          # 6 文件 0 命中 + assets 一致性
node tools\lint-css.js
node tools\test-ui.js           # 渲染规则
node tools\test-ha.js           # 协议离线
powershell -File tools\build.ps1                      # debug（含假 HA）
powershell -File tools\build.ps1 -Variant release -OutName homecontrol-release.apk
powershell -File tools\deploy.ps1 -SkipApk -Serial A3P4661B1BA6
node tools\check-security.js A3P4661B1BA6             # SECURITY OK
node tools\check-rest.js A3P4661B1BA6                 # REST OK（并发 5 个都回调）
node tools\check-tls.js A3P4661B1BA6                  # TLS 三条判定
node tools\check-temp.js A3P4661B1BA6                 # TEMP OK（没设定温度的空调）
powershell -File tools\smoke.ps1 -Serial A3P4661B1BA6
powershell -File tools\verify.ps1 -Serial A3P4661B1BA6
```

已实测通过：SECURITY OK 9/9、REST OK 5/5、TLS 三条判定、TEMP OK、`first states 460ms · 实体 1264`、`tls anchors: 2`、release dex 不含 `MockHaServer`；正式部署（release 包 + `-Prod`）下 `loadPanel file:///android_asset/panel/index.html`、`first states 437ms · 实体 1264`、`/proc/net/unix` 里没有 devtools socket、`netstat` 里没有 8123/9222。

---

## 3. 有意不动的东西（审计说「这是对的」，别顺手改）

- `backend.js`：增量 `emitEntity` 浅拷贝（`:191-200`）、指数退避（`:119-126`）、连接超时（`:82-87`）、REST 兜底梯子（`:102-105` + `:306-331`）、`onclose` 全清（`:89-106`）。改回调表时没动这些。
- `app.js`：`renderGrid` 的 sig 增量（`:1436-1445`）、`updateTile` 「变了才写 DOM」（`:822-938`）、`setBarPct` 守卫（`:523`）、`gridClassOnly`（`:1424-1434`）、`pctHold` 1.2s 防抖（`:894-900`）、`bindDim` 唤醒重装 timer（`:3083-3110`）、`pixelShift`（`:3064`）、`tick` 的 `textContent` 守卫（`:2786-2790`）、`whoSig` 防头像重载（`:2871-2892`）、自注册回环守卫（`:1087-1093`，靠 `last_updated` + 2000ms，**别改成只比对值**，实测防的是面板与 HA 互相来回拨）。
- Chromium 57 的防御式写法：手写 `hasClass/closest`（`:293-306`）、曲线用 `innerHTML` 拼 SVG（`:655-656`）。
- 音乐负一屏：`EDGE_PULL` 64px + GRABBY 名单（`music.js:1594-1619`）、`bindDrag` 双路（`:1742-1785`）、服务端随机批（`:704`）、recent 去重（`:1119`）、`startTick` 自停（`:926-929`）。
- 1×½ 半高卡片全套（`tileHtml`、`cellRows` 分桶、`setColumns` 半行单位、grip `stepY`、snap `.5`）——另一个会话正在改这块，本次重构没碰 `app.js`/`app.css`。
- 仓库侧密钥卫生：`ha.json` 与 `syspkgs.txt` 未进仓库，只提交 `ha.json.example`；README/docs 里没有明文令牌；`*.apk` 忽略。这条本来是对的，不用改。

---

## 4. 还没做（按优先级，含为什么现在不动）

### A. `app.js` 的结构性问题：三处已修（J4/J5/J6），剩下的是模块拆分

三处粘贴/接线事故本轮已修并真机验证（见 §1 的 J4/J5/J6）。删掉那 51 行后 `app.js` 从 4468 行变成 4417 行，**下面的行号要重新定位再做搬迁**（1×½ 卡片也在改这个文件，行号会继续漂）：

1. 模块拆分（纯搬迁，共享状态仍挂在 `window.HC.S`；`__PANEL_TEST__` 导出指向搬迁后的函数保住测试；`index.html` 脚本顺序不变 = 零行为差异）：
   `hc-util.js`（`esc/svg/num/clamp/hasClass/closest`，`app.js:57-330` + `music.js:68/:1901` 去重）→
   `hc-theme.js`（LAB tone 引擎 + `applyTheme/isLight`，`app.js:1036-1223`，顺手删 `legacyThemeAcc`）→
   `hc-store.js`（prefs/hidden/room/edit/names + music 的 vol/mode 缓存，读写统一含 try/catch）→
   `hc-grid.js`（`itemsFor/cardSpan/cellRows/setColumns/renderGrid/tileHtml/updateTile`，`app.js:1323-1507`、`741-939`，1×½ 原样搬）→
   `hc-sheet.js`（弹层 markup + 滑条，`app.js:2433-2780`）→
   `hc-self.js`（自注册 `:1046-1135`）→ `hc-dim.js`（`:2990-3110`）→ `hc-settings.js`（`:3115-3900`，音乐设置 UI 挪到 music 侧）→ `hc-gestures.js`（`:4027-4270`）。
   `backend.js`/`music.js` 已经自带边界，不用拆。

### B. 设备侧凭据还在世界可读目录里

`/sdcard/HomeControl/ha.json`（长期 HA 令牌，`exp≈2109284981` ≈ 2036）与 `music.json`（道理鱼账号密码）是 `rw---- root:sdcard_r`，同设备的其它 app 走 MediaStore/存储权限能读到；`push.ps1`/`deploy.ps1` 也把它们推到那里。

要改的两处，工作量中等，所以本轮没做：
- 配置搬到 app 私有目录（`getFilesDir()`）：要同时改 `app.js:3152/:3186/:3175`、`music.js:166/:204`、`push.ps1` 的推送路径、以及「平板上自己改配置」的弹层（长按状态胶囊 → 写 `ha.json`）。面板与 `adb push` 都要能读写。
- HA 令牌换成可吊销的短期令牌（现在这个一签就是几十年，泄露了只能重建整个令牌）。

### C. `MainActivity` 仍是上帝类（~1085 行，10 个职责）

本轮把 TLS 抽成了 `TlsPolicy.java`，其余还在一个类里。建议的拆分（不改行为，按 §3 的清单逐块搬）：`PanelWebView`（`:144-257`）/ `PanelBridge`（`:566-1107`）/ `HttpGateway`（`:817-1107`）/ `Watchdog`（`:446-495`）/ `DevUrlResolver`（`:259-295`）。注意 `Bridge` 的方法名是 JS 侧的契约，改名要同步改 `panel/js`。

### D. 音乐封面只做到「合并重绘 + LRU」，没做到行级更新

`music.js` 现在仍是合并成一次 `paintNow+paintList()`（每 250ms 最多一次），不是逐行 `img.src`。彻底做法要给每张行加 `data-idx` 映射再定位单行——改动更大，且 512MB 设备上现在的上限是 60 张封面（≈几 MB），先够用。

### E. 工具脚本里剩下的硬编码像素与破坏性动作

- `smoke.ps1` 用固定像素点击（`:66/:69`）→ 换分辨率就点错。改成 `uiautomator`/按标签定位。
- `verify.ps1:46` 的 `adb reboot` 是破坏性的（文档里已注明是「上墙验收」的一部分，但它会真重启设备）→ 加显式确认或 `-Reboot` 开关。
- `docs/HANDOVER.md` 里 45s 看门狗的旧描述、`tools/` 的脚本数量、APK 尺寸与版本号都已按新事实改写；`docs/USAGE.md` 里如果有同样的 45s 描述，下次上墙验收时一并核对。

### F. `tools/build/` 里的 Edge user-data-dir 会重新长出来

`build.ps1` 只清根 `build/`，Edge profile 在 `tools/build/edge-*`。`lib/cdp.js` 的 `openEdge` 每次用 `build/edge-<port>`（已 gitignore）。清理策略：跑完脚本 `closeAll()` 后 `rmSync` profile（`sim-shot.js` 已有），其它脚本沿用同一做法。

---

## 5. 踩过的坑（下次别再踩）

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `build.ps1` 报 `error: failed to open file`（link 失败） | assets 里有非 UTF-8/中文名的冲突副本 | 任何 `app/assets` 下的多余文件都会进 APK——把冲突副本挪到 `backup/`，别留在 `panel/` |
| .ps1 报 `Unexpected token` / `The string is missing the terminator`，中文变乱码 | Windows PowerShell 5.1 读无 BOM 的 UTF-8 ps1 会按 GBK 解析（`write`/`edit` 工具会丢 BOM） | 改完 .ps1 补 BOM：`[System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($true))` |
| 看门狗日志每 45s 一次 reload | 熄屏 + Doze 冻结 JS 定时器，且 Activity 因 `SHOW_WHEN_LOCKED` 没有 `onPause` | 先查 `dumpsys power` 的 `mWakefulness`，别先怀疑页面卡死 |
| 截图全黑 | 屏幕熄了（`screen_off_timeout=120000`） | `input keyevent KEYCODE_WAKEUP` 再截；唤醒 tap 可能落到系统通知页，别盲点坐标 |
| PowerShell 里 adb 命令变成打印 adb help | 函数参数名 `$args` 被自动变量吞掉（`$args -join ' '` 为空） | 参数名用 `$arglist` |
| `node` 里 `spawnSync` 拿不到 adb 输出 | 沙箱不允许管道 stdio；`os.tmpdir()` 在工作区外也被拒 | `{stdio:'ignore'}` + 把输出重定向到工作区内的文件（`ROOT/build/`）；可执行路径带空格时加引号，但 cmd 行里加引号会静默无输出——按空格判断再加 |
| 临时备份消失 | `build.ps1` 会 wipe `build/` | 设备配置备份放 `backup/`，不放 `build/` |
| `Get-Content` 读 UTF-8 中文变乱码 | PS 5.1 默认按 GBK | `[System.IO.File]::ReadAllText($p,[System.Text.UTF8Encoding]::new($false))` |
| `adb install -r` 打印「Performing Push Install」然后什么都没装成，进程还跑着旧代码 | 老 adb 在 Android 5.1 上是「push 到 /data/local/tmp 再 `pm install`」，失败不体现在退出码里（本次是 `INSTALL_FAILED_VERSION_DOWNGRADE`：设备上装了 48，新包默认 47） | 装完必须 `adb shell dumpsys package <pkg> | Select-String versionCode` 核对；要发新包就升 versionCode（`build.ps1` 默认值即当前版本）；显式安装用 `adb push apk /data/local/tmp/hc.apk` + `adb shell pm install -r /data/local/tmp/hc.apk`（会打 `Success` / `Failure [...]`） |
| `build.ps1` 一跑就 `Cannot bind argument to parameter 'Path' because it is null`（stdout 一行没有） | 文件丢了 BOM，PS 5.1 按 GBK 解析，`$PSScriptRoot` 那行被 mojibake 打断（`edit`/`write` 工具会丢 BOM） | 改完 .ps1 立刻补 BOM（同上一条）；本轮已对 tools/*.ps1 全量补过 |
| `check-rest.js` 报 `{"got":1,"codes":[200]}`、`check-temp.js` 报「没有 `__PANEL_TEST__.adjustTemp`」，但仓库里的代码是新的 | **`adb push <目录> <已存在的目标目录>` 会把目录本身放进去** → `/sdcard/HomeControl/panel/panel/`，真正被读的 `panel/js/*` 还是旧副本 | 推目录内容用 `panel\.` 形式（`push.ps1` 就是这么写的）；自己临时写脚本时别写 `push panel …`；改完先 `grep -c restCbs /sdcard/HomeControl/panel/js/backend.js` 确认副本真的更新了 |
| 面板一直加载 `file:///android_asset/panel/index.html`，改的代码没跑到 | `adb shell "echo … > /sdcard/HomeControl/url.txt"` 经 cmd 转手时**重定向不生效**，url.txt 没落盘（而 `debug.flag` 落盘了，所以看着像"开了调试但没生效"） | 设备上写文本文件用 `adb push <本地临时文件> <路径>`；验证看 logcat `url from /sdcard/HomeControl/url.txt: …` |
| 临时脚本/备份跑一半就没了 | `build.ps1` 会 wipe `build/`（本轮就把 `build/dev-verify*.js`、`build/probe-state.js` 抹掉过两次，第二次报 `Cannot find module`） | 临时脚本放 `backup/tmp/`，设备配置备份放 `backup/`；`tools/lib/cdp.js` 的 `adbOut` 中转文件仍在 `ROOT/build/`（构建之后会重建目录，不影响） |
| `node tools/check-*.js` 打印完结果后进程还活着十几秒 | `WS.call` 的 20s 超时定时器吊住 event loop | 不是错误；批量跑时每条单独跑并直接读 stdout（PowerShell 的 `Select-Object -Last N` 会把输出缓冲到进程退出，看着像"卡住"） |
| `probe-globals.js` 里 `typeof window.__PANEL_TEST__` = `object`，但脚本判定它是 undefined | 判断写成了 `window.HC && window.HC.__PANEL_TEST__`——这个面板没有 `window.HC` 这个全局，测试对象直接挂在 `window.__PANEL_TEST__` | 测试钩子取 `window.__PANEL_TEST__`（`tools/check-temp.js` 已改成这个） |
| `build.ps1` 报 `Cannot bind argument to parameter 'Path' because it is null`（这次不是 BOM） | DSH 文件沙箱会把写进 `build/` 的文件做成 **reparse point**（`Attributes` 带 `ReparsePoint`、`Target` 为空），`Remove-Item -Recurse` 遍历到它们的空目标就中断 | 已修：逐项删并跳过 reparse point（`tools/build.ps1` 第 38 行附近）；`unsigned.apk`/`aligned.apk` 先 `Remove-Item` 再 `Copy-Item`，否则 `ZipFile::Open(Update)` 报 `being used by another process` |
| release 包里居然有 `MockHaServer` | debug 与 release 共用 `build\classes`，沙箱让那个目录删不干净，上一轮 debug 的 `.class` 被一起 dex 进去 | 已修：变体各用一套中间目录（`build` / `build-release`，后者已加进 `.gitignore`）；每次发版用 python 读 `classes.dex` 断言 `Lcom/homecontrol/panel/MockHaServer;` **不在** release 里 |
| javac 报「内部类 MainActivity.Bridge 中的静态声明非法」 | 把 `contentLength()` 写成了 `private static`，而 `Bridge` 是**非静态**内部类 | 改成实例方法（内部类能直接调外层实例方法）；Java 8 + SDK 22 的约束要一起守 |
| javac 报「字符文字的行结尾不合法」 | node 一次性脚本里用模板字面量写 Java 的 `'\n'`，`\n` 被 JS 展开成**真换行**，字符字面量被劈成两行 | 往 Java 源码里写转义要写 `'\\n'`；改完立刻 `build.ps1` 编译验证，别等真机 |
