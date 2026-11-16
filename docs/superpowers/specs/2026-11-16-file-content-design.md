# 图片、传输内容与接收保存体验设计

日期：2026-11-16 · 状态：已通过 ExitPlanMode 批准

## 意图与范围

用户要求：
1. 图片传输有预览。
2. 默认目录设置为 `~/Download/OToolsLocalSend`（Download 单数）。
3. 传输记录显示文本、图片预览；文本和图片支持复制，其他文件支持打开所在文件夹。
4. 收件弹窗文本支持复制，图片支持另存为。

保留现有 LocalSend v2 互通、明亮默认/宿主主题、panel、自绘文件树及可重启服务。此次不提交、推送、发布或修改宿主公共接口。

## 事实与方案

沿用 React + Rust 原生方案：Rust 负责真实本机文件读取、受限图片解码、保存与资源归属；前端负责缩略图与交互，宿主负责剪贴板及文件管理器。

不采用全图 readHostFile/base64 往返：当前 SDK 包装存在二进制转文本行为，宿主文件读取和图片复制缺少资源预算。也不把对端 preview 作为任意 URL、HTML 或私有图片协议字段。

查到的官方实装在 prepare-upload 中仅给文本消息填 preview，图片缩略图是发送端本地状态。该缓存不具备可校验版本清单，不能据此声称协议定义图片 preview 格式。标准图片在接受前没有原图资源：弹窗提示“接受后显示预览”，不提前接收、不扩展私有网络协议。发送端和收到的图片从真实本地文件显示缩略图。

## 默认目录

- 持久设置 `downloadDir` 缺失/null/空白归一化为精确字符串 `~/Download/OToolsLocalSend`。
- 有效自定义目录保留。统一 helper 以注入的 home 展开 `~`、`~/`、Windows `~\\`；拒绝 URL、UNC/网络共享、非绝对目录、非法 ADS/控制字符等路径。
- runtime 快照使用展开后的绝对路径，UI/设置可保留可读的 tilde 字符串。
- 仅实际接收保存时创建目录；查询默认设置/选择路径不写目录。旧 tmp/下载/历史文件不迁移或删除。
- Rust fixture 注入临时 home 或显式临时 downloadDir；DLL 测试在开始时设置临时下载目录。不得因为新默认而写真实 home。

## 本机历史资源

- `TransferRecord.sources`：可缺省 fileId→绝对发送源路径，仅本机历史/FFI，不放进 FileEntry 或网络请求。
- `destinations` 仅指真实完成、保留下来的接收文件。未上传/失败文件不占位；实际提交成功后才更新到最终唯一路径。
- 终态提交期间先使用真实已完成 tmp 文件，不能登记尚未写入的预估目标。同名旧文件不得被误认成本次接收。
- 混合失败和取消中已完成文件仍保留并可操作。移动失败保留 tmp，并保存可见的失败原因，不宣称保存成功。
- 历史查询参数为 sessionId+fileId，精确验证记录/fileId、来源 map、普通本机文件及大小。旧发送记录缺 source 时明确不可用，不按文件名猜路径。
- 已选发送本机路径可作为 file_preview 的另一种输入，但不得是 URL/UNC；资源不是对端可调用的 HTTP API。

## 图片预算与生命周期（构建者决定）

- 支持 PNG/JPEG/GIF/WebP/BMP 栅格图片；通过魔数/解码器识别真实格式。SVG/HEIC 等明确降级，不注入远端内容。
- 编码源最大 32 MiB；单边最大 16384、像素最大 16 MiPixels、解码分配最大 128 MiB。缩略图最长边 384、PNG 输出最大 512 KiB。
- native 只回有界 PNG data URL、源尺寸、资源版本；缩略图缓存上限 8 MiB/64 项，原生同时最多 2 次解码。
- 图片复制为受控原始尺寸 PNG 本地临时资源（最大输出 32 MiB），宿主只接收文件路径。最多 4 个未释放资源；await 宿主成功后 finally 显式释放。清理由不透明 resourceId 管理，不接受任意待删路径。
- 文件/版本变化使缓存失效；前端按稳定资源身份缓存、有界并发，旧请求不得写入新 session/path，卸载后不更新 UI。
- 解码/文件 IO 不长时间持有全局 Slot/history mutex。资源操作有独立 admission/ownership；卸载先 fence 新操作并 drain 实际 native worker。

## 另存为授权流程

- 弹窗每张图片有“另存为”，使用 `pickFromHostTree({save:true,defaultPath,filters})`。
- picker 完成仅暂存该 fileId 的拟保存路径；取消无副作用。选完不 accept、不 dismiss、不上传。
- “接受所选/全部接受”才调用 `acceptSession(sessionId,fileIds,destinations?)`。仅提交接受集合中的拟目标；无目标保持旧线格式/行为。
- 原生在改变 Pending/发 token 前验证接受集合、目标 map、合法本机绝对路径。非法请求不改变会话。
- 实际保存以原子 create_new 防覆盖，冲突使用 `name (n).ext`，候选耗尽明确失败，绝不退回覆盖原目标。
- 自绘 picker 有覆盖确认但无原子授权标记，本插件仍选择不覆盖（界面解释可能顺延文件名），不改 vendored SDK。
- 接受/拒绝与正在选择保存路径互斥；停服/关闭/会话替换使晚到 picker 失效，但停止确认遮挡时保留已有选择与拟目标。
- 文件提交归既有 UploadLease/retained worker 所有，peer reset/stop/unload 不得提前释放磁盘 owner。

## 前端与宿主动作

- 文本消息用严格 text/plain + string preview 检测，直接展示原正文和换行，可复制；普通文本文件不伪造正文。
- 历史图片真实预览，可复制原尺寸图片；不支持/损坏/移动/删除有占位与原因。其他文件可定位源/接收目的目录，缺真实路径不伪造。
- 宿主命令经已有 `invokeTauri` await：otools_copy_text({text})、otools_copy_image({image:path})、otools_shell_show_item_in_folder({path})。成功返回才提示，桥缺失/权限/宿主错误明确反馈。
- 复制不会接受/关闭收件；打开目录不执行文件本身。预览模式明确仿真，不操作真实剪贴板/文件管理器/用户文件。
- authority merge 保留 sources/destinations/files 内容元数据，保留 terminal tombstones、代际保护及 slow poll coalescing。
- 使用现有语义 CSS 和主题令牌，不重做导航/品牌/启停。

## 验收和保护

测试先行验证精确默认目录、无 home 写入、自定义保留、边界图片/缩略图/临时资源释放、接受目标校验/取消/no-clobber/跨卷/混合终态一致性、UI 文本/预览/复制/定位/异步失效。跑全套 JS、类型检查/构建、Rust/clippy、实际 DLL smoke、原有互通及官方线格式测试；浏览器检验明暗主题。

本轮不把隔离测试称为真实手机/安装宿主系统剪贴板已验收。不动真实宿主、不改全局环境/代理/防火墙、不读 PAT、不发送用户文件、不清旧目录或公开 tag。默认在既有 main 开发（用户明确工作区规则），不创建 worktree，不提交/推送/发布。
