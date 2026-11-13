# LocalSend 服务启停 Implementation Plan

> **For agentic workers:** 实现者遵循 test-driven-development；控制器执行 executing-plans 并保留一次全分支独立审查。每步记录真实测试证据。

**Goal:** 添加可重启的手动启动/停止服务，替代无限“等待 autostart”，保留自动启动与全部用户持久数据。

**Architecture:** 插件 Tokio/历史/证书长期存活；每代网络服务独立取消及任务管理。原生控制与前端控件共享完整带 revision 状态快照。

**Tech Stack:** 现有 Rust/tokio/axum-server/serde、React/TypeScript/Node tests，不添加外部常驻进程。

**Spec:** `docs/superpowers/specs/2026-11-13-service-control-design.md`（已批准方案）。

## Global Constraints
- 普通 stop 不调用 `__otools_shutdown__`，不 Retired；启动/停止异步返回，poll_events 不长持全局锁。
- 默认 panel/autostart、LocalSend v2、宿主文件树、三平台发布都保持不变。
- state=stopped/starting/running/stopping/failed；完整快照 `{state,port,udpPort,protocol,fingerprint,error,activeTransfers,revision}`。
- 启动→`{started:true,status}`；停止→`{confirmationRequired,activeTransfers,status}`；活动任务默认需确认。
- 保留设置/证书/历史/已完成文件；停止不得删除整个 tmp 或用户下载目录。

## Review Focus
1. 停止过程中仍有并发上传：禁止新会话，取消/关闭后清理文件，不能继续写盘。
2. 旧代服务事件使 stopped 再变 running：revision/generation 阻挡旧事件。
3. Failed 服务重复启动被遗留 Some 状态阻挡：重试新任务而非只看 Option。
4. 全局 Mutex 长持导致 UI 轮询卡死：所有等待与清理在后台，状态短锁读取。
5. 无下载目录的完成文件在 tmp：取消只清理未完成目录，历史和成功文件必须保留。

---

## Task 1: 原生生命周期和协议层取消
**Files:** 新增 `native/src/service.rs`；修改 `runtime.rs`、`server.rs`、`sender.rs`、按需 `discovery.rs`、`lib.rs`。
**Interfaces:** 实现 Spec 的 3 个 method 与完整事件；复用 ReceiveSessions 历史、SendSessions watch cancel、DiscoveryShared 与 cert。
- [ ] 写实例局部失败测试：未启动为 stopped、重复 start/stop、绑定端口释放、同实例重新启动、保存端口重启生效、failed 可重试。
- [ ] 实测 RED（失败原因要是缺行为，不是拼写错误）。
- [ ] 实现按代资源管理、任务句柄和 axum_server handle；短锁控制、异步关闭、状态 revision。
- [ ] 写并通过停止确认与强制取消测试：pending receiver→403、stalled body 不等待 EOF、出站挂起响应可取消、终态一次、保留成功文件与证书。
- [ ] `cargo test --locked --manifest-path native/Cargo.toml` 与 clippy 全通过；显式路径 commit，不 push/main/tag。

## Task 2: 状态契约与共享 UI 控制
**Files:** `src/api.ts`、`src/hooks/usePollEvents.ts`、新增 `src/hooks/serviceState.ts` 与测试、`src/components/ServiceControls.tsx`、`App.tsx`、`pages/Settings.tsx`、`styles.css`。
**Interfaces:** 使用 Task 1 固定 JSON；共享 start/stop busy、error、confirmation 与 revision。
- [ ] 写失败测试：显式 stopped 与 starting 区分、旧 revision 忽略、操作失败释放 busy、confirm cancel 无网络副作用。
- [ ] 实现服务 action 封装、状态完整快照归一化、操作后重读状态、双入口共享状态。
- [ ] 自绘确认框：说明取消 N 个未完成任务但保留已完成文件；取消关闭，确认 force=true。
- [ ] preview 模拟状态与启停（仅仿真），新端口提示“重启服务生效”。
- [ ] pnpm test/build；浏览器用真实点击检查双入口、状态、确认和明暗主题。

## Task 3: 真实 DLL 集成与独立审查
**Files:** `scripts/smoke-native.py`、`scripts/interop-test.py`，README。
- [ ] 测试新增 stop 之前应失败，再用新版 DLL 测试通过。
- [ ] 同一 DLL start-stop-start，探测旧 TCP/UDP 端口释放，fingerprint/历史不变；确认不停止、强制停止挂起传输；重启收发再成功。
- [ ] 原完整 10 项矩阵继续通过；全分支独立审查生命周期/数据安全/竞态，不只看 typecheck。
- [ ] 修复高优先级问题、跑全测试；README 如实列能力与验证层级。

## Task 4: 三平台 CI 发布
- [ ] 版本清单设 v0.4.0（保留 native crate 内版本不改 ABI）；新分支 push 先 build/dry-run。
- [ ] Mac Universal2 编译/签名/加载和 Windows/Linux 产物都通过；pack/verify --require-all-platforms 四包完备。
- [ ] 验证后新 tag 发布到 Release/已配置市场，不覆盖旧 tag。
- [ ] 独立分支只更新 xyito 的该子模块指针，保持其他脏文件原样。

## Self-review
同一快照 schema 贯穿原生/前端/preview；stop 与卸载分开。Task 1 覆盖取消、端口/锁/保留数据，Task 2 覆盖状态与交互，Task 3/4 验证真实库与发布，非目标不混入。
