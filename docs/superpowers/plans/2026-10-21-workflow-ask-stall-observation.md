# Workflow 单 ask 停滞观察 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 主 Agent 已选择子 Agent 实施，独立审查代替用户流程批准；不提交。

**Goal:** 单 ask 持续模型重试 20 分钟时，主 Agent 收到可定位通知，其他 ask 成功不屏蔽它。

**Architecture:** Driver 按实例拥有时钟，Engine 只记录 node-stalled，复用既有 RunProgress 到父会话普通文本通知链。保留 run-stalled 与旧通知合同，不扩展闭集通知 kind，不冒用 run 的 stall 元数据。

**Tech Stack:** TypeScript、既有 Vitest 假时钟；无新依赖。

**Spec:** `docs/specs/workflow-ask-stall-observation.md`。

## Global Constraints

- 检测与通知是一个最小交付，不把内部时钟单独宣称完成。
- 阈值 1,200,000 ms，每实例每段一次；保留全 run 时钟。
- 不自动重跑/取消、不增加纯工具超时、不新增 UI 交互。
- 不改当前 confidential-controller/branding dirty；若接口需更新 dirty 文件，由主 Agent 合并。
- 不提交、推送、部署，不跑全量测试。实施使用隔离工作树 `C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode`；主 Agent 先复制当前二开 dirty 快照及本任务文档，再核对基线。不能用纯 HEAD 冒充当前二开源码，不在原 checkout 并发实现产品代码。

## Review Focus

- 同 actor 下一实例及晚到异步状态不能重新激活旧钟。
- turn 与工具侧模型并发仍归本 ask；其他 ask 成功不能归零。
- node-stalled 不应被投影误算进度、节点迁移或 run 停滞。
- 原 run-stalled payload、文本和 UI 判别保持兼容。
- 通知入口畸形身份/时间不抛错，完整身份不能被静默截断。

## Task 1：实例观察到主 Agent 通知的完整垂直交付

**Files:**

- Modify: `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver.ts`、`workflow-driver-concurrency.ts`、`workflow-driver-types.ts`（仅需要时）。
- Modify: `apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts`、`engine.ts`、`index.ts` 与 `src/index.ts`。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-run-progress.ts`、`core/src/runtime-task/notification.ts`。
- Modify: `apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts`（既有 sink 转发）。
- Test: `apps/zcode-cli/packages/dynamic-workflow-runtime/tests/provider-stop.test.ts`（真实 harness → engine journal）、`bootstrap/tests/dynamic-workflow-run-roster.test.ts`（只观察回归）；`bootstrap/tests/workflow-driver.test.ts` 和 `workflow-driver-seat-gate.test.ts` 仅适配 sink 新成员。
- Inspect/protect: `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-roster-events.ts`；只有测试发现事件处理错误才修改。
- Test: `apps/zcode-cli/packages/bootstrap/tests/workflow-driver-concurrency.test.ts`、`apps/zcode-cli/packages/dynamic-workflow/tests/engine/engine-concurrency-observations.test.ts`、`apps/zcode-cli/packages/core/tests/dynamic-workflow-run-progress.test.ts`、`workflow-terminal-notification.test.ts`。
- Docs: 本 spec、计划、既有 concurrency/execution-engine 章节；实现同时同步 `docs/dynamic-workflow/transcript-and-notifications.md` 的 payload、事件来源和通知文字段落。

**Interfaces:**

- `AskStallInfo`、`WorkflowReportSink.askStalled(instance, info)`、`node-stalled` 与 `formatWorkflowAskStallNotification(input)` 精确签名按 spec。
- 优先复用 `createRunStallClock` 的成熟计时算法为每个 ask 创建独立实例，不改变原 run clock；回调只传 `sinceMs/reason` 给 ask sink，不混入 run cap。实例引用和取消函数在 driver 生命周期内持有；不得增加另一套持久化状态。
- ask 通知保留 backgroundSource/title/workId，省略 workflowNotification；旧客户端展示普通后台文本，既有 run 通知仍为 kind: stall。

- [ ] 核对 Git 状态，运行 `pnpm architecture:check --changed`，按 architecture-governance 读取 bootstrap、dynamic-workflow、core 与 shared 相关受控上下文。先确认测试命令工具链可用。
- [ ] 在 driver 定向测试增加双 actor 用例：A retry，B 每分钟 completed，20 分钟 A 通知一次而 run 不通知；新增自己成功后重新上膛、取消/完成/失败/dispose、下一 ask 与迟到状态用例；用既有假时钟，不等真实 20 分钟。
- [ ] 在 engine/core 定向测试增加 node-stalled live 检查、进度到通知队列与格式器可定位文本、ask 不设 workflowNotification、畸形 payload；断言旧 run 语义不变。补观察不改变 roster wait/progress/run stalledSince 的定向回归。
- [ ] 分别运行下方定向测试，记录预期失败来自缺少新合同/行为；不得把工具链失败当作 red。
- [ ] 实现 spec 的 sink/事件/出口，修复所有生产及测试 sink mock 的新增成员类型错误。
- [ ] 接 driver 实例时钟并覆盖所有终止路径；核查成功接受结果后的提前清理，不能只等 run dispose。
- [ ] 接 core 普通文本通知，复用 runId fencing 和 escaping；不新增 RPC/schema。更新 transcript 合同。
- [ ] 运行同一组定向测试至通过，执行下方静态验证，独立审查后修复具体问题并复跑受影响检查。

## 验证命令

全部从 `C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode` 执行；CLI 有独立 workspace，定向命令切到包目录，避免根 Vitest 误选。Vitest 限单 worker、关闭文件并行和缓存，减少并发代理资源竞争。

```powershell
pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/workflow-driver-concurrency.test.ts --maxWorkers=1 --no-file-parallelism --no-cache
pnpm --dir apps/zcode-cli/packages/dynamic-workflow exec vitest run tests/engine/engine-concurrency-observations.test.ts --maxWorkers=1 --no-file-parallelism --no-cache
pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/dynamic-workflow-run-progress.test.ts tests/workflow-terminal-notification.test.ts --maxWorkers=1 --no-file-parallelism --no-cache
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
git diff --check
```

如 roster 回归位于现有另一测试文件，实施者记录真实文件并增加该文件的定向命令。通过标准：定向用例均通过，根和 CLI 类型检查成功，lint 无 error，架构无违规；已有 warning 如实记录。独立审查必须检查真实通知链和生命周期，不能只看 clock 单测。此计划未执行这些测试，当前不宣称实现完成。

实施补充：AskStallInfo 直接在 types.ts 复用 RunStallInfo 的 sinceMs/reason；未修改 run-terminal.ts。迟到请求隔离复用现有活动链，墓碑仅保留换 ask 时尚在飞链，终态/退订回收。真实通知以 harness journal 与 core command queue 分层验证，不宣称单条全链 E2E。定向证据及最终静态结果见当前会话 handoff 的 implementation-report.md 和 verification 日志。


## WF-3 增量实施

独立审查先看根spec新增WF-3。新增修改既有 `bootstrap/src/app/workflow-driver-model-failure.ts` 内部host回调与driver接线；只复用ask钟，run合同不变。先扩 `adapters/tests/retry-budget.test.ts` 的真实adapter状态集合，再在既有bootstrap driver并发测试接实际Core恢复耗尽组合RED。通过后实现，复跑两文件与原生命周期回归；根/CLI静态检查及独立复审由主Agent协调。不新增CLI源文件或架构豁免，不增加恢复层。
