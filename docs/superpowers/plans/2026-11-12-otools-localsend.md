# otools-localsend 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LocalSend 桌面版移植为独立 OTools 插件 `otools-localsend`，LocalSend 协议 v2 兼容（与真实 LocalSend 设备发现/互传）。

**Architecture:** Rust cdylib（走宿主 `ot-plugin-ffi` ABI）实现全部网络面：UDP 组播发现 + 自签 HTTPS v2 端点 + 收发会话状态机；React 18 + Vite 前端只做界面与控制，经 vendored `otools-plugin-sdk` 的 `invoke/listen` 桥与 native 通信；autostart 常驻接收。

**Tech Stack:** Rust (tokio 1 / axum 0.7 / axum-server 0.7 rustls / rustls 0.23 ring / rcgen 0.13 / reqwest 0.12 / socket2 / serde_json / uuid 1 / sha2 0.10)、React 18 + Vite + TypeScript、Node（mock 对端）、Python ctypes（DLL 独立驱动测试）。

**Spec:** `docs/superpowers/specs/2026-11-12-otools-localsend-design.md`（本计划从 spec 出发，执行者须同时读两份。协议事实以 https://github.com/localsend/protocol v2.2 为准。）

## Global Constraints

- 许可证 GPL-3.0；`uuid` = `packid` = `otools-localsend`；`entry` = `dist/index.html`；`native.libDir` = `lib`；autostart 命令名 `start_localsend`
- 协议默认值：UDP 组播 `224.0.0.167:53317`；HTTPS 端口 `53317`；fingerprint = TLS 证书 DER 的 SHA-256（hex）；端口被占则递增重试并在 announce 上报实际端口
- 插件数据目录：`~/.otools/local/otools-localsend/`（设置 settings.json、证书 key.pem+cert.pem、历史 transfers.json）
- native 导出 `otools_plugin_invoke` / `otools_plugin_free`；JSON `{method, payload}` → `{ok, data | error}`；`__otools_shutdown__` 为 runtime 特殊 method（停 socket、持久化、退休状态）
- autostart `start_localsend` 必须 spawn-and-return（宿主 120s 超时）
- native→前端事件队列有界（≤2048 条 / 8MB，满丢最旧）；`transfer-progress` 按 250ms 或 ≥1% 聚合节流
- v1 仅产出 `lib/Windows.dll`；`lib/` 与 `native/target/` 入 .gitignore
- `otools-plugin-sdk` 快照 vendored 到 `vendor/otools-plugin-sdk/`（照 ai-switch），前端 vite 从 `./vendor/otools-plugin-sdk/src/*` 解析 `otools-plugin-sdk/*` 导入
- Rust 依赖版本对齐 `otools-ai-switch/native/Cargo.toml`（同代版本）；前端 vite/react 版本取 ai-switch `package.json`
- 提交信息 conventional commits（feat/fix/chore/test/docs）；直接提交 main（新仓库）

## Review Focus

spec 未被任务测试覆盖、最可能咬到使用者的五类输入/条件：

1. **首启端口/防火墙失败静默**——53317 被占或防火墙拦截时，UI 必须显示 `server-status` 错误态而非无限"搜索中"。（Task 7：端口回退测试；Task 12：错误态 UI 测试）
2. **大文件传输内存膨胀**——upload 处理必须流式写盘，禁止整体读入内存。（Task 7：64MB 文件经 mock 对端传输成功 + 代码审查断言流式；Task 8 集成矩阵含 64MB 文件）
3. **面板关闭期间事件丢失/堆积**——进度事件聚合不淹没队列；面板重开以 `transfer_list` 重建而非等事件回放。（Task 5：队列溢出丢最旧测试；Task 8：面板关闭模拟（不 poll）完成传输后 `transfer_list` 完整）
4. **非 ASCII 文件名**——中文/emoji 文件名经 JSON 与文件系统两端不乱码、不丢失。（Task 8 矩阵：中文文件名互传）
5. **并发/重放攻击上传**——错误 token、错误来源 IP 必须拒绝（403），token 单会话一次性映射。（Task 7：伪造 token/伪造 IP 测试）

---

### Task 1: 仓库脚手架与发布清单

