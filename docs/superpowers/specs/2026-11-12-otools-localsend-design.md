# otools-localsend 设计文档

日期：2026-11-12 · 状态：待批准

## 意图

把 **LocalSend**（https://github.com/localsend/localsend ，GPL-3.0，Flutter/Dart 实现的跨平台局域网互传工具）的桌面版能力移植为**独立 OTools 插件** `otools-localsend`。

硬指标是 **LocalSend 协议 v2 兼容**：与局域网内真正的 LocalSend 设备（官方 Windows/macOS/Linux 桌面端、iOS/Android App）**互相发现并互传文件与文本**。协议兼容优先于界面复刻。

独立 GitHub 仓库 **`ootools/otools-localsend`**（与现有 otools-* 插件一致），作为 xyito 单仓库的子模块挂在 `otools/` 目录下，打 tag 走独立发布 CI 产出 `.oplg` 并上架插件市场。

## 目标

1. **协议 v2 兼容（验收硬门槛）**，以 https://github.com/localsend/protocol 的 v2.2 规范为准：
   - 组播发现：UDP `224.0.0.167:53317`，announce/register 行为对齐规范（收到 `announce:true` 后通过 HTTP POST `/api/localsend/v2/register` 回源应答，UDP 回包仅作回退）
   - HTTPS 自签证书服务器（默认端口 53317），fingerprint = TLS 证书 SHA-256
   - 端点全实现：`register` / `prepare-upload` / `upload` / `cancel` / `info`
   - PIN 校验（401）、部分接受、会话取消、sha256 失配（422）、来源 IP 校验（403）、并发会话互斥（409）
   - 文本消息：对齐官方 App 的实现方式（以 `.txt` 文件条目传输，构建时以官方源码核对细节）
2. **桌面版核心 UX（Web 重建）**：附近设备列表、发送文件/文本、接收确认卡片、传输进度、历史记录、设置
3. **插件化合规**：`plugin.json`（native + autostart）+ `logo.svg` + `dist/` + `lib/Windows.dll`，autostart 常驻接收
4. **合规溯源**：GPL-3.0 LICENSE + `UPSTREAM.md` + `THIRD_PARTY_NOTICES.md`
5. **发布**：`build-plugin.yml`（push/PR 构建）、`release-plugin.yml`（tag 构建 + 打包 `.oplg` + GitHub Release + 上架插件市场）

## 非目标（v1）

- 浏览器反向传输（v2 规范第 5 节 `prepare-download` / `download`）——留后续版本
- 收藏设备同步（官方 App 的 `register-favorite` 扩展）——留后续版本
- protocol v3
- 非 Windows 平台的 native 产物（构建脚本预留 macOS/Linux 命名，v1 只出 `Windows.dll`）
- 与官方 UI 像素级一致
- 真机（第二台电脑/手机）对测——当前无对测环境，v1 以 mock 对端测试架为验收口径，真机对测留待用户具备环境后补测（见"验收"）

## 反目标

- 不把官方桌面 exe 打进插件（不是移植、体积失控、宿主无此先例）
- 不引入 Flutter 运行时
- 不用私有简化协议替代 LocalSend 协议

## 约束（含宿主行为核实结论）

