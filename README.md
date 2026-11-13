# HomeControl · 小米平板2 中控屏

一块挂在墙上的 Home Assistant 中控屏：自研轻量 Web 面板 + 极简安卓壳，跑在 **MI PAD 2**（Android 5.1 / WebView Chromium 57 / x86_64 / 2GB RAM，未 root）上，风格参考米家。

## 目录

```
panel/                 面板前端（纯静态、无构建链、ES5，兼容 Chromium 57）
  index.html
  css/app.css
  js/config.js         模拟数据定义 + HA 配置占位
  js/icons.js          线性 SVG 图标
  js/backend.js        MockBackend + HABackend（HA WebSocket 客户端）
  js/layout.js         按 HA registry 自动生成房间 / 卡片 / 场景键
  js/app.js            渲染、弹层与交互
  js/music.js          负一屏音乐页（演示 / 道理鱼 / Subsonic 三种音源）
app/                   安卓壳（Java，minSdk 21 / targetSdk 22；正式变体不含 app/src_debug）
app/certs/             TLS 锚（ISRG Root X1/X2），构建时拷进 assets/certs
tools/
  env.ps1              集中解析 SDK / build-tools / android.jar / JDK / adb / 默认设备（可用 HC_* 覆盖）
  build.ps1            手工构建 APK（aapt2 + javac + d8 + zipalign + apksigner；-Variant debug|release / -VersionCode / -VersionName / -OutName）
  deploy.ps1           装 APK + 推面板 + 重启 + 自检（-Build / -Mock / -SkipApk / -Prod / -Serial）
  push.ps1             推面板到 /sdcard/HomeControl/panel 并重启 App（-Restart / -Mock / -Prod / -Build）
  verify.ps1           上墙验收：设备/安装/默认桌面/重启自动拉起/无脚本错误，产出 docs/verify-report.md
  smoke.ps1            上机冒烟：推面板→重启→查 page finished/无 JSBERR→点一张卡→查 ACT 日志
  lib/cdp.js           共享 CDP 客户端（Edge 与设备 WebView 两条路；e2e/shot/probe 都用它，别再手抄 WS 握手）
  lint-es5.js          Chromium 57 语法闸门（Chrome 57 会报错的写法 FAIL；能跑但不合风格的走 note）
  lint-css.js          CSS 闸门：Chromium 57 不生效但不报错的写法（布局会悄悄变形）
  test-ha.js           协议 + 自动布局单测（假 HA 跑在 Node 里，WS + REST + history + registry）
  test-ui.js           PC 侧 UI 回归（Edge headless + CDP）
  check-security.js    真机上验 JS 桥的文件白名单（../ 穿越、目录读取、越权写必须被拒）
  check-tls.js         真机上验 TLS：LAN 直通、公网 Let's Encrypt 走自带锚、自签与域名不匹配必须被拒
  check-rest.js        真机上验原生 REST 回调表：并发 5 个请求必须全部回调
  fake-ha.js           零依赖假 HA（WebSocket），可单跑，也被单测复用
  fake-daoliyu.js      零依赖假「道理鱼」音乐服务（REST + WAV + SVG 封面），负一屏联调用
  sim.js               PC 模拟器（默认只读、拦 POST /api/services/*），配 sim-shot.js 出图
  e2e-*.js             真机端到端用例（改卡片布局/命名/设置等，经 WebView CDP）
  shot-*.js / probe-*.js 真机截图与探针（同样走 lib/cdp.js）
  make-fixture.ps1     生成「真实模式」离线验收用的面板副本
  make-big-fixture.ps1 生成 80 实体压力测试用的面板副本
  fixture-panel-ha.js  验收副本里的样例数据后端（替换 window.HABackend）
  fixture-big-ha.js    压力测试数据后端
  mk-music.js          写 build/music.json（凭据从本地记忆取，不进仓库）
  cdp-run.js           用 CDP 在面板 WebView 里执行一段 JS（调试/验收用）
  real-ha-check.js     连真实 HA 核对实体与房间分类
  devserver.js         PC 侧静态服务（8787），用于 PC 上快速看页面
dist/homecontrol.apk   构建产物
docs/screens/          实机截图（panel-home / panel-config / panel-diag / panel-real-layout / panel-study / panel-cover / panel-climate-heatcool / panel-night-dim / panel-many-rooms 等）
ha.json.example        HA 地址 + 令牌的配置样例
```

## 为什么不用 HA 官方前端

平板的系统 WebView 是 **Chromium 57（2017）**，无 root 无法升级。HA 2023+ 前端依赖 ES2019+/现代 CSS，在这块板上跑不起来。所以面板自研，并遵守实测得出的硬约束：

- 可用：CSS Grid、CSS 变量、fetch、Promise、WebSocket、localStorage、ES6 class、async/await
- 不可用：**flex gap**（用 margin 代替）、**backdrop-filter**、**可选链 `?.`**
- 视口固定 **1024×768 CSS px**（dpr=2）

## 一条命令部署（平板回来时用这个）

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1            # 装 APK + 推面板 + 重启 + 自检
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Build     # 先重新构建
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Mock      # 部署成模拟数据模式
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -SkipApk   # 只改了面板，不重装 APK
```

它会依次做：adb 在线检查（离线时直接告诉你「长按电源键 10 秒」而不是抛异常）→ 装 APK → 推 `panel\` 到 `/sdcard/HomeControl/panel/` → 改写 `url.txt` → force-stop + 启动 → 校验 `page finished` / 无脚本错误 / 前台是壳 App，最后打印 DEPLOY OK。

版本号随构建更新：`versionName 0.7.19` / `versionCode 56`（`build.ps1` 的默认值就是当前版本；发新包就 `-VersionCode 57 -VersionName "0.7.20"` 并同步改这一行，不用再写一次性升版本脚本——装到已装更高 versionCode 的设备上会 `INSTALL_FAILED_VERSION_DOWNGRADE`），诊断页第一行就能看到「版本 0.7.19 · MI PAD 2」。

面板把自己也注册进 Home Assistant（0.7.9）：走 `POST /api/states/<entity_id>`（实测 201，不存在就新建，不需要 MQTT），每分钟报一次 `sensor.homecontrol_panel`（在线状态、型号、App 版本、IP/SSID、皮肤、电量、充电、`last_seen`）、`binary_sensor.homecontrol_panel_connected`、`sensor.homecontrol_panel_battery`、`binary_sensor.homecontrol_panel_charging`、`switch.homecontrol_panel_dark_mode`。那个开关是双向的：面板写自己的皮肤，HA 里把开关拨了，面板跟着换皮肤（`selfWritten` 用来区分「HA 那边改了」和「我们自己写的」，不会自己跟自己打架）。注意 HA 的 REST 建的是实体，不是设备注册表里的设备，所以在 HA 界面上它们归在「未分配设备」下。
## 构建与部署

```powershell
# 构建（路径由 tools\env.ps1 解析：SDK / build-tools / android.jar / JDK / adb，可用 HC_ANDROID_SDK 等环境变量覆盖）
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1                                  # debug 变体，含假 HA + 调试开关
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -Variant release -OutName homecontrol-release.apk   # 正式包：不含 MockHaServer
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -VersionCode 57 -VersionName "0.7.20"   # 发新包：版本号 +1（默认值就是当前版本）

# 安装
adb install -r .\dist\homecontrol.apk

# 开发期：推面板 + 重启 App（约 3 秒出效果，不用重装 APK）
powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Restart
powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Prod     # 生产形态：删掉 debug.flag 与 url.txt
```

调试开关是一个文件而不是编译期常量：`/sdcard/HomeControl/debug.flag` 存在时才开 WebView CDP（:9222）、才读 `url.txt`、才允许起假 HA。开发部署由 `push.ps1` 写这个文件，`push.ps1 -Prod` / `deploy.ps1 -Prod` 删掉它——正式版不该让同网段的人连上调试端口就能往面板里注入 JS（配合下面的文件白名单，那才是真正能越权的路径）。

`build.ps1` 里有个 Windows 专属的坑：`aapt2 link -A` 写进 APK 的资产条目名带反斜杠（`assets/panel\js\app.js`），Android 只认 `/`，于是 `file:///android_asset/panel/index.html` 一律 `ERR_FILE_NOT_FOUND`。第 3b 步会把条目名统一正斜杠再继续打包（构建日志里 `[3b/7] asset entry names normalized (8)`）；改构建脚本时别把这一步去掉。`app/assets/panel/` 与 `app/assets/certs/` 是构建产物（每次 wipe 后从 `panel/` 与 `app/certs/` 拷进来），已 gitignore，别手工编辑。

## 中控屏行为（上墙相关）

