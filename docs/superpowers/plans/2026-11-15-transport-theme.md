# LocalSend Transport and Theme Fix Implementation Plan

> 执行TDD，根因先复现后修复；一次独立全项目审查。用户已批准ExitPlanMode方案。

**Goal:** 修正真宿主事件数据丢失及官方传输兼容问题，默认明亮并跟随宿主。
**Spec:** docs/superpowers/specs/2026-11-15-transport-theme-design.md
**Baseline:** 53953c1 / v0.4.0。保留panel、autostart、手动启停和三平台完整包。

## 共用契约
- 原生poll_events canonical {topic,payload}；边界归一化到内部{event,data}，兼容旧格式。
- TransferRecord追加可选 `stage` (preparing/waiting/uploading/finished) 与 `error`；旧历史default兼容；错误必须脱敏。
- send_files/send_text追加可选 `protocol`，已公告peer按ip+port选scheme；缺参数保留现行为，非法拒绝。
- __OTOOLS_THEME__快照{themeMode,themeAccent,resolvedTheme}；window CustomEvent `otools-theme-changed`；iframe消息type `otools:theme-sync`，只接受直接父窗口。

## Review focus
1. 200ms宿主队列drain vs1000ms前端fallback：payload格式必须正确，不能靠竞争偶然成功。
2. 真实官方TLS/JSON而非同源mock：省略字段、response字段、需要客户端证书。
3. 失败诊断泄漏query token/PIN/body：完整URL/响应文本不持久化，网络错误remove_url。
4. 周期history补齐仍须抵御迟到响应/终态回退；Pending必须可确认不重复。
5. 初始亮色无host信号、dark/light切换和iframesource验证，不能用OSdark替换默认。

## Task1 Native protocol/transport
Files: native/src/{models,sender,runtime,service,crypto,event_bridge,server}.rs（必要改动与测试）。
- [ ] RED actual host parser canonical event fixture；官方download省略/注册响应DTO。
- [ ] 实现 canonical事件，官方response DTO、下载缺省值、合法peer scheme。
- [ ] RED HTTPpeer/mandatoryclientcertTLS/LANproxy cases，再实现same certidentity/no_proxy，不改变现代与旧TLS兼容。
- [ ] 保存stage/error和合理脱敏HTTP/网络原因，失败terminal事件不泄漏data。
- [ ] Full cargo test/clippy，报告实际line级结果，不对未知iPhone失败作额外猜测。

## Task2 Theme (independent)
Files: src/theme.ts（或等价小模块）、main.tsx、styles.css、theme tests。
- [ ] RED nohost默认LIGHT即使OSdark；hostsnapshot/classes；DOMdetail；directparentmessage；invalidsource忽略。
- [ ] 亮色tokens默认/dark显式，同步初始化/listeners/cleanup与safeclasswrites。
- [ ] brandaccent/status含义无改，fullfronttests/typecheck/build。

## Task3 Frontend bridge/recovery/feedback
Files: src/api.ts,hooks/usePollEvents.ts,components/TransferCard.tsx,pages/{Devices,Transfers}.tsx,相关tests。
- [ ] RED真实host topic/payload经SDKlistener可达confirmation/done，与旧event/data兼容。
- [ ] periodic authorityhistory独立于hostdrain，保持generation/ref/latestrequests/terminaltombstones。
- [ ] protocol传参、stage/error展示、非terminal取消按钮，busy/error正确恢复。
- [ ] 更新preview只作UI模拟，fullNode/TSbuild。

## Task4 Independent wire/DLL/CI
Files: scripts/smoke-native.py,interop-test.py,mock-peer.mjs与独立wire/TLSfixture（新文件如果必要）。
- [ ] canonical rawdrain校验后Pythonnormalize，不改host业务/用户安装目录。
- [ ] 原完整16matrix仍过；外部TLS+官方minimalrequest/response验证不能复用nativeDTO构造期望。
- [ ] 浏览器bright/default/hosttoggle/确认与错误卡实测；真实手机未测则清楚报告。
- [ ] 整体独立审查修复高优先级问题，三平台build+dryrun。
- [ ] 新版本发布不覆盖已公开tag，子模块仅目标路径变化；工作区无关dirtyfiles不动。

## Self-review
事件schema/nativeDTO/feedback全边界保持兼容；主题独立层不改rates布局；证书transport调试不使用用户keycontents作日志；实测对等目标是loopback，不发送用户文档到外部。