**Files:**
- Create: `LICENSE`(GPL-3.0 全文)、`UPSTREAM.md`、`THIRD_PARTY_NOTICES.md`、`README.md`、`.gitignore`、`plugin.json`、`logo.svg`、`package.json`
- Create: `vendor/otools-plugin-sdk/**`（从 `D:\Repos\xyito\otools\otools-ai-switch\vendor\otools-plugin-sdk\` 整目录拷贝，剔除其 `.git`）

**Interfaces:**
- Produces: `plugin.json`（后续所有任务读取）；GitHub 仓库 `ootools/otools-localsend`（CI 与 tag 发布的目标）

- [ ] **Step 1: 写入清单与合规文件**

`plugin.json` 全文（后续任务不再改除 version/screenshots 外的字段）：

```json
{
  "packid": "otools-localsend",
  "uuid": "otools-localsend",
  "displayName": "LocalSend · 局域网互传",
  "displayNameCN": "LocalSend · 局域网互传",
  "version": "0.1.0",
  "entry": "dist/index.html",
  "icon": "📡",
  "developerName": "OTools",
  "summary": "LocalSend 协议 v2 兼容的局域网互传：与手机、电脑上的官方 LocalSend 互相发现并收发文件与文本。",
  "key": ["localsend", "LocalSend", "互传", "局域网", "文件传输", "AirDrop", "传输"],
  "openMode": "panel",
  "openInBrowser": false,
  "devUrl": "http://127.0.0.1:6497",
  "quickDev": true,
  "hasAd": false,
  "inPluginPurchase": false,
  "screenshots": []
}
```

`native` 与 `autostart` 字段由 Task 13 加上（避免清单指向不存在的 lib）。`UPSTREAM.md` 照 ai-switch 的 `UPSTREAM.md` 结构写：上游 https://github.com/localsend/localsend 、快照 ref 记 `v2.x（以本插件实现时的最新 release 为准）`、说明"协议实现参考上游 Dart 源码与 localsend/protocol v2.2 规范，GPL-3.0 沿用"。`LICENSE` 放 GPL-3.0 官方全文；`THIRD_PARTY_NOTICES.md` 列 otools-plugin-sdk (MIT，全文附于 `LICENSES/otools-plugin-sdk-MIT.txt`) 与上游 LocalSend (GPL-3.0)。`.gitignore`：`node_modules/`、`dist/`、`lib/`、`native/target/`、`*.log`。

- [ ] **Step 2: 建仓与首推**

```bash
cd D:\Repos\xyito\otools\otools-localsend
git init -b main
git add -A && git commit -m "chore: scaffold otools-localsend plugin repo"
gh repo create ootools/otools-localsend --public --source . --remote origin --push
```

若 `gh` 无 ootools 组织建仓权限，停下并报告用户（不要降级到个人账号）。

- [ ] **Step 3: 接入 xyito 子模块**

在 `D:\Repos\xyito` 执行：`git -C xyito submodule add git@github.com:ootools/otools-localsend.git otools/otools-localsend`，`.gitmodules` 追加后以 `chore(submodule): add otools-localsend` 提交 xyito 仓库（现有插件同款格式）。

- [ ] **Step 4: 验证**

`node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf8'))"` 无输出；`git ls-remote origin` 返回 HEAD；xyito 仓库 `git status` 显示子模块干净。

### Task 2: CI 工作流

