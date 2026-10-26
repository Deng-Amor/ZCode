# CCode 客户端审计遥测上报（一期，轻量遥测层）

- 状态：待评审
- 编写日期：2026-10-22
- 修订：2026-10-23 增补「§6A 诊断 bundle 自动上传」（2026-10-22 A2 拍板，对齐中台 PRD v0.2 M4-R9）；同日 A3 拍板甲案已更新 §一/§六.7/OQ-A8
- 台账来源：`E:\ZCode\docs\prd\总控台账.md` 开发批次 1「审计遥测上报 spec→产出 docs/specs/ccode-audit-telemetry.md」行（2026-10-22 19:25 派发；执行时实读该行位于台账第 30 行，任务卡所写「第 31 行」为行号漂移，见回执异常段）
- 定位：**轻量遥测层（一期先行）**——客户端把用户运行错误、任务停止/失败等生命周期事件、能力调用证据等元数据上报数据中台。任务级台账记录与关闭门禁（缺证据不得标完成）仍归 `E:\ZCode\docs\specs\ccode-provenance-ledger.md` 体系（二期衔接），本 spec 不重定义、不替代（见 §2.3、§7）。
- 中台侧合同：`E:\ZCode\docs\prd\ccode-dataplatform-prd.md`（v0.1，批次 20261022-D1，待评审）。本文已实读对齐：§3.4 模块④（M4-R1~R8）、§4.4（遥测事件 schema 要点与幂等命令 ID 语义）、§4.5（归因字段）、§4.6（既有接口基线）、§3.5 M5-R3（上报可见性策略）、§3.6 M6-R2（设备标识）、§6 S7/S9/S10、§7 P2 分期、OQ-7/OQ-11。接口语义契约以该 PRD §4 为准；端点命名、路径与内部实现由中台定。该 PRD 属待评审状态，评审冻结前本文引用其条目均视为草案对齐。
- 输入真源（均已实读）：
  - `E:\ZCode\docs\prd\ccode-dataplatform-prd.md`（中台接收契约）
  - `E:\ZCode\docs\prd\split\06-ledger-evidence-stress.md`（盘点 4 状态字段现状、盘点 6 tool.call 事件流范式）
  - `E:\ZCode\docs\specs\ccode-provenance-ledger.md`（二期台账，划界依据）
  - `E:\ZCode\apps\zcode-cli\packages\contracts\src\events\session.events.ts`（tool_call_* / turn / background_task 事件契约）
  - `E:\ZCode\apps\zcode-cli\packages\contracts\src\telemetry\index.ts`、`...\telemetry\agent-execution.ts`（既有模型 API 遥测词汇与资源上下文）
  - `E:\ZCode\apps\zcode-cli\packages\adapters\src\confidential-controller\bootstrap.ts` L16-L27（ConfidentialControllerError 失败码族）
  - `E:\ZCode\packages\services\src\confidential-controller\platform-auth.ts`（中台认证与 token 复用）
  - `E:\ZCode\packages\services\src\logger\serviceLogger.ts`（日志分级纪律）
- 盘点基线：分支 `codex/ccode-update-feed` 当前工作区（2026-10-22 实测约 236 条未提交在途改动；本文代码断言均按当前工作区字节实读，不预测在途改动走向）
- 保密约束：本文只描述机制与契约要点，不复制任何受控总控正文或中台未公开内容；遵守 `E:\ZCode\AGENTS.md`「不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址」与母 PRD §5（`E:\ZCode\docs\prd\ccode-product-prd.md` L95「不记录密码、访问令牌、总控正文、企业敏感数据或私有接口响应到普通日志、会话导出或遥测中」）。

## 一、拍板记录（2026-10-22 用户与老板讨论收敛，直接采用）

以下为方向拍板摘要（任务卡转述），本文按其直接展开，不重新论证：

1. **只传元数据**：错误码、任务生命周期状态、版本归因、能力调用证据（toolCallId/工具名/结果状态）；**不传对话内容与消息正文**；字段白名单 + 客户端脱敏后才允许出网。
2. **频率两档**：任务生命周期事件准实时（分钟级队列）；诊断细节（堆栈摘要、上下文片段）批量/采样。
3. **断网与离线**：本地排队、不阻塞用户任务；上线 heartbeat 触发补传。
4. **上报可见性**：作为管理端策略配置项（默认静默后台执行、不打扰用户；是否对企业终端用户明示由管理策略决定）。**2026-10-22 A3 拍板：采用甲案（静默后台）为默认**，乙案（明示低调）保留为管理端策略选项（对齐中台 PRD OQ-3 v0.2.1 结案记录）。
5. **每条记录必带归因字段**：ccodeRelease 版本、平台、租户/设备标识、相关 skill 的 version/digest（与中台 PRD §4.5 的归因字段对齐）。

与中台 PRD 的落点对应：#1→M4-R8 与 §4.4 字段白名单；#2→M4-R7 通道分类；#3→M4-R2 幂等（断网补传重放安全的前提）；#4→M5-R3；#5→§4.5 归因字段表。

## 二、目标与范围

### 2.1 目标

