# 中控屏使用手册

这块面板现在的状态：**能跑、能上墙、能自己恢复**，但还没接你家的真实 Home Assistant —— 接上之后房间和卡片会自动生成。下面按「第一次装」「日常用」「出问题」三部分写。

---

## 一、接上你的 Home Assistant

**第一次上墙会自动弹出三步引导**：点「填地址和令牌」直接跳到下面的连接设置；点「先看模拟数据」可以先逛一逛（之后长按右上角胶囊随时能再进来）。

### 1. 拿一个长期访问令牌

HA 网页 → 左下角用户名 → **安全** → 页面最下方「长期访问令牌」→ 创建 → 复制那串 `eyJ...`（只显示一次）。

### 2. 在平板上填进去（不用连电脑）

1. 长按右上角状态胶囊 0.8 秒 → 弹出「连接设置」
2. 地址填 `http://192.168.x.x:8123`（只填到端口即可，`/api/websocket` 会自动补）
3. 令牌粘贴进去
4. 点「保存并重连」

保存前它会先用壳 App 的原生 HTTP 探一次，所以你不用猜：

| 探测结果 | 提示 | 说明 |
| --- | --- | --- |
| 200 | 令牌有效，已保存，正在重连… | 正常，随后自动重载 |
| 401 / 403 | 已保存，但令牌被拒绝，请检查令牌 | 令牌复制错了，或已失效 |
| 连不上 | 已保存，但连不上这个地址（SocketTimeoutException） | 地址错、平板不在同一网段、或 HA 没开 |

弹层不会关，改完再点一次就行。

### 3. 接上之后会发生什么

- 面板会从 HA 拿「区域 / 设备 / 实体」三张表，**自动生成房间和卡片**（灯 → 开关 → 空调 → 窗帘 → 传感器 排序）
- 你在 HA 里没建区域也没关系，所有实体会归到「其他」房间，不会一片空白
- 场景键取前 6 个 `scene.*` / `script.*`
- 卡片只显示实体真正支持的能力：onoff 灯不出现亮度条、只能开合的窗帘不出现开合度滑杆、只有冷暖的空调不出现制冷档

---

## 二、日常怎么用

| 操作 | 动作 |
| --- | --- |
| 点卡片 | 开 / 关（灯、插座、开关、风扇、自动化） |
| 点卡片后 5 秒内点底部提示 | **撤销**刚才那一下 |
| 长按卡片 | 打开详情：灯的亮度/色温、空调模式与温度、窗帘开合度、传感器读数 |
| 点卡片右上角「…」 | 同上，打开详情 |
| 点顶部场景键 | 执行场景 / 脚本 |
| 点房间 tab | 切换房间（房间多时可横向滑动）；**会记住这个房间**，凌晨重载或重启后还停在这里 |
| 卡片超过两屏 | 网格可上下滑动 |
| 长按右上角状态胶囊 | 打开「连接设置」（改 HA 地址 / 令牌 / 切回模拟数据） |
| 短按右上角状态胶囊 | 立刻重连一次 |
| 长按左上角时间 | 打开「设备与连接诊断」 |

### 夜里会自己变暗

- 白天空闲 90 秒、夜间（23:00–07:00）空闲 20 秒 → 屏幕压暗成一个大时钟，**硬件背光同时降到 35%**（不是只盖一层黑）
- 轻触屏幕唤醒；唤醒的那一下不会误触到下面的卡片
- 想改时间/亮度：`panel/js/config.js` 里的 `dim` 段（`idleSec` / `nightIdleSec` / `brightness` / `nightStart` / `nightEnd`）

### 防烧屏

每 5 分钟整块界面随机平移 1–2 像素（肉眼看不出），避免时钟、卡片边框长期压在同一批物理像素上。频率在 `config.js` 的 `burnIn` 段。

---

## 三、出问题怎么查

### 长按左上角时间 → 诊断页

一次能看到这些，直接念出来就能定位：

```
模式        真实 HA / 模拟数据
HA 地址     http://192.168.1.10:8123
令牌        ••••abcd
连接        已连接 / 连接失败，重试中… / 连不上 HA · 检查地址与网络
连通测试    正常 · 令牌有效 / 连不上（SocketTimeoutException）
布局        6 个房间 / 32 张卡
实体        37 个
网络        10.10.1.78 · 501_5G      ← 平板自己的 IP 和 Wi-Fi
视口        1024×768 @2x
内核        Chrome/57.0.2987.132 / WebView
最近错误    无
```