**Files:**
- Create: `.github/workflows/build-plugin.yml`、`.github/workflows/release-plugin.yml`（从 `D:\Repos\xyito\otools\otools-plugin-template\.github\workflows\` 拷贝改写）

**Interfaces:**
- Consumes: Task 1 仓库
- Produces: push/PR 自动构建；`v*` tag 触发构建+打包+Release+市场上架（市场开关在 Task 14 生效）

- [ ] **Step 1: 拷贝并改写两个 workflow**

`build-plugin.yml`：windows-latest；装 Rust stable + pnpm；步骤 = `node scripts/build-native.mjs` + `node scripts/build-web.mjs` + 上传 `dist/`、`lib/` 工件。`release-plugin.yml`：保留模板的 tag 触发（`on: push: tags: ["v*"]` + workflow_dispatch）、`GITHUB_REPOSITORY=ootools/otools-localsend`、release-policy 校验、GitHub Release + `.oplg` 附件、市场发布步骤（以 `vars.OTOOLS_PUBLISH_MARKET == 'true'` 门控，secrets 名照模板：`XYCLOUD_PAT`）。保留模板的 `release-policy.mjs`/`publish-market.mjs` 调用方式（这两个脚本在 Task 13 拷入）。

- [ ] **Step 2: 验证并提交**

`node -e "['build-plugin','release-plugin'].forEach(f=>require('js-yaml').load(require('fs').readFileSync('.github/workflows/'+f+'.yml','utf8')))"`（无 js-yaml 则目检+`actionlint` 若可用）；push 后在 GitHub Actions 页确认 build 触发（此步会因脚本未就绪失败，属预期，Task 13 后转绿——workflow 文件本任务内标注 `continue-on-error` 不需要，构建失败不阻塞后续任务）。提交 `ci: add build and release workflows`。

### Task 3: native 骨架 — FFI 入口、runtime 分发、settings

**Files:**
- Create: `native/Cargo.toml`、`native/src/{lib,runtime,settings,event_bridge}.rs`（event_bridge 本任务先建空实现，Task 5 填充）、`native/src/models.rs`、`scripts/smoke-native.py`（从 `D:\Repos\xyito\otools\otools-ai-switch\scripts\smoke-native.py` 抽取 ctypes 加载与 invoke 辅助函数改写：`load_dll(path)`、`invoke(method, payload)`、`drain_events()`）
- Test: `native/src/settings.rs` 内 `#[cfg(test)]`、`scripts/smoke-native.py`（集成冒烟）

**Interfaces:**
- Produces（后续所有 native 任务依赖）：
  - `lib.rs`: `handle_json(input: &[u8]) -> Value`（ai-switch 同款封套 `{ok, data|error}`）+ 两个 `#[no_mangle] extern "C"` 导出
  - `runtime.rs`: `pub fn invoke(method: &str, payload: Value) -> Result<Value, String>`（match 分发；未知 method 返回 Err）、`pub fn start_background()`（建 tokio Runtime 存入 OnceLock，spawn-and-return）
  - `models.rs`: `DeviceInfo { alias: String, version: String, device_model: Option<String>, device_type: Option<String>, fingerprint: String, port: u16, protocol: String, download: bool }`、`FileEntry { id: String, file_name: String, size: u64, file_type: String, sha256: Option<String>, preview: Option<String>, metadata: Option<Metadata> }`、`TransferRecord { session_id, direction: Send|Receive, peer_alias, files, status: Pending|Transferring|Done|Cancelled|Failed, created_at }` —— 全部 `#[serde(rename_all = "camelCase")]`
  - `settings.rs`: `Settings { alias: String, device_model: Option<String>, device_type: String, port: u16, download_dir: Option<String>, pin: Option<String>, auto_save: bool, notify_on_incoming: bool }`，默认值 alias=主机名、device_type="desktop"、port=53317、auto_save=false、notify_on_incoming=true；`load(data_dir) -> Settings`（缺省补全）、`save(&self, data_dir)`；data_dir = `~/.otools/local/otools-localsend`（`directories` crate 或 `dirs`，对齐 ai-switch paths.rs 写法）
  - 分发 method（Task 3 实现 3 个，其余后续任务）：`settings_get`、`settings_set`（payload.settings 整体替换+持久化）、`__otools_shutdown__`

- [ ] **Step 1: 写失败测试（settings）**

`native/src/settings.rs` 测试：`settings_default_fill` —— 加载仅含 `{"alias":"测试机"}` 的 json 时返回 port==53317、auto_save==false、notify_on_incoming==true；`settings_roundtrip` —— save 后 load 相等；`settings_data_dir` —— 数据目录拼接 `otools-localsend`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path native/Cargo.toml`
Expected: 编译失败（模块不存在）

- [ ] **Step 3: 实现 Cargo.toml + lib/runtime/settings/models**

Cargo.toml 照 ai-switch 的 `[lib] crate-type=["cdylib","rlib"]` 模式，`autobins = false`；dependencies 按本计划 Tech Stack 清单（版本对齐 ai-switch Cargo.toml 同名依赖）。lib.rs 的 FFI 与 catch_unwind 照 ai-switch `native/src/lib.rs:1-60` 原样模式改 crate 名。runtime.rs 先实现：settings 三 method + 未知 method 报错 + `start_background` 空壳（Task 7 填充）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path native/Cargo.toml`
Expected: PASS（3 个 settings 测试）

