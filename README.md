# otools-localsend

LocalSend 协议 v2 兼容的局域网互传 OTools 面板插件：与手机、电脑上的官方 LocalSend
互相发现并收发文件与文本（已通过独立官方线格式/HTTPS 客户端身份测试及互操作矩阵，手机真机复测见文末）。

- 发现：UDP 组播 `224.0.0.167:53317`（announce / register 按官方语义回源）
- 传输：自签 HTTPS `53317`，端点 `register` / `prepare-upload` / `upload` / `cancel` / `info`
- 实现：Rust native（`lib/Windows.dll`、`lib/macOS.dylib`、`lib/Linux.so`，宿主 `ot-plugin-ffi` ABI）+ React 面板
- autostart：宿主会话启动时执行 `start_localsend`，服务常驻后台接收
- 平台：Windows x64、macOS Intel / Apple Silicon（Universal2）、Linux x64

上游：[LocalSend](https://github.com/localsend/localsend)（快照 `v1.18.2`）与
[localsend/protocol](https://github.com/localsend/protocol) v2.2。溯源见 [UPSTREAM.md](UPSTREAM.md)，
第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目沿用上游 **GPL-3.0**。

## 安装

- 插件市场安装 `otools-localsend`（市场分发通用包，含全部平台原生库），或
- 手动安装发布包：GitHub Release 按平台选择
  - `otools-localsend-<v>-windows.oplg`（仅 Windows.dll）
  - `otools-localsend-<v>-macos.oplg`（仅 macOS.dylib）
  - `otools-localsend-<v>-linux.oplg`（仅 Linux.so）
  - `otools-localsend-<v>.oplg`（通用包，含全部平台）

## 使用

1. 打开插件面板 → **设备** 标签自动发现同网段内正在运行的 LocalSend 设备
2. 选中设备 → **发送文件**（可多选）或 **发送文本**
3. 对方接收端确认后开始传输，**传输** 标签显示实时进度
4. 收到他人发送时弹出确认框：全部接受 / 勾选部分接受 / 拒绝；单条文本消息按气泡展示

设置项：设备别名、设备型号、设备类型、端口、下载目录、PIN、自动保存、来件通知。

- **自动保存开启**：来件不再弹确认框，直接接收并落盘到下载目录。
- **PIN**：开启后对方必须输入正确 PIN 才能发送；同一 IP 连续 3 次错误会被限流（429，30 分钟）。
- **文本消息**按官方线格式发送：单条 `<uuid>.txt` 且文本置于 `preview`，官方客户端渲染为消息气泡。
- **传输反馈**显示准备文件、等待对方确认、上传与最终状态；失败时保留脱敏的 HTTP/TLS/连接原因。
  等待或传输中的任务可在传输卡片点击取消。界面定期读取后台记录，单个事件丢失也能恢复收件确认与终态。
- **接收目录**默认精确为 `~/Download/OToolsLocalSend`（`Download` 单数），自动展开当前用户主目录，
  实际保存时创建。原先未设置目录或留空会采用此默认；已有自定义目录、历史和旧文件不会迁移或删除。
- **内容历史**显示文本原文与换行，支持复制文本；本机发送源和已收到的图片显示缩略图并支持复制原尺寸图片。
  其他文件可打开所在文件夹，不会执行文件本身；旧发送记录缺少源路径或文件已移动/删除时会明确提示不可用。
- **收件另存为**使用宿主自绘文件树。图片“另存为”只选择目标，点击“接受所选”或“全部接受”后才接收保存；
  同名文件不覆盖，会自动顺延文件名。文本可在弹窗中直接复制，复制不会接受或关闭请求。
- **图片预览边界**：PNG/JPEG/GIF/WebP/BMP 使用原生有界缩略图；编码源最多 32 MiB、最大 16384 单边与
  16 MiPixels，缩略图最长边 384；JPEG/WebP 会在解码前额外检查内部帧尺寸与工作区预算。
  超限、损坏和不支持的格式仅关闭预览/图片复制，不改变文件传输能力（复杂无损变换或压缩透明通道 WebP 会保守降级）。
  标准 LocalSend 图片在接受前只有元数据，弹窗显示“接受后显示预览”，不会为预览提前接收或加载对端网址。
  `?preview=1` 的复制、另存为和文件夹反馈都是本地仿真，不操作真实宿主剪贴板或文件管理器。

### 主题

默认使用明亮主题；宿主已声明暗色/明亮时采用宿主主题，并跟随宿主 `otools-theme-changed`
事件或受信任父窗口的 `otools:theme-sync` 更新。不会因为操作系统偏好暗色而覆盖默认明亮。
没有宿主主题信号时仍保持明亮，品牌蓝色与状态颜色不改变。

### 手动启动与停止

打开插件页面后，会在宿主桥就绪并确认服务已停止时**自动启动一次**，同时保留宿主 autostart。
已运行或正在启动不会重复启动；正在停止不逆转，启动失败保留错误，可在侧栏或 **设置 → 服务状态**
点击 **启动服务** 重试。自动启动使用已保存设置，不保存当前表单草稿。

手动停止后，同一次页面打开中的轮询和界面切换不会自动重启；明确关闭插件页面再打开会形成新的自动启动周期。
宿主若只是隐藏/再次显示原有页面而没有重新加载，则仍尊重该页面内的手动停止。

- 空闲时点击 **停止服务** 即可停止 HTTPS/UDP 发现与后台回源；完成后释放端口。
- 存在未完成的发送、接收或待确认请求时，先弹出停止确认；取消确认不影响传输。
  确认后会取消未完成传输，保留设置、证书、历史和已经完成的文件。
- 停止不是卸载插件，之后可再次启动；保存新端口后重新启动服务即可生效，无需重启整个宿主。
- `?preview=1` 的启停只是界面仿真，不会启动真实网络服务。

### 端口与防火墙

插件优先绑定 `53317`（UDP 发现 + TCP 传输）。若该端口已被占用（例如本机同时运行官方
LocalSend），会自动递增到空闲端口，并在公告中上报实际端口；应用内状态栏显示实际端口。

首次运行时 Windows 防火墙可能拦截入站连接，需要为宿主程序放行 UDP/TCP `53317`
（或自动回退后的端口），否则其他设备无法发现或连接本插件。

### 已知能力边界

- **来件通知**依赖 webview 的浏览器 Notification API（SDK shim 无宿主 IPC）：仅在面板
  仍驻留、但窗口处于隐藏状态时触发；面板被完全销毁时不会通知，发送方会停留在等待确认。
- 若 UDP 发现端口回退（本机 53317 被占用）：本插件的公告仍发往标准组播端口，其他设备
  **可以**发现本插件并回源 register；但其他设备的公告也发往标准端口，本插件已回退**收不到**，
  因此本插件无法通过组播主动发现其他设备，发现依赖对方收到公告后回源。
- v1 未实现：浏览器反向传输（`prepare-download` / `download`）、收藏设备同步、protocol v3。
- 局域网发送显式绕过 HTTP 代理，并使用同一插件证书作为 HTTPS 客户端身份，兼容新版官方端的客户端证书要求；
  支持对端公告的 HTTP/HTTPS。HTTPS 仍接受对端自签证书，本版未新增证书指纹固定验证。

## CI 与 macOS 原生库

公开仓库可使用 GitHub 标准 macOS 托管 runner，无需用户手工构建动态库。
`macos-native.yml` 固定使用受支持的 `macos-15-intel`，分别编译 `x86_64-apple-darwin`
和 `aarch64-apple-darwin`，经 `lipo` 合并、临时签名、架构校验及实际加载冒烟后，
上传一个 `lib/macOS.dylib`。两种 Mac CPU 共用同一个安装包，最低部署版本为 macOS 11.0。

发布流程等待 Windows、macOS、Linux 三个平台构建成功，再生成三个独立包与通用包。
装配和发布前均用 `--require-all-platforms` 校验：缺少任一平台库或独立安装包就失败，
不会把缺 Mac 库的包作为通用包发布。原有 v0.3.2 及以前已发布的包缺少 Mac 动态库，
Mac 用户需要更新到包含 Universal2 库的新版本。

本地构建仍可用于开发调试；在 Mac 上执行：

```bash
node scripts/build-native.mjs
python3 -I scripts/smoke-native.py --library lib/macOS.dylib
```

## 开发

```bash
pnpm install
node scripts/build-native.mjs     # cargo cdylib → lib/Windows.dll（校验导出符号）
node scripts/build-web.mjs        # vite 构建 → dist/
node scripts/pack-plugin.mjs      # → dist-pack/otools-localsend-<version>.oplg + SHA256SUMS
node scripts/verify-plugin.mjs    # 校验 ZIP/CRC/SHA256、清单、桥标记、DLL 符号
```

测试：

```bash
cargo test --manifest-path native/Cargo.toml     # 原生单测
node --test scripts/package.test.mjs             # 打包/校验门槛（含篡改拒绝）
python -I scripts/smoke-native.py                # DLL 冒烟（隔离数据目录）
python -I scripts/native-events.test.py         # 原始 topic/payload 宿主事件契约
python -I scripts/official-wire-test.py           # 独立官方 JSON/HTTP/HTTPS 身份互测
python -I scripts/file-content-test.py            # 真实 DLL 图片/资源释放/手动另存为（隔离目录）
python -I scripts/interop-test.py                # 独立 mock 对端互操作矩阵
```

`scripts/interop-test.py` 用 `scripts/mock-peer.mjs`（独立 Node 实现的 LocalSend v2 对端，
不复用插件代码）覆盖：发现、收发文件（含 64MB 与中文文件名）、PIN、拒绝/取消、
面板关闭后重建、sha256 失配重试、PIN 限流、发送文件/文本、自动保存接收，以及真实
动态库的手动启停、端口释放、保存端口后重启、活动传输停止确认和完成文件保留。
可用 `--scenario service_restart` 等参数单独跑一个场景。

`scripts/official-wire-test.py` 使用独立 loopback 对端，直接检查真实动态库的官方精简注册响应、
省略可选字段的收件请求、手动确认、HTTP 文件收发、HTTPS 客户端证书身份以及失败原因脱敏。
原始队列先通过宿主实际 `topic/payload` 解析规则，不能用前端归一化掩盖丢失的 payload。
Node TLS 对端在 HTTP 层强制证书指纹匹配；严格 TLS 握手要求客户端证书的场景由独立 Rust
原生 fixture 补充验证。这些本机隔离测试不等同于真实手机和已安装宿主的端到端验收。

`scripts/file-content-test.py` 用真实动态库和临时 PNG 检查：精确默认目录、有界缩略图、原尺寸稳定复制资源及释放、
手动确认前无图片读取、逐图片另存为真实字节/实际路径、同名不覆盖、普通停服后资源仍可用。
它不调用系统剪贴板或文件管理器；这些交互仍需要安装宿主内实测。原生解码限制不是操作系统级进程 RSS 隔离。

本地部署到 OTools 主仓库试跑：

```bash
pwsh -File scripts/deploy-to-otools.ps1 -OtoolsRoot D:\Repos\xyito\otools\otools
```

## 真机对测待办

以下需要在具备条件时手工验证（自动化包含独立协议/TLS fixture 与 mock 对端，尚未代替真实手机复测）：

- [ ] 官方 LocalSend Windows 桌面端 ↔ 本插件：互相发现、互发多文件、取消、拒绝、PIN
- [ ] 手机 App（Android / iOS）↔ 本插件：同上，以及文本消息气泡显示
- [ ] 同机共存（官方 LocalSend 与本插件同机运行）：端口回退、互相可见
- [ ] 宿主内 UI 验收：设备卡片时间与排序、来件确认框、自动保存静默接收、端口占用错误态
- [ ] 防火墙首次放行流程
