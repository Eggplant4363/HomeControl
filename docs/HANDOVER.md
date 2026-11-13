# 交接审查（Handover Audit）

写这份文档时的状态：**面板侧全部就绪并通过六层离线自检；缺两样外部输入才能收尾** ——
Home Assistant 的地址与长期访问令牌，以及一台在线的平板。

本文档回答三个问题：**哪些已经真机验证过**、**哪些只差一步**、**补上输入后按什么顺序验**。

---

## 一、已真机验证（有 logcat／截图／系统属性证据）

设备：MI PAD 2（A3P4661B1BA6），Android 5.1 / MIUI 9.6 / WebView Chromium 57，1024×768 CSS @2x。

### 壳 App（目标 ①）

| 能力 | 证据 |
| --- | --- |
| 全屏 WebView + 本地资源 | `page finished: file:///sdcard/HomeControl/panel/index.html` |
| 常亮 | `FLAG_KEEP_SCREEN_ON`；`dumpsys power` 中 `mWakefulness=Awake` 持续 |
| 开机/回桌面自启 | 设为默认桌面（`CATEGORY_HOME`），重启 33 秒后面板自动出现；`mCurrentFocus=com.homecontrol.panel/.MainActivity` |
| 断线自动重连 | 停掉假 HA 后状态胶囊转「连接断开，重连中…」，恢复后自动 `已连接` |
| 假死自愈 | 自检钩子阻塞主线程 60s → 45s 时 `watchdog: no heartbeat for 45s, reloading` → 页面自恢复。**熄屏时看门狗直接跳过**（Doze 会冻结 WebView 的 JS 定时器，旧版因此在熄屏状态下每 45s 重载一次；见 [docs/REFACTOR.md](docs/REFACTOR.md) R1） |
| 离家熄屏 | 造两台合成 `person.*` 全 `not_home` → `AndroidBridge.screenTimeout()` 变短（默认 5s）；改回 `home` → 还原设备原值；关掉开关 → 也还原。MIUI 不认超时的 ROM 走全黑兜底（`AndroidBridge.blackoutState()`）。回归：`node tools/check-away.js <序列>`；`WRITE_SETTINGS` 授权见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 5b |
| 双击返回键逃生口 | 1.5s 内两次 BACK → 进入系统设置（默认桌面被替换时的后路） |
| 平板内改配置 | 长按状态胶囊 → 写 `/sdcard/HomeControl/ha.json`（`writeText ok: ... (54 chars)`）→ 重连 |
| 保存前探活 | 200 / 401 / `SocketTimeoutException` 三种结果分别提示，失败不关弹层 |
| 夜间调暗 + 背光 | `setBrightness 0.35` 且 `dumpsys window windows` 出现 `sbrt=0.35`；唤醒后 `setBrightness -1.0`、`sbrt` 消失 |
| 防烧屏位移 | `JSB ACT shift 2,1 / 0,1 / 1,1 / -1,-1`；像素级 diff 85% |
| 热更新（替代 adb reverse） | push 后 `JSB ACT hot reload` → `page finished`，pid 不变 |
| 内存基线 | 10 分钟 300+ 次推送：DOM 节点 357→359、渲染 8→334，**无 DOM 泄漏** |

### 面板（目标 ②）

| 能力 | 证据 |
| --- | --- |
| 全量交互 | 灯/开关/插座/空调/窗帘/场景/自动化/传感器逐项点过；`ACT toggle` / `ACT undo toggle` 日志 |
| 能力自适配 | onoff 灯无滑杆、`heat_cool` 双设定点（20–26°C 两行）、无温度空调只显示模式、无开合度卷帘无滑杆 |
| 离线态 | `unavailable` 卡片降透明 + 「离线」，点击只 toast「设备离线，无法操作」，无服务调用 |
| 真实协议（WS） | 设备内假 HA：`mock HA listening 127.0.0.1:8123` → registry 自动出房间 → 点灯往返 → `tick` 推送后屏幕数值自变 |
| REST 兜底 | 只关 WS：`rest GET /api/states -> 200`、11 张卡由 REST 渲染、点灯 `rest POST /api/services/light/toggle -> 200` |
| 连不上诊断 | 12s 超时后「连不上 HA · 检查地址与网络」；短按胶囊「正在重新连接…」 |
| 规模 | 306 实体 / 30 房间：boot 66ms、first states 46ms、tab 可横滑到远端并切换 |
| 其他 | 撤销、房间记忆、场景「更多 N」、温湿度曲线、彩色灯 8 色块、面板设置隐藏房间（部分在 PC 侧验收） |

### PC 侧验收（不需要平板）

| 脚本 | 断言 | 结果 |
| --- | --- | --- |
| `tools/lint-es5.js` | 现代语法闸门 | 5 文件 0 命中 |
| `tools/lint-css.js` | Chromium 57 CSS 闸门（曾抓出 6 处 flex gap） | ALL PASS |
| `tools/test-ui.js` | 纯函数渲染规则 | 87 项 |
| `tools/test-ha.js` | WS + REST 协议、布局、重连、诊断、历史 | 43 项 |
| `tools/render-check.ps1` | Edge headless 整页渲染 | 10 项 |
| `tools/e2e-pc.js` | CDP 真实点击链路 | 20 项 |

