# 回执：CCode 开发批次2c（集成接线：调度器/roots/数据源/组合根，2026-10-23）

- 回执性质：总控汇总回执（批次2c：C10 遥测调度器 / C8R roots+数据源 / C9R2 组合根；全部经 codex 通道——本地线程额度 2026-10-26 22:46 前耗尽）
- 台账行号：E:\ZCode\docs\prd\总控台账.md L61-L71（派工/取消/改派/验收/收口）
- 日志落盘路径：本文件 E:\ZCode\docs\prd\回执-ccode-dev-batch2c-20261023.md；codex 卡目录 C:\Users\Administrator\.zcode\workspace\default\codex-task-cards\ 下 2026-1023-02、2026-1023-03、2026-1023-04 三卡各含任务卡与回执
- 池行号：不适用（非清单池任务）

## 结果

验收：批次2c 三项全部交付，总控终验（2026-10-23 08:59 实跑）——vitest 两轮合并 26 文件 187 测试全绿（首轮通配参数未展开漏跑 12 文件，显式补跑 87 条后合计），`pnpm architecture:check --changed` 0 违规，`pnpm exec tsc -b packages/services` 零错误：

- C10：E:\ZCode\packages\services\src\audit-telemetry\upload-scheduler.ts 两档 flush/五分支 outcome/退避降速/认证暂停/dispose 等待（fake timers；29 条模块测试含总控独立复跑）。
- C8R：E:\ZCode\packages\services\src\skill-reflow-upload\roots-provider.ts（语义锚定 adapters roots.ts 的回流专用实现）+ E:\ZCode\packages\services\src\platform-command-channel\run-logs-source.ts（只读行时间过滤分页）+ stub-sources.ts（chat-logs 按 OQ-12 门控、skill-usage 按存储未落地，均 NOT_COLLECTED 如实占位）。
- C9R2：E:\ZCode\packages\services\src\ccode-platform-runtime\ 组合根七件套（四模块装配/生命周期/聚合状态面）；总控补写 E:\ZCode\packages\services\test\ccodePlatformRuntimeLifecycle.test.ts 4 条生命周期用例。

副作用同句写明：新代码全部为未跟踪文件；E:\ZCode\architecture-policy.yaml 追加 ccode-platform-runtime 注册（requires 由总控手工对齐 module.ts，adopt 工具不回填，已留注释）；audit-telemetry/index.ts 与 platform-command-channel/index.ts 补 scheduler/long-poll/executors 公开导出；未执行任何 git 提交/推送。

## 异常

1. 本地线程额度耗尽（GLM 套餐周/月上限，2026-10-26 22:46 重置）——C8 首派失败作废，本批全部改经 codex（其额度独立存活），三卡均三分开合格回执。
2. C9 两次正确停手暴露总控两处同型遗漏：模块落盘后未及时补 index 公开导出（long-poll/executors、scheduler 两次）；卡内"禁碰 M 文件"与"需跑 adopt"自相矛盾（codex 台账 20261016-01 老教训重犯）——均已修复并回写流程。
3. C9R2 的完整装配冒烟（真工厂+fake fetch 串联四模块）未做（deps 为注入骨架），列下一批集成卡首项。

## 处置

- 架构 requires 对齐、生命周期测试补写由总控直做并复验；chat-logs/skill-usage 占位的门控依据（OQ-12/统计存储未落地）已在代码注释与台账留痕。
- 设计债清单更新：SkillRoot 类型迁 shared 完成roots 收敛、chat-logs 的 CLI 侧导出路径设计（批次3 或后续）。
- 批次2c 收口行入台账，本回执随台账过校验。

## 证据

- 模块：E:\ZCode\packages\services\src\audit-telemetry\upload-scheduler.ts E:\ZCode\packages\services\src\skill-reflow-upload\roots-provider.ts E:\ZCode\packages\services\src\platform-command-channel\run-logs-source.ts E:\ZCode\packages\services\src\platform-command-channel\stub-sources.ts E:\ZCode\packages\services\src\ccode-platform-runtime\runtime.ts
- 测试：E:\ZCode\packages\services\test\ 下 auditTelemetryUploadScheduler skillReflowRootsProvider platformCommandChannelRunLogsSource platformCommandChannelStubSources ccodePlatformRuntimeLifecycle 等新文件
- 注册与导出：E:\ZCode\architecture-policy.yaml E:\ZCode\packages\services\src\audit-telemetry\index.ts E:\ZCode\packages\services\src\platform-command-channel\index.ts
- 调度台账：E:\ZCode\docs\prd\总控台账.md

## 自判项（待复核）

- C9R2 组合根为注入骨架（deps 全注入），桌面 Main 的真实装配（真工厂+真 token provider+index.ts 一行接法）留批次3；本批组合根验证止于生命周期与契约面——此拆分判断待用户复核。
