# 上墙验收报告

- 时间：2026-11-07 20:07:44
- 设备：MI PAD 2
- 应用：com.homecontrol.panel 0.6.0

| 检查项 | 结果 | 详情 |
| --- | --- | --- |
| 设备在线 | PASS | MI PAD 2 |
| 中控屏已安装 | PASS | versionName=0.6.0 |
| 按 HOME 进入面板 | PASS | com.homecontrol.panel/com.homecontrol.panel.MainActivity |
| 系统启动完成 | PASS | sys.boot_completed=True |
| 重启后自动拉起面板 | PASS | com.homecontrol.panel/com.homecontrol.panel.MainActivity，重启后 33 秒出现 |
| 屏幕保持唤醒 | PASS | mWakefulness |
| 面板内存占用 | PASS | PSS 67.9 MB |
| 设备已连网 | PASS | wlan0 10.10.1.78 |
| 无脚本错误/崩溃 | PASS | 命中 0 条 |
| 截图存档 | PASS | docs/screens/panel-verify.png |

**结论：全部通过**
