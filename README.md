# otools-localsend

LocalSend 协议 v2 兼容的局域网互传 OTools 面板插件：与手机、电脑上的官方 LocalSend
互相发现并收发文件与文本（协议兼容经 mock 对端矩阵验证，真机对测清单见文末）。

- 发现：UDP 组播 `224.0.0.167:53317`（announce / register 按官方语义回源）
- 传输：自签 HTTPS `53317`，端点 `register` / `prepare-upload` / `upload` / `cancel` / `info`
- 实现：Rust native（`lib/Windows.dll`，宿主 `ot-plugin-ffi` ABI）+ React 面板
- autostart：宿主会话启动时执行 `start_localsend`，服务常驻后台接收

上游：[LocalSend](https://github.com/localsend/localsend)（快照 `v1.18.2`）与
[localsend/protocol](https://github.com/localsend/protocol) v2.2。溯源见 [UPSTREAM.md](UPSTREAM.md)，
第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目沿用上游 **GPL-3.0**。

## 安装

- 插件市场安装 `otools-localsend`，或
- 手动安装发布包：GitHub Release 中的 `otools-localsend-<version>.oplg`

## 使用

1. 打开插件面板 → **设备** 标签自动发现同网段内正在运行的 LocalSend 设备
2. 选中设备 → **发送文件**（可多选）或 **发送文本**
3. 对方接收端确认后开始传输，**传输** 标签显示实时进度
4. 收到他人发送时弹出确认框：全部接受 / 勾选部分接受 / 拒绝；单条文本消息按气泡展示

设置项：设备别名、设备型号、设备类型、端口、下载目录、PIN、自动保存、来件通知。

- **自动保存开启**：来件不再弹确认框，直接接收并落盘到下载目录。
- **PIN**：开启后对方必须输入正确 PIN 才能发送；同一 IP 连续 3 次错误会被限流（429，30 分钟）。
- **文本消息**按官方线格式发送：单条 `<uuid>.txt` 且文本置于 `preview`，官方客户端渲染为消息气泡。

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
python -I scripts/interop-test.py                # mock 对端互操作矩阵
```

`scripts/interop-test.py` 用 `scripts/mock-peer.mjs`（独立 Node 实现的 LocalSend v2 对端，
不复用插件代码）覆盖：发现、收发文件（含 64MB 与中文文件名）、PIN、拒绝/取消、
面板关闭后重建、sha256 失配重试、PIN 限流、发送文件/文本、自动保存接收。

本地部署到 OTools 主仓库试跑：

```bash
pwsh -File scripts/deploy-to-otools.ps1 -OtoolsRoot D:\Repos\xyito\otools\otools
```

## 真机对测待办

以下需要在具备条件时手工验证（当前自动化只覆盖 mock 对端）：

- [ ] 官方 LocalSend Windows 桌面端 ↔ 本插件：互相发现、互发多文件、取消、拒绝、PIN
- [ ] 手机 App（Android / iOS）↔ 本插件：同上，以及文本消息气泡显示
- [ ] 同机共存（官方 LocalSend 与本插件同机运行）：端口回退、互相可见
- [ ] 宿主内 UI 验收：设备卡片时间与排序、来件确认框、自动保存静默接收、端口占用错误态
- [ ] 防火墙首次放行流程