- [ ] **Step 5: DLL 冒烟**

`node scripts/build-native.mjs`（从 ai-switch 的同名脚本拷贝，`otools_ai_switch_native` → `otools_localsend_native`）产出 `lib/Windows.dll`；`python scripts/smoke-native.py` 断言：`settings_get` 返回 `ok:true` 且 port==53317；未知 method 返回 `ok:false`。

- [ ] **Step 6: Commit** — `feat(native): FFI skeleton, runtime dispatch, settings`

### Task 4: crypto — 自签证书与指纹

**Files:**
- Create: `native/src/crypto.rs`
- Modify: `native/src/runtime.rs`（`start_background` 生成/加载证书，之后任务接入服务器）

**Interfaces:**
- Produces: `pub fn ensure_cert(data_dir: &Path) -> Result<(Vec<u8> /*cert DER*/, Vec<u8> /*key DER*/, String /*fingerprint hex*/)>`——首启 rcgen 生成并写 `cert.pem`/`key.pem`，复启加载；`pub fn sha256_hex(bytes: &[u8]) -> String`

- [ ] **Step 1: 失败测试**：`cert_fingerprint_is_sha256_of_der`（对固定 DER 向量比对已知 sha256）；`cert_persist_and_reload`（ensure 两次同目录，第二次 fingerprint 与第一次相同）；`fingerprint_matches_official_algorithm`（fingerprint == sha256_hex(cert_der)）。
- [ ] **Step 2:** `cargo test --manifest-path native/Cargo.toml crypto` → FAIL
- [ ] **Step 3: 实现**（rcgen `generate_simple_self_signed` 不可控 SAN/IP 时不满足——需用 `rcgen` 的 `CertificateParams` 自定义 subject_alt_names 含本机 IP 与 localhost；实现时若 IP 变化不重签——LocalSend 自身不校验证书，SAN 不影响互通）。
- [ ] **Step 4:** PASS
- [ ] **Step 5: Commit** — `feat(native): self-signed certificate with sha256 fingerprint`

### Task 5: event_bridge — 有界事件队列

**Files:**
- Create: `native/src/event_bridge.rs`（填充 Task 3 的空壳）

**Interfaces:**
- Produces: `pub struct WebEventBroadcaster { /* Mutex<VecDeque<Event>>, 上限 2048 条且总字节 ≤ 8MB，drop-oldest */ }`；`pub fn send(&self, event: &str, data: Value)`、`pub fn drain(&self) -> Vec<Value>`（每项 `{event, data}`）；`runtime.rs` 的 `poll_events` method 改为返回 `{events: broadcaster.drain()}`

- [ ] **Step 1: 失败测试**：`drain_returns_sent_events_in_order`；`queue_caps_at_2048_drop_oldest`（发 2100 条，drain 后首条为第 53 条）；`queue_caps_at_8mb`（单条大 payload 挤出旧条目）；`progress_coalescing_helper`（`coalesce_progress(&mut pending, new)` 使 250ms 窗口内同 sessionId+fileId 只留最新）。
- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4:** PASS，Commit — `feat(native): bounded event broadcaster with progress coalescing`

### Task 6: discovery — 组播发现与设备表

**Files:**
- Create: `native/src/discovery.rs`
- Modify: `native/src/runtime.rs`（`device_list`、`discover_now` method；`start_background` 启动发现循环）

