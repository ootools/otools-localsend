# LocalSend 真机传输与宿主主题修复设计

日期：2026-11-15 · 状态：已通过会话 ExitPlanMode 方案审批

## 现场事实
市场版0.4.0在真实OTools0.9.3宿主加载，监听TCP53318，能发现对端。12B Send后台已Failed但界面Pending；另一2B Receive后台Pending，未发接受调用。现场失败没有保存HTTP/TLS错误，不能把任何代理/证书缺陷泛化为这次全部根因。

## 确定缺陷
1. 插件事件使用{event,data}，实际宿主listen解析只认payload（event名虽有别名），先drain再发null。导致收件确认、进度、终态内容丢失；旧独立mock直接读取data没有覆盖这个边界。
2. DeviceInfo.download未设置serde默认，而官方v2定义可省略false；官方register响应没有port/protocol，现实现按完整公告反序列化。
3. 请求硬编码https，丢弃对端protocol；局域网未显式no_proxy。新版官方1.18.2默认要求client cert而本客户端未提供identity；旧1.17服务不要求mTLS，不能将此直接认定未知手机版本失败根因。text/plain、UUID.txt+preview符合官方适配，保留。
4. CSS默认暗色，未接宿主__OTOOLS_THEME__、otools-theme-changed与iframe otools:theme-sync。rates仅是视觉参考，其OS主题行为不是可靠宿主跟随实现。

## 最小修复
- 原生队列输出canonical {topic,payload}，前端/Python边界兼容canonical与旧格式，内部页面维持{event,data}。
- 权威transfer_list定期补齐，不仅依赖事件。严格保留代际排序、终态防回退、Pending去重、用户确认和手动启停。
- 官方公告/注册响应独立DTO；缺省download=false；保留peer地址和公告端口/协议。
- SendPeer、prepare/upload/cancel/register按合法http/https，未知scheme拒绝；可选参数向后兼容旧调用。
- 正式HTTPS客户端使用同一插件证书/key身份，LAN显式no_proxy；不改系统代理、不自动旋转用户证书、不外发私钥。
- TransferRecord增可选stage/error，保存脱敏连接/TLS/HTTP状态和失败阶段；UI显示具体失败/等待与可取消操作。不要记录文本、PIN、token、私钥或带query的完整URL。
- 主题亮色默认，html.dark明确覆盖；React挂载前读取host snapshot/classes；DOM更新detail直接读取；iframe消息只认direct parent和验证的枚举/type。保留accent/status颜色/无关classes。

## 边界
不自动停止宿主/真实传输、不修改host或vendored SDK公共桥、不放宽路径/IP/token安全、不新增外部服务、不覆盖既有tag。真实手机重测必须与loopback官方线格式/TLS测试分开报告。

## 验收
- canonical事件通过实际宿主解析规则后payload非null；宿主轮询先drain也不丢有效incoming/done。
- 新旧官方请求fixture（省略download/没有注册响应port）真实handler通过；HTTP目标和强制客户端证书HTTPS目标收发成功，代理环境不劫持loopback。
- 收件确认可在事件丢失时由历史补齐；后台Failed界面不会停Pending，错误无敏感query。
- 主题默认亮，初始宿主dark/light与动态事件/messages生效，拒绝无关source，品牌主色保留。
- 全原生/前端/启停/打包/三平台CI通过；独立审查；真实手机未测时明确标注。