- **WebView 无 UDP 组播、无法直连自签 HTTPS** → 设备发现与文件传输全部落在 native 层；前端只做界面与控制。
- **宿主 native ABI**（照 `otools-ai-switch` 已验证模式，关键行为已对照宿主源码核实）：
  - 导出 `otools_plugin_invoke(input_ptr, input_len, output_len) -> *mut u8` 与 `otools_plugin_free(ptr, len)`；JSON `{method, payload}` 入 → `{ok, data | error}` 出
  - DLL 在面板关闭后仍驻留；`__otools_shutdown__` 仅在安装/升级/重载插件时触发 → 关闭时须优雅停掉 socket 并持久化状态
  - `autostart` 任务由宿主 UI 在会话启动时执行，`once` = 每会话一次，**120 秒超时** → `start_localsend` 必须 spawn 后立即返回，服务在后台线程/运行时中常驻
  - native → 前端事件：宿主仅在面板有监听者时以 200ms 间隔轮询 `poll_events`；native 事件队列有界（约 2048 条 / 8MB，满则丢最旧）→ **进度类事件必须节流/合并**（如按百分比或 250ms 聚合），面板重开时以 `transfer_list` 重建状态，不依赖事件回放
  - `plugin.json` 中 `native: {enabled: true, libDir: "lib", autoReload: false}` + `autostart.tasks: [{command: "start_localsend"}]`
  - 构建：cargo cdylib → `lib/Windows.dll`，构建脚本校验导出符号存在；`lib/` 不入库（gitignore）
  - 插件数据目录约定：`~/.otools/local/otools-localsend`（设置、证书、历史存这里）
- **前端桥**：vendored `otools-plugin-sdk`（快照入库，不依赖邻仓），`invoke / listen`；`pickFile / pickDirectory / saveFile` 返回真实绝对路径；SDK 还提供 notification shim（来件通知用）
- **许可证**：上游 GPL-3.0 → 本插件 GPL-3.0

## 方案对比（已决策：方案 A）

| 方案 | 内容 | 结果 |
| --- | --- | --- |
| **A（选定）** | Web 重建 UI（React 18 + Vite）+ Rust 原生协议栈 | 协议兼容与 B 等价（都在 native 层），UI 轻量可控、贴合宿主生态 |
| B | Flutter Web 编译官方 UI + Rust 原生协议栈 | 放弃：官方 App 依赖十余个原生插件需逐个 shim 到宿主桥，包体大、同步难 |
| C | 官方 exe 作 sidecar | 放弃：非移植、上百 MB、宿主 ABI 无加载外部进程插件的先例 |

## 架构

```
otools-localsend/
├── plugin.json              # uuid/packid=otools-localsend, entry=dist/index.html,
│                            # native{enabled,libDir:lib}, autostart start_localsend
├── logo.svg
├── LICENSE (GPL-3.0)  UPSTREAM.md  THIRD_PARTY_NOTICES.md
├── native/                  # Rust cdylib：协议栈 + 状态 + 事件
│   ├── Cargo.toml           # tokio(net,rt-multi-thread,fs,time,sync,macros) axum axum-server(rustls)
│   │                        # rustls(ring) rcgen reqwest(rustls) socket2 serde_json uuid sha2
│   └── src/
│       ├── lib.rs           # FFI 入口（照 ai-switch 模式：catch_unwind + JSON 分发 + __otools_shutdown__）
│       ├── runtime.rs       # method 分发、tokio runtime、poll_events
│       ├── settings.rs      # 别名/设备型号/deviceType/端口/下载目录/PIN/自动保存/通知开关；JSON 持久化
│       ├── discovery.rs     # UDP 组播收发、设备表（fingerprint 去重 + lastSeen TTL）
│       ├── server.rs        # HTTPS axum：v2 全端点 + 接收会话状态机
│       ├── sender.rs        # prepare-upload → 并行 upload → 进度事件（节流）；取消
│       ├── crypto.rs        # rcgen 自签证书（首启生成、持久复用）+ 证书 SHA-256 指纹
│       └── event_bridge.rs  # WebEventBroadcaster（有界队列）
├── src/                     # React 18 + Vite 前端（附近设备 / 发送 / 接收 / 设置）
├── lib/                     # 构建产物 Windows.dll（gitignore，不入库）
├── scripts/                 # build-native.mjs / build-web.mjs / pack-plugin.mjs /
│                            # verify-plugin.mjs / mock-peer.mjs / publish-market.mjs /
│                            # release-policy.mjs / deploy-to-otools.ps1
├── vendor/otools-plugin-sdk/   # SDK 快照（照 ai-switch 惯例）
└── .github/workflows/       # build-plugin.yml / release-plugin.yml
```

### 协议实现要点（v2.2，以官方规范 + 官方 App 源码为准）

