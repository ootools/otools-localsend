# LocalSend 手动服务启停设计

日期：2026-11-13 · 状态：已通过会话方案审批

## 目的
保留默认 `start_localsend` autostart，但在侧栏和设置页提供手动启动、停止。未启动不再显示无限等待；普通停服后可重新启动，且不是卸载插件。

## 决策与边界
- 使用可恢复的服务生命周期；不采用 `__otools_shutdown__`（会永久 Retired）、不只改 UI/暂停收件。
- 默认 panel、协议 v2、宿主文件树、三平台独立包与通用包不变。
- 无活动传输时直接停止；有 Pending/Transferring 收发会话时原生返回确认需求，UI 确认后调用 `force:true`。取消确认不改变服务。
- 普通停服释放 HTTPS/UDP/回源任务并取消未完成传输；保留设置、证书、历史和已完成文件，包括没有下载目录而留在插件 tmp 下的已完成文件。
- 阻止停止期间的新传输；等待写入/连接/任务退出后才报告 stopped。后台清理需有时间上限；超时仍不能虚报端口已释放。
- 服务状态：`stopped / starting / running / stopping / failed`。旧代状态事件不可覆盖新状态。

## JSON 契约
`server_status` 与 `server-status` 事件共用完整快照：

```
{ state, port, udpPort, protocol:"https", fingerprint:string|null,
  error:string|null, activeTransfers:number, revision:number }
```

`revision` 在插件进程生命周期中单调递增（停止/启动状态变更，不在重启服务时归零）。`port` 是实际 TCP 端口，`udpPort` 是实际发现端口。

- `start_localsend {}` → `{started:true,status:<快照>}`；幂等、立即返回，异步绑定。stopping 时拒绝启动。
- `stop_localsend {force?:boolean}` → `{confirmationRequired:boolean,activeTransfers:number,status:<快照>}`；默认遇活动任务不改变状态；确认停止立即进入 stopping 并异步清理。已停止重复停止可成功。
- 卸载仍使用 `__otools_shutdown__`，无需 UI 确认，停掉本插件任务后退休。

## UI
侧栏状态区与设置页服务卡共用 `ServiceControls`。状态未知、busy、starting/stopping 禁止重复操作；failed/stopped 可启动，running 可停止。有活动传输时使用自绘确认弹窗。操作后拉完整状态，不只依赖事件。保存端口后提示重启服务生效。

`?preview=1` 仅模拟 UI 状态、动作和确认，不启动真实服务；普通浏览器无桥继续降级。

## 验收
- 真实 start→stop→start，同进程无需卸载，TCP/UDP 原绑定端口可重新绑定。
- 默认停止检查原生活动任务；强制停止中断待确认/挂起收件/出站发送，记录 Cancelled 且终态只发一次。
- 保留证书指纹和持久数据，重新启动应用新保存端口。
- 前端五状态、port=0 正常停止、旧 revision 忽略、共享 busy/失败恢复、确认取消无操作。
- Windows 本地 DLL 回归与完整协议矩阵；macOS Universal2 CI 单测+加载，三平台完整包校验；浏览器预览不冒充真实原生测试。