- **默认桌面**：壳 App 声明了 `CATEGORY_HOME`，设为默认桌面后开机会直接进面板，不需要解锁或点图标
- **更新 APK 后会掉回桌面**：`adb install -r` 会杀掉正在运行的面板进程，且 Android 5.1 上更新安装不会再收到开机广播，所以装完必须 `adb shell am start -n com.homecontrol.panel/.MainActivity`（或重启设备）
- **上墙验收**：`powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1` 依次检查 设备在线 / 应用已装 / 按 HOME 进面板 / 系统启动完成 / 重启后自动拉起 / 屏幕常亮 / 无脚本错误，结果写 `docs/verify-report.md` 并留重启后截图 `docs/screens/panel-verify.png`
- **使用手册**：docs/USAGE.md（接 HA 的两种方式、日常操作、夜间调暗、诊断页、逃生口、更新 APK 的注意事项）
- **架构**：docs/ARCHITECTURE.md（panel/ 与 Java 壳两层职责、页面地址来源、debug.flag 开关矩阵、MainActivity 职责按行号、TLS 两类主机两套规则、看门狗参数、数据流、构建七步、验证入口）
- **本轮重构**：docs/REFACTOR.md（已修的安全/自愈问题、验证矩阵、有意不动的东西、待办、踩过的坑表）
- **性能**：docs/PERFORMANCE.md（Chromium 57 上没有 CPU profile，改用函数级计时 + MutationObserver + logcat + meminfo；基线数字、批次 A/B/C 每条改了什么、改后数字、有意不动的既有优化、下一轮候选）
- **工具链**：docs/TOOLING.md（每个脚本跑什么、需要什么前提、失败了怎么办；含 env.ps1 变量表与端口表）
- **全屏常亮**：`FLAG_KEEP_SCREEN_ON`，并带 `SHOW_WHEN_LOCKED / DISMISS_KEYGUARD`，锁屏时也能盖上来
- **断线自愈**：JS 心跳 4s；看门狗只在**屏幕亮着**时判卡死（熄屏 + Doze 会冻结 WebView 定时器，老版本因此在熄屏后每 45s 重载一次，整夜不停），首帧前给 180s 宽限（慢网络下 `first states` 实测可到 35s，原来 45s 阈值会把启动中的页面打断）；页面加载失败按 3s / 10s 重试，最多 10 次后停在「已停止自动重试」而不是无限重试
- **逃生口**：1.5 秒内连按两次返回键 → 打开系统设置（恢复原桌面：设置 → 主屏幕 → 系统桌面）
- **配置读取**：`/sdcard/HomeControl/url.txt` 指定页面地址（`file://` 或 `http(s)://`）；`/sdcard/HomeControl/ha.json` 提供 HA 地址与令牌
- **平板内直接配置**：长按右上角状态胶囊 0.8 秒 → 「连接设置」弹层，填地址 + 令牌点「保存并重连」（写入 `ha.json` 后自动 reload）；点「改用模拟数据」删掉 `ha.json` 回到模拟模式。这样上墙后不用再摸电脑
- **夜间 / 空闲调暗**：空闲 90 秒（夜间 23:00–07:00 只需 20 秒）自动压暗全屏，中间留一个大号时间；轻触任意位置唤醒，唤醒那一下不会误触下面的卡片。参数在 `panel/js/config.js` 的 `dim` 段
- **连背光一起调**：压暗时通过 `window.setAttributes()` 把本窗口的 `screenBrightness` 降到 `dim.brightness`（默认 0.35），退出时传 `-1` 恢复系统亮度。只作用本窗口、不需要 WRITE_SETTINGS 权限；夜里是真的不刺眼、也省电，不是只盖一层黑遮罩
- **防烧屏位移**：每 5 分钟把 `#app` 整体随机平移 1~2px（`cfg.burnIn.shiftEverySec` / `maxShift`，`panel/js/app.js` 的 `startPixelShift()`），配合 `scale(1.01)` 盖住边缘。像素级偏移肉眼看不出来，但静态的时钟、卡片边框不会长期压在同一个物理像素上
- **记住房间**：选中的房间存 localStorage['hc.room']，凌晨静默重载 / 应用重启后回到同一个房间，不会跳回「全部」；如果那个房间在真实 HA 里已经不存在，自动回落到「全部」
- **误触撤销**：点卡片开关后，底部提示条给 5 秒「撤销」（`toggle()` 里调 `toast(text,'撤销',fn)`，`fn` 发反向 `turn_on`/`turn_off`）。墙上触摸屏手臂伸过去容易蹭到旁边卡片，撤销比重做一次便宜。整条提示可点——Chromium 57 里 pointer-events:none 的父元素即使子元素设 `auto` 也点不到（elementFromPoint 能命中但事件不派发），所以带动作时给 .toast.act 整条放开
- **亮度条直接拖**：可调光的灯（`light` 且 `supported_color_modes` 含亮度）卡片上有一条 22px 高的进度条，手指按住任意位置就能拖，拖动中每 140ms 推一次 `light.turn_on {brightness_pct}`，本地先改、不跟着 HA 回包抖；关灯时条留在原位画到 0（半透明），一眼看出这盏灯能调。能力判断在 `panel/js/app.js` 的 `pctMeta()`，拖完那一下的 click 会被吞掉，不会顺手关灯
- **顶栏住户头像 + 在家/离家**：「已连接」左边显示 `person.*` 的圆形头像（取 `attributes.entity_picture`，相对路径自动拼上 HA 地址，是公开图所以不需要带令牌；加载失败退回首字母），旁边一句在家人话。`home` → 「在家」（头像描绿环），`not_home` → 「离家」、自定义区域名原样显示、`unknown/unavailable` → 「状态未知」；家里有多个 person 时最多并排 3 个头像，文字显示「2/3 在家」。逻辑在 `panel/js/app.js` 的 `renderWho()` / `whoState()`，头像签名不变就不重绘，1254 个实体的高频回包不会反复重载图片
- **没人在家就熄屏**（设置里 `离家熄屏 · 回家亮屏`，默认开）：判定复用上面那套 `person.*` —— 有人 `home` 亮屏，**全部 `not_home`** 才熄屏，没有 person 实体或全是 `unknown` 时不动屏幕（宁可一直亮着，别把屏关死）。亮屏 = 挂回 `FLAG_KEEP_SCREEN_ON` + 短暂唤醒锁 + 还原原来的自动锁屏值；熄屏 = 取消 keep-on + 把系统「自动锁屏」压到短值（设置里选 2/5/15 秒）+ 试反射 `goToSleep`（多数 ROM 不让用，靠超时）。改系统设置要 `WRITE_SETTINGS`：Android 5.x 装包即有，6+ 要授权一次（设置页有「去系统设置允许」按钮；MIUI 平板 5 那个授权页调不起来，正式部署用 `adb -s <序列> shell appops set com.homecontrol.panel WRITE_SETTINGS allow` 授一次，重装后要重授）。MIUI 不认我们写的超时（它有自己的省电策略）时，过一会儿检查一次：屏幕还亮就把面板压成**全黑 + 背光最低**，等同熄屏，回家自动恢复。回归 `node tools/check-away.js <序列>`
- **房间多 / 实体多**：房间 tab 放不下时自动改为可横向滑动（选中的房间会自动滑进可视区）；某个房间实体超过 8 张时网格改为可纵向滑动，行高固定，不会把卡片挤出屏幕又没法翻。场景键超过 4 个时同样可横向滑动，且场景区最宽只占 46%，不会把房间 tab 挤没
- **诊断页**：长按左上角时间 → 显示模式、HA 地址、令牌（打码）、连接状态、连通测试、房间/卡片/实体数、**设备网络（IP + Wi-Fi SSID）**、视口、内核版本、最近一次 JS 错误；带按钮「重新加载 / 清缓存并重载 / 连接设置 / 回模拟数据 / 关闭」。上墙后不用连电脑就能自己判断问题
- **夜间静默重载**：每天 04:00 自动 reload 一次释放 WebView 内存（2GB 老设备长时间点亮会越用越慢），每天只执行一次，由 `panel/js/config.js` 的 `reloadHour` 控制（设 `null` 关闭）

### 重启/断网后的自动恢复

挂墙设备最常遇到的不是「连不上」，而是「刚开机那一分钟连不上」：面板比 WiFi 先起来，WebSocket 会拿到 `ERR_INTERNET_DISCONNECTED`。

处理方式（都在 `panel/js/app.js` 的 `boot()` 里）：

- 监听 `window` 的 `online` 事件 → 立刻 `S.backend.reconnect()`，有网就重连，不等指数退避（退避最长 15 秒）
- 每 5 秒检查一次：真实模式、未连接、且距上次主动重连超过 20 秒 → 再 `reconnect()` 一次，避免卡在旧状态
- 壳 App 另有 45 秒心跳看门狗：页面假死会整页重载

实测：重启后面板 33 秒自动出现；WiFi 晚到时页面先显示「正在连接 Home Assistant…」，网络就绪后约 26 秒内自动连上，无需人工干预。

## 负一屏（屏幕左边缘往右滑 · 音乐）

从**屏幕左边缘**（手指出手点在左边 64px 以内）往右滑拉出负一屏音乐页：左边是正在播放（封面 / 歌名 / 歌手 / 专辑 / 三行歌词 / 进度条 / 播放暂停·上下首·播放列表·随机·循环 / 音量），右边是歌单和曲目（点一首就播）。左滑、点左上角返回、或点弹层外收起；在歌单里点返回回歌单列表，在「播放列表」里点返回回上一屏。

- **歌词**：走道理鱼 `GET /api/tracks/{id}/lyrics`（带 Bearer），只显示当前行 ±1 共三行，当前行高亮；有时间轴的跟随进度，纯文本歌词按进度比例大致定位并标「纯文本歌词（没有时间轴）」，没有歌词就不占位。
- **播放列表 / 随机 / 循环**：下一首右边三个小按钮。播放列表把右列换成按播放顺序排的队列（当前曲在最前，带序号，点任意一首直接切）；随机打乱顺序（当前曲排最前）；循环按钮三档——关 / 整个列表循环 / 单曲循环。三个状态存在 localStorage `hc.music.mode`，重启后保持。上一首在播放超过 3 秒时先回到本曲开头。
- **所有歌曲**：歌单列表第一行是「所有歌曲 · N 首 · 分页加载」（`GET /api/tracks?skip=&take=120`），滚到底自动续装下一页（最多先渲染 1500 行，底部提示还有多少没装进来）。全库随机不拉 5002 条：按 `GET /api/tracks/random?count=100` 取一批，去掉最近播过的（localStorage `hc.music.recent`，窗口 240 首），从批里取下一首；批用完再要下一批。「播放列表」在全库随机模式下显示的就是这批的余量（最多 40 行），所以能提前看到接下来要播什么。
- **音量条控制的是安卓系统媒体音量**（`AudioManager STREAM_MUSIC`，桥方法 `getVolume` / `setVolume`，flag 0 不弹系统音量条），面板里 `<audio>` 固定满档，所以墙上平板的总音量就是这根滑条；没有桥时退回音频自身音量。

手势只在左边缘生效是有意的：屏幕中间的卡片亮度条、房间/场景那两条横向滚动条、设置弹层里的滑条都要自己横着拖，之前的版本「哪里往右滑都能拉出音乐页」，一拖亮度就误开。


支持的音源（设置页 → 负一屏 → 「道理鱼 · 设置」里切换）：

| 音源 | 说明 |
| --- | --- |
| 演示 | 内置 3 个歌单 + 合成音源，不联网；首次上墙默认就是这个 |
| 道理鱼 | 自家 REST：`POST /api/auth/login` 换 token，`/api/playlists/web/mine` 取歌单，`/api/playlists/{id}/tracks` 取曲目，`/api/cover`、`/api/tracks/{id}/stream?token=` 取封面和音频。地址只填到端口（如 `http://10.10.1.7:4000`），不要带 `/api` |
| Subsonic | Navidrome / Gonic / AirSonic 等兼容服务，`/rest/*` + `u/p=enc:<hex>` |

道理鱼不是 Subsonic 兼容服务（`/rest/*` 会 404），所以走的是它自己的接口；接口若有变动，只改 `panel/js/music.js` 里的 `DaoliyuBackend`。

配置优先级：`/sdcard/HomeControl/music.json` → localStorage `hc.music` → `config.js` 里的 `PANEL_CONFIG.music`。面板里点「保存并连接」会同时写 `music.json`，所以重启、重装都不会丢：

```powershell
adb push music.json /sdcard/HomeControl/music.json
# {"kind":"daoliyu","baseUrl":"http://10.10.1.7:4000","user":"you@example.com","pass":"***"}
```

几个实现细节：