**Interfaces:**
- Produces:
  - `pub struct DeviceTable { /* fingerprint → (DeviceInfo, ip: IpAddr, last_seen: Instant) */ }`；`upsert(info: DeviceInfo, ip)`、`list() -> Vec<DeviceEntry>`（`DeviceEntry { info, ip: String, lastSeenMs: u64 }`）、`gc(ttl: Duration)`（TTL 75s，官方同款）
  - `pub fn announce_frame(info: &DeviceInfo, announce: bool) -> Vec<u8>`（JSON + `\n`）
  - `pub fn parse_frame(bytes: &[u8]) -> Option<(DeviceInfo, bool /*announce*/)>`
  - `pub async fn run_discovery(state, port: u16)`：bind UDP `0.0.0.0:53317`（被占则 53318… 递增，记录实际端口）、`socket2` join_multicast_v4(224.0.0.167)、启动即发 `announce:true`、收包循环：parse → 非本机 fingerprint → upsert + `device-found` 事件；若 `announce==true` 则向来源 `POST /api/localsend/v2/register` 回源应答（复用 Task 9 sender 的 http 客户端，未就绪时先留 todo 钩子）；每 5s 重发 announce、每 15s gc 发 `device-lost`
  - method：`device_list {} → {devices:[DeviceEntry]}`；`discover_now {} → {ok}`（立即发一次 announce:true）

- [ ] **Step 1: 失败测试**：`announce_frame_roundtrip`（announce_frame → parse_frame 还原 alias/fingerprint/port/announce）；`device_table_upsert_dedupes_by_fingerprint`；`device_table_gc_expires_stale`（注入 last_seen 过期项，gc 后 list 为空且触发 device-lost 事件）；`parse_rejects_garbage`。
- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现**（组播收发本身不做单测，Task 8 集成验证）
- [ ] **Step 4:** PASS，Commit — `feat(native): udp multicast discovery with device table`

### Task 7: server — HTTPS v2 端点与接收状态机

**Files:**
- Create: `native/src/server.rs`
- Modify: `native/src/runtime.rs`（`start_background` 起服务器；`session_accept`/`session_decline`/`session_cancel` method）、`native/src/settings.rs`（如需增字段不加）

**Interfaces:**
- Produces:
  - `pub async fn run_server(state, port: u16)`：axum-server + rustls（Task 4 证书）；绑定失败端口递增（与 discovery 同步同一实际端口值，存 state）；发 `server-status {port, protocol:"https", fingerprint}` 与失败事件
  - 路由：`POST /api/localsend/v2/register`（返回本机 DeviceInfo JSON）、`POST /api/localsend/v2/prepare-upload`、`POST /api/localsend/v2/upload`、`POST /api/localsend/v2/cancel`、`GET /api/localsend/v2/info`
  - `pub struct ReceiveSession { session_id, sender: DeviceInfo, files: HashMap<String, FileEntry>, tokens: HashMap<String, String>, status, sender_ip: IpAddr, pin_ok: bool }`
  - prepare-upload 行为：无 PIN 校验 `?pin=`（错→401）；有活跃未完会话→409；PIN 通过且非自动保存→整体 Pending 并发 `incoming-request` 事件 + （若面板无监听）宿主通知；自动保存开启→直接全接受返回 tokens；部分接受靠 `session_accept {sessionId, fileIds}` 后补发 tokens（对齐官方：响应里的 files map 只含接受的 fileId）
  - upload 行为：query 三参校验（缺→400）、token/来源 IP 不符→403、会话非传输态→409、流式写 `~/.otools/local/otools-localsend/tmp/<sessionId>/<fileId>`、sha256 失配→422 且删临时文件
  - `transfer_list {} → {transfers:[TransferRecord]}`（含历史，持久化 transfers.json）

- [ ] **Step 1: 失败测试**（纯状态机与 handler 层，不走 TLS）：
  - `prepare_upload_issues_tokens`（有效体 → sessionId + fileId→token 映射，status==Pending）
  - `prepare_upload_requires_pin_when_set`（错 pin → 401 错误值）
  - `prepare_upload_rejects_second_session`（409）
  - `upload_rejects_bad_token_and_wrong_ip`（403 ×2）
  - `upload_stream_verify_sha256`（对 3 块数据流式写临时文件，sha256 对→状态 Done；错→422 且临时文件删除）
  - `accept_after_pending_issues_remaining_tokens`（Pending → session_accept 指定 fileIds → 仅这些 fileId 获得 token）
  - `cancel_clears_session_and_temp`（404/无错误、tmp 清空）
