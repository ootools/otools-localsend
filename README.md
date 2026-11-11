# otools-localsend

LocalSend 协议 v2 兼容的局域网互传 OTools 插件：与手机、电脑上的官方 LocalSend 互相发现并收发文件与文本（UDP 组播发现 `224.0.0.167:53317` + 自签 HTTPS 端点，Rust native 实现，React 面板界面）。

- 插件形式：OTools 面板插件（`plugin.json`，`entry: dist/index.html`），native 能力经 `lib/Windows.dll` 提供，autostart 常驻接收（后续任务接入）。
- 上游项目：[LocalSend](https://github.com/localsend/localsend)（快照 `v1.18.2`，协议规范 [localsend/protocol](https://github.com/localsend/protocol) v2.2）。溯源与改动范围见 [UPSTREAM.md](UPSTREAM.md)。
- 许可证：GPL-3.0（沿袭上游），第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建

构建与打包脚本（`scripts/`）由后续任务加入；当前仓库为脚手架阶段。