- `file://` 页面里 XHR 会被 CORS 拦（道理鱼不返回 `Access-Control-Allow-Origin`），所以所有接口请求都走壳 App 的原生桥 `AndroidBridge.httpReq(cbId, method, url, headersJson, body)`，回调 `window.__musicHttpCb(id, {'{'}status,body{'}'})`；`<audio>` / `<img>` 不受 CORS 限制，可以直接用
- 道理鱼的封面 `GET /api/cover?path=…` **必须带 `Authorization: Bearer`**（`?token=` 不认），而 `<img>` 加不了请求头 → 走原生桥 `AndroidBridge.httpBinary(cbId, method, url, headersJson)` 取字节转 base64 的 `data:` URI（`window.__musicBinaryCb` 回调，同一 URL 只取一次）
- 曲库是 FLAC（一首 85MB，平板放不动）：按曲目格式选流 —— mp3/m4a/aac/wav/ogg 直接 `/api/tracks/{id}/stream?token=`，其余走 `/api/tracks/{id}/transcode?token=&format=mp3&bitrate=192`；万一播放失败再退一次转码
- `WebViewClient.onReceivedSslError` 按**主机范围**放行（不是无脑 `proceed()`）：Android 5.1 的 WebView（Chromium 57）信任库里没有 Let's Encrypt 的 ISRG 根证书，音频流与 WebSocket 走 WebView 自己的网络栈（Java 桥的 `TlsPolicy` 管不到它），不放行就播不出歌、也没有实时推送。放行只限局域网 + 面板自己配置的服务器（`ha.json` 的 url、`music.json` 的 `baseUrl`（也认旧键 `base`）、弹层里填的地址），没配过的域名一律 `cancel()`；错误码不看（Chromium 57 对同一张证书在页面里报 2、在 WSS 握手里报 3，分类不可靠）。真校验在 Java 侧：`TlsPolicy` 逐环验签 + 有效期 + 主机名（实测 badssl 被 Java 侧 `SSLHandshakeException: untrusted root` 拒掉）
- 还有一条**运行时放行**：原生桥（REST / `httpReq` / `httpBinary` / 开机探活）请求成功时，把那个 https 域名记进 `verifiedHosts`（上限 8，跳过局域网），日志 `ssl allow (verified by bridge): <host>`。意义是「我们自己的证书校验已经通过过这个域名」，所以 WebView 同一主机的音频流也就放行了——音乐只在设置弹层里配过（只写进 localStorage，设备上并没有 `music.json`）也能播。平板 2 上「获取音乐地址失败」就是这两处：`music.json` 读的是 `base` 而设置存的是 `baseUrl`，加上没有运行时放行，音频流一直 `ssl error cancel`。
- 拖动时页面**不**先置 `open`，松手后按位移/速度一次性决定开或收（早期版本先置 `open` → 后半段手势被守卫丢掉，右滑打不开）
- 手势只从左边 64px 内起手才算拉出（`EDGE_PULL`），另外落点落在 `.t-bar`（卡片亮度条）、`input`/`.slider`（设置滑条）、`.toolbar`（场景/房间横滚）、`.sheet`/`.mask`/`.view` 这些控件上时直接放弃，避免和它们抢横滑。Android 10+ 手势导航会把屏幕左边缘留给系统返回，所以 MainActivity 在 API 29+ 用 `setSystemGestureExclusionRects` 把左侧 56dp 宽的竖带排除在系统手势之外（返回手势在右边缘仍可用）——小米平板 5（Android 13）上从边缘滑不出音乐页就是这条在起作用。

本地联调不需要真的道理鱼：`node tools\fake-daoliyu.js 8099` 起一个零依赖假服务器（登录 → 歌单 → 曲目 → 封面 → WAV 音频），模拟器里地址填 `http://10.0.2.2:8099` 即可跑通全链路。

## 接入真实 Home Assistant

**最快的方式**：面板上长按右上角状态胶囊 → 填 HA 地址（如 `http://192.168.1.10:8123`）+ 长期访问令牌 → 「保存并重连」。地址可以只写 base（`/api/websocket` 会自动补）。

地址和令牌会被自动规整，不用记格式：

| 你填的 | 实际用的 WS 端点 |
| --- | --- |
| `192.168.1.10:8123` | `ws://192.168.1.10:8123/api/websocket` |
| `http://ha.local:8123/` | `ws://ha.local:8123/api/websocket` |
| `https://ha.example.com` | `wss://ha.example.com/api/websocket` |
| `http://ha:8123/ha/`（反代子路径） | `ws://ha:8123/ha/api/websocket` |

主机名大小写、结尾斜杠、是否已经带 `/api/websocket` 都不影响；令牌里夹带的换行/空格也会被去掉（复制粘贴时常有）。这些规则有 12 项离线断言（`node tools\test-ui.js`）。
点保存时会先用**壳 App 的原生 HTTP** 探一次 `GET /api/`（WebView 里做 REST 会被 CORS 拦，所以走 Java 桥），结果直接告诉你：
- `200` →「令牌有效，已保存，正在重连…」并自动 reload
- `401 / 403` →「已保存，但令牌被拒绝，请检查令牌」，弹层不关，可当场改
- 连不上 / 超时 →「已保存，但连不上这个地址（SocketTimeoutException）」，弹层不关

诊断页（长按左上角时间）里也有一行「连通测试」和「测试连接」按钮，随时可复测，不用等到 reload 后看状态胶囊猜。

也可以从 PC 推（适合首次批量部署）：

1. 在 HA 里建长期访问令牌：左下角用户名 → 「长期访问令牌」→ 创建（建议单独建一个用户给中控屏用，便于吊销）
2. 项目根目录建 `ha.json`（可复制 `ha.json.example`）：

```json
{"url":"http://192.168.1.10:8123","token":"eyJhbGciOi..."}
```

3. 推上去并重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Restart
```

面板检测到 `ha.json` 就进入真实模式：`http` 自动换成 `ws` 并补 `/api/websocket`，登录后 `get_states` + 订阅 `state_changed`，再拉三张 registry 自动布局。想回到模拟数据：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Mock -Restart
```

### 连接诊断（右上角状态胶囊）

上墙后没人会去翻 logcat，所以连不上时面板要自己说清原因：

| 胶囊文案 | 含义 | 该做什么 |
| --- | --- | --- |
| 连接中… / 认证中… | 正在建连 / 认证 | 等一两秒 |
| 连接失败，重试中… | 第一次失败，指数退避重试 | 持续出现就检查地址 |
| 连不上 HA（第 N 次重试） | 多次失败仍在重试 | 检查地址/网络，或长按改配置 |
| 连不上 HA · 检查地址与网络 | 12 秒内没连上（SYN 被防火墙丢掉时 WebSocket 不报错、不 close，只能靠超时判定） | 改地址；确认 HA 允许局域网入站 |
| 连接断开，重连中… | 连上后断开 | 等自动重连 |
| 令牌无效 · 长按右上角修改 | 认证被拒，已停止重连 | 长按胶囊换令牌 |

交互：**长按**状态胶囊 = 打开「连接设置」（改地址/令牌、切回模拟数据）；**短按** = 立刻重连一次（会弹「正在重新连接…」）。

### 自动布局规则（panel/js/layout.js）

- 房间 = HA 的「区域」；实体区域取 `entity.area_id`，没有则用所属设备的 `area_id`
- 只显示可操作/可读的域：`light`、`switch`（含 `fan` / `input_boolean` / `humidifier` / `automation`）、`climate`、`cover`、`sensor` / `binary_sensor`（只收温度、湿度、人体、门窗、烟感、可燃气体、照度、CO₂、PM2.5 等 `device_class`）
- 跳过隐藏/禁用的实体（`hidden_by` / `disabled_by` / `entity_category = diagnostic|config`）
- 房间内排序：灯 → 开关 → 空调 → 窗帘 → 传感器；空区域不显示；每个房间最多 24 张卡
- **没建区域的实体不会消失**：都归到「其他」房间（真机第一次接入很常见——HA 里还没划分区域，面板仍然能用）
- 场景/脚本最多取 24 个；顶栏只放 5 个（第 6 个位置是「更多 N」，点开是全部列表），避免 script 一多就把房间 tab 挤没

### 设备名称：清洗 + 自定义重命名

米家/小米集成给实体的 `friendly_name` 常常是「设备名 + 子功能」复合串，还有哈希段和括号说明，直接显示会变成
`zm1_b0f8932275c7_brightness`、`按键1-DIY四路开关 开关一键`、`提示音 提示音`、`光照度传感器 光照度（1-暗；100-亮…）` 这种。

面板分三层处理（`panel/js/layout.js` + `panel/js/app.js`）：

1. **清洗**（`cleanLabel`）：去括号说明、去前导 `*`、去哈希段（至少 6 位数字才当哈希，`S2719DGF` 这类型号串会保留）、
   下划线转空格、合并相邻重复词、末尾重复的通用词去掉；`shortDev` 去「米家/小米/智能/小爱/涂鸦/Aqara/Xiaomi/Redmi」前缀与
   「Pro/Lite/MESH」后缀。
2. **补上下文**（`displayName`）：实体名是「灯/灯带/开关/插座/静音/…”这类通用词时，用设备名补前缀 ——
   「鱼缸 + 灯 → 鱼缸灯」、「Channel 1 + 插座 → Channel 1 插座」。
3. **自定义覆盖**：长按卡片 → 弹层右上角**铅笔** → 输入名字 → 保存。只写本机 `localStorage['hc.names']`，
   **不会同步回 Home Assistant**；留空保存等于恢复默认。面板设置里还有一键「恢复默认名称」。

也可以在 `ha.json` 里写 `"names": { "light.living_main": "客厅主灯" }` 做全局默认（本机改的优先）。

体检真实 HA 的名字：`node tools\name-report.js`（只读，打印每张卡的清洗前后与来源）。
交互验收（不需要平板）：`node tools\sim.js --mock --port 8791` 后另开一个终端跑 `node tools\e2e-rename.js`
——CDP 真点击，验证「铅笔可见 → 预填 → 保存后卡片改名 → 面板设置恢复默认」。

### 性能与卡顿（老平板上为什么会卡）

这台平板是 2015 年的 x86 Android 5.1，WebView 固定在 Chromium 57，2GB 内存。
用 `adb shell "dumpsys gfxinfo com.homecontrol.panel"` 量出来的底子就不好：

| 场景 | 帧数 | Janky | p90 | 主要成因 |
|---|---|---|---|---|
| 只滑网格（不开弹层） | 135 | 69.6% | 34ms | Slow draw 55 |
| 打开设置 + 滑到底 | 33 | 57.6% | 38ms / p95 81ms | Slow UI 16、Slow draw 19 |
| 连点 4 个设置项 | 67 | 68.7% | 69ms / p95 97ms | Slow UI 39、Slow draw 44 |
| 完全空转 3 秒 | 5 | — | 129ms | Slow draw 3 |

所以「卡」主要是**这台设备的 2D 合成速度**（MIUI 的 `MiuiPerfService … Slow issue draw commands`
也是这个意思），不是设置页本身有重活。设置页能做的优化已经做了：