- **发现消息**字段：`alias`、`version`（major.minor，取值以官方 App 当前实现为准）、`deviceModel`（可空）、`deviceType: "desktop"`、`fingerprint`、`port`、`protocol: "https"`、`download`、`announce`
- **端口回退**：53317（UDP+TCP）绑定失败（如同机已装官方 LocalSend）→ 端口递增重试并在 announce 中上报实际端口（协议允许，官方同策略），UI 显示实际端口状态
- **发送方流程**：向目标设备 `POST /api/localsend/v2/prepare-upload`（元数据 + 可选 `?pin=`）→ 拿 `sessionId` + `fileId→token` → 并行 `POST /upload?sessionId&fileId&token`（二进制体）→ 可 `POST /cancel?sessionId=`；对自签证书不做服务端校验（与官方一致，fingerprint 仅用于自发现去重）
- **接收方状态机**：等待确认 →（部分）接受 → 传输中 → 完成/取消/失配；一次只允许一个活跃接收会话（409）；文件先落临时目录、会话完成后移入下载目录
- HTTP 错误码严格对齐规范（204/400/401/403/409/422/429/500）

### 桥 API（invoke methods）

`settings_get` / `settings_set` / `device_list` / `discover_now` / `send_files` / `send_text` / `session_accept` / `session_decline` / `session_cancel` / `transfer_list` / `poll_events`

事件（经 poll_events 排水，进度类节流）：`device-found` / `device-lost` / `incoming-request` / `transfer-progress` / `transfer-done` / `server-status`

### 来件通知（面板关闭时）

收到 `incoming-request` 且面板无监听时，native 侧触发宿主通知（走 SDK notification shim 的宿主通道；具体通道实现以构建时核实为准），设置中可关（`notifyOnIncoming`，默认开）。通知不携带操作按钮（v1）。

### 安全与隐私

- 自签证书首启生成并持久化于插件数据目录；PIN 默认关闭；autostart 只起服务，**默认手动确认**才接收文件（设置里可开自动保存）
- 下载目录由用户在设置中显式选择（宿主 `pickDirectory`）
- 首次入网需 Windows 防火墙放行 53317（文档说明；与官方 LocalSend 同样的用户动作）

## 里程碑

1. 仓库脚手架 + `plugin.json` + CI + GPL 溯源文件 + 子模块接入 xyito
2. native：settings + discovery → **mock 对端发现互通**
3. native：HTTPS server + 接收状态机 → **mock 对端发文件成功**（PIN 开/关、拒收、取消、sha256 失配）
4. native：sender → **本插件发文件/文本到 mock 对端成功**
5. 前端完整 UX + 事件联动 + 来件通知
6. `.oplg` 打包 + verify + tag 发布 + GitHub Release + 市场上架（仓库 secrets：XYCLOUD_PAT 等）

## 验收

- **mock 对端测试架**（`scripts/mock-peer.mjs`，Node 实现，独立于本插件 Rust 代码，避免同源循环验证）：模拟真实 LocalSend 对端——UDP 组播 announce/register、自签 HTTPS v2 端点、可发送/接收文件与文本
- 对测矩阵（官方 LocalSend 语义 ↔ 本插件，经 mock 对端执行）：发现、互发文件（多文件/大文件/取消/拒收/PIN/sha256 失配）、文本互发、端口回退
- **真机对测**（官方 Windows 桌面端、手机 App）：当前无环境，待用户具备后按同一矩阵补测；CI 中保留矩阵清单与手动验收脚本
- `verify-plugin.mjs` 通过、CI 绿、tag 与构建提交一致（release-policy）、市场上架成功

## 留给构建者

- UI 样式细节（贴合宿主暗色主题与中文界面）
- Rust 依赖版本（对齐 ai-switch Cargo.lock 附近版本）
- 文本消息的确切文件名与接收展示（对齐官方 App 源码）
- 发现消息 `version` 字段取值（对齐官方 App 当前实现）
- mock 对端脚本与 native 测试的分工细节
