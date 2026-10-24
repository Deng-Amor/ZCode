# audit-telemetry

CCode 客户端审计遥测**基础层**（docs/specs/ccode-audit-telemetry.md，2026-10-22 定稿）：事件模型 strict schema、生命周期映射纯函数、白名单脱敏投影器、按登录身份隔离的磁盘 JSONL 队列、上报器端口与策略位。不含网络实现、不订阅 CLI 事件总线、不做 Main 进程集成（后续卡）；不复用既有模型 API 遥测（apps/zcode-cli/packages/telemetry/）的出口与 schema。

- 事件三类 + 信封：`schemaVersion/eventId/commandId/occurredAt/channel/type/payload/attribution`，全部 zod `strictObject`（未知字段在 strict parse 处失败、在序列化投影处丢弃）；tenantId 不入请求体（服务端认证上下文补全，M4-R4）。
- 生命周期映射（lifecycle.ts）是独立投影枚举，不改任何既有 schema；输入词汇为本地镜像联合（权威定义在 CLI contracts 与 task-facts，services 不反向依赖上层）；未知词汇返回 undefined。`BackgroundTaskStatus.lost → stopped` 按 spec 表值实现，归并待评审（OQ-A2）。
- 脱敏（sanitizer.ts）：原始 ErrorPayload 只产 sanitizedSummary（打码 JWT/`sk-`/Bearer/高熵串 + 空白折叠 + ≤512 截断）与可聚合字段；负面清单其余 6 类由字段集结构性排除。
- 队列（queue.ts）：单所有者磁盘 JSONL；身份 key=tenantId+userId（loginId 不参与，注销/切换不清队列）；FIFO；双上限淘汰最老并计 `droppedOldest`，淘汰经注入 `mintOverflowEvent` 补报一条低频 `runtime.error`(AUDIT_QUEUE_OVERFLOW, diagnostic) 计数事件，队列内同时至多一条未 ACK 补报；内容冻结——入队时白名单投影 + 固定键序序列化一次，落盘字节即出网字节，同 commandId 同字节重放幂等、异字节拒绝计数；重启恢复丢弃撕裂/损坏行并计数、原子重写；ACK 以中台逐条受理为准（幂等重放视同受理）。写操作经内部 promise 链串行，异步 IO，临时文件 + 原子替换。
- 策略位（policy.ts）：入队前取舍；lifecycle 默认全量、diagnostic 默认采样 0.1（OQ-A11 待评审），租户策略可关；`droppedByPolicy/droppedSampled` 只增计数；可见性默认 silent（2026-10-22 A3 甲案拍板），announced（乙案）保留为管理端策略位。
- 上报端口（uploader.ts）：注入接口无网络实现；outcome 分支 accepted/rejected(死信不重试)/rate-limited/retryable-failure/auth-required 对应 spec §4/§6 行为。
- 模块登记待补：本目录创建时 architecture-policy.yaml 处于在途未提交修改，adopt 待该文件收敛后执行（module.ts 注释附命令）。