- **点设置项不再重建整个弹层**：只切 `.seg` 的高亮，走 `syncSegRows(key)`
- **改「每行卡片 / 卡片大小」只换网格类名**（`gridClassOnly()`），不重建 60~70 张卡片
- **`updateTile()` 只在真的变了才写 `className` 与 `--accent`**，避免每 6 秒一次状态推送就触发整页重排
- 图标用 `data-icon` / 数值用 `innerHTML` 比较，没变就不写 DOM

### 设置页滚动为什么比「添加卡片」列表卡

设置弹层 `.sheet` 自己是 `position:fixed` + `transform` 的滚动容器，Chromium 57 里这种
滚动会把**整块图层连同背后整张网格**一起重绘；而「添加卡片」列表是普通文档流里的
`.ed-list { max-height:52vh; overflow-y:auto }`，滚动时只重绘自己，所以顺。

三处针对性修法（`panel/js/app.js` + `panel/css/app.css`）：

| 修法 | 作用 |
|---|---|
| 弹层打开时 `freezeGrid(true)`（给 `#grid` / `#editBar` 加 `visibility:hidden`） | 遮罩本来就挡住了网格，重绘它纯属浪费；关弹层时解冻 |
| `.sheet` 提为显式合成层：`will-change:transform`、`transform:translate3d(0,104%,0)`、`backface-visibility:hidden`、`contain:layout paint` | 滚动只重绘弹层自己，不再波及主文档 |
| `.set-row` / `.p-row` / `.set-sec` / `.cfg-actions` / `.seg { contain: layout style }` | 行级隔离，避免整行跟着背景重绘 |

另外 `saveConfig()` 的存盘 + 探活是**同步网络调用**，原来点「保存并重连」会像假死；
现在先 `toast('正在保存并测试连接…')` 再干活，并用 `window.__HC_NO_PROBE__` 允许测试跳过探活。

实测（同一台机器、同样 5 次滑动）：修前 `32 帧 / Janky 50% / Slow draw 16`，
修后 `28~30 帧 / Janky 50% / Slow draw 14~15`。剩下的抖动是设备自身上限，
上面的修法削掉的是「跟着背后网格一起重绘」那部分额外开销。

### 状态推送：从「每次全量」改成「只回一个实体」（2026-11-09）

真 HA 有 1254 个实体、稳态 4.2 条 `state_changed`/秒。原来 `backend.js` 每收到一条事件都把**全部**
states 复制一份回调给面板，面板再整屏 `renderGrid()`。在模拟器（Android 11 / WebView 83）上用 CDP
Profiler 量，空闲时 JS 非 idle 约 7.4%（740ms/10s），self-time 热点是 `num` / `toneOf` / `prefs` /
`querySelector`。

改法（`panel/js/backend.js` + `panel/js/app.js`）：

- `HABackend` 新增 `onEntity(cb)`：`state_changed` 只回这一个实体的浅拷贝；初次 `get_states` / REST 兜底仍走 `emitStates()` 全量
- 面板 `onState(id, st)` 只更新 `S.states[id]`、对应那张卡（`updateByEntity`）和天气/住户条；设置页正开着就刷新当前卡
- `prefs()` / `hiddenRooms()` 按 `localStorage` 原始串缓存；`toneOf()` 颜色映射记忆化（上限 512 条）；`tick()` 只在时间/日期文本真的变了才写 DOM
- 设置页/弹层打开时（`body.sheet-open`）`camPaint()`（每 8 秒拉摄像头缩略图）与 `sparkPaint()`（每 20 秒拉历史曲线）直接跳过，关掉后自动恢复

实测（同一模拟器、同一个真 HA，10 秒）：非 idle 7.4% → 3.4%（约 -54%），`updateTile` / `num` /
`toneOf` 从 self-time 排行里消失；面板自报 `renders` 3 次 / `entityEvents` 50 条（改造前约每条事件
一次整屏渲染），单实体连推 200 次共 11ms。复测工具：`node tools/perf-profile.js 10`（CDP Profiler +
WebSocket 帧统计）。注意这是模拟器数字，Chromium 57 真机还没有重测（平板离线中）。

想再快一点，按收益排序：

1. 面板设置里关掉「传感器卡片」和「离线设备」——卡片从 60+ 降到 20 左右，滚动立刻顺很多
2. 面板设置里把「每行卡片」调成 5 或「卡片大小」调成紧凑（同样面积少滚几屏）
3. 关掉「防烧屏位移」（每 5 分钟一次 `transform` 重绘，旧机器上一次就是上百毫秒）
4. 设备侧：关闭系统动画/关闭 MIUI 省电限制、用 5G WiFi（已连 501_5G）

### 设置页（显示 / 交互 / 屏幕）

入口：**顶栏右上角「已连接」胶囊右边的齿轮按钮**（也保留「长按左上角时间 → 设置」这条老路）。所有选项都存在本机 `localStorage['hc.prefs']`，改完立即生效，
换平板/清缓存就回到默认。

| 分组 | 设置 | 默认 | 说明 |
|---|---|---|---|
| 显示 | 皮肤 | 深色 | 深色 / 明亮两套（`panel/css/app.css` 顶部两个变量块：`:root` 给深色、`html.hc-light` 给明亮）。明亮皮肤下卡片强调色会被 `themeAcc()` 压暗，否则浅底上看不清 |
| 显示 | 每行卡片 | 4 | 3 / 4 / 5 / 6 列，卡片会自动变宽变窄 |
| 显示 | 卡片大小 | 标准 | 紧凑 / 标准 / 大，只改行高与数值字号 |
| 显示 | 传感器卡片 | 显示 | 关掉后温度/湿度这类只读卡不进网格 |
| 显示 | 离线设备 | 保留 | 选「隐藏」时 unavailable/unknown 的卡片不显示 |
| 交互 | 点一下卡片 | 直接开关 | 也可改成「打开面板」，老人/小孩误触更安全 |
| 交互 | 误触撤销 | 5 秒 | 3 / 5 / 8 秒；撤掉后 toast 的「撤销」按钮窗口变长 |
| 屏幕 | 空闲自动调暗 | 开 | 关掉后不再自动进暗屏 |
| 屏幕 | 唤醒亮度 | 100% | 40% / 70% / 100%，点一次屏幕恢复到这个背光 |
| 屏幕 | 夜间调暗 | 开 | 夜间时段（`panel/js/config.js` 的 `dim.nightStart/nightEnd`）用更深遮罩 |
| 屏幕 | 防烧屏位移 | 开 | 关掉后停止像素位移（想截图对比时有用） |

设置页底部还有：房间显示开关、**恢复默认名称**、**恢复默认房间**、**恢复默认设置**、**编辑卡片**、**恢复默认编辑**，
以及「HA 地址与令牌」「重新加载面板」两个常用动作。

### 电池保养（设置页「电池保养」一节）

挂在墙上的平板常年插着电，电池一直 100% 会鼓包、缩短寿命。这节让面板自己守电量：

- **自动保养**：开 / 关。开着时面板每 30 秒看一次**自己的电量**（经 AndroidBridge 读，读不到就兜底读 HA 里自己上报的 `sensor.homecontrol_panel_<设备>_battery`）。
- **充电开关**：选一个 HA 的 `switch.*` 实体当这台平板的充电器电源。列表只列「真能断电」的开关——把各家设备的**功能开关**（静音、指示灯、蜂鸣器、提示音、童锁、背光、勿扰、移动侦测、保温……按实体 id 关键字 + 中文友好名双重过滤）都藏掉，面板自注册的夜间模式开关也不列。
- **开始充电 / 停止充电**：电量 ≤ 开始阈值就 `switch.turn_on`，≥ 停止阈值就 `switch.turn_off`（默认 40% / 80%）。只在跨过阈值那一侧动作，避免来回抖。

守护逻辑跑在**面板里**而不是 HA 自动化：面板是常亮墙屏、自己本来就有定时器，能读自己电量、能调 HA 开关，改起来不用再去 HA 里配一条自动化。代价是面板进程没在跑时这条守护也不在（断电关机到 0% 的极端情况兜不住），但对常年通电的墙屏够用。

磁贴拉伸的真机验收（2026-11-08，MI PAD 2 / 6 列）：编辑态从卡片右下角 `(780,720)` 拖到 `(1180,1120)` → logcat `ACT grip down …` / `ACT resize … 3x2` / `ACT grip up … 3x2`，卡片当场变成 3 列 × 2 行（截图 `docs/screens/panel-tile-resize.png`）；再反向拖回 → `ACT resize … 2x1`（`docs/screens/panel-tile-resized.png`）。

验收：`node tools\sim.js --mock --port 8791` + `node tools\e2e-settings.js`（CDP 真点击：
开设置 → 切 3 列 → 隐藏传感器 → 点击语义改「打开面板」→ 恢复默认，全部断言）。

### 自升级（应用内更新，2026-11-13）

设置页「升级」一节：显示当前版本 → **点一下检查 GitHub 上有没有新版本 → 有就下载 → 直接拉起系统安装器**。
整条链路在平板上完成，不用连电脑（上墙以后最需要的就是这个）。

顺序是这样的（`panel/js/update.js` + `MainActivity` 里的 `updNet`/`updDownload`/`updInstall` 三个桥方法）：

1. **检查**：GET `https://api.github.com/repos/Eggplant4363/HomeControl/releases/latest`，取 `tag_name` 当版本号，
   在 `assets[]` 里挑第一个 `.apk`（多个取体积大的）。仓库还没有 release 时 GitHub 回 404，面板显示「还没有发布任何版本」。
2. **比较**：`verCmp(a,b)` 逐段按数字比（`0.7.10 > 0.7.9`，`0.7 == 0.7.0`），只有严格更大才提示可升级。
3. **下载**：Java 桥把 APK 写到 `getCacheDir()/upd/homecontrol.apk`，边下边按 `Content-Length` 的百分比回调进度。
   安全检查：只认 http(s)、跟随 GitHub 的 302、拒绝 `text/html`、**头两个字节必须是 `PK`**、超过 200MB 直接拒、
   小于 50KB 视为不完整，落地前先写 `.part` 再 `renameTo`。
4. **安装**：用 `UpdateProvider`（authority `com.homecontrol.panel.upd`，只暴露 cache 目录里那一个文件）给出
   `content://` URI，然后依次尝试 `ACTION_INSTALL_PACKAGE` / `ACTION_VIEW` 的 content:// 与 file:// 两种形态
   （Android 7 起不再允许 `file://`）。MIUI 5.1 上只有 `ACTION_VIEW + content://` 能起来，所以是「按顺序试」而不是写死一条。