按钮：重新加载 / 清缓存并重载 / 测试连接 / 连接设置 / 回模拟数据 / 关闭。

### 「连不上 HA」三步

1. 诊断页看**网络**：IP 是不是 `0.0.0.0`、SSID 是不是你家那个
2. 点「测试连接」看具体错误：`SocketTimeoutException` = 网络/地址不通；`401` = 令牌问题
3. 还不行就长按胶囊核对地址（常见错误：填了 `https://` 但家里是 http，或端口不是 8123）

### 想回模拟数据

长按右上角胶囊 → 「改用模拟数据」。设备上 `ha.json` 被删掉，面板立刻回内置样例（37 个实体），适合演示和排错。

### 逃生口（面板卡住 / 想回安卓桌面）

**连续按两次返回键**（1.5 秒内），会先提示「再按一次返回键进入系统设置」，然后跳到系统设置。

恢复原来的桌面：设置 → 主屏幕 → 系统桌面。

### 应用更新后屏幕掉回桌面？

正常。`adb install -r` 会杀掉面板进程，而 Android 5.1 上更新安装不会再触发开机广播。装完补一句：

```
adb shell am start -n com.homecontrol.panel/.MainActivity
```

或者重启设备（默认桌面角色仍然有效，开机自动进面板）。

---

## 四、上墙验收（可重复执行）

```
powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
```

它会自己重启设备，然后逐项检查：设备在线 / 应用已装 / 按 HOME 进面板 / 系统启动完成 / **重启后自动拉起（记录秒数）** / 屏幕常亮 / 内存占用 / 已连网 / 无脚本错误 / 截图存档。

结果写到 `docs/verify-report.md`，形态如下（实机实测）：

| 检查项 | 结果 | 详情 |
| --- | --- | --- |
| 重启后自动拉起面板 | PASS | 重启后 33 秒出现 |
| 面板内存占用 | PASS | PSS 71.9 MB |
| 设备已连网 | PASS | wlan0 10.10.1.78 |

---

## 五、截图

| 页面 | 文件 |
| --- | --- |
| 主界面（模拟数据） | `docs/screens/panel-home.png` |
| 真实 HA 自动布局（样例数据） | `docs/screens/panel-real-layout.png` |
| 连接设置 | `docs/screens/panel-config.png` |
| 诊断页 | `docs/screens/panel-diag.png` |
| 空调详情（含 heat_cool 能力） | `docs/screens/panel-climate-heatcool.png` |
| 窗帘详情（可调位置 / 只能开合） | `docs/screens/panel-cover.png`、`panel-cover-noposition.png` |
| 夜间压暗 | `docs/screens/panel-night-dim.png` |
| 房间多 / 卡片多 | `docs/screens/panel-many-rooms.png`、`panel-dense-room.png` |
| 误触撤销 | `docs/screens/panel-undo.png` |
| 重启后自动进面板 | `docs/screens/panel-verify.png` |

## 第一次上墙（还没接 HA 时）

面板没填地址/令牌时，右上角胶囊显示 **「未配置 · 长按右上角」**（琥珀色点），并且首次启动会弹一次提示。这是「样例数据」状态，不是连不上：

- **短按**胶囊 → 直接打开连接设置
- **长按**胶囊 0.8s → 同样打开连接设置
- 设置里填 `http://<HA 地址>:8123` + 长期访问令牌 → 「保存并重连」，保存前会先探活（令牌对不对、地址通不通当场就有结论）

## 设备掉线/卡住怎么办

这台平板只能通过 USB 调试连接，实测偶发「屏幕半白 + `adb devices` 变成 offline」——是设备侧 adbd 挂了，不是面板的问题：

1. 拔插 USB 线，等 30 秒看 `adb devices`
2. 仍 offline → 长按电源键重启平板（面板是默认桌面，开机自动回来）
3. 面板本身不需要电脑：重启后会自动加载，配置也存在 `/sdcard/HomeControl/`
## 实时画面（可选，需要 go2rtc）