- [ ] **Step 2:** `cargo test --manifest-path native/Cargo.toml server` → FAIL
- [ ] **Step 3: 实现**（上传 body 用 `axum::body::Body::data_stream` 流式落盘——Review Focus #2）
- [ ] **Step 4:** PASS，Commit — `feat(native): https v2 server with receive session state machine`

### Task 8: mock 对端与 DLL 集成对测（发现 + 接收）

**Files:**
- Create: `scripts/mock-peer.mjs`（Node，独立实现，禁 import 本插件 Rust 代码）、`scripts/interop-test.py`（python 驱动 DLL，内部 spawn mock-peer）
- Test: `scripts/interop-test.py` 本身

**Interfaces:**
- Consumes: Task 3 smoke-native.py 的 `load_dll/invoke` 辅助；Task 6/7 的 method
- Produces: `node scripts/mock-peer.mjs serve [--alias MockPeer] [--dir tmp]`——独立 LocalSend v2 对端：UDP 组播 announce 收发、自签 HTTPS `register/prepare-upload/upload/cancel/info`；`node scripts/mock-peer.mjs send --to <ip:port> --file <path> [--pin] [--text "…"]`——作为发送方向插件推文件/文本；`python scripts/interop-test.py` 编排全部场景断言

- [ ] **Step 1: 实现 mock-peer.mjs**：node:dgram（`addMembership("224.0.0.167")`）、node:tls 自签证书（`openssl` 或 node:crypto 生成——用 `selfsigned` 不可引入外部依赖，node 内置 `crypto.generateKeyPairSync` + 手工拼证书太繁，允许 devDependency `selfsigned`）；HTTPS 端点按 v2.2 规范返回值。
- [ ] **Step 2: 编排 interop-test.py 场景并逐个断言**：
  1. `discovery`：DLL 起 server+discovery → mock-peer 起服 → 双方 `device_list` 互相可见（≤10s）
  2. `receive_files`：mock-peer send 2 个文件（其一 64MB、其一中文文件名 `测试文件.txt`）→ DLL `incoming-request` 事件 → `session_accept all` → 传输完成 → `transfer_list` 状态 Done、落盘文件字节一致（sha256 比对）
  3. `receive_pin`：DLL 设 pin=123456 → mock-peer 无 pin 发起 → 收 401；带 pin → 成功
  4. `receive_decline_cancel`：decline 后 mock-peer 侧收到 403；传输中 `session_cancel` → mock-peer 上传中断
  5. `panel_closed_rebuild`：全程不调 `poll_events` 完成一次传输 → `transfer_list` 完整（Review Focus #3）
  6. `sha256_mismatch`：mock-peer 上传错 payload → DLL 返回 422
- [ ] **Step 3: 跑全套**：`python scripts/interop-test.py` → 全场景 PASS
- [ ] **Step 4: Commit** — `test: mock LocalSend peer and DLL interop matrix`

### Task 9: sender — 主动发送

**Files:**
- Create: `native/src/sender.rs`
- Modify: `native/src/runtime.rs`（`send_files`/`send_text` method）、`native/src/discovery.rs`（回源 register 接入 http 客户端）

**Interfaces:**
- Produces:
  - `pub fn http_client() -> reqwest::Client`（`danger_accept_invalid_certs(true)`——对齐官方，fingerprint 仅自发现去重）
  - `pub async fn send_to_peer(state, peer: DeviceEntry, files: Vec<(String /*绝对路径*/, String /*fileName*/)>, pin: Option<String>) -> Result<String /*sessionId*/>`：prepare-upload（元数据 + sha256 预计算 + `?pin=`）→ 204/403/409 分别结束/失败/失败并事件 → 成功后并发 upload（并发度 3，逐文件 `transfer-progress` 节流事件）→ 全部完成发 `transfer-done`；`session_cancel` 对出站会话调对端 `/cancel` 并中断本地流
  - `send_files {ip, port, files:[{path}], pin?}` / `send_text {ip, port, text, pin?}`：文本转虚拟文件条目（fileName=`message.txt`、fileType=`text/plain`，内容内存字节流——以官方 App 源码核对命名后允许调整）