5. **权限**：Android 8+ 一般要求「安装未知应用」授权。面板不预先拦，先直接起安装器；
   起不来时才提示「去授权」（跳 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`），授权回来点「继续安装」即可，
   不用重新检查/重新下载。Android 5.1（平板2）没有这一步。

要让升级真正可用，还需要两件事：

- **发一个 release**：tag 用 `v0.7.14` 这种格式，附件上传 APK（文件名任意，`.apk` 结尾即可）。
  `tools/release.ps1` 就是干这个的（走 GitHub API，需要 `GITHUB_TOKEN` 环境变量；仓库现在还没有任何 release）。
- **签名一致**：新 APK 必须能覆盖装旧 APK。默认 `tools/build.ps1` 用仓库里的 debug keystore，
  同一把钥匙签出来的才能原地覆盖；换成正式签名后要保证钥匙不变，否则系统会报「应用未安装」。

排查/联调时不用真发版：`node tools\dev-release.js 8795 0.7.16` 会在本机起一个假 Release
（把 `dist/homecontrol.apk` 当附件、JSON 里写本机局域网 IP），再在面板里 `window.__HC_UPDATE_API = 'http://<pc>:8795/release.json'` 指过去，就能把「检查 → 下载 → 安装」跑完整。

真机验收（2026-11-13，MI PAD 2 / Android 5.1 / Chromium 57）：
① 真实 GitHub → 「仓库还没有发布任何版本」（网络 + TLS + 404 映射通）；
② 指向本地镜像 → 「发现新版本 v0.7.15（177 KB）」→ 下载 0%…100% → 「下载完成，点下面的按钮安装」；
③ 点安装 → 系统安装器弹出（`mCurrentFocus=com.android.packageinstaller/.PackageInstallerActivity`，截图 `build/padupd-6-installer.png`）。

同一套流程在平板5（Android 13 / MIUI，截图 `build/pad5upd-1-found.png`…`pad5upd-3-install.png`）也走通了，多踩到一个坑：
本项目 `targetSdk=22`，MIUI 13 上 `canRequestPackageInstalls()` 即使 appops 已经 allow 仍然返回 **false**，
所以**不能拿它提前拦**（提前拦会把本来能装的路径堵死）。现在的做法是「先试着起安装器」，
四个 Intent 组合都被拒时才回头判权限、提示「去授权」——那次实测直接弹出了 MIUI 的安装确认框。
另外「需要授权」这个状态现在给了「继续安装」按钮，授权回来不用重新检查、重新下载。

验收：`node tools\sim.js --mock --port 8794` + `node tools\e2e-update.js`（假桥 + 假 GitHub：无桥提示、检查、下载进度、
安装、同版本/404/需要授权三个分支、只重绘 `#updSec` 不重建设置页，共 32 项）。

### 编辑卡片（默认一张都不显示）

面板默认**不显示任何设备卡片**：第一次装好、点顶栏右边的 ✎ 进编辑模式，再一张张挑。所有编辑状态都存在本机
`localStorage['hc.edit']`，格式是 `{ added: {实体:1}, order: [实体…], span: {实体: 2|3} }`。

| 操作 | 位置 | 说明 |
|---|---|---|
| 进入 / 退出编辑 | 顶栏 ✎ 按钮（齿轮左边），或设置页「编辑卡片」 | 编辑期间 ✎ 变成蓝色 ✓，点它退出（编辑态没有「编辑中 / 完成」那一行工具条） |
| 添加 / 移除一张卡 | 编辑模式下点卡片 | 已添加的卡高亮，未添加的暗显（`opacity .42`） |
| 按房间整加 / 整减 | 工具条「本房间 +」/「本房间 −」 | 只作用于当前选中的房间 |
| 全部添加 / 全部清空 | 工具条 | 一次把所有可显示设备加进来或清空 |
| 调顺序 | 卡片头部 ▲ / ▼ | 每次移动一位，写进 `order` |
| 改卡片大小（两套） | ① 编辑态卡片**右下角的三角手柄**按住拖动 ② 选中卡片后工具条 **尺寸 1×1** 按钮 → 弹层选 `1×½ 半高 / 1×1 / 2×1 / 1×2 / 2×2` | 手柄：横向最多拉满当前「每行卡片」列数，纵向三档（半高 / 一格 / 双高）；松手才落盘（`span` / `rows`）。尺寸弹层：五档预设，1×1 是正方形，1×½ 是半高的一条，2×2 是四格 |
| 卡片排版（宽卡） | 左图标块、中间名称 + 「房间 · 状态」、右侧电源钮（照米家） | 状态与名称相同时自动留空；数值/进度条从 2×1 起出现。**1×1 不用这套排版**，用下面的两种模板 |
| 图标块按类型分四种画法 | **仪表类**（传感器/窗帘/空调）：方角块 + 字形 + 块底一根细刻度（刻度按读数深浅）；**动作类**（灯/开关/风扇）：方角块本身就是电源键，开=实心强调色，卡上不再挂第二个钮；**画面类**（摄像头）：块退成线描，画面自己当主角；**占位类**：线描小块 | 照 HomeKit / Google Home：图标块是方角（squircle）不是圆，块内颜色就是状态。宽卡（2×1/2×2）上动作类退回浅 tint 块 + 电源钮，一张卡上不会出现两个实心色块。刻度只在有可信区间时画（% / 温度 5–40°C / 照度 0–1000 lx / 窗帘开合），门磁、人体感应、PM2.5 这类没有区间的把刻度整根藏掉。**1×1 的控制卡不用方角块，改用整颗圆钮**（见下一行）；方角块只出现在宽卡上 |
| 卡片内部四格 | A 左上图标 / B 右上名称+状态 / C 左下主数值 / D 右下控制条、曲线、±、电源钮 | 1×1 只露 A+B+C；2×1 起露控制；2×2 给摄像头画面与温湿度大数字 |
| 1×1 的两种模板 | **控制卡**（灯 / 开关 / 窗帘 / 摄像头 / 场景）：一个圆钮坐在正中，圆里的图标就是可以按的东西，**圆钮的颜色就是状态**（开=实心强调色、关=浅灰底、离线=更暗的底），卡上只写一个实体名称。**传感卡**（传感器 / 空调 / 天气）：大字读数 + 单位坐在正中，下方一行只有名称 | 两种模板的核心区都固定成 64px 高（一个圆钮的直径）、名称都留 16px，所以同一排里控制卡和读数卡的名字是齐平的；一行放不下就省略号。按整张卡就是主动作（灯开关、场景运行、窗帘/空调开弹层），卡上不再挂第二个电源钮，也不再写「开 / 关 / 离线」这种状态词——图标自己说话。1×1 不显示亮度数值（要看亮度用 2×1），窗帘开合度与 ± 在弹层和宽卡里 |
| 恢复默认编辑 | 设置页「恢复默认编辑」 | 清空 `hc.edit`，回到一张卡片都没有 |

**切列数顺序不变**：卡片顺序只由 `order` 数组决定（没排过的按「名称 + 实体 id」稳定排序补在后面），
换每行 3 / 4 / 5 / 6 列只改 `.grid` 的类名，不会重排、也不会丢跨列设置。

**默认尺寸（照米家）**：摄像头与温湿度计默认 **2×2**，能调光的灯默认 **2×1**（大数字 + 整条亮度），
其余（开关、按钮、场景、普通传感器）默认 **1×1**；1×1 严格正方形，行高 = 当前列宽
（`rowHeight()` 按 `#grid.clientWidth` 实测算，窗口尺寸或列数变化时重算）。用户拖过手柄、或按过
**尺寸** 按钮选过档位的卡片，以 `hc.edit.span / rows` 为准，没改过的才走这张默认表。
**注意 1×1 也是显式值**：把可调光灯选成 1×1 后它会记住（不会回落到默认的 2×1）；想恢复按类型给的
默认，在尺寸弹层里选 **跟随默认**（清掉这张卡的 `span / rows`）。

**半高卡（1×½）**：网格的行单位其实是「半行」（`setColumns()` 写 `grid-auto-rows = (行高 − 行距) / 2`，
1×1 卡 `grid-row: span 2`），所以半高卡正好是一个方格的一半，两张半高 + 一道行距 = 一个 1×1。
半高卡换一套横向模板：左边迷你圆图标、中间名称、读数型右边带一个小数值（`updateTile` 走
`data-role="hval"`），放不下就省略号；开关型不显示读数。适合一整排开关、温湿度这类「只想瞄一眼」的卡。
`hc.edit.rows` 只认三档（0.5 / 1 / 2），别的值读回来会被夹到最近一档；拖手柄、尺寸弹层都走这三档。

验收：`node tools\sim.js --mock --port 8791` + `node tools\e2e-settings.js`（CDP 真点击：
默认 0 张 → 进编辑（✓、无工具条）→ 从列表挑 4 张 → 3 列 → 6 列顺序一致 → 选中卡改 2× → 挪位 → 移除 → 恢复默认编辑回 0 张）；
批量选择与「编辑态图标一致」：`node tools\sim.js --mock --port 8794` + `node tools\e2e-bulk.js`（41 项：平时/编辑态 1×1 都是圆钮、宽卡都是方角块、无 `t-edit-ico`、勾选/全选/取消/批量移除/退出、`hc.edit.hidden` 落盘、刷新后仍生效；第 5 节专测「带控制按钮的卡 / 右下角区 / 多选态」点上去都只是选中、不发服务调用）。
半高卡：`node tools\sim.js --mock --port 8794` + `node tools\e2e-half.js`（几何「两张半高 + 行距 = 一个 1×1」、
横向模板（迷你图标/名称/读数）、尺寸弹层选半高并落盘、刷新后仍在、改回 1×1 与放大到 2×2、六列窄卡布局）。

### 编辑卡片（手机桌面那套）

1. 点顶栏 **✎** 进入编辑：网格只显示已添加的卡片（不会把全部设备铺出来），每张卡变成虚线框，末尾多一个 **＋ 添加卡片** 空格子。
2. 点 **＋ 添加卡片**（编辑态没有工具条，网格末尾那个虚线格子就是入口）弹出**设备列表**，按房间分组，点一行加一张，已加的带 ✓，可反复点。
3. **改大小有两种**：拖卡片右下角的三角手柄（往右变宽、往下变高/变矮，松手才保存，卡片右上角实时显示 `2× · 高 2` / `1× · 半高`）；或者点中卡片后按工具条 **尺寸** 按钮，在弹层里直接选 `1×½ 半高 / 1×1 / 2×1 / 1×2 / 2×2` 五档。
4. 点某张卡选中它，底部浮出工具栏：**◀ ▶** 调顺序、**尺寸 1×1** 打开尺寸弹层、**✕ 移除**；编辑期间顶栏的 ✎ 会变成蓝色 **✓**，点它就退出编辑（没有「编辑中 / 完成」那一行）。
5. **批量选择**：编辑态顶栏 ✓ 左边多一颗「批量选择」（点过变「退出多选」）。进去以后点卡片是勾选/取消勾选，勾中的卡描浅蓝边 + 右上角蓝底 ✓；底部浮出一条 **已选 N 张卡片 / 全选 / 取消选择 / ✕ 移除 / 退出多选**，一次把勾中的卡全移除（N=0 时移除按钮是灰的）。退出编辑会自动退出多选、清掉勾选。
   多选时**整张卡任何位置都能点**：不显示右下角拉伸三角、空调/窗帘卡里的「打开 / 关闭 / ±温度」也只是当点选（编辑态一律只选中，不执行动作）；底部那条浮出来时网格会自动留出 92px 内边距，滚到底最后一排也能点中。

