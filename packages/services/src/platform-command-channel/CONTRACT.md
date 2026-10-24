# platform-command-channel

CCode 客户端**服务端指令/订阅通道基础层**（中台 PRD v0.2.1 §3.7 M7 / §4.7，任务卡 20261022-C4）：指令/通告信封 strict schema、验签端口、策略门、幂等命令存储（磁盘）、处理核心 `processEnvelope`、通告分发端口与本地审计钩子。**不含**网络 transport（端口注入）、验签实现与密钥管理、三类指令执行体、总控更新器/专家目录刷新接线、Main 装配（后续卡）。

- **信封两段式 strict schema**（schema.ts）：基础信封（envelopeVersion=1 / type 任意非空字符串 / params 对象 / issuedAt+expiresAt 带时区 / signature / commandId·noticeId UUID 可选）放行未知 type；已知 6 类型（3 通告 + 3 指令）再按 type 分支全量 strict 校验（通告 params=version/digest/seq 不含正文；指令 params=scope，chat=sessionId|timeRange、其余=timeRange）。未知字段一律 MALFORMED；未知 type 穿过 schema 以便在验签/过期之后判 UNKNOWN_TYPE（S11-d）。
- **处理管线**（processor.ts，顺序为任务卡拍板口径）：schema（MALFORMED）→ 验签（INVALID_SIGNATURE）→ 过期（EXPIRED，到达即失效；先于幂等命中——过期重放回 EXPIRED）→ 类型白名单（UNKNOWN_TYPE，双保险）→ 策略门（POLICY_DISABLED）→ scope 校验（SCOPE_INVALID：from<to、时窗≤maxTimeRangeMs 默认 7 天、sessionId 长度≤256 且无控制字符、chat 至少一个限定）→ 幂等检查（重放返回冻结原字节）→ 执行端口 → executed(resultRef)。响应固定键序序列化；同 commandId 重放字节一致。
- **通告路径**：schema → 验签 → `CommandChannelNoticeSink.dispatch` → dispatched。不做过期/策略/幂等（按 seq 补取是通道义务 M7-R1，版本单调性归下游所有者）。
- **策略**（policy.ts）：`CommandChannelPolicy` = 通道总开关 + 按指令类型开关 + visibility（默认 silent，2026-10-22 A3 甲案拍板：不产生用户可见副作用）。默认值：通道开、pull_run_logs/pull_skill_usage_stats 开、**pull_chat_logs 默认关**（P2：OQ-12 合规确认后启用）。两类关闭都映射 POLICY_DISABLED。经 `getPolicy()` 提供者注入，policy.update 通告生效后动态读数。
- **幂等存储**（store.ts）：按登录身份（tenantId+userId）隔离的 JSONL；只冻结 executed 结果字节，同 commandId 不改写；无容量淘汰（有意：淘汰破坏 S11-b 幂等判据，容量策略留后续卡）；重启恢复丢弃撕裂/损坏行并计数 + 原子重写；写操作串行链、异步 IO。
- **端口**（contract.ts，全部注入）：`CommandChannelSignatureVerifier`（输入基础信封形态）、`CommandChannelExecutor`（返回 resultRef，抛错=非终态不冻结）、`CommandChannelNoticeSink`、`CommandChannelAuditSink`（执行/拒绝/分发终态留痕；sink 抛错降级 warn 不阻断）、`CommandChannelCommandStore`。
- **审计事件族**：envelope.rejected（MALFORMED/UNKNOWN_TYPE：家族不可知）、command.executed / command.rejected、notice.dispatched / notice.rejected。
- 常数待中台对齐：maxTimeRangeMs（默认 7 天）、maxSessionIdLength（默认 256）。