---

## 二、只差一步（需要真 HA 或在线平板）

| # | 事项 | 差什么 | 验证方式 |
| --- | --- | --- | --- |
| 1 | 真实 HA 接入（目标 ③） | HA 局域网地址 + 长期访问令牌 | 填入后状态胶囊转「已连接」，房间/设备与 HA 一致，点灯在 HA 侧同步 |
| 2 | 上墙验收（目标 ④） | 平板恢复在线 | 见下面第四节命令 |
| 3 | 77 KB APK 安装 | 同上 | `tools\deploy.ps1` |
| 4 | 未配置徽标/首次引导截图 | 同上 | 装完首次打开应看到三步引导，`docs/screens/panel-first-run.png` 待补 |

> 平板自 05:17 起 `offline`，掉线前最后一帧是「左半正常、右半白」——判断为设备侧 compositor 与 adbd 一起挂住。
> 软件侧无法恢复：`adb kill-server`/`start-server` 无效，`adb reboot` 报 `error: device offline`。
> **只能长按电源键 10 秒强启，或拔插 USB。**

---

## 二·五、真实 HA 已联通（2026-11-06 08:3x 复核）

用户提供的长期访问令牌已验证可用，HA 就在同一网段：

```
mDNS: homeassistant.local -> 10.10.1.7
GET http://10.10.1.7:8123/api/  ->  200 {"message":"API running."}
WS   ws://10.10.1.7:8123/api/websocket  ->  auth_ok，get_states 1254 个实体（217ms）
registry: areas 3 / devices 88 / entities 1430
```

只读联调脚本：`node tools\real-ha-check.js http://10.10.1.7:8123 <token>`
（只发 auth / get_states / registry / subscribe，不发 call_service，不会动任何设备）

### 这个家庭在面板上会长成这样

| 房间 | 卡片 |
| --- | --- |
| 其他（没分配区域） | 42 张：light×6、switch×24、sensor×12 |
| 主卧 | 26 张：switch×24、sensor×2 |
| 客厅 | 1 张：sensor×1 |
| 场景 | 1 个「欢迎回家」 |

HA 里的域分布：`sensor×600 button×139 switch×105 select×93 event×91 number×80 text×54 notify×31 binary_sensor×19 update×15 light×11 device_tracker×5`。
**没有 `climate` / `cover`**，所以空调、窗帘那两类面板不会出现（这是数据决定的，不是功能缺失）。

顺带据此调了一条布局规则：每个房间**按类型各自限流**（light 24 / switch 24 / climate 12 / cover 12 / sensor 12），
并过滤掉米家的「指示灯 / 屏幕亮度」这类噪声实体（`*_indicator_light`、名称含「指示灯」）——
否则 100+ 开关的大房间会把灯和传感器整段挤掉（130 轮里第一次用真实家庭数据验证到这一点）。

### 配置已就绪

仓库根目录已有 `ha.json`（地址 `http://10.10.1.7:8123` + 该令牌）；
`tools\deploy.ps1` 现在会自动把它推到 `/sdcard/HomeControl/ha.json` 并校验「已按 ha.json 加载」。
**平板一上线，一条命令即可上台。**
## 三、拿到 HA 凭证后的确切步骤

1. **建令牌**：HA 网页 → 左下角用户名 → 安全 → 长期访问令牌 → 创建，复制出来（形如 `eyJ0eXAiOiJKV1Qi...`）。
2. **在平板上填**（推荐，不需要电脑）：
   - 长按右上角状态胶囊 → 「连接设置」
   - 地址只写 base 即可，例如 `192.168.1.10:8123`（也可 `http://…` / `https://…` / `wss://…/api/websocket`；**地址与令牌会被自动规整**）
   - 令牌粘贴进去（换行/空格会被自动去掉）
   - 点「保存并重连」→ 先探活：`200` 提示「令牌有效，已保存，正在重连…」；`401` 提示令牌被拒；超时提示「连不上这个地址」
3. **或用电脑推文件**（等价）：
   ```powershell
   '{"url":"http://192.168.1.10:8123","token":"<令牌>"}' | Set-Content -Encoding utf8 .\ha.json
   adb push .\ha.json /sdcard/HomeControl/ha.json
   adb shell am force-stop com.homecontrol.panel
   adb shell am start -n com.homecontrol.panel/.MainActivity
   ```
   > 必须用 `adb push`，`adb shell echo` 会把 JSON 的引号吃掉。

### 预期结果

- 状态胶囊：「已连接」（绿点），诊断页「模式 真实 HA / 连通测试 正常 · 令牌有效」
- 房间 tab 来自 HA 的「区域」；没有区域的实体落进「其他」
- logcat 出现 `I/HomePanel: url from /sdcard/HomeControl/ha.json`、`page finished`
- 点灯后 HA 里同实体状态同步；HA 里改状态，面板 1 秒内跟着变（若没有，看是否走了 REST 兜底：胶囊会写「REST 兜底 · 无实时推送」）