**编辑态的图标和平时一模一样**：进编辑只叠两样东西——虚线外框、角上的「1× / 2× · 高 2」尺寸标；卡片内部（1×1 的圆钮 / 大字读数、宽卡的方角图标块）都还是平时那套模板，不再换成另一套「编辑专用图标」。想确认可以看 `tools/e2e-bulk.js` 里的逐字节比较：1×1 卡片进编辑前后的 `innerHTML`，除了 `.t-tools` 和 `.t-grip` 两个编辑专属节点之外完全相同。

数据存在 `localStorage['hc.edit']`：`{ added: {实体:1}, hidden: {实体:1}, order: [实体…], span: {实体: 2..N}, rows: {实体: 2} }`（`span` 是横跨列数、`rows` 是横跨行数，1 表示不存）。

**「显示全部设备」开着时也能移除**：这个模式下列表不是靠 `added` 撑起来的，所以移除不能靠删 `added`。
`hidden` 就是为此存的：`cardVisible()` 先看 `hidden`，被移除的实体记一条 `hidden[实体]=1` 就不再出现；
再在「添加卡片」里点回来，或者按「全部添加 / 恢复默认」，`hidden` 里对应那条会被清掉。
`setCardVisible(实体, true/false)` 是唯一的写入口（`added` 与 `hidden` 一起维护），换设备、换主题都不会丢。
「每行卡片」3~6 与「卡片大小」在设置里，切来切去顺序不变（排序按 `order`，没排过的按名字稳定排序）。

真机验收记录（2026-11-07，MI PAD 2 / 真实 HA 1254 实体 / 本房间 70 张卡）：
默认空网格 → 点顶栏 ✎ 进编辑（按钮变 ✓，无工具条）→ 全部添加（70 / 70）→ 点 ✓ 退出；
设置页切 3 / 6 / 4 列，logcat 依次出现 `ACT pref cols=3` / `cols=6` / `cols=4`，同一批卡片顺序始终一致。
截图：`docs/screens/panel-empty.png`、`panel-edit-mode.png`、`panel-edit-added.png`、`panel-cols-3.png`、`panel-cols-4.png`。

### 自动化的语义（别把「禁用自动化」当成关灯）

`automation.*` 实体在 HA 里是个开关，但它开关的是**自动化是否生效**，不是灯。面板因此把两者的语义分开：

| 位置 | 行为 |
| --- | --- |
| 卡片文字 | 「启用 / 禁用」（不是 开 / 关），副标题「点按触发」 |
| 点卡片 | `automation.trigger` —— 立即执行一次，**不会**关掉自动化 |
| 长按弹层 | 显示「已启用 / 已禁用」+ 上次触发时间 + 「立即执行 / 禁用」两个按钮 |

这样误触最多是多跑一次自动化，不会在半夜把某个自动化悄悄关掉。
### 温湿度曲线（详情弹层）

点温湿度/光照/CO₂/PM2.5/功率这类传感器卡片，弹层里除了当前值，还有一条最近 12 小时的曲线：

- 数据来自 HA 的 `GET /api/history/period/<开始时间>?filter_entity_id=…&minimal_response`
- 拉取同样走壳 App 的原生 HTTP（`file://` 页面直接 XHR 会被 CORS 拦）
- 模拟模式下会合成一条正弦波曲线（不需要 HA 也能看到效果）
- 曲线下方给出最低/最高/采样点数；HA 没开 recorder 或历史被清理时显示「暂无历史数据」

### 实时画面（go2rtc + MJPEG）

Chromium 57 跑不了 WebRTC/HLS，但 **能直接播 MJPEG**（`<img src>` + `multipart/x-mixed-replace`）。所以「实时画面」走这条路：

1. HA 装 **go2rtc** 插件，把摄像头 RTSP 加进去（插件配置或 Web UI 里 `streams: { mainStream: rtsp://user:pass@cam:554/stream1 }`）
2. 确认 go2rtc 的 **1984 端口**从 HA 宿主机可达（HAOS 插件默认映射 1984）
3. 把流地址告诉面板，两种写法都行：
   - `panel/js/config.js` → `camStream: { 'camera.tp_ipc_mainstream': 'http://10.10.1.7:1984/api/stream.mjpeg?src=mainStream' }`
   - 或写在 `/sdcard/HomeControl/ha.json` 里同名的 `camStream` 字段（部署时写一次，不用改面板源码）
4. 面板行为：卡片缩略图变成**实时流**（左上角绿点），详情页大图带「实时 · MJPEG」徽标、按钮变「重连画面」；拉流失败自动退回快照；没配 `camStream` 就还是原来的 8 秒快照

> 为什么不用 go2rtc 的 WebRTC：这块板子 WebView 是 Chromium 57 且无 root 不能升级，WebRTC 用不了；MJPEG 是它唯一能「连续动」的格式（5–15fps，延迟 0.5–1.5s）。

### 摄像头

- 布局里 `camera.*` 被当成一种卡片类型（排序最前、每房间最多 4 个）
- 卡片是**缩略图**：优先用 HA 给的 `attributes.entity_picture`（已签名链接），没有就自己拼 `http://<ha>/api/camera_proxy/<实体>?token=<长期令牌>`（`<img>` 带不了 Authorization 头，只能用 URL 令牌）
- 缩略图 8 秒刷新一次；点开详情是 340px 大图，1.2 秒刷新（`camera_proxy` 的 `t=<ms>` 破缓存）
- **没有画面时不会画假图**：实体是 `unavailable`/`unknown` 就在详情里说明「摄像头没有画面 · HA 里这个实体现在是 unavailable」，卡片显示「离线 / 不可用」
- 摄像头**不做**实时流（RTSP/HLS 在 Chromium 57 上跑不动）；这是「隔几秒一张快照」的方案，够看门口/客厅有没有人
### 按实体能力自适配（真机才有的差异）

同一个域的实体在真实 HA 里能力差别很大，面板按实体属性决定显示什么，不会出现「点了没用的滑杆」：

| 实体属性 | 面板行为 |
| --- | --- |
| `light` 的 `supported_color_modes` 含 `onoff`（或没有 `brightness`） | 卡片只显示「开/关」，详情页没有亮度/色温滑杆 |
| `light` 的 `supported_color_modes` 含 `color_temp`（或带 `min_mireds`） | 详情页出现色温滑杆 |
| `light` 的 `supported_color_modes` 含 `hs` / `rgb` / `rgbw` / `xy` | 详情页多一排 8 个预设色块，点一下 `light.turn_on` 带 `rgb_color`；卡片光斑用灯的实际颜色 |
| `climate` 的 `hvac_modes` | 模式段严格按该实体的模式列表渲染（例如只有 `off` / `heat_cool` 就不显示制冷/除湿） |
| `climate` 的 `target_temp_step` | 加减温度按实体步长走（1°C 的空调不会出现 0.5 度） |
| `climate` 没有 `fan_modes` | 隐藏风速段 |
| `climate` 没有目标温度能力（`supported_features` 缺 TARGET_TEMPERATURE / RANGE 位，如新风、只能开关换模式的盘管） | 卡片显示模式文字（关/送风），没有 ±；详情页只有模式与风速 |
| `climate` 是 `heat_cool`（带 `target_temp_low` / `target_temp_high`） | 卡片显示「20–26°C」区间且不给 ±；详情页拆成「制热下限 / 制冷上限」两行，各自加减，之间至少留一个步长 |
| `cover` 的 `supported_features` 不含 `SET_POSITION`（bit 4） | 详情页只留「打开/停止/关闭」，隐藏开合度滑杆，卡片显示开/关而不是百分比 |
| 实体状态是 `unavailable` / `unknown`（设备掉线） | 卡片整卡降透明度、值显示「离线」、副标题「不可用」，点它只提示「设备离线，无法操作」，不会发服务调用 |

样例数据里专门放了三种「能力缩水」的实体（`light.study_onoff`、`climate.study_floor`、`cover.study_blind`）来固化这些行为，单测里有对应断言，截图见 `docs/screens/panel-study.png`、`panel-cover-noposition.png`、`panel-climate-heatcool.png`。

### 压力样例（房间/实体很多时）

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\make-big-fixture.ps1   # 生成 build\panel-big
```

`tools\fixture-big-ha.js` 造了 8 个房间 × 10 个实体 = 80 个实体 + 6 个场景，用来验证 tab 横向滑动与网格纵向滚动；截图见 `docs/screens/panel-many-rooms.png`、`panel-dense-room.png`。

## 真实模式离线验收（没有 HA 或网络不通时）

用样例数据把「真实模式」整条链路在平板上跑通：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\make-fixture.ps1
adb shell "rm -rf /sdcard/HomeControl/panel-fixture"
adb shell "mkdir -p /sdcard/HomeControl/panel-fixture"
adb push .\build\panel-fixture\. /sdcard/HomeControl/panel-fixture/
adb shell "echo file:///sdcard/HomeControl/panel-fixture/index.html > /sdcard/HomeControl/url.txt"
adb shell "am force-stop com.homecontrol.panel; am start -n com.homecontrol.panel/.MainActivity"
```

`js/fixture-ha.js` 会把 `window.HABackend` 换成样例数据实现（数据与 `tools/fake-ha.js` 同一份：2 个区域 / 13 个实体，含 6 秒传感器漂移）。已实测（`docs/screens/panel-real-layout.png`）：状态「已连接（样例数据）」、场景键「观影模式 / 全部关闭」、房间 tab「全部 / 客厅」（空的主卧被跳过）、10 张卡按 灯→开关→空调→窗帘→传感器 排序、点卡片能 toggle、长按与「…」能开弹层。

恢复模拟模式：

```powershell
adb shell "echo file:///sdcard/HomeControl/panel/index.html > /sdcard/HomeControl/url.txt"
adb shell "rm -f /sdcard/HomeControl/ha.json; rm -rf /sdcard/HomeControl/panel-fixture"
adb shell "am force-stop com.homecontrol.panel; am start -n com.homecontrol.panel/.MainActivity"
```

## 协议单测 / 假 HA

