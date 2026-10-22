# 当前启动集成（2026-10-22）

默认 CCode 链路遵循根 `docs/specs/ccode-startup-global-prompt.md`：CLI 从专用 Node IPC 读取一次 bootstrap 配置，传入 `runtimeConfig.globalSystemPrompt`；ContextBuilder 将其叠加到标准系统消息，子代理与工作流继承。此字段不进入会话 persona 持久化。模型请求保留日志脱敏，但不再创建 execution scope、获取租约或发送 acquire/complete。下文是旧私有执行协议的历史背景，不能用来恢复默认路径的五分钟授权。

# 核心总控模型调用隔离

总控身份在所有运行模式下永久保留给中台私有通道。未配置通道时激活失败，
不得从本地Skill或旧managedSkills签名包读取；普通适配器发现/加载和工具返回边界均拒绝该身份。

CLI bundle 构建生成 `ccode-controller-capability.json`，schemaVersion/protocolVersion均为1，
entry固定为zcode.cjs，sha256绑定构建字节。桌面暂存同时复制声明；Host启动前异步核对摘要，
仅匹配时为配套Node bundle开启私有IPC。源码tsx wrapper、字节码、原生和env自定义命令
不自动继承此能力。该声明是兼容性证据，不是数字签名或抵御本机篡改的承诺。

整体需求与边界见仓库根 `docs/specs/ccode-confidential-controller.md`。
正文只允许在模型调用的私有临时上下文中注入，不能进入历史、压缩输入、工具结果。
本文件记录 CLI 模型适配器的具体约束，不表示当前已启用核心总控。

## 模型记录开关

私有调用由内部 metadata.confidentialController=true 标记。runner 在解析请求时强制
skipTranscript，关闭该请求的 logger/debug 及全文保留；普通并发请求不变。
请求级、适配器级和 admission ticket 的状态出口使用同一白名单投影：保留关联ID、
事件类型、时序/重试数值及分类，移除 header、原始异常、provider错误正文、observation
和 modelCall 自由文本；失败文案固定。准入acquire/tryAcquire/release仍委托原owner。
保留既有 WORKFLOW_QUOTA_PROVIDER_CODES 集合中的业务码，保证额度耗尽不会被错误
降为普通限流而冻结共享并发桶；其他provider错误字符串全部丢弃。
此步骤只隔离runner出口，底层网络与安全签名器、最终异常和模型注入仍需后续审计。

现有 `metadata.skipTranscript === true` 同时作用于 generate 与 stream。
该请求不得产生 runner-debug model-io 文件，也不得在 option-map transport 的
`rawRequestBodyCapture` 中保留请求正文；重试和刷新鉴权后的模型绑定继承此选择。
开关不改变模型选项映射或发给用户所选模型提供商的实际请求。
普通请求继续沿用既有记录策略，单个私有请求不修改共享 Provider 或并发请求状态。

数据流：调用上下文 metadata → 每请求 resolveForRequest → 每次尝试的独立
factory/capture 配置 → option-map 转换 → provider fetch。

后续还必须隔离 SDK 异常、状态事件、网络调试、流式输出与工具参数；仅禁止
model-io 并不构成完整保密能力。核心注入、私有通道及泄露检查尚待集成。

受保护流式请求在 SDK options 入口覆盖默认 `onError`，回调不得读取、序列化或
输出原始异常，避免 SDK 的默认 console 错误出口绕过后续异常脱敏。原始 error part
仍沿 fullStream 交给既有 runner 分类与受控失败出口，不能将失败变为成功。
此规则仅用于 `metadata.confidentialController === true`；普通请求（包括仅设置
`skipTranscript` 的请求）保留 SDK 默认错误诊断。本边界不代表 SDK warnings、
第三方其他日志或真实模型服务端已经完成保护验收。

## 验收边界

## 私有 IPC 消费端

### 保护 Skill 的发现入口

受保护 App（具有 scope 工厂或继承的执行端口）在普通 SkillPort 外套保护适配器。
发现列表剔除保留名及限定名、路径段冒用，加入仅名称/公开用途的 remote/admin 虚拟项；
path/directory/rootPath 为空，模型上下文不显示文件位置。普通 Skill 功能关闭时仍保留
该授权入口，不能因为没有 Skill 工具而无法满足工作门禁。普通 Skill 的启用配置不变。
直接 load 保留名或其路径/限定名变体安全拒绝；正常 Skill 工具须通过 runtime 激活回调，
只返回固定确认，不返回正文。包装适配器不下载、不缓存正文，不持有授权状态。
每次新工作输入调用总控入口完成当轮激活，历史已加载确认不能替代当轮授权；普通聊天
不激活。再次激活复用 Main 缓存，不能等同于再次下载。普通 Skill 继续原加载语义。
验收边界：普通开关关闭、外部自定义SkillPort、冒名本地项、别名load、无文件路径的
完整/预算降级列表、取消、子任务继承和普通模式兼容。静态检查不替代运行验收。

### 进程入口装配