### 如果连不上

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「令牌被拒绝（HTTP 401）」 | 令牌错/已撤销 | 重新建令牌 |
| 「连不上这个地址（SocketTimeoutException）」 | 地址错、端口错、不在同一网段、HA 未监听 0.0.0.0 | 手机上用浏览器打开 `http://<地址>:8123` 先确认 |
| 「地址不对（HTTP 404）」 | base 里带了多余路径 | 只填 `http://host:port` |
| 「REST 兜底 · 无实时推送」 | WS 被反代挡住 | 反代需要放行 `/api/websocket` 的 Upgrade |

---

## 四、平板回来后按顺序跑

```powershell
cd D:\Document\Project\HomeControl

# 0) 确认在线
& "D:\Software\platform-tools\adb.exe" devices        # 必须是 device，不是 offline

# 1) 一条命令部署（装 APK + 推面板 + 重启 + 校验）
powershell -ExecutionPolicy Bypass -File .\tools\deploy.ps1 -Build
#   期望最后一行：DEPLOY OK

# 2) 设备端冒烟（点一张卡，看有没有 ACT 日志）
powershell -ExecutionPolicy Bypass -File .\tools\smoke.ps1
#   期望：SMOKE PASS

# 3) 上墙验收（重启后自动拉起、常亮、无脚本错误、截图）
powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
#   期望：10 项 PASS，报告写 docs\verify-report.md，截图 docs\screens\panel-verify.png
```

补充的人工动作（各 10 秒）：

| 动作 | 期望 |
| --- | --- |
| 长按右上角胶囊 | 连接设置弹层 |
| 点「保存并重连」（地址空） | 提示需填地址，不写文件 |
| 长按左上角时间 | 诊断页（版本/内存/网络/连通测试） |
| 点场景「⋯ 更多 N」 | 场景与脚本列表 |
| 长按温湿度卡 | 详情页有 12 小时曲线 |
| 长按彩色灯卡 | 详情页 8 个色块，点一个卡片变该颜色 |
| 诊断页 →「面板设置」 | 房间列表可隐藏/恢复 |

---

## 五、目录与产物

```
app/src/            安卓壳（Java，无第三方依赖）+ TlsPolicy
app/src_debug/      只在 debug 变体编译的假 HA（release dex 里没有这个类）
app/certs/          ISRG 锚证书源文件（构建拷进 assets/certs，本身不放进 assets）
panel/              面板前端（HTML/CSS/JS，Chromium 57 兼容；唯一的真相，assets 不入库）
tools/              构建/部署/推送 + 自检 + 真机回归（env.ps1、lib/cdp.js、check-{security,rest,temp,tls,away}.js…）
dist/               homecontrol.apk（debug，185 KB）/ homecontrol-release.apk（173 KB），versionName 0.7.19 / versionCode 56
docs/ARCHITECTURE.md 两层职责、Bridge 契约、TLS 与看门狗规则、构建七步
docs/REFACTOR.md    本轮重构：已修清单+证据、验证矩阵、待办、踩坑表
docs/PERFORMANCE.md 性能基线与批次 A/B/C 的改动、改后数字、有意不动的既有优化、下一轮候选
docs/TOOLING.md     每个脚本跑什么、需要什么前提、失败了怎么办（env 变量表 + 端口表 + 三条咬人的坑）
docs/USAGE.md       使用手册（含首次上墙、掉线处理、截图索引）
docs/screens/       29 张实机/PC 截图
README.md           工程说明（20 节，含所有“为什么这么做”）
```

推送面板到设备（改 JS 后最常用）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Restart
```

---

## 六、已知限制（设计取舍，非缺陷）

1. **不用 HA 官方前端**：这块板的 WebView 是 2017 年的 Chromium 57 且无法升级；HA 官方前端（2023+）跑不起来。所以自研轻量面板。
2. **开发期热更新不用 `adb reverse`**：这台设备的 adbd 太老，`adb reverse` 报 `protocol fault` 还会打死 adb server；改用「推 `.rev` 时间戳 + 页面轮询 mtime」。
3. **设备→PC 方向网络不通**：Windows 防火墙静默丢包（6 个端口全部 `SocketTimeoutException` 而非 refused），加规则需管理员权限。
   因此真实协议验证改用**设备内假 HA**（`MainActivity` 反射起 `MockHaServer`，127.0.0.1:8123）。它只在 **debug 变体**里编译，且要 `/sdcard/HomeControl/debug.flag` + `/sdcard/HomeControl/mockha.enabled` 同时存在才起——正式包里既没有这个类也没有调试通道。
4. **没有 npm 依赖**：Node 24 自带的 npm 在这台机器上坏了（`Class extends value undefined`），所有工具脚本零依赖手写。
5. **不自动拉起被杀进程**：MIUI 拒绝第三方后台自启广播，靠「默认桌面」角色解决；没有加 AlarmManager（force-stop 会清闹钟，且与双击返回键逃生口冲突）。