- [ ] **Step 1: 失败测试**：`send_text_wraps_as_virtual_txt_file`（条目 fileName/fileType 断言）；`progress_events_coalesced`（模拟 50 次回调 → broadcaster 中 ≤ 若干条且百分比单调）；`prepare_403_marks_failed_event`（mock 403 → transfer-done status==Failed）。
- [ ] **Step 2:** FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4:** PASS
- [ ] **Step 5: 集成**：`interop-test.py` 加场景 `send_files`（DLL → mock-peer 互传 2 文件 + 文本 `send_text`）→ 全套重跑 PASS
- [ ] **Step 6: Commit** — `feat(native): sender with parallel uploads and progress events`

### Task 10: 前端骨架 — vite + react + SDK 桥

**Files:**
- Create: `package.json`（补 devDeps：对齐 ai-switch 的 vite/@vitejs/plugin-react/react/typescript/uno 版本）、`vite.config.ts`（`otoolsTauriShimPlugin` + `otools-plugin-sdk/*` → `./vendor/otools-plugin-sdk/src/*.ts` 别名——照 ai-switch vite.config.ts:6,51-58）、`tsconfig.json`、`index.html`、`src/main.tsx`、`src/App.tsx`、`src/api.ts`、`uno.config.ts`
- Modify: `package.json` scripts：`dev`(6497)/`build` → `dist/`

**Interfaces:**
- Consumes: vendored SDK 的 `invoke/listen`（`@tauri-apps/api/core`、`@tauri-apps/api/event` 导入路径）
- Produces: `src/api.ts` 全量 invoke 封装与类型（后续页面只用它）：
  `getSettings(): Promise<Settings>`、`setSettings(s)`、`listDevices(): Promise<DeviceEntry[]>`、`discoverNow()`、`sendFiles(ip, port, paths, pin?)`、`sendText(ip, port, text, pin?)`、`acceptSession(id, fileIds|"all")`、`declineSession(id)`、`cancelSession(id)`、`listTransfers()`、`pollEvents()`；TS 类型镜像 models.rs 的 camelCase 形状

- [ ] **Step 1: 实现 App.tsx 最小三栏**（设备/传输/设置 tab 占位）+ `settings_get` 渲染别名与端口——证明桥通。
- [ ] **Step 2: 验证**：`pnpm build` 产出 `dist/index.html`；`node scripts/serve-dist.mjs`（从模板拷贝）+ 手动/浏览器检查设置页显示 53317；DLL 在场时显示真值。
- [ ] **Step 3: Commit** — `feat(web): react skeleton wired to native bridge`

### Task 11: 前端功能页与通知