1. 定义「采集 → 白名单脱敏 → 排队 → 上报 → 补传」的客户端端到端机制，承接中台 PRD 模块④（M4）中遥测事件流表一侧的全部客户端义务。
2. 定义三类核心事件模型（任务生命周期、运行错误、能力调用证据）的 schema 要点、负面清单（绝不外传字段）与归因字段注入方式。
3. 定义本地队列的唯一所有者、持久化与幂等命令 ID 纪律，使断网排队、重启、补传重放在中台 M4-R2 幂等语义下不产生重复行。
4. 定义两档频率、限流采样配合、失败不阻塞用户任务、可见性策略配置的行为细节。

### 2.2 范围内

客户端侧事件采集投影、白名单脱敏、双通道本地队列、上报与补传调度、归因字段注入、可见性策略执行的机制与契约要点；客户端侧验收场景（与中台 PRD S7/S9/S10 互补：PRD 场景验中台侧服务端判据，本文场景验客户端侧判据）。

### 2.3 范围外

- **任务级台账与关闭门禁**：记录模型（来源/步骤/证据/关闭结论）、submitted→accepted→closed 状态机、expectedRevision、证据核验、「缺证据不得标完成」的代码卡点，全部归 `ccode-provenance-ledger.md` 与拆项 6（`E:\ZCode\docs\prd\split\06-ledger-evidence-stress.md`）体系，二期衔接（§7）。遥测事件**不能**作为任务完成结论的凭据。
- 中台侧遥测事件流表/任务台账表的存储、幂等实现、限流阈值、采样维度、看板（中台 PRD 模块④⑤，中台团队实施）。
- 既有模型 API 遥测（OTLP/ARMS 面：`E:\ZCode\apps\zcode-cli\packages\telemetry\`，`TELEMETRY_SCHEMA_VERSION=6`，`otlp-exporter.ts` 资源属性 `zcode.telemetry.schema_owner: "cli"`）的改造——审计遥测是独立出网通道，不复用其出口，也不改其 schema（边界见 §3 现状 A6）。
- 用户 skill 回流上传（同批 `ccode-skill-sync-upload.md` 范围）；总控本地锁定 skill 与专家 skill 下发本体（同批兄弟 spec 范围）。
- 代码实现与测试（本 spec 为待评审设计文档）。

## 三、现状依据（复用面与缺口）

以下断言均按当前工作区实读标注；「已实测」附路径与符号/行号。

- A1【已实测】事件源契约现成。`E:\ZCode\apps\zcode-cli\packages\contracts\src\events\session.events.ts`：`SessionEventType` 含 `tool_call_scheduled/started/progress/result/error`（L135-L139）、`turn_complete/turn_error`（L110-L111）、`background_task_started/updated/completed`（L141-L143）、`permission_denied`（L151）、`interrupt/cancel`（L181-L182）。`ToolCallResultPayload`/`ToolCallErrorPayload`（L936-L953）携带 `toolCallId`、`skillMetadata`（仅 telemetry 用，注释明示「不进入模型可见的 result.content」）、`pluginId`；`ToolCallStartedPayload`（L905-L917）携带 `toolCallId/startedAt/readOnly`。`ErrorPayload`（L1212-L1225）含 `code/type/message/underlyingErrorMessage/stack/data`——**这些字段携带原始错误正文，不可直接出网**，仅作采集输入。
- A2【已实测】可聚合失败事实的现成范式。同文件 `ErrorAttribution`（L1227-L1247）注释明示「只承载可聚合的失败事实，不包含请求正文、凭据、URL 或监控策略」，字段含 `source(provider/runtime/tool/network)、errorPhase、exceptionKind、statusCode、providerErrorCode、retryable`——审计遥测的运行错误事件按同一纪律设计（白名单内只保留此类可聚合字段）。
- A3【已实测】真实调用证据归并范式现成。`tool.call.started`/`tool.call.completed` 协议事件按 `toolCallId` 统计真实执行、排除权限等冗余事件的解析范式已有测试先例（拆项 6 盘点 6，`E:\ZCode\packages\desktop\test\remoteToolExecutionEvidence.test.ts`；FR-5 明确复用）。能力调用证据事件的采集直接采用同款配对逻辑。
- A4【已实测】失败分类固定错误码族现成。`E:\ZCode\apps\zcode-cli\packages\adapters\src\confidential-controller\bootstrap.ts` L16-L27 的 `failureSchema` code 枚举共 10 值：`AUTHORIZATION_EXPIRED / AUTHORIZATION_REJECTED / AUTH_REQUIRED / IDENTITY_CHANGED / CANCELLED / UNAVAILABLE / EXECUTION_FAILED / INVALID_RELEASE / VERSION_CHANGED / CAPACITY_EXCEEDED`——固定码 + 不泄漏内部细节的风格即遥测错误码的铸造风格；总控装配失败类事件的错误码直接取自该码族。
- A5【已实测】多套状态词汇并存、均无台账语义（拆项 6 盘点 4 复核）：会话状态 `zcodeSessionStatusSchema`（`E:\ZCode\packages\shared\src\zcode-protocol-legacy-types.ts` L77-L84：idle/running/waiting/paused/completed/error）；会话任务事实 `CliTaskFacts.lastOutcome`（`E:\ZCode\packages\services\src\task-facts\contract.ts` L15：completed/interrupted/error）；后台任务 `BackgroundTaskStatus` 8 值（session.events.ts L961-L968：running/completed/failed/timed_out/cancelled/spawn_error/lost 等）；回合终态 `TurnResultType`（L650-L657：success/cancelled/error_max_turns/error_max_budget/error_during_execution/error_max_tool_calls）。**结论：遥测生命周期词汇必须是独立投影枚举 + 映射表，不改任何既有 schema、不加语义超载**（§5.1.1）。
- A6【已实测】既有遥测面是模型 API 可观测层，非审计通道。`E:\ZCode\apps\zcode-cli\packages\contracts\src\telemetry\agent-execution.ts`：`TELEMETRY_SCHEMA_VERSION = 6`（L4）、`AgentTelemetryErrorCategory` 11 值（L41-L52：configuration/authentication/permission/rate_limit/timeout/network/provider/parse/cancelled/internal/unknown）、`AgentTelemetryCancellationReason`（L54-L60）、执行上下文含 `sessionId/turnId/actorKind`（L67-L78）；`...\telemetry\index.ts`：`TelemetryIdentitySnapshot`（L226-L229）、`TelemetryResourceContext`（L231-L241，含 `productVersion/cliVersion/installationId/runtimeSurface`）；OTLP 出口在 `E:\ZCode\apps\zcode-cli\packages\telemetry\src\otlp-exporter.ts`（资源属性 `zcode.telemetry.schema_owner: "cli"`，L254）。**边界结论：错误分类词汇可映射复用；`installationId` 是该体系自有的安装标识，CCode 审计遥测的设备标识以中台 M6-R2 服务端下发为准（PRD M6-R2「客户端不可自报或伪造」），不复用 `installationId`，避免两套设备身份。**
- A7【已实测】skill 归因字段缺口。`SkillTelemetryMetadata`（`E:\ZCode\apps\zcode-cli\packages\contracts\src\skills\index.ts` L70-L76）现仅 `name/qualifiedName/pluginId/source`，**无 version/digest**；skill 工具处理器 `recordSkillTelemetryMetadata` 钩子（`E:\ZCode\apps\zcode-cli\packages\core\src\tool\handlers\skill.ts` L88-L93）同构。skillVersion/skillDigest 依赖总控/专家装配记录链路（中台 PRD §4.5 值来源「客户端装配记录」；总控侧由 `ccode-controller-local-skill.md`、专家侧由 `ccode-expert-skills-distribution.md` 承接）——本文只定义消费方式与缺失处置（OQ-A7）。
- A8【已实测】中台认证与请求纪律现成。`E:\ZCode\packages\services\src\confidential-controller\platform-auth.ts` 的 `CcodePlatformAuth`：Bearer token + `tenant-id` 头（L332-L337）、身份三元组 `{tenantId, userId, loginId}`（L188-L192）、`getAccessToken` 到期前 30s 自动刷新（L229-L239）、请求 15s 超时（L322）、响应上限 256KB（L357）、`cache: "no-store"`、`redirect: "error"`（L329-L330）；现有端点仅 `system/auth/*`、`system/tenant/simple-list`（L70、L138-L140、L174）。审计遥测上报复用该认证与请求纪律，**不新增第二套客户端凭据**（对齐 PRD M6-R1）。
- A9【已实测】日志分级纪律。`E:\ZCode\packages\services\src\logger\serviceLogger.ts`：`createServiceLogger(scope)` 提供 debug/info/warn/error 四级；debug 默认仅本地开发运行时打印、生产构建不落盘（L23-L25、L44-L46）。遥测服务自身日志沿用该纪律（§6.8）。
- A10【已实测】审计遥测出网通道不存在。客户端现有中台 HTTP 调用面仅 auth/tenant/authorize/content（A8 + `http-source.ts`，见中台 PRD §4.6）；M4 遥测上报端点中台侧未定（PRD OQ-11）。全仓库无任何遥测上报中台的调用路径——本 spec 为该通道的首次定义。

## 四、架构与数据流（采集 → 白名单脱敏 → 排队 → 上报 → 补传）

```mermaid
sequenceDiagram
  participant E as 事件源（CLI Runtime：SessionEvent 总线 / bootstrap / 认证失败）
  participant C as AuditTelemetryCollector（CLI 侧采集投影器，事件唯一铸造者）
  participant Q as AuditTelemetryQueue（Main 侧持久化队列，唯一出网所有者）
  participant P as 中台 M4 接收端（遥测事件流表）
  participant G as 管理端策略（M5-R3，经中台配置通道下发）

  E->>C: 原始事件（含正文的 ErrorPayload / 事件流）
  C->>C: 铸造：生命周期映射（§5.1.1）+ 归因字段注入（§5.1.3）+ 白名单脱敏（§5.1.5）
  C->>Q: 已脱敏事件（channel=lifecycle|diagnostic，contentFrozen 不可变，commandId 已定）
  G-->>Q: 采样/可见性策略（仅生命周期、关闭诊断、采样率）
  loop 出网调度
    Q->>P: 批量上报（Bearer + tenant-id；每条自带 eventId+commandId）
    alt 受理（含幂等重放返回原结果）
      P-->>Q: 逐条受理状态
      Q->>Q: ACK 出队
    else 网络失败 / 中台不可用 / 超时
      Q->>Q: 留队 + 指数退避（不改写内容、不换 commandId）
    else 限流（M4-R6 错误码）
      Q->>Q: 留队 + 退避降速
    else 拒收：归因缺失 / schema 不识 / 敏感命中（M4-R8 兜底）
      Q->>Q: 本地死信计数，不再重试（§6.5）
    else 认证失败（AUTH_REQUIRED）
      Q->>Q: 暂停出网、队列保留，等重新登录
  end
  Note over Q: 上线 heartbeat / 启动 / 登录成功 / 网络恢复 → 触发队列 flush（补传）
  Note over C,Q: 全链路 fire-and-forget：任一环节失败不回写事件源、不阻塞用户任务
```

数据流硬规则：

1. **单向流**：事件源 → 采集器 → 队列 → 中台。出网结果不回流到事件源；采集与上报永不 await 在用户任务的关键路径上。
2. **脱敏先于入队**：本地队列里保存的**只有**已通过白名单脱敏的投影事件——本地队列本身不得成为敏感数据集（对齐母 PRD L95 对"遥测中"的禁令延伸到本地暂存形态）。
3. **内容冻结**：事件入队后字节不可变；重试/补传重放同一 `commandId` 必须发送同一字节序列（中台 M4-R2「同 ID 异内容拒绝并记审计」的客户端义务）。任何修正需求铸新事件新 commandId，不改写在队事件。
4. **归因注入在铸造时**：采集器从装配记录读取 ccodeRelease/platform/skillVersion/skillDigest 一并写入事件；tenantId 不写入请求体（服务端认证上下文权威，M4-R4）。

## 五、状态所有者与接口

### 5.1 事件模型 schema 要点

#### 5.1.1 任务生命周期事件（task.lifecycle，channel=lifecycle）

- `lifecycleStatus` 枚举（拍板 #1 原文词汇，独立投影枚举，不改 A5 任何既有 schema）：`started | stopped | failed | completed | error`。
- 语义：`started` 任务进入执行；`completed` 正常完成；`stopped` 用户主动停止/中断；`failed` 任务执行链路内的失败终态；`error` 运行环境/系统级异常终止（如总控装配失败、进程异常恢复），区别于任务自身执行失败。
- `subjectRef`：`{ kind: session | background_task | workflow_run | runtime, id }`，`id` 取本地稳定标识（sessionId / backgroundTaskId / runId），为不透明字符串，不含用户内容；同一任务的 started 与终态事件靠 `subjectRef` 关联。
- 映射表（采集器实现依据；歧义项列 OQ-A2）：

| 现有词汇（实测来源） | 遥测 lifecycleStatus |
| --- | --- |
| `TurnResultType: success`（session.events.ts L652） | completed |
| `TurnResultType: cancelled`（L652，注释明示用户主动中断） | stopped |
| `TurnResultType: error_max_turns / error_max_budget / error_during_execution / error_max_tool_calls`（L654-L657） | failed |
| `CliTaskFacts.lastOutcome: completed / interrupted / error`（task-facts/contract.ts L15） | completed / stopped / failed |
| `BackgroundTaskStatus: completed / cancelled / failed / timed_out / spawn_error / lost`（session.events.ts L961-L968） | completed / stopped / failed / failed / failed / stopped（`lost` 归并待评审，OQ-A2） |
| `zcodeSavedWorkflowRunStatusSchema`（拆项 6 盘点 4：pending/running/completed/errored/stopped） | started / started / completed / failed / stopped |
| bootstrap 失败码族（A4）落到的运行异常 | error |

#### 5.1.2 运行错误事件（runtime.error）

- `errorCode`：固定错误码（铸造风格对齐 A4 码族；总控装配/中台链路错误直接采用 `ConfidentialControllerError` 码值；模型/网络/工具类错误从 `AgentTelemetryErrorCategory`（A6）与 `ErrorAttribution.source/reason`（A2）映射为可聚合码）。
- `sanitizedSummary`：脱敏摘要，≤512 字符；铸造时执行：凭据/密钥正则剔除与打码（模式库对齐中台 M3-R3 第一层「密钥/凭据正则模式库」的客户端子集）+ 高熵段打码 + 截断。
- 可选聚合字段（白名单内）：`errorPhase`、`exceptionKind`（复用 `ModelApiErrorPhase`/`ModelFailureExceptionKind` 词汇，`contracts/src/telemetry/index.ts` L53/L62）、`retryable`、`statusCode`。**不含** `ErrorPayload.message/detail/underlyingErrorMessage/stack/data` 原文。
- 堆栈摘要（`stackSummary`：仅函数名 + 文件基名 + 行号、前 N 帧 + 总帧数，不含目录路径全文）与上下文片段（turnPhase、工具名等结构化字段，非消息文本）属**诊断细节**，走 diagnostic 通道（拍板 #2），批量/采样上报。

#### 5.1.3 能力调用证据事件（capability.evidence）

- 字段：`toolCallId`、`toolName`、`resultStatus: started | completed | failed | denied`、`durationMs`（取自 `ToolCallResultPayload.duration`）、`skillMetadata`（现有四字段 + version/digest，A7 缺口）、`pluginId`、`subjectRef`（关联所属任务）。
- 采集配对逻辑按 A3 范式（`tool.call.started`/`tool.call.completed` 按 toolCallId）；`denied` 映射 `permission_denied`（L151）。
- **只含元数据**：工具 `input`、`result.content`、`display` 一律不出现在遥测事件中（对齐中台 PRD §4.4「能力调用证据引用……不含响应正文」）。
- 二期衔接：本事件族与拆项 6 FR-5「必须能力已实际执行」判定同源（都按 toolCallId 归并真实执行），但遥测侧只做上报，不做门禁判定（§7）。

#### 5.1.4 事件通用信封（对齐中台 PRD §4.4）

```
{
  schemaVersion: number            // 显式携带，N-1 兼容义务归服务端（M4-R5）
  eventId: UUID                    // 事件唯一标识
  commandId: UUID                  // 幂等键；唯一键 = 租户 + 用户 + commandId（M4-R2）
  occurredAt: 带时区时间           // 合法时区解析，不以字符串正则替代日期解析（provenance-ledger L24 同款纪律）
  channel: "lifecycle" | "diagnostic"
  type: "task.lifecycle" | "runtime.error" | "capability.evidence"
  payload: <按 type 的白名单严格 schema>
  attribution: { ccodeRelease, platform, skillVersion, skillDigest }   // §5.1.5
}
```

#### 5.1.5 归因字段（拍板 #5，与中台 PRD §4.5 逐一对齐）

| PRD §4.5 字段 | 客户端值来源（实测锚点） | 说明 |
| --- | --- | --- |
| ccodeRelease | `TelemetryResourceContext.productVersion`（A6）同源的产品版本 | 客户端自报，服务端校验格式 |
| skillVersion + skillDigest | 客户端装配记录（总控：controller-local-skill spec 的本地锁定版本；专家：expert-skills-distribution 的缓存 version/digest） | 依赖 A7 缺口补齐；缺失处置见 OQ-A7 |
| platform | `process.platform` 归一：win32→windows、darwin→macos、linux→linux | 值域对齐 PRD §4.5 |
| tenantId | **不写入请求体**；随既有 `tenant-id` 头 + Bearer 认证由服务端从认证上下文取（A8；M4-R4「不接受请求体覆盖」） | 客户端义务=用已认证会话上报，不自报租户 |
| （拍板 #5 另提「设备标识」） | 中台 M6-R2 服务端分配下发 | PRD §4.5 必带组**未含** deviceId；P0 未落地时是否必带 → OQ-A1，不代拍板 |

缺失归因（ccodeRelease/skillVersion/skillDigest/platform 任一缺失）的事件：服务端将拒绝或入死信区并计数（PRD §4.5 尾段）。客户端侧策略：铸造时归因不完整仍入队，但标记 `attributionIncomplete: true`，出网前由本地计数可回读——是否直接免出网待评审（OQ-A7）。

#### 5.1.6 负面清单（绝不外传；采集器白名单的补集即此清单）

以下内容**任何通道、任何字段、任何形态**（含摘要、截断、编码、转义后）不得出现在出网 payload：

1. **对话内容与消息正文**：user/assistant/system message content、turn input/response 正文（`TurnStartedPayload.input`、`TurnCompletePayload.response`、`UserMessagePayload.content` 等）。
2. **凭据**：密码、access/refresh token、API key、`Authorization` 头、中台凭据存储内容（platform-auth 存储的 refreshToken 等）。
3. **受控正文**：总控 skill 正文（stub 与完整正文、加密 release payload、systemPrompt）、已加载 skill 正文（含专家 skill 缓存正文）。
4. **私有接口响应正文**：中台/私有通道（authorize/content 等）的响应体。
5. **工具输入/输出正文**：工具 `input`、`result.content`、`display`、MCP 响应正文。
6. **workspace 本地身份**：`workspacePath`/`workspaceIdentity` 全文（可能含用户名等本地路径事实；PRD §4.5 归因组不含此字段，一期排除；二期台账如需 → 另行拍板，OQ-A10）。
7. **原始错误全文**：`ErrorPayload.message/detail/underlyingErrorMessage/stack/data` 原文（只允许 §5.1.2 的脱敏摘要与聚合字段）。

白名单实现纪律：每个事件 type 一份 strict schema（zod `.strict()`，先例：bootstrap.ts `z.strictObject`）；序列化时未知字段丢弃而非透传；新增字段必须走 schemaVersion 递增（规则归中台/双方联合，PRD OQ-7）。

### 5.2 队列与上报的所有者

- **采集器（AuditTelemetryCollector）**：CLI runtime 进程内组件，订阅 SessionEvent 总线（A1）与 bootstrap/认证失败信号（A4/A8），是遥测事件的**唯一铸造者**（归因注入、生命周期映射、白名单脱敏都在此完成）。只读事件源，无出网能力。
- **队列与出网（AuditTelemetryService，Main 侧）**：持久化磁盘队列与上报调度归桌面 Main 进程内的服务层组件（与 confidential-controller 服务族同层，A8），是**唯一出网所有者**：持有上报端点配置、退避/heartbeat 调度、认证复用 `CcodePlatformAuth.getAccessToken`。CLI→Main 的事件传递走既有 stdio 协议新增受限消息类型（严格运行时校验、有界载荷，对齐 provenance-ledger L36 私有进程协议纪律）。standalone CLI（无 Main）形态一期不做出网，采集事件本地暂存等待桌面接管 → OQ-A6。
- **队列持久化纪律**：按登录身份隔离存储；跨重启保留；FIFO；容量上限（条数与字节数）超限时淘汰最老事件并**本地计数** `droppedOldest`（不静默丢弃、零记录可查），计数本身作为一条低频 diagnostic 事件补报。注销/切换身份不清空队列（补传以认证后的身份上下文为准）。
- **commandId 纪律**：铸造时生成、随事件持久化；出队以中台逐条受理状态为准（幂等重放返回原结果视同受理）。

### 5.3 与中台 M4 的接口对齐（逐条）

| 中台条目 | 客户端行为（本 spec 落点） |
| --- | --- |
| M4-R1 两张表（遥测事件流 + 任务台账） | 本 spec 只对接**遥测事件流表**；任务台账表客户端入口归 provenance-ledger 体系（§7），不混用通道 |
| M4-R2 幂等命令 ID（唯一键=租户+用户+commandId；同 ID 同内容幂等、同 ID 异内容拒+审计） | §4 规则 3（内容冻结）；断网补传重放安全由此成立（PRD S7） |
| M4-R4 租户从认证上下文 | §5.1.5：tenantId 不入请求体，Bearer + tenant-id 头 |
| M4-R5 schema N-1 + 显式 schemaVersion | 信封必带 schemaVersion；客户端只发自己 schemaVersion 的事件，未知响应版本按错误处理不重试同批 |
| M4-R6 限流 + 采样 | §6.3/§6.4：限流错误码→退避降速；采样策略管理端配置客户端执行 |
| M4-R7 通道分类（生命周期准实时、诊断批量） | `channel` 字段 + 两档调度（§6.1） |
| M4-R8 只收白名单元数据 + 服务端敏感过滤兜底拒收 | §5.1.5 白名单/负面清单在前；服务端兜底拒收（敏感命中/schema 不识）→ 客户端死信计数不重试（§6.5），避免与兜底过滤死循环 |
| §4.4 事件通用头（schemaVersion/eventId/commandId/occurredAt/归因组） | §5.1.4 信封逐字段对应 |
| §4.5 归因字段 | §5.1.5 对齐表（deviceId 差异 → OQ-A1） |
| §4.6 既有端点演进不破坏 | 上报端点为新增端点；复用既有 Bearer + tenant-id 体系与请求纪律（A8），不动 authorize/content |

端点命名、路径、批量格式（逐条 vs 批量会话清单 + N 条，PRD §4.3 回流侧有批量先例）、批量条数上限、限流错误码具体值：**待中台定**（PRD OQ-11），客户端按「批量 POST、逐条自带 eventId/commandId、响应逐条受理状态」的语义假设做抽象，端点细节以配置注入。

## 六、行为细节

1. **两档频率（拍板 #2）**：`lifecycle` 通道准实时——分钟级 flush（目标 ≤5 分钟或队列满 N 条先触发，具体常数待评审）；`diagnostic` 通道批量——更低频窗口（15-60 分钟级或会话退出/进程退出 flush）+ 采样。两通道独立计数、独立退避，互不拖累（诊断积压不推迟生命周期上报）。
2. **断网与离线（拍板 #3）**：网络失败、中台不可用、超时 → 留队 + 指数退避（上限封顶）；**不阻塞用户任务**——采集 fire-and-forget，上报调度独立于任务执行路径，任何上报异常对事件源零副作用（对齐 AGENTS「不能用超时掩盖同步问题」：上报慢/失败不注入任务时序）。
3. **heartbeat 补传（拍板 #3）**：触发源 = 进程启动、登录成功、网络恢复信号、周期 heartbeat 任一命中即 flush 队列。heartbeat 的载体（独立轻量心跳请求 vs 复用既有启动/更新检查轮询点）与间隔待定（OQ-A5）；现有 heartbeat 先例仅本地锁心跳（`packages/services/src/bots/channelRuntime.ts` L9 `BOT_RUNTIME_LOCK_HEARTBEAT_MS`），非网络心跳，不复用其语义。
4. **限流与采样配合（M4-R6/M5-R3）**：服务端限流错误码 → 本通道退避并降发送速率（不弃数据）；管理端策略（租户级"仅生命周期/关闭诊断上报"、采样率）经中台配置通道下发生效，客户端在**入队前**按策略决定取舍，被采样/策略丢弃的事件仅本地计数（`droppedSampled`/`droppedByPolicy`），不传明细；策略未下发时用客户端默认值（lifecycle 全量、diagnostic 默认采样率，常数待评审）。
5. **服务端拒收处置**：归因缺失、schema 版本不识、M4-R8 敏感兜底命中 → 该条移入本地死信计数（`deadLettered` 按 reason 分类），**不再重试**；同批其余条目不受牵连。
6. **认证失败处置**：`AUTH_REQUIRED` → 暂停出网、队列保留、等待重新登录（登录成功即 heartbeat 触发源）；认证丢失不清队列、不视为不可恢复错误（对齐 A8「网络异常不能失去可重试凭据」语义）。
7. **可见性（拍板 #4）**：默认静默后台执行、不打扰用户（无弹窗、无阻塞、无任务界面侵入）；**2026-10-22 A3 拍板：甲案（静默后台）为默认口径**；乙案（明示低调）为管理端策略选项（M5-R3 租户级配置项），客户端只执行策略位（明示的 UI 形态属产品层另行设计）。
8. **日志纪律（A9 一致性）**：遥测服务自身日志用 `createServiceLogger("audit-telemetry")`；`debug` 记录原始事件与出网 payload（仅本地开发，生产不落盘；payload 已是脱敏后形态）；`info` 记录生命周期事件（flush、补传完成、策略生效）；`warn` 记录可恢复异常（退避、限流、队列淘汰）；`error` 仅用于队列存储损坏等不可恢复错误。凭据与负面清单内容不入任何级别日志。
9. **时间纪律**：`occurredAt` 由采集器在铸造时以带时区时间写入；补传不改写时间（服务端另行记录提交时间，provenance-ledger L24 同义）。

## §6A 诊断 bundle 自动上传（2026-10-22 A2 拍板，v1.1 增补）

- **拍板**：A2 已批准（2026-10-22）诊断 bundle 自动上传；中台侧承接见 `E:\ZCode\docs\prd\ccode-dataplatform-prd.md` M4-R9。
- **载荷**：复用既有反馈诊断 bundle——当天的诊断日志、CLI 配置安全投影、当天模型调用轨迹；已自动脱敏；**不含数据库（硬红线）**。实现锚点：bundle 构建在 `packages/services` 侧 `createFeedbackDiagnosticArchive`（`E:\ZCode\packages\desktop\src\main\exportLogs.ts` 调用，导出管线文档 `E:\ZCode\docs\feedback-log-export-alignment.md`）；字段级清单以该实现实读为准（本节未逐文件核验，标注待实测）。
- **触发两档**：①错误触发——任务 `failed`/`error` 终态、进程崩溃恢复、总控装配失败时，采集器自动打包**当天** bundle 上传；②每日一次常规摘要（与每日触发窗口对齐）。
- **通道与载荷形态**：走 diagnostic 批量通道；bundle 为存档文件（zip），**以引用入队**（存档 digest/size/traceId 记入事件），不由事件负载内联携带全文；存档文件经 uploader 的独立附件上传端点上传（端点待中台 M4 定，OQ-A3）。上传幂等键 = 租户 + 存档 digest。
- **TraceID 关联**：bundle 上传必带 traceId；用户主动反馈入口保留，凭 TraceID 与已上传 bundle 自动关联（用户只补描述）。
- **策略与可见性**：默认开启（A2）+ 管理端策略可关/可调采样（M5-R3）；可见性按甲案静默（2026-10-22 A3 拍板）。
- **红线与兜底**：不含数据库为硬红线；bundle 内容沿用既有反馈脱敏管线，客户端不做二次过滤，中台入口按 M4-R8 兜底过滤+短保留。
- 新增开放问题：**OQ-A12** 每日摘要窗口与 bundle 体积上限；**OQ-A13** bundle 存档的本地保留期与清理；**OQ-A14** 附件上传端点形态与断点续传（大包）是否需要。

## 七、与任务台账体系的边界（二期衔接）

- 一期（本 spec）：轻量遥测 → 中台**遥测事件流表**。只回答"发生了什么"（生命周期、错误、能力调用事实）。
- 二期（`ccode-provenance-ledger.md`，现状「设计中，未实现、未部署」L3）：任务级台账 → 中台**任务台账表**（submitted→accepted/rejected→closed 状态机、expectedRevision、supersedesRecordId、证据核验、Skill 发布门禁），及拆项 6 的关闭门禁与压力测试封装。
- 衔接点：能力调用证据事件与二期「必须能力已实际执行」判定同源（A3/FR-5，按 toolCallId 归并）；`eventId/commandId` 幂等语义与台账命令幂等语义同构（M4-R2 唯一键同式）；遥测事件可作为台账「来源上下文」的旁证输入，但**遥测送达不等于台账关闭**，缺证据不得标完成的门禁只在二期台账体系内执行。本 spec 不为二期预建状态字段（对齐拆项 6「现有状态字段不加语义超载」）。

## 八、验收场景（客户端侧判据，均可回读；服务端侧对应 PRD S7/S9/S10）

普通任务最小接线（2026-10-26）：Agent 服务在 live 事件去重后、UI 订阅广播前，只提取 `turn.started` 与非 compact 的 `turn.completed`/`turn.failed` 中的任务 ID、turn ID、结果，经受限 Host→Main 消息交给 Main 采集器；因此零个或多个 UI 订阅都只铸造一次。Main 在开始事件捕获已验签锁定总控的 `skillVersion`/`skillDigest`，终态只使用该 turn 的捕获值；开始事件或锁定副本缺失时不猜测归因、不上报。`ccodeRelease` 来自产品构建元数据。`instanceId` 复用本地持久 `deviceMid` UUID，仅供统计分组，属于未验证设备标识，不作设备注册或身份凭证。队列按租户与用户隔离，身份切换时旧运行时先退出，旧队列只能用原账号凭据发送；Main 是队列和周期上传的唯一所有者，成功冲刷后继续排定下一窗口。

1. **AT-1 白名单剔除凭据样本**（拍板 #1；对应 PRD M4-R8）：构造含 API key 形 token（如 `sk-` 前缀高熵串）的 `ErrorPayload.message` 样本驱动一次运行错误。判定：出网请求体（本地队列 dump 或测试代理抓包）序列化文本对该 token 全文检索零命中；事件仅含 errorCode 与 sanitizedSummary，且 sanitizedSummary 中该 token 被打码/剔除。
2. **AT-2 断网补传幂等**（拍板 #3；对应 PRD S7 客户端侧）：断网期间产生 10 条 lifecycle 事件并本地排队，恢复后按入队序补传，随后人为重放同一批次（同 commandId 同字节）。判定：中台事件流表该批恰好 10 行（去重生效）；客户端队列出队数与受理数一致，无第二条重试队列。
3. **AT-3 负面清单全文检索**（§5.1.6）：同一会话内产生含对话正文、工具 result content、已加载 skill 正文的样本。判定：该会话全部出网 payload 对上述正文片段（各取 ≥32 字节特征串）全文检索零命中。
4. **AT-4 失败不阻塞用户**（拍板 #3）：模拟中台不可用（超时/连接拒绝）期间执行一个正常任务。判定：任务正常完成（turn 终态照常产生）、任务耗时不受上报调度影响（无 await 注入）；事件留存队列，恢复后补传成功；再模拟队列写失败（磁盘错误注入），会话执行不受影响，仅本地 warn 日志与失败计数可回读。
5. **AT-5 两档通道分类**（拍板 #2；对应 PRD S7 后半）：同一测试窗口内产生 lifecycle 与 diagnostic 事件各若干。判定：出网请求按 channel 分批，中台收到的事件归类可回读（lifecycle 通道延迟 ≤ 分钟级目标，diagnostic 走批量窗口）；诊断通道积压不推迟 lifecycle 通道 flush（两通道时间线可区分）。
6. **AT-6 归因字段齐备**（拍板 #5；对应 PRD S9）：抽样（或全量）校验出网事件。判定：每条事件 attribution 组 ccodeRelease/platform/skillVersion/skillDigest 四要素齐备（tenantId 由服务端认证上下文补全，请求体零 tenantId 字段）；缺失或 `attributionIncomplete` 条目有本地计数可回读。
7. **AT-7 可见性策略执行**（拍板 #4；对应 PRD S10 客户端侧）：管理端对测试租户配置「关闭诊断上报」并下发。判定：策略生效窗口内客户端诊断事件出网数为 0（本地 `droppedByPolicy` 计数与之相等），lifecycle 事件不受影响；全程无用户可见弹窗/阻塞（静默执行）。
8. **AT-8 重启不丢且 commandId 不变**：事件入队后强制重启进程。判定：队列恢复完整、在队事件字节与 commandId 与重启前一致（本地 dump 可比对）；补传后中台无重复行（与 AT-2 判据合用）。
9. **AT-9 拒收进死信不重试**（§6.5）：构造归因缺失事件与（由测试中台模拟的）M4-R8 敏感兜底拒收响应。判定：两类事件进入本地 `deadLettered` 计数（按 reason 分类）且不再出现在后续出网批次；同批合法事件正常受理。
10. **AT-10 生命周期映射正确**（§5.1.1）：分别驱动正常完成任务、用户停止任务、构造失败终态（如 error_max_budget）与总控装配失败。判定：出网事件 lifecycleStatus 依次为 completed / stopped / failed / error，映射表断言在测试报告中逐条可回读。

## 九、开放问题（不代拍板）

- **OQ-A1【待拍板 + 待中台】** 设备标识：拍板 #5 提「租户/设备标识」，中台 PRD §4.5 必带组仅含 tenantId（服务端权威）；deviceId 依 M6-R2 由服务端分配（P0 依赖）。一期是否把 deviceId 列入必带、未下发时缺省还是不发，待拍板。
- **OQ-A2【待评审】** lifecycle 五值映射细则：`BackgroundTaskStatus.lost`→stopped 还是 failed、`timed_out`→failed 的归并、`error` 与 `failed` 的边界（运行环境异常 vs 任务执行失败）需评审确认（§5.1.1 映射表的待定项）。
- **OQ-A3【待中台定】**（继承 PRD OQ-11）上报端点命名/路径、批量格式（逐条 vs 会话清单 + N 条）、批量条数/字节数上限、限流错误码具体值与重试提示格式、心跳端点（若独立）。
- **OQ-A4【待定】**（继承 PRD OQ-7）遥测字段白名单的冻结责任方（中台/双方联合）与 schemaVersion 递增、弃用规则；客户端白名单与服务端白名单的版本协商方式。
- **OQ-A5【待定】** 上线 heartbeat 的载体（独立心跳请求 vs 复用启动/登录/更新检查触发点）与间隔、退避上限、flush 批大小等运行常数。
- **OQ-A6【待评审】** standalone CLI（无桌面 Main）形态：一期是否只采集不出网（暂存等待桌面接管），还是允许 CLI 直连出网（涉及凭据持有边界），需与产品范围确认。
- **OQ-A7【待定】** skill 归因缺失（未装配总控/专家 skill 的普通任务）时：事件标记 `attributionIncomplete` 照常出网（服务端按 §4.5 尾段拒绝/死信）还是本地免出网仅计数；依赖 A7 缺口补齐的排期。
- **OQ-A8【已拍板（2026-10-22，A3=甲案）】**（继承 PRD OQ-3）上报可见性最终口径：**默认静默后台（甲案）**，乙案（明示低调）为管理端策略选项；用户主动查询/导出自己被上报记录的能力仅在租户启用乙案时提供。
- **OQ-A9【待评审】** 本地队列容量上限（条数/字节）、淘汰策略的可见性（droppedOldest 是否补报、何时补报）、队列存储加密要求（登录身份隔离存储的具体形态对齐 `ccode-storage-isolation.md`）。
- **OQ-A10【待拍板】** workspace 身份是否进入遥测/台账归因（一期负面清单排除；二期台账若需要 workspaceIdentity，须先解决本地路径事实脱敏）。
- **OQ-A11【待中台确认】**（继承 PRD OQ-11④）M4 限流阈值与采样维度；客户端默认采样率（诊断通道）与之的关系。