```powershell
node .\tools\test-ha.js          # 17 项断言：认证、状态、事件、call_service、registry、自动布局、重连、错误令牌
node .\tools\fake-ha.js 8123     # 起一个假 HA（token=good-token），绑 0.0.0.0，可给局域网内设备连
```

已知网络限制（会影响联调方式，踩过）：

- 本机 Windows 防火墙三个 profile 都开着且**未放行入站**，加规则需要管理员权限 → 平板连不上 PC 上的假 HA
- 这台平板的旧 adbd 不支持 `adb reverse`（报 `protocol fault (couldn't read status length)`，还会把 adb server 打死）
- 所以真实链路的端到端验证走上面的 fixture 方案；等真实 HA 地址与令牌到位再上真数据

### 开发期热更新（替代 adb reverse）

因为 `adb reverse` 在这台设备上不可用、PC 的 8787 也被防火墙挡住，热更新改成「`/sdcard` + 版本号文件」：

1. `tools\push.ps1` 推完面板后，会把一个时间戳推到 `/sdcard/HomeControl/panel/.rev`
2. 面板里的 `watchDevReload()`（`panel/js/app.js`）每 2 秒用桥方法 `AndroidBridge.mtime()` 读这个文件的 mtime
3. mtime 一变就 `location.reload()`，**不用 force-stop 重启 App**

真机实测（同一 pid，无重启）：

```
D/HomePanel: JSB ACT hot reload
I/HomePanel: page finished: file:///sdcard/HomeControl/panel/index.html
```

冷启动时设备上还没有 `.rev` 也能用：第一次 push 把文件创建出来即触发一次重载；60 秒内都没有 `.rev` 就停止轮询，所以正式上墙的环境不会空转。要彻底关掉热更新，删掉 `/sdcard/HomeControl/panel/.rev` 即可。

## WebSocket 掉了怎么办：REST 兜底

主通道是 WebSocket（实时推送、registry、状态事件都在这里）。如果 WS 连续失败（重试 3 次仍连不上），面板会**自动退到 REST**：

- `GET /api/states` 拉一次全量状态 → 卡片照样显示
- 点卡片/按钮走 `POST /api/services/<domain>/<service>` → 控制仍然有效
- 状态胶囊显示「REST 兜底 · 无实时推送（WS 重试中）」，WS 恢复后自动切回，状态文字也会跟着变回来

REST 走的是**壳 App 的原生 HTTP**（`Bridge.rest`），不是页面里的 XHR —— 因为面板是 `file://` 加载的，直接 XHR 到 HA 会被 CORS 拦。

顺带支持 HTTPS 自签名证书（局域网自建 HA 常见）：`https://` 与 `wss://` 都可以直接用，探活和 REST 都会放行自签证书。

代价要说清楚：REST 模式下没有面积/设备 registry，所以所有实体都会落在「其他」房间；也不会有实时刷新，需要手动重连（点一下状态胶囊）或等 WS 恢复。
## 设备内假 HA 联调（不依赖局域网）

面板与真实 HA 的 WebSocket 协议链路可以在设备上自证 —— 壳 App 带一个假 HA（`MockHaServer`，监听 `127.0.0.1:8123`），只在开关文件 `/sdcard/HomeControl/mockha.enabled` 存在时启动，而且**只有 debug 变体有这个类**（`app/src_debug/`，release 构建不编译它，正式 APK 的 dex 里没有 `MockHaServer`，已用 zipfile 读 dex 验过）。起假 HA 还要 `debug.flag` 在场，所以正式版既没有假 HA 也没有调试端口。

```powershell
# 打开（flag 文件 + ha.json 两个都要）
adb shell "echo 1 > /sdcard/HomeControl/mockha.enabled"
# ha.json 必须用 push（shell echo 会把 JSON 引号吃掉）
adb push tools\ha-mockha.json /sdcard/HomeControl/ha.json
adb shell am force-stop com.homecontrol.panel
adb shell am start -n com.homecontrol.panel/.MainActivity
```

`ha.json` 内容：`{"url":"ws://127.0.0.1:8123","token":"test-token"}`

该验的几件事：

- 状态胶囊显示「已连接」（不是「模拟数据」）→ 认证 + `get_states` 通了
- 房间 tab 出现「客厅 / 主卧」、卡片来自 registry → 三张 registry 查询通了
- 点灯 → logcat `JSB ACT toggle ...` → 卡片状态往返 → `call_service` + `state_changed` 通了
- 什么都不做，主卧温度每 6 秒自己变一次（logcat `MockHa: tick sensor.master_temp = ...`）→ 服务端主动推送通了

关掉：

```powershell
adb shell "rm -f /sdcard/HomeControl/mockha.enabled /sdcard/HomeControl/ha.json"
adb shell am force-stop com.homecontrol.panel; adb shell am start -n com.homecontrol.panel/.MainActivity
```

截图留档 `docs/screens/panel-real-ws.png`。

## PC 侧交互验收（不需要平板）

渲染自检只证明「页面能画出来」，这层证明「**点了会不会变**」：

```powershell
node tools\e2e-pc.js
```

做法：headless Edge + CDP（Chrome DevTools Protocol），自己实现了一个极简 WebSocket 客户端（只收发文本帧，无 npm 依赖），连上去后用 `Runtime.evaluate` 驱动页面、用真实 DOM 事件模拟点击/长按。

覆盖的流程（20 项断言）：

| 流程 | 断言 |
| --- | --- |
| 启动 | 卡片数 >= 8 |
| 首次引导 | 三步都在、点「先看模拟数据」后弹层关闭 |
| 开关 + 撤销 | 点灯带 → 卡片变 on + toast「已开启」→ 点撤销 → 回到 off |
| 灯详情 + 换色 | 长按开弹层、8 个色块、只有选中的高亮 |
| 场景 | 点场景键有「已执行」反馈 |
| 诊断页 | 长按时间打开、有版本行、有内存行 |
| 面板设置 | 列出 6 个房间、隐藏一个后 tab 少一个、恢复默认后复原 |

价值：平板 offline 的这 9 轮里，靠它发现了两个真 bug ——
① mock 数据的 `light.living_main` 没有 `supported_color_modes`，导致**模拟模式下彩色灯功能根本点不到**（真 HA 设备才显示，等于新功能在 demo 里是隐形的）；
② DOM 桩测不出的「长按要 520ms 才触发」这种时序问题。
## PC 侧渲染自检（不需要平板）

平板不在手边时，用本机 Edge 的 headless 模式把面板**真渲染一遍**再断言结构：

```powershell
# 先起静态服务（或让脚本自己起）
node tools\devserver.js
powershell -ExecutionPolicy Bypass -File tools\render-check.ps1 -ExpectGuide
```

断言内容：拿到的 DOM 够长、卡片数 >= 8、`#grid` / `.tabs` 存在、房间 tab >= 2、无 `Uncaught/SyntaxError` 痕迹、状态胶囊有文案、`#dim` 遮罩已渲染；带 `-ExpectGuide` 时再断言首次引导三步与「填地址和令牌」按钮。

这条链路的价值：`test-ui.js` 只测纯函数（DOM 桩），`render-check.ps1` 测的是**真 Chromium 里整页能不能跑起来**——包括 app.js 的执行顺序、CSS 生效、以及「引导弹层真的会弹」。第 34 轮的引导页就是先用它验的（平板当时 offline），截图见 `docs/screens/panel-pc-guide.png`。
## Chromium 57 的 CSS 兼容检查

`panel/js` 有 `lint-es5.js` 挡现代语法，CSS 这边原来没有对应物——而这台设备的 WebView 是 2017 年的 Chromium 57，**很多写法不生效但不报错，只是布局悄悄变形**。

```powershell
node tools\lint-css.js
```

它按「属性级黑名单 + 上下文判断」检查：

- `flex` 容器里的 `gap`（需 Chrome 84）→ 必须用 margin
- `grid` 容器用 `gap:` 简写（需 Chrome 66）→ 用 `grid-column-gap` / `grid-row-gap`
- `backdrop-filter` / `:is()` / `:where()` / `:focus-visible` / `aspect-ratio` / `clamp()` / `color-mix()` / `conic-gradient()` / `inset:` / `overscroll-behavior` / `scroll-snap` / `:has()` / 逻辑属性

第一次跑就抓到 **6 处真问题**（都是最近几轮新加的 UI）：会话弹层 `.s-item`、换色块 `.sw-row`、面板设置 `.p-row` / `.p-name`、首次引导 `.g-step` / `.g-step > div`。这些在 PC 的 Edge 里看不出任何异常（现代浏览器支持 flex gap），**只有装到平板上才会挤成一团**。已全部改成 margin 方案。
## 离线自检（不需要设备）

六套脚本，改完面板/协议都能先在本机跑一遍（平板不在也能验）：

```powershell
node tools\lint-es5.js      # Chromium 57 语法检查 + panel/ 与 app/assets/panel 是否一致（6 文件 0 命中）
                            # 也支持 `node tools\lint-es5.js <文件>` 临时查单个文件（给门禁自己测用）
node tools\lint-css.js      # Chromium 57 CSS 检查（flex gap / backdrop-filter / :is() 等）
node tools\test-ui.js       # 渲染与规整纯函数（87 项：离线/onoff/双设定点/无温度空调/卷帘/自动化/场景/房间/地址/曲线）
node tools\test-ha.js       # 协议与自动布局（43 项，假 HA 跑在 Node 里，含 WS + REST + history）
powershell -ExecutionPolicy Bypass -File .\tools\render-check.ps1 -ExpectGuide   # Edge headless 整页渲染（10 项）
node tools\e2e-pc.js        # CDP 真实点击链路（20 项：开关/撤销/长按/换色/场景/诊断/房间隐藏）
```

`test-ui.js` 给 `app.js` 一个够用的 DOM 桩，只跑纯渲染函数（`valHtml` / `subText` / `tileHtml` 等，通过 `window.__PANEL_TEST__` 暴露），不启动 boot、不连网络。这样「能力自适配」这类规则改错了，本机就能发现，不用每次都推真机。
## 规模与启动耗时（真机实测）

面板在真实 HA 里要面对的房间/实体数量取决于家里，所以专门做了规模测试（`tools\fixture-big-ha.js`，地址栏加 `?rooms=30` 就是 30 房 × 10 实体）：

| 场景 | 实体 | 房间 | 启动（脚本 → 首屏） | 首屏数据 | 表现 |
| --- | --- | --- | --- | --- | --- |
| 模拟数据 | 37 | 7 | 83 ms | 333 ms | — |
| 压力样例 | 306 | 30 | 66 ms | 46 ms（同步 fixture） | tab 横向滚动可到任一房间，点选后自动滚入可视区 |

日志里会打两行，方便换机/换 HA 后自己看：

```
JSB ACT boot 83ms · 卡 8 · 实体 0
JSB ACT first states 333ms · 实体 37
```

