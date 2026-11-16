# 打开插件自动启动服务

日期：2026-11-16 · 已通过 ExitPlanMode 批准

用户要求打开插件时自动启动。清单已有宿主 autostart，但不能代替插件页面的启动保障。

## 选定方案

在 usePollEvents 加独立一次性启动 effect，复用现有 controller.start。初始化完成、桥可用和有效状态已知后，首个状态 stopped 则启动一次；running/starting/stopping/failed 消费决策但不启动。查询/轮询/controller 本身不隐式启动。失败可见、只手动重试。

每次 App/hook mount 是启动周期，StrictMode 重放不重置标记；手动 start/stop 先消费自动启动机会。手动停止后同页面的轮询/宿主恢复/焦点切换不重新拉起。真正关闭再打开页面可以再次启动。宿主可能复用 mounted webview，未证实逐插件 reopen 事件，因此不猜通知、不用通用 panel-shown/focus 逆转手动停止。

保留清单 autostart、手动启停/活动确认/错误处理、现有图片与历史所有未提交改动，不改原生协议、宿主或机器配置。不提交/推送/发布，不操作真实宿主服务。

## 验收

Stopped mount 一次启动；Running/Starting/Stopping/Failed 不重复；延迟桥恢复有效Stopped后一次；手动stop后不复活；失败手动重试；unmount未初始化不启动；StrictMode effect replay 不重复；真实新mount可启动。全JS/类型检查/build及隔离启停回归。