Host 仅在命令明确声明私有 IPC 能力且存在私有通道工厂时设置
`ZCODE_CONFIDENTIAL_CONTROLLER_IPC=1`，同时建立第四路 Node IPC。该标记只表示
传输能力，不包含正文或授权；Host 覆盖继承值，未启用时清空。CLI main 在任何
异步启动步骤前取出并删除标记，避免工具或 Worker 继承。只有正式 protocol
运行入口同时收到标记及已连接 Node IPC 才创建进程唯一 client；缺通道安全失败。
存储准备、插件及其他命令不创建 client。生命周期取消立即释放，入口 finally
移除取消监听并幂等释放，单个 App 关闭
不释放共享 client。工厂经 run 依赖及 bootstrap protocol options 注入各 App，
每个任务仍独立创建 scope，不把正文放入配置或环境变量。
当前默认 resolver 尚不声明能力；完成保护 Skill 发现及迁移后才启用。
验收需覆盖标记缺失/继承清除、无 IPC、多个 App、单 App 释放、进程断连与退出。

Runtime 通过 ModelInvocationContext.confidentialController 注入进程私有执行端口，
不通过用户消息/序列化请求开启。Adapter 在 generate/stream executor 边界读取端口，
将正文和保密要求添加到本次 system 消息副本，不修改原 messages；强制私有metadata。
stream 在授权消费回调内完整收集后统一检查，收到completed才逐事件回放。
最多 100000 个事件、序列化接受预算 4×1024×1024 码元；取消检查覆盖收集及回放。
正文、按块ID的推理和按调用ID的工具参数分别重建为完整字符串，与events一起筛查，
避免交错事件插入噪声造成漏检；只回放已检查events。错误事件不能进入结果数组。
外部模型错误保留已知code/reason/retryable、有限retryAfterMs及受控额度码，使用新建
AiSdkModelAdapterError和固定文案，不含原SDK对象/cause。授权取消/身份失效优先。
含 execute 回调或 providerNative 的工具在保护请求中拒绝：它们可在SDK返回结果前
执行，无法由本地缓冲屏障事后撤销。普通Runtime工具声明可继续生成调用，审核后执行。
Runtime尚未装配端口时不激活私有执行；仅metadata声称私有而无端口必须拒绝。

App 接受已激活任务的 confidentialController 端口并注入 Runtime；主 agent_step
调用携带它，子代理继承同一端口/固定版本范围。标题、压缩、独立工作区查询不注入
正文。仅提供可选依赖不表示默认激活；后续任务准入层负责创建版本范围与鉴权。
任务准入创建独立的 createControllerExecutionScope，保存只读版本元数据，子任务共享
该对象。首次 ready 同步固定版本及内容摘要，后续 use 显式请求该版本；并发首次 ready
或后续调用的版本、摘要任一不同，均在调用模型之前拒绝，不混用规则。相同版本号
不能作为不同租户内容相同的依据。可从可信任务元数据恢复版本，不持久化正文；
只恢复版本时，摘要由恢复后的首次授权内容固定，不声称已经校验重启前内容一致性。

CLI adapter 只接专用 Node IPC，不处理普通 stdio 帧。每次 use 分配单调递增 ID，
最多 8 个并发调用。严格解析 ready/completed/failed；非法消息或错误顺序关闭连接。
ready 后只在 consume 回调内传入临时正文和取消信号；回调必须缓冲模型结果，不能
广播、写历史或执行工具。回调返回才发送 complete，收到 completed 后才返回结果。
注销、授权失效、调用方取消或 IPC 断开时中止回调并拒绝结果；迟到结果丢弃。
回调原始异常转换成安全错误，不传递 cause；正文不缓存、不记录、不写入环境变量。
等待 ready/完成确认各有 30 秒超时，模型执行期由调用方取消与服务端授权期限管理。
未连接 IPC 时 use 拒绝；适配器存在不代表 Runtime 已启用注入或输出检查。

## 验收边界补充

## 结果放行前的正文片段检查

消费端在发送 complete 前对缓冲结果进行 JSON 可序列化检查并筛查全部字符串字段，
包括工具参数、推理和扩展元数据。拒绝循环对象、不可序列化结果或超过 4×1024×1024
个 UTF-16 码元的 JSON 结果。通过后返回已检查的 JSON 快照，避免回调继续修改原对象。
结果须为纯 JSON 树：拒绝 Date/Map/Set、非有限数、undefined/函数、getter、稀疏数组、
重复对象引用，深度最多 128、节点最多 100000。序列化前预检，不静默转换工具参数。
这些是接受规模限制，并不保证 V8 临时分配的硬内存上限。
使用 NFKC 与去除空白/标点/格式字符后的正文指纹；规则每 12 字符取一个 24 字符
窗口，结果逐字符匹配并核对原串以排除哈希碰撞。因此任意连续 35 个规范化正文字符
的原文复制必定含一个指纹。较短规则全文匹配。规范化规则上限为相同码元数量，超限
安全拒绝。text/delta 字段额外连续检查，避免流式事件的 ID/字段名打断正文片段。
这是最低限度的原文泄露检查，不识别任意翻译/改写/编码，也不能替代禁止索取内部
规则的模型指令和调用方的工具执行屏障。失败只返回 EXECUTION_FAILED，不带匹配片段。

需要覆盖 generate/stream、自动重试、鉴权刷新、普通/私有并发、非法 JSON 错误。
当前开发者禁止未要求的测试，故本阶段只执行类型/Lint/架构和独立审查，
不将这些检查作为运行时无泄露的证明。

## 恢复版本绑定

Runtime先读取SessionStore的session/run绑定，再进行无副作用授权握手；completed后不可变保存
version/digest，成功且轮次仍有效才发布active scope。绑定只有版本标识，不含正文或授权。
目标运行使用target键，普通外部输入使用稳定input键；内部续跑无法找回原键时拒绝激活。
恢复同时核版本和摘要，撤销或不可用时不能回退最新版本。软删除保留元数据；fork为新run。