300 实体下启动仍是**几十毫秒**——因为渲染只发生在当前房间，不是把 300 个都画出来。
## 第一次上墙的引导

还没填 HA 地址时，面板不是「空白 + 一个徽标」，而是第一次启动自动弹出三步引导（用 localStorage 的 hc.guide.v1 记住看过就不再弹）：

1. 在 HA 里建长期访问令牌（网页 → 用户名 → 安全 → 长期访问令牌）
2. 把地址和令牌填进这块屏（地址写 192.168.1.10:8123 这样就行，协议/路径自动补）
3. 保存前会先探活：令牌不对当场提示，不用等连上

底部两个出口：「填地址和令牌」直接开连接设置，「先看模拟数据」关掉引导（随时长按右上角胶囊还能再开）。

状态胶囊在未配置时显示「未配置 · 长按右上角」+ 琥珀色圆点，短按也会直接打开连接设置——不依赖记住手势。
## 面板设置（隐藏不用的房间）

长按左上角时间 → 诊断页 → 「面板设置」，可以逐个关掉房间：

- 关掉的房间不出现在顶栏，也不出现在「全部」里
- 设置存在本机 `localStorage['hc.hidden']`，换面板文件不会丢
- 正在看的房间被关掉时，自动退回「全部」
- 「恢复默认」一键清空

真实家里常有儿童房/储物间/客房这类不想上墙的房间，全放上去会把 tab 挤满（第 7 轮踩过一次），所以给个开关比强行全渲染更实用。

## 长跑内存基线（挂墙 24 小时会怎样）

中控屏要一直挂着，所以专门测了「每 6 秒一次状态推送」下的内存表现（设备内假 HA，3 个传感器每 6s 变一次，10 分钟约 300 次 `state_changed`）：

| 指标 | 结果 |
| --- | --- |
| DOM 节点 | 357 → 359（10 分钟），基本不变 |
| 渲染次数 | 8 → 334（说明更新走的是 patch，不是重建整屏） |
| PSS | 83.7 MB → 92.3 MB（10 分钟，含 App 内假 HA 服务端） |
| 关掉假 HA 只跑模拟数据 | 72.0 → 77.3 MB（10 分钟），Native Heap +2.2 MB |

结论：**没有 DOM 泄漏**，剩下的是 WebView / ART 堆的自然增长（GC 松弛量），不是每帧新建节点。另外每天凌晨 4 点的静默重载本身会重置一次页面。

保险起见加了个自检：节点数超过「基线 × 1.6 + 80」就自动重载并提示；打开诊断页时会打一条 `JSB ACT mem <当前>/<基线> limit <上限>`，现场可以直接看数字。
## 面板模拟器（不需要平板）

平板不在手边（或者干脆还没上墙）时，用电脑浏览器就能跑**同一份面板代码**，数据来自真实 HA：

```powershell
node tools\sim.js                 # 打开 http://127.0.0.1:8788/
```

它做四件事：

1. 静态托管 `panel/`（和装置上跑的是同一份文件）
2. 把 `js/config.js` 在内存里改写为真实模式 —— `mock:false`、地址指向本机代理、令牌取根目录 `ha.json`
3. `/api/*` 反向代理到 HA（普通请求），`/api/websocket` 做 WebSocket 隧道 —— 所以没有 CORS，实时状态也照常推送
4. **默认只读**：`POST /api/services/*` 会被拦下并打日志，避免你不在家时误动真设备；真要试试控制就加 `--allow-control`

| 参数 | 作用 |
| --- | --- |
| `--port 9000` | 换端口（默认 8788） |
| `--mock` | 不连 HA，用面板自带的模拟数据 |
| `--allow-control` | 允许真的调用 HA 服务（开关灯等） |
| `--host 0.0.0.0` | 让同局域网的手机/平板也能打开 |

浏览器窗口调到 **1024×768** 就是平板上看到的比例。想看自动截图和摘要（含「连上 HA 了吗」）：

```powershell
node tools\sim-shot.js            # 产出 build\sim-home.png / sim-room.png / sim-sheet.png
```
## 连真实 HA 做只读联调（有令牌就能跑）

```powershell
node tools\real-ha-check.js http://10.10.1.7:8123 <长期访问令牌>
```

它用**面板自己的** `panel/js/backend.js` 和 `panel/js/layout.js`：REST 探活 → WS 认证 → `get_states` → 三张 registry → 交给布局引擎，
最后打印「这个家面板会长成什么样」（房间、每房间卡片类型分布、场景、按域统计、哪些域暂不渲染）。
只发只读命令，**不会调用 call_service，不会动任何设备**。

第一次跑真实家庭（1254 实体 / 3 区域）就暴露了两个布局问题，都已修：

- 每房间总量上限 24 会把排在后面的类型整段切掉（大房间全是开关时，灯和传感器消失）→ 改成**按类型各自限流**（light 24 / switch 24 / climate 12 / cover 12 / sensor 12）
- 米家的「指示灯 / 屏幕亮度」不是给人操作的功能灯 → 过滤 `*_indicator_light`、`*_indicator` 与名称含「指示灯」的实体
## 自查工具

改完代码按顺序跑，前四个不需要平板：

```powershell
# 1) Chromium 57 语法闸门：箭头函数/可选链/class 等现代语法直接报错
node tools\lint-es5.js

# 2) Chromium 57 CSS 闸门：flex gap / backdrop-filter / :is() 等不生效的写法
node tools\lint-css.js

# 3) 纯函数 UI 测试：离线/onoff/亮度/双设定点/无温度空调/卷帘/自动化/场景/房间可见性/地址规整/曲线
node tools\test-ui.js

# 4) 协议离线测试：手写假 HA（WS+REST）验证认证/状态/事件/服务调用/registry/布局/重连/诊断/历史
node tools\test-ha.js

# 5) 真 Chromium 整页渲染（Edge headless）：证明页面能跑起来
powershell -ExecutionPolicy Bypass -File .\tools\render-check.ps1 -ExpectGuide

# 6) 真 Chromium 交互（CDP）：证明点了会变（开关/撤销/长按/换色/场景/诊断/房间隐藏）
node tools\e2e-pc.js

# 7) 重命名全流程（CDP 真点击，跑在模拟器上）：铅笔 → 改名 → 卡片生效 → 面板设置回滚
#    node tools\e2e-rename.js

# 8) 设备端冒烟：推面板 → 重启 App → 检查加载与 JS 错误 → 点一张卡 → 看日志里有没有 ACT
powershell -ExecutionPolicy Bypass -File .\tools\smoke.ps1
```

`smoke.ps1` 通过时输出 `SMOKE PASS` 并留一张 `build\smoke-home-rot.png`。

面板的每个用户动作都会打一行 `ACT <动作> <实体>` 到 logcat（`adb logcat -d | Select-String "ACT "`），排查「点了没反应」时先看有没有这行：有 ACT 说明点击到了、问题在后端；没有就是手势/坐标问题。
## 交接审查

`docs/HANDOVER.md` 把「已真机验证 / 只差一步 / 补上输入后按什么顺序验」三件事分开写清楚了：包含每个能力的证据（logcat 片段、系统属性）、拿到 HA 凭证后的确切操作与四种失败现象的对应处理、以及平板回来后的三条命令与预期输出。
## 当前状态

- 面板功能：房间切换、灯/开关/插座、空调（模式/温度/风速）、窗帘（开合度滑杆）、温湿度/人体传感器、场景键、长按详情弹层、断线提示
- 能力自适配：按 `supported_color_modes` / `hvac_modes` / `target_temp_step` / `supported_features` 决定是否显示滑杆与档位，避免真实 HA 里出现无效控件
- 配置：**可在平板上长按状态胶囊直接改 HA 地址/令牌**（写 `ha.json` 后自动重连），也可 adb 推 `ha.json`；保存前用原生 HTTP 探活校验地址与令牌（200 / 401 / 超时三种结果分别提示）
- 默认走**模拟数据**（`panel/js/config.js` 里 `mock: true`），37 个实体的完整交互已逐项验证
- 真实模式：协议层由 `tools/test-ha.js` 全绿覆盖；设备端 UI 链路用 fixture 方案验收通过；只差真实地址 + 令牌做最终联调
- 局域网限制（实测）：平板 → PC 方向所有端口（80/443/8080/5037/5555/9999/8123）都是 SocketTimeoutException，Windows 防火墙三个 profile 全开且加规则需要管理员权限，所以「设备连 PC 上的假 HA」这条路不通；真实 HA 只要在同一网段且允许入站就没问题。`adb reverse` 也因旧 adbd 报 protocol fault 不可用，热更新改用 `.rev` 文件 + mtime 轮询
- 上墙：已设为默认桌面，重启自动拉起（实测）；常亮、锁屏覆盖、看门狗、双返回键逃生口均可用；夜间/空闲自动调暗（实测，docs/screens/panel-night-dim.png）；长按时间可开诊断页（docs/screens/panel-diag.png）；每天 04:00 静默重载一次
- **假死自愈（实测）**：面板 JS 每 4 秒心跳一次；壳 App 的看门狗每 15 秒检查，**屏幕亮着**且超过 45 秒没心跳才 web.reload()（PowerManager.isInteractive()；熄屏 + Doze 会冻结 WebView 定时器，所以熄屏时看门狗直接跳过，不再整夜每 45s 重载），首帧前给 180 秒宽限（慢网络下 irst states 实测可到 35 秒，45 秒阈值会把正在启动的页面打断）。真机验证两条：① URL 加 ?selftest=hang 让页面主线程卡死 60 秒 → logcat 出现 watchdog: no heartbeat for 45s, reloading，卡死结束后自动重载、页面恢复、无人工干预；② 熄屏静置 110 秒 → 0 条 watchdog/reload 日志（改之前每 45 秒一次）
- **进程被杀后的恢复**：默认桌面角色保证按 Home 键 / 重启都会重新拉起（实测 force-stop 后按 Home 重新拉起、重启后无需解锁直接进面板）；MIUI 的 AutoStart 会拒绝后台自启广播，所以不依赖开机广播这一路

## PC 侧排版自检（不用真机）

改卡片布局、文字排版这类「看得见」的东西时，先在 PC 模拟器里过一眼再推真机：

```powershell
# 1. 起 mock 模拟器（站点根就是 panel/，不要再加 /panel/）
Start-Process node tools\sim.js --mock --port 8788 -WindowStyle Hidden

# 2. 灌 5 张卡并截图，第 3 个参数是列数（3/4/5/6），4 列就省略
node tools\shot-foot.js http://127.0.0.1:8788/ build\foot.png 6
```

脚本会打印每张卡的 `名称 | 状态`，方便确认有没有挤压、截断、名称被状态顶掉。
注意：列数参数必须传**数字**，传 JSON 会被 PowerShell 吃掉双引号（localStorage 里存成 `{cols:6}` 而失效）。
