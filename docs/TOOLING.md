# HomeControl 工具链怎么用（tools/）

这一份只讲「跑什么、需要什么前提、失败了怎么办」。架构与为什么这么做见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，本轮改了什么见 [docs/REFACTOR.md](docs/REFACTOR.md)。

## 环境（一次配置，全工具共用）

`tools/env.ps1` 被四个 PowerShell 脚本 dot-source，导出 `$AndroidSdk $BuildTools $AndroidJar $JavaHome $Javac $Keytool $Adb $Fastboot $Device`。找不到东西就 throw 并告诉你该设哪个变量：

| 变量 | 覆盖什么 | 本机默认 |
| --- | --- | --- |
| `HC_ANDROID_SDK` | android-sdk 根 | `D:\Software\android-sdk`，回退 `%LOCALAPPDATA%\Android\Sdk` |
| `HC_BUILD_TOOLS` | build-tools 目录 | SDK 下最新那个版本目录 |
| `HC_JAVA_HOME` | JDK 17（javac/keytool） | 常见 JDK17 路径 |
| `HC_ADB` | adb.exe | `D:\Software\platform-tools\adb.exe` |
| `HC_DEVICE` | 默认设备号 | `emulator-5554`；`ANDROID_SERIAL` 也认 |

设备号规则：**命令行首参优先**（`node tools\check-rest.js <serial>`、`-Serial`），否则 `HC_DEVICE`/`ANDROID_SERIAL`。

## 构建与部署

| 命令 | 作用 | 注意 |
| --- | --- | --- |
| `powershell -File tools\build.ps1` | debug 包 `dist/homecontrol.apk`（含假 HA、CDP 可用） | 每次 wipe `app/assets` 再拷 `panel/` + `app/certs/*.pem`；所以临时文件别放 `build/`（也会被 wipe），放 `backup/` |
| `powershell -File tools\build.ps1 -Variant release -OutName homecontrol-release.apk` | 正式包 | `app/src_debug/` 不参与编译 → dex 里没有 `MockHaServer`；用 `-VersionCode/-VersionName` 定版本，别再写一次性升版本脚本 |
| `powershell -File tools\push.ps1 -Restart` | 只推面板 + 触发热更新 | 开发态会写 `debug.flag` + `url.txt`；`-Prod` 删掉这两个文件（正式部署） |
| `powershell -File tools\deploy.ps1 -Serial <号>` | 装 APK + 推配置 + 验收 | 复用 `push.ps1`；按 SDK 分流 `pm grant`（Android 5/6 没有运行时权限，`pm grant` 会报错）；验收看 logcat `first states … 实体 N≥100` |
| `powershell -File tools\verify.ps1 -Serial <号>` | 冷启动/重启后的完整检查 | 里有 `adb reboot`（破坏性，已注明） |
| `powershell -File tools\smoke.ps1 -Serial <号>` | 点击链路冒烟 | 用固定像素点击（换分辨率要改，见 REFACTOR §4） |

## 门禁与离线测试（不需要设备）

| 命令 | 断言 | 前提 |
| --- | --- | --- |
| `node tools\lint-es5.js` | Chromium 57 语法门禁（`RULES` 算失败，`NOTES` 只是风格提示）+ `app/assets/panel` 与 `panel/` 一致性 | 无 |
| `node tools\lint-css.js` | Chromium 57 CSS 门禁（曾抓出 `flex gap`） | 无 |
| `node tools\test-ui.js` | 渲染规则纯函数（当前 215 项） | 无 |
| `node tools\test-ha.js` | WS + REST 协议、布局、重连、诊断、历史（离线假服务器） | 无 |
| `node tools\sim.js --mock --port <端口>` | 只读假 HA，拦 `POST /api/services/*` | 给 e2e/shot 用 |
| `node tools\fake-ha.js` / `fake-daoliyu.js` | 假 HA（token `good-token`）/ 假音乐服务器（8099） | 无 |
| `node tools\devserver.js` | PC 侧静态面板服务（`e2e-pc.js` 会自动拉起） | 无 |
| `node tools\fixture-big-ha.js` / `fixture-panel-ha.js` | 大数据 fixture（306 实体/30 房间等） | 无 |
| `node tools\mk-music.js` | 重新写 `build/music.json`（凭据从记忆文件取） | 之后要再跑一次 `build.ps1` 才会进 assets |
| `node tools\real-ha-check.js` | 拿真实 HA 地址验一次协议 | 读仓库根 `ha.json`（未入库） |