**Files:**
- Create: `src/pages/{Devices,Transfers,Settings}.tsx`、`src/components/{DeviceCard,TransferCard,IncomingDialog}.tsx`、`src/hooks/usePollEvents.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `src/api.ts` 全部封装；事件名 `device-found/device-lost/incoming-request/transfer-progress/transfer-done/server-status`；SDK `pickFile(s)/pickDirectory/saveFile`、notification shim

- [ ] **Step 1: Devices 页**：设备卡片（alias/deviceModel/deviceType 图标/ip）+ 刷新（`discover_now`）+ 选中设备 → `pickFile` 多选 → `send_files`；文本发送入口（textarea → `send_text`）。
- [ ] **Step 2: Transfers 页**：`transfer_list` 初始渲染 + `transfer-progress` 节流更新 + 完成/失败态；`IncomingDialog`：Pending 会话弹确认（文件清单 + 全部/勾选接受/拒绝）。
- [ ] **Step 3: Settings 页**：alias/deviceModel/port/downloadDir（`pickDirectory`）/pin/autoSave/notifyOnIncoming → `settings_set`；`server-status` 事件驱动顶部状态条（含端口回退与防火墙错误态——Review Focus #1）。
- [ ] **Step 4: 通知**：`incoming-request` 事件在面板隐藏时经 SDK notification shim 弹宿主通知（settings.notifyOnIncoming 门控）。
- [ ] **Step 5: 验证**：`pnpm build` 通过；`python scripts/interop-test.py` 跑 `receive_files` 场景的同时手动/浏览器确认 UI 出现确认弹窗并接受成功（acceptance 走真宿主时复验）。
- [ ] **Step 6: Commit** — `feat(web): devices, transfers, settings pages with incoming notification`

### Task 12: 打包、校验与本地宿主联调

**Files:**
- Create: `scripts/pack-plugin.mjs`、`scripts/package-utils.mjs`、`scripts/verify-plugin.mjs`（从 ai-switch 拷贝，crate 名/清单校验处适配）、`scripts/deploy-to-otools.ps1`（从模板拷贝适配 packid）
- Modify: `plugin.json`（补 `native: {enabled: true, libDir: "lib", autoReload: false}` + `autostart: {enabled: true, once: true, tasks: [{command: "start_localsend", args: {}}]}`）、`README.md`（用法 + 防火墙说明 + 真机对测待办清单）

**Interfaces:**
- Consumes: `dist/` + `lib/Windows.dll` → `dist-pack/otools-localsend.oplg`

- [ ] **Step 1: 拷贝适配三个打包脚本**：pack（手写 ZIP：plugin.json/logo/dist/lib）、verify（ZIP/CRC、SHA256、入口 HTML 含宿主桥、DLL 导出符号、清单字段）
- [ ] **Step 2: 跑通**：`node scripts/pack-plugin.mjs && node scripts/verify-plugin.mjs` → verify PASS
- [ ] **Step 3: 本地宿主联调**：`scripts/deploy-to-otools.ps1` 同步进本地 OTools 宿主 → 宿主内确认：插件加载、autostart 起服务（120s 内返回）、面板 UI 可用、mock-peer 场景在宿主内重跑 `receive_files`
- [ ] **Step 4: Commit** — `feat: packaging, verification and host deploy script` + `chore: manifest native/autostart, readme`

### Task 13: 发布 — tag、Release、市场上架

**Files:**
- Create: `scripts/publish-market.mjs`、`scripts/release-policy.mjs`（+ 各自 `.test.mjs`）（从模板 `scripts/` 拷贝，`GITHUB_REPOSITORY` 适配）
- Modify: `.github/workflows/release-plugin.yml`（与 Task 2 呼应，无实质改动则不动）

**Interfaces:**
- Consumes: Task 12 的 `.oplg` 产出；仓库 secrets `XYCLOUD_PAT`、变量 `OTOOLS_PUBLISH_MARKET=true`

- [ ] **Step 1: 拷贝适配并跑脚本自测**：`node --test scripts/release-policy.test.mjs scripts/publish-market.test.mjs` → PASS
- [ ] **Step 2: 配置市场凭据（需用户参与）**：`gh secret set XYCLOUD_PAT --repo ootools/otools-localsend`（用户提供 PAT 值）；`gh variable set OTOOLS_PUBLISH_MARKET --repo ootools/otools-localsend --body true`。若用户无 PAT，此步停下报告——Release 照发，市场跳过。
- [ ] **Step 3: 首发验证**：`git tag v0.1.0 && git push origin v0.1.0` → Actions 全绿 → GitHub Release 含 `.oplg` → 市场出现插件卡片。
- [ ] **Step 4: Commit**（若有适配改动）— `chore(release): market publish plumbing`

## Self-Review 记录

- **Spec coverage**：spec 目标 1–5 → Task 3–9（协议）、10–11（UX）、1/12/13（合规与发布）；非目标未混入；端口回退（Task 6/7）、事件节流（Task 5/9）、面板重建（Task 8 场景5）、通知（Task 11）、mock 对端（Task 8）、真机对测待办（Task 12 README）均有归属。v1 范围内无缺口。
- **Step scan**：各 code step 均给出签名/文件/规格值，无 TBD；测试步骤给出名称与断言值；实现体仅在不被签名+测试决定处出现。
- **Type consistency**：`DeviceEntry{info,ip,lastSeenMs}`、`TransferRecord`、method 名与事件名在 Task 3/6/7/9/10/11 间一致；`start_localsend`、`__otools_shutdown__` 拼写一致。
- **Review Focus**：#1→Task 6/7 端口回退测试 + Task 11 Step 3 错误态；#2→Task 7 流式断言 + Task 8 场景 2（64MB）；#3→Task 5 溢出测试 + Task 8 场景 5；#4→Task 8 场景 2 中文文件名；#5→Task 7 `upload_rejects_bad_token_and_wrong_ip`。
- **Proportion**：计划约 500 行，spec 约 200 行，未逐字转写实现体。