想看到「会动」的画面（不再是几秒一张）：

1. HA → 设置 → 加载项 → 商店 → 装 **go2rtc**
2. go2rtc 配置里加你的摄像头：`streams: mainStream: rtsp://用户名:密码@摄像头IP:554/stream1`
3. 浏览器打开 `http://<HA地址>:1984` 确认能看到 `mainStream`
4. 告诉面板流地址（两种方式任选）：
   - 编辑 `panel/js/config.js` 的 `camStream`
   - 或在平板的 `/sdcard/HomeControl/ha.json` 里加 `"camStream": {"camera.tp_ipc_mainstream": "http://10.10.1.7:1984/api/stream.mjpeg?src=mainStream"}`
5. 面板上摄像头卡会带绿点、详情页写「实时 · MJPEG」；断了会自动退回快照

## 摄像头

- 客厅/门口这类 `camera.*` 实体会出现在卡片里，显示的是**快照**（几秒一张），不是实时视频
- 点开看大图，1.2 秒刷新一次；大图下面有「立即刷新」
- 摄像头离线（HA 里是 `unavailable`）时卡片写「离线」，点开写「摄像头没有画面」，不会给你一张黑图或假图
- 快照地址：HA 的 `entity_picture`（推荐，HA 自己签名）或 `camera_proxy + 长期令牌`

## 截图索引

`docs/screens/` 下的实机截图，按用途分组（都是 MI PAD 2 真机，2048×1536 横屏截取后转正）：

| 文件 | 内容 |
| --- | --- |
| `panel-home.png` | 主界面（模拟数据，客厅） |
| `panel-master.png` / `panel-study.png` | 主卧 / 书房；书房里有三台能力不同的空调 |
| `panel-light.png` | 灯详情弹层（亮度 + 色温滑杆） |
| `panel-climate.png` / `panel-climate-heatcool.png` | 空调弹层（单温度 / heat_cool 区间） |
| `panel-dual-setpoint.png` | `heat_cool` 双设定点：卡片 20–26°C、弹层两行限值 |
| `panel-climate-no-temp.png` | 没有目标温度能力的空调（新风）：只有模式 |
| `panel-cover.png` / `panel-cover-noposition.png` | 窗帘弹层（有开合度 / 只能开合） |
| `panel-automation.png` / `panel-automation-card.png` | 自动化：点卡片=触发、弹层里启用/禁用 |
| `panel-unavailable.png` | 设备离线：整卡降透明度、点它提示「设备离线」 |
| `panel-undo.png` | 误触后的 5 秒撤销 |
| `panel-night-dim.png` | 夜间调暗（含背光降到 0.35） |
| `panel-diag.png` | 设备与连接诊断（含网络、内存节点数） |
| `panel-config.png` | 连接设置弹层（地址 + 令牌） |
| `panel-connecting.png` / `panel-reconnect.png` | 连不上时的状态文案 / 短按重连 |
| `panel-real-layout.png` / `panel-real-ws.png` | 真实模式自动布局（fixture / 设备内假 HA 真实 WS） |
| `panel-rest-fallback.png` | WS 挂掉后的 REST 兜底 |
| `panel-many-rooms.png` / `panel-dense-room.png` | 80 实体压力样例 / 单房间多卡滚动 |
| `panel-room-memory.png` | 记住上次查看的房间 |
| `panel-verify.png` / `panel-smoke.png` | 验收脚本 / 冒烟脚本截图 |
| `panel-after-reboot.png` | 重启后自动拉起面板 |
| `panel-pc-guide.png` | 首次引导（PC 侧 headless 渲染，1024×768） |

> 交接与验收细节（谁验、怎么验、失败现象怎么对应）见 [HANDOVER.md](HANDOVER.md)。

## 模拟器（电脑上看，不需要平板）

平板不在手边时，用浏览器看同一份面板、连真实 HA：

```powershell
node tools\sim.js
```

然后打开 <http://127.0.0.1:8788/>，窗口调到 1024×768 就是墙上的样子。默认**只读**（不会动你家的设备）；要真的试开关，加 `--allow-control`。手机/平板想看得加 `--host 0.0.0.0`。

自动截图与「连上没有」的自检：`node tools\sim-shot.js`。