## 真机回归（需要设备 + `debug.flag`）

这三个都用 `tools/lib/cdp.js` 连 WebView 调试端口（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`），所以设备上必须有 `/sdcard/HomeControl/debug.flag`（开发部署会写；`-Prod` 会删）。

| 命令 | 断言 | 失败常见原因 |
| --- | --- | --- |
| `node tools\check-security.js <serial>` | 文件白名单：`../` 穿越、配置目录外、目录路径都读不到；目录内写→读→删可用（9 项） | 没有 debug.flag → 连不上 CDP |
| `node tools\check-rest.js <serial>` | 并发 5 个 GET `/api/states` 必须 5 个都回调（以前 `__restCb` 是单槽，只有 1 个） | 设备上 `/sdcard` 里的 `backend.js` 是旧的 → 见下面「推目录」 |
| `node tools\check-temp.js <serial>` | 没有设定温度的空调调 `adjustTemp`：不抛错、返回 `undefined`、toast 出现 | 设备上的 `app.js` 没导出 `adjustTemp`（旧副本） |
| `node tools\check-tls.js <serial>` | LAN http 200；`self-signed.badssl.com` 与 `wrong-site.badssl.com` 必须被 Java 侧拒绝（`SSLHandshakeException`）；logcat 有 `tls anchors: 2` | 锚证书没进 assets（`app/certs/` 是源真相，构建拷进 assets） |

## CDP 脚本（截图/e2e，都靠本地服务，不靠设备）

`e2e-avatar/bulk/pc/pctbar/remove/rename/settings`、`probe-pbar/spark`、`shot-foot/gear/rename/settings`、`sim-shot` 全部只用 `tools/lib/cdp.js`（共享 WS 客户端 + Edge 启动）。跑之前要先有对应端口的服务：

| 脚本 | 端口 | 需要先起 |
| --- | --- | --- |
| `e2e-pc.js` | 8787 | 自足（自动 spawn `devserver.js`） |
| `e2e-rename.js` / `e2e-settings.js` / `shot-gear/rename/settings.js` | 8791 | `node tools\sim.js --mock --port 8791` |
| `probe-pbar.js` / `probe-spark.js` / `shot-foot.js` / `sim-shot.js` | 8788 | `node tools\sim.js`（默认 8788；连真实 HA 连不上会 `SIM WARN` 退出 1） |
| `e2e-pctbar.js` | 8792 | `node tools\sim.js --mock --port 8792` |
| `e2e-avatar.js` | 8793 | `node tools\sim.js --mock --port 8793` |
| `e2e-bulk.js` / `e2e-remove.js` | 8794 | `node tools\sim.js --mock --port 8794` |

## 三条会咬人的坑（工具侧）

- **推目录要用 `panel\.` 形式**：`adb push <目录> <已存在的目标目录>` 会把目录本身放进去，变成 `/sdcard/HomeControl/panel/panel/`，真正被读的 `panel/js/*` 还是旧的。症状：`check-rest` 只回调 1 个、`check-temp` 说「没有 `__PANEL_TEST__.adjustTemp`」。`push.ps1` 用的就是 `panel\.`；自己临时写脚本时别写成 `push panel …`。
- **设备上写文件用 `adb push`，不要用 `adb shell "echo … > 路径"`**：经 cmd 转手时重定向不生效（`url.txt` 没落盘，面板就退回 `file:///android_asset/…` 而不是 `/sdcard` 副本，你在改的代码根本没被跑到）。
- **改 `.ps1` 后要补 UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 GBK 解析，中文注释变乱码并打断字符串/括号（`Unexpected token` / `The string is missing the terminator`）。编辑工具写出来的文件通常没有 BOM：`[System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($true))`。
- 临时脚本放 `backup/tmp/`，不要放 `build/`（`build.ps1` 会 wipe）；跑 `check-*` 时 node 进程会被 20s 的 CDP 超时计时器吊住一会儿，那不是错误。
