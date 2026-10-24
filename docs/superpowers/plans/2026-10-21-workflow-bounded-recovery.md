# WF-4 有限模型恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 单写者实现，独立审查；无提交授权。

**Goal:** 工作流模型失败链有界，底层恢复结束后单ask明确失败，禁止Driver无限新turn。
**Architecture:** Adapter拥有请求预算，Core拥有流恢复预算，Engine拥有ask终态。Driver桥接最终错误，不新增重试owner。
**Tech Stack:** TypeScript、Vitest、pnpm；已有隔离工作树。
**Spec:** docs/specs/workflow-bounded-recovery.md

## 全局约束

沿用adapter默认maxAttempts11及既有覆盖；Core10不变；Driver额外恢复0。新档名固定WorkflowFinite（值workflow-finite），专用错误RecoveryExhausted。无墙钟/整ask调用总量承诺；offpeak合法排队豁免不变。无新依赖、无总控装配改动、无全量测试、无提交推送。

## 审查重点

- workflow policy与普通classifier分歧：测试新档保留原workflow分类。
- SingleAttempt fallback优先级、嵌套及tool-side传播：现有Core预算测试补断言。
- 取消/已accept/旧generation回调：测试在撤升级及FIFO结算前过滤。
- A失败B正常：用真实engine/harness局部catch测试；未捕获仍fail run。
- 终态后不再执行工具/模型；不宣称未知副作用回滚。

## Task 1：请求预算与策略分离

Files：contracts/src/model/index.ts；core/src/runtime/methods/model-request-session-type.ts；adapters/src/model/workflow-model-failure-policy.ts；必要retry-budget.ts文档注释。测试core/tests/model-retry-budget.test.ts、adapters/tests/retry-budget.test.ts、workflow-model-failure-policy.test.ts。

- [x] 增加新档有限次数、workflow分类、默认/Unbounded/SingleAttempt不变、nested/tool propagation测试，先运行确认RED。
- [x] 增加ModelRetryBudget.WorkflowFinite并映射workflow taskType；policy选择独立于isUnbounded。预算继续使用现有解析值，不改Core10。
- [x] 运行上述定向测试确认GREEN，核实实际runner覆盖与maxAttempts状态事件；不能只测纯helper。

## Task 2：终止外层重驱并保持实例隔离

Files：bootstrap/src/app/workflow-driver-model-failure.ts、workflow-driver.ts、workflow-driver-types.ts、workflow-driver-helpers.ts（仅删无调用重驱辅助）；dynamic-workflow/src/engine/errors.ts。测试bootstrap/tests/workflow-driver-concurrency.test.ts、workflow-driver.test.ts及必要现有真实engine/harness测试文件。

- [x] 以已冻结33/30无限基线为参照，补新真实Core/Driver 11/10后RecoveryExhausted且无重驱的RED。
- [x] 补真实engine A失败catch/allSettled、B成功保留；旧turn/取消/accepted与后继ask安全断言；长等待不失败。
- [x] 收到最终瞬态错误先确认当前实例/generation及未取消，清本实例状态后askFailed(RecoveryExhausted)；不在释放FIFO后修改共享state。删除重驱timer/attempt/WF3 callback死路径，仅删经引用核实的辅助。
- [x] accepted后保留合法用量/转录处理，settleExchange await后复核generation，不能简单屏蔽全部resolve。保持stop/context/cancel路径合同，检查新错误码序列化/闭集；运行针对性测试GREEN。

## Task 3：文档、独立复核与安全集成

- [x] 同步docs/dynamic-workflow/concurrency.md、相关model/engine合同、旧WF3 spec和authoring错误处理说明；历史基线保留为历史证据，不再写当前无限合同。
- [x] 运行针对性回归、CLI typecheck/lint、architecture。交独立子Agent审代码与spec一致性，修复后复验。
- [x] 主Agent按原仓库最新SHA核对单文件冲突，只集成本次精确增量；不覆盖他人总控/品牌代码，不复制生成物。
- [x] 原仓库pnpm typecheck、pnpm lint、architecture及必要新行为定向复验，记录退出码；客户端E2E/24h soak若未执行明确保持缺口。
本地验收：Task1 105项、Task2 263项定向通过（非去重总数）；原库集成复验7文件137项通过，root typecheck/lint/architecture与CLI typecheck/lint通过。CLI typecheck使用当前进程临时工具PATH完成，Node实际24.16.0与要求24.14.0差异保留。未执行客户端E2E或24小时长时运行。无提交推送。
