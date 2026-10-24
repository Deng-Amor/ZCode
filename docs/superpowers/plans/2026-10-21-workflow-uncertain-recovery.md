# WF5 未知外部效果恢复保护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. WF4/WF5及P2-A为已独立验收的历史阶段；本轮活动入口为末尾P2-B计划。B已获授权，Task1–Task5已在隔离树实现并完成分层验证，Task6精确原库集成和最终门禁待验收；保留以下历史计划与验证记录，不提交。

**Goal:** 保持未知world-run不被重放的执行保护，并让已提交的宿主终态观察在分发失败时按同身份完成一次严格投影恢复或明确失败。

**Architecture:** dynamic-workflow提供唯一纯判定及Engine最后执行门。Bootstrap lifecycle拥有宿主收敛和terminal缓存，resume/amend只调用该owner；宿主收敛不伪造引擎事件。Contracts提供结构化拒绝，Core工具仅展示事实。

**Tech Stack:** TypeScript、Vitest、pnpm、真实SQLite与Node子进程；不新增依赖。

**Spec:** docs/specs/workflow-uncertain-recovery.md；独立设计结论见会话wf5-safety-spec-review.md。

## Global Constraints

- 执行业务不新增DB状态、force/idempotent旗标、receipt账本、重试或确认机制；无绕过。P2-B仅增加本地纯观察同event重试/严格重建，界限见活动计划。
- 新码RecoveryUncertain，拒绝reason recovery_uncertain；unknown节点仍running，completed/failed缓存、running纯read、新world-run不变。
- owner/parent、取消/单飞、scriptHash与CTRL固定version/digest原合同不变；正文不得落盘或离线回退。
- 单写者；WF4仍修改errors.ts，本计划不授权提前实施。原库和隔离树有其他人改动，不整文件覆盖、不提交推送、不执行全量测试。
- Node以mise.toml的24.14.0为准；现有探针实际24.16.0，若仍不一致记录，不将其称固定版本验收。
- 所有下列命令cwd为所选仓库根（当前隔离树 C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode）。代码短路径P代表apps/zcode-cli/packages/，文档短路径D代表apps/zcode-cli/docs/design/v2/。

## Review Focus

1. 写库抛错必须不launch、不更新terminal缓存、不通知成功（Task2）。
2. terminal registry优先于journal，旧Promise不能重新resolve；get/list/wait须看到新终态（Task2/3）。
3. 授权await期间出现未知节点，amend最终scan→abort同步；拒绝不停止前驱、不留悬空后继（Task3）。
4. foreign owner不读取返回节点详情；live/completed前驱不被宿主改errored（Task2/3）。
5. 重复拒绝不退回建议amend；冷读/实时读不虚构run-settled或重复执行（Task3/4）。

---

## Task 0：冻结安全实施基线

**Files:** Read AGENTS.md、apps/zcode-cli/AGENTS.md、上述spec、会话current.md/queue.md、.agents/skills/architecture-governance/SKILL.md；Read D/tool/00-tool-change-chain.md。本task不改产品。

- [ ] 主Agent确认WF4源码单写者结束并记录其冻结SHA；刷新git status与适用规则，运行`node scripts/check-workspace-freshness.mjs`。
- [ ] 读取architecture技能，执行`pnpm architecture:check --changed`，按实际policy模块运行context；涉及工具模块现有id为workflow-tool-entrypoints，运行`pnpm architecture:context workflow-tool-entrypoints`。
- [ ] **先解决装配基线差异。** 本计划编写时隔离run-submit的Context没有原库现有assertOpen/preparingRuns/prepareController；E:/ZCode已有他人CTRL更新。由主Agent先建立原库CTRL依赖闭包manifest：从run-submit/service/launch/lifecycle/reconcile/create-app及prepareController接口出发，沿当前import与类型引用核对关联bootstrap装配、contracts session-store与controller绑定接口、core runtime/session恢复、adapters真实存储与controller factory实现；仅收录实际必需依赖，不按整个目录覆盖。每项记录原库源SHA、隔离同步前SHA、目标同步后SHA、依赖理由及精确合并决定；包含新增/删除/公开barrel/类型签名变化。按manifest同步后验证所有import与接口闭合，再冻结该manifest供独立复核；不能仅拷run-submit或靠编译报错逐项猜依赖。禁止用隔离旧文件覆盖原库，也不在WF5重复实现授权装配。源SHA漂移须重新比较；同步来的CTRL差异与WF1-4已有差异单列，不算WF5实现，不反向覆盖原库。若授权/abort位置变化先修订Task3时序；确认prepareController真实接缝后才执行Task3。
- [ ] 保留原WF5强杀JSON为旧行为证据，不改历史日志。后续按新代码产生独立结果。

## Task 1：纯规则、错误码与Engine保护

**Files:** Modify P/dynamic-workflow/src/engine/errors.ts（放置纯finder和错误factory）、同目录engine-world.ts、index.ts及P/dynamic-workflow/src/index.ts；Create P/dynamic-workflow/tests/engine/recovery-uncertainty.test.ts。

**Interfaces:**
```ts
findUncertainWorldRun(
  nodes: readonly Pick<NodeRecord, "kind" | "status" | "siteId" | "ordinal">[],
): InstanceRef | undefined;
createRecoveryUncertainError(runId: string, instance: InstanceRef): WorkflowError;
```
两函数均实现于既有engine/errors.ts（WF4已有精确准入例外，仍属legacy unmanaged）并从包根公开，不新增源模块或architecture例外。NodeRecord/InstanceRef仅使用type import，避免与既有types错误再导出形成运行时循环；保留WF4已冻结RecoveryExhausted改动。finder仅过滤world-run/running，多条按siteId词典序与ordinal数值取首，不修改输入；error factory固定RecoveryUncertain，消息只含run/instance和需核实事实，不含command/input/result。

- [ ] 写RED：finder过滤/稳定顺序；真实Engine同run缓存completed世界节点后遇running world-run，driver调用0、run errored、error.code RecoveryUncertain、unknown行保持running。catch后再请求新效果仍拒绝。另测running纯read执行、首次world-run执行、failed缓存、hash不符先InputHashMismatch。
- [ ] 运行`pnpm --dir apps/zcode-cli/packages/dynamic-workflow exec vitest run tests/engine/recovery-uncertainty.test.ts --maxWorkers=1 --no-file-parallelism --no-cache`，记录因缺新行为RED，不能以环境失败代替。
- [ ] 实现接口和错误码，在readWorld现有hash检查之后、running进入live之前调用finder([recorded])，命中state.failRun(error)后reject。只改run终态，不能putNode伪造失败。不改已完成缓存路径；更新原“所有running重执行”注释。
- [ ] 重跑上述命令GREEN；再运行同包`tests/engine/engine-resume-reads.test.ts`和`tests/engine/imported-cache.test.ts`，相同worker参数。此处只证明Engine，不是RunService。

## Task 2：宿主唯一收敛owner与Contracts

**Files:** Modify P/bootstrap/src/app/dynamic-workflow-run-lifecycle.ts、dynamic-workflow-run-service.ts、dynamic-workflow-run-submit.ts（Context接线）、dynamic-workflow-run-reconcile.ts；Modify P/contracts/src/interfaces/dynamic-workflow-run.port.ts及其现有公开导出（若显式导出需补）；Create P/bootstrap/tests/workflow-recovery-lifecycle.test.ts。

**Interfaces:**
```ts
// contracts JSON，不导入engine类型
interface DynamicWorkflowRecoveryUncertainty {
  runId: string;
  instance: { siteId: string; ordinal: number };
}
// resume/amend结果各新增此联合分支，旧成功与其他失败分支原样保留
{ ok: false; reason: "recovery_uncertain";
  uncertainty: DynamicWorkflowRecoveryUncertainty }
// createRunServiceLifecycle返回对象及EntryContext新增内部接口
reconcileUncertainRecovery(runId: string, instance: InstanceRef): void;
```
Lifecycle deps的journal从getRun扩为getRun/updateRunStatus/listNodes，其他依赖不变。方法内部复读owner、live、节点判定；对照真实updateRunStatus实现验证errored会清旧stopReason，真正superseded先由入口保留原拒绝，不吞掉旧lineage；只接受本parent、无live且status为stopped/pending/running，或已RecoveryUncertain的errored（幂等）。completed、其他errored及live由调用方仅拒绝，不调用此写接口；方法对违反前置条件抛错，不能静默改写。

- [ ] RED测试创建真实lifecycle+测试journal与registry：stopped旧terminal收敛后DB errored、node未改、entry.terminal更新；已兑现旧settlement不被重新resolve，新等待读取新terminal。没有entry也可收敛，完全一致时重复无写/无通知；DB已RecoveryUncertain但缓存仍stopped时不重写DB，仍修正缓存并通知一次；foreign/live/completed前置条件不写。
- [ ] RED测试令updateRunStatus抛错：缓存、completedAt、订阅次数、journal事件不变，错误向上传播。恢复成功通知只能在DB及缓存更新后发。
- [ ] 执行`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/workflow-recovery-lifecycle.test.ts --maxWorkers=1 --no-file-parallelism --no-cache`确认RED。
- [ ] 实现：构造Task1错误→同步journal.updateRunStatus(runId,"errored",{failure:error.toJSON()})→更新已有entry.terminal/completedAt，并将entry.settlement引用换为Promise.resolve(newTerminal)供后续读取（旧promise不变）。没有entry不新建run/registry。不得appendEvent。
- [ ] 成功发生状态修正时通过既有notifySettled通知一次；订阅合同明确包含宿主终态修正，不把它算引擎再次结算。幂等重复不通知、不重复加入terminalOrder；该内部notice不是模型/协议run-settled。测试先查既有消费者不会因此重复业务动作。
- [ ] 孤儿构造收敛使用同一finder/error factory：本parent非终态遇未知直接写errored，否则原stopped(interrupted)。保留原构造warn边界；操作时reconcile失败必须throw且不launch。无新增全库扫历史terminal。
- [ ] 接入service/context窄方法，完成Contracts类型，重跑Task2命令GREEN。现有waitForTask在entry.terminal存在时直接snapshot，保持此机制；对后续get/list/wait完整一致性留Task3验证。

## Task 3：resume/amend服务门与真实harness交错

**Files:** Modify P/bootstrap/src/app/dynamic-workflow-run-submit.ts；Extend P/bootstrap/tests/dynamic-workflow-run-service.test.ts（使用已有makeHarness/preloadRun/settle，测试名统一WF5）；只对测试HarnessOptions加入需要的真实prepareController/执行端fixture注入，不mock resume或Engine。

**Interfaces:** 使用Task1 finder/error factory、Task2 owner方法/返回形状；现有resumeDynamicWorkflowRun/amendDynamicWorkflowRun函数签名不变。不新增授权旗标。

- [ ] RED：本parent旧stopped未知run resume返回recovery_uncertain，无actor创建/模型/执行端调用，journal errored且无新增引擎event；同service再resume/amend仍专用reason。getTask/waitForTask/listRunsForSession均看到errored、resumable=false，冷重开也一致。
- [ ] RED：通过真实service提交→停止得到terminal registry，再发现其world-run未知，调用resume验证缓存修正；completed前驱未知amend拒绝但completed/result不变；live未知amend拒绝仍live，foreign owner拒绝且节点查询/写入次数0。
- [ ] RED：updateRunStatus注入throw，resume/amend不launch、不新增run行，终态缓存不冒报成功；修复store后再请求可安全收敛。
- [ ] RED真实harness时序：安全live前驱进入amend prepareController deferred；等待期间让前驱通过真实sandbox world.run执行fixture并挂在返回前；放行授权，最终scan发现running，amend拒绝；前驱无supersededBy、无后继run、abort未触发。此测试授权端用受控fake，实际单飞/Service/harness/Engine不可替换。
- [ ] RED正常amend：授权结束最后scan与controller.abort同一同步片，真实harness onAbort同步markSettled；迟到世界结果不能新增running行或产生无后继superseded。保留原成功amend用例，不为测试增加生产延时hook。
- [ ] 执行`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/dynamic-workflow-run-service.test.ts -t WF5 --maxWorkers=1 --no-file-parallelism --no-cache`确认RED。
- [ ] 实现resume：先owner/live/superseded边界；首次未知检查在授权前且在通用not_resumable之前（保证已RecoveryUncertain重复返回专用reason）；命中符合条件调用lifecycle再返回。授权/编译后、launch前再查owner/record/取消与未知。保留现有hash与固定绑定逻辑；不为未知请求执行授权网络调用。
- [ ] 实现amend：先读实际前驱记录核对parent（在preflightAmendImport前，不仅校验request.parentSessionId）→首次finder→原有异步准备→assertOpen/owner/live复核→最后同步finder→若无未知紧接原abort。两个同步操作中不插await。未知时live/completed只拒绝；旧stopped/孤儿先owner收敛。不要把初次mint的字符串ID写为run或supersededBy；不加“停后拒绝”的fallback。
- [ ] 重跑WF5定向GREEN；复跑该文件现有resume/amend/provider/owner/close场景，使用实际describe/it名称的`-t`，在执行报告逐项列选择名与通过数，不运行全仓库测试。

## Task 4：工具文案、恢复投影与真实强杀回归

**Files:** Modify P/core/src/tool/handlers/resume-workflow-run.ts、amend-workflow.ts、P/cli/src/command-center/handlers/dwf.ts；Extend P/cli/tests/dwf-command.test.ts 的 recovery_uncertain 文案回归；Extend P/core/tests/resume-workflow-run-tool.test.ts；Create P/core/tests/amend-workflow-recovery.test.ts（复用现有amend测试构造模式）；Extend P/bootstrap/tests/dynamic-workflow-run-service.test.ts的WF5冷/实时投影断言；Create P/bootstrap/tests/workflow-uncertain-crash.test.ts与tests/fixtures/workflow-uncertain-crash-process.ts。
**批准的精确补充：** Modify P/bootstrap/src/zcode-protocol-v4/commands/handlers/interaction-background.ts；Extend P/bootstrap/tests/v4-native-interaction-background.test.ts；按需局部修改 P/core/src/tool/handlers/amend-workflow-source.ts 的既有工具专属错误码表及 P/core/src/tool/handlers/amend-workflow-description.ts 的常驻描述，不重构source/resolve模块。Task3的两个文件须等待其写者冻结后再接续。补充依据为会话wf5-task4-scope-review.md，当前仅完成范围批准，不表示Task4实现通过。
**Docs:** Update D/tool/00-tool-change-chain.md（改工具前先更新）；Create D/workflow-uncertain-recovery.md作为已通过spec入口；同步dynamic-workflow/docs/execution-engine.md和docs/dynamic-workflow/launch.md的running重放/errored/amend恢复提示。不得修改总控spec正文或离线缓存。

- [ ] 工具RED：端口回新拒绝时结构化error定位run/instance，文本明确未知需核实，无自动推荐AmendWorkflow/CreateWorkflow/force。普通拒绝原行为不变。执行`pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/resume-workflow-run-tool.test.ts tests/amend-workflow-recovery.test.ts --maxWorkers=1 --no-file-parallelism --no-cache`。
- [ ] CLI测试使用node:test：执行`pnpm --dir apps/zcode-cli/packages/cli exec node --disable-warning=DEP0205 --import tsx --test tests/dwf-command.test.ts`，覆盖新reason的可信run/instance定位、未知需核实及无自动重跑建议；不把该文件交给Vitest。
- [ ] V4通过真实V4CommandExecutor验证`fault.command.workflowRunResumeRejected.recovery_uncertain`与安全message；执行`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/v4-native-interaction-background.test.ts -t resumeWorkflowRun --maxWorkers=1 --no-file-parallelism --no-cache`。message沿既有ACK进入UI generic/detail，不新增通知kind、UI词表或locale；shared的resume仅有fault前缀，不误改saved-workflow拒绝枚举。
- [ ] 实现专用handler分支、CLI恢复拒绝事实文案与工具描述（Task2只做联合类型安全读取，不替代本步骤）；对真实协议schema/调用点用rg核对新reason闭集，只有确有闭集才扩展；不得新增通知kind。测试live snapshot与cold replay均读errored，不虚构宿主dwf_event，不让旧stopped缓存显示resumable。
- [ ] 失败输出沿既有ToolHandlerFailure的result/errorCode/message，使用各工具未占用专属码，身份只从可信端口返回值取；不任意添加未经executor保留合同的uncertainty键。同步删除描述中“ANY run”“unfinished全部重派发”“errored都可amend”的无条件指导，保留安全run及provider/user权限合同。不改变权限谓词，不新增审批或复制未知状态；服务门无条件拒绝，用户确认不解锁重放。
- [ ] 将会话wf5-probe/child.mts与run.mjs的Engine效果切点移成最小持久测试，不硬编码E:/ZCode路径/自定义全源loader；用本仓库已有fork+tsx方案和公开包入口。每case私有mkdtemp、真实createSqliteSessionStore、append+sync、IPC barrier、SIGKILL、等待exit、全新进程同库恢复。
- [ ] 新RED/GREEN目标：world#1效果1且completed保留；world#2在第一次效果已写后kill，恢复效果仍1、节点仍running、run errored/RecoveryUncertain，无第二次driver调用。纯read恢复另由Task1/3测试。未知效果没有“回滚成功”断言。先保留旧代码行为2次的历史JSON，不修改它。
- [ ] 执行`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/workflow-uncertain-crash.test.ts --maxWorkers=1 --no-file-parallelism --no-cache`。父finally终止自己尚活child，关闭数据库后验证目录边界再删除；不得碰真实会话或模型/中台。记录真实Node版本和子进程退出，不用sleep猜切点。
- [ ] 重跑工具定向GREEN；说明Engine kill、真实RunService/harness、协议读面为不同层，未执行客户端E2E/跨Host/掉电/24h soak保持缺口。

## Task 5：独立代码审查与精确集成

- [ ] 运行隔离树`pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint`、`pnpm architecture:check --changed`，真实记录退出码。若隔离残留node_modules.failed-hoisted污染lint，按已记录环境边界处理并单列限制，不删除绕过审批、不把补充命令冒充标准通过。
- [ ] 独立Agent核对spec、diff及以上实证；重点审查写库→缓存→通知、unknown重复拒绝、foreign/live/completed边界、最终scan→abort无await。发现问题由同一写者修复并定向复验。
- [ ] 主Agent逐文件核对原库最新SHA，仅集成本次增量，保护CTRL新装配、WF4 RecoveryExhausted及品牌改动，不复制dist/node_modules。冲突无法精确合并时保留现场并先读原变更，不回退他人代码。
- [ ] 原库运行`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`及受集成影响的上述定向测试。静态通过不是强杀通过；所有结论分开记录。无提交、推送或部署步骤。

## 自检及交接

spec每项映射：规则/纯读/Engine→Task1；状态owner/缓存→Task2；resume/amend授权时序→Task3；客户端既有读面/提示/强杀→Task4；验收与单写者→Task0/5。Review Focus五项均有明确测试。接口名称在各task保持一致；本计划仅规划，不表示测试已执行。实施前由另一独立Agent审查此计划，主Agent处理技术反馈，无需用户选择流程。



## P2-B 观察可靠性实施计划（待授权）

**阶段边界：**A正常分发已完成原库独立验收；B设计冻结SHA256为64F69BEEF4CD7D47A8271AAD34481DADAC5CBEE5952FF280D079D8D7F20E88A0，只批准spec/plan。本节为当前活动计划，上面Task0–5保留WF5历史设计，不应重新执行/重置历史测试。六文档独立评审通过并由主任务明确授权后才可写下列代码；当前不build/test/policy写入/提交。

**Spec：**[根合同](../../specs/workflow-uncertain-recovery.md)的P2-B、[CLI入口](../../../apps/zcode-cli/docs/design/v2/workflow-uncertain-recovery.md)、[case catalog](../../conversation-session-case-catalog.md)的E2E1-P2-B01–B23和[coverage matrix](../../testing/conversation-session-e2e-coverage-matrix.md)。

### B Global Constraints

- 唯一业务owner仍为journal/lifecycle；观察恢复不得重做resume/amend/abort/world/actor/model，safe amend最终scan→abort不加await。
- 一次创建eventId；store已settle且权威absent才串行再append一次。真实store确认后、durable/usage/普通fanout之前同步安全onStored；普通sink永久pending不能挡job。未settle append或必要lookup不伪称有界，不并发盲重试。
- 公开appendEvent(event,traceContext)、legacy recorder、SessionEventSink和eventStore/workflow port/工具schema不变；receipt不经工具/拒绝响应上推。
- WORKFLOW_HOST_OBSERVATION_TIMEOUT_MS=25000；WORKFLOW_HOST_OBSERVATION_INITIAL_WAIT_MS=1000。一次job deadline含接单后所有await，不做周期轮询；严格candidate最后同步owner/generation/deadline核对后才adopt。
- strictAttempted/永久失败及真实admission证明按同session generation/eventId保留，独立于finally删除的job Map和recent-tail；只恢复本host目标，其它取消/失败在loaded replay输入和tail均过滤保护。
- 保留publisher/订阅/epoch/reservation、两profile语义、normal hydration fallback/oversize/batch、generic waiter取消、permission allowlist；host observer取消不污染generic。
- 所有新增诊断仅安全身份与reasonCode；host可带toolCallId，usage无upsert按事件类型证明，registry前置可reject。
- 当前仅6文档写入。未来白名单之外（含依赖/lockfile、upstream snapshot、baseline、其它A模块、总控、UI、E2E正式suite）不得扩展；无提交/推送/部署。所有自启服务在验证结束关闭；此B协议计划不需要启动开发服务。

### B Review Focus（每项落入下述任务）

1. 真实store已settle，排在protocol前的普通sink永久pending：释放前同event job已核实/恢复，append仍1（B-Task1/2/5，B21）。
2. hook接单前throw只保证安全失败/fanout继续；正常hook先接管后registry reject不抹去stored事实或阻塞job（B-Task1，B23三独立组）。
3. strict读取一个非目标字段/seed失败时旧publisher/订阅保持；迟到候选和旧flight不写新generation（B-Task3/4，B10–B12）。
4. loaded replay已有其它cancelled TurnStarted：在reducer之前排除，不靠复制failed表掩盖复活（B-Task4，B16）。
5. job finally之后同event又从迟到fanout到达：strict成功后的已commit快返仍strictAttempted=true，未消耗才false，永久失败重复保留原reason/attempt且零新strict；不同event不串、wire失败不重做业务（B-Task2/4/5，B13–B17/B22）。

### B文件结构与未来精确白名单

本计划代码短前缀P=apps/zcode-cli/packages。当前11个既有生产文件都是snapshot historical、非introduced，仍属legacy zcode-cli；架构0违规不能写成它们已受管。新增adapter必须先登记唯一managed模块。不得借此纳管整个历史目录。

| 类型 | 精确路径 | 责任/任务 |
| --- | --- | --- |
| Modify生产 | P/core/src/runtime/agent-runtime.ts | 新host-only方法声明；Task1 |
| Modify生产 | P/core/src/runtime/methods/index.ts | 显式import/proto绑定，当前源码:26/:233是对应接缝；Task1 |
| Modify生产 | P/core/src/runtime/methods/events.ts | 内部共用阶段主体与store后/tail前同步拆点，公开append不变；Task1 |
| Modify生产 | P/core/src/runtime/methods/dynamic-workflow-run-progress.ts | stable event、同store精确查询/settled retry、host提醒一次；Task1 |
| Modify生产 | P/bootstrap/src/app/dynamic-workflow-run-progress-sink.ts | 调recorder时传入同步hook，不等返回；Task2 |
| Modify生产 | P/bootstrap/src/app/types.ts、P/bootstrap/src/app/create-app.ts | app可选host hook注入，TUI不强加protocol；Task2 |
| Modify生产 | P/bootstrap/src/zcode-protocol/server-operations.ts | ownSessionRecord闭包、同adapter实例、包完整callback、先dispose后unsubscribe；Task4随gateway可用后装配 |
| Modify生产 | P/bootstrap/src/zcode-protocol/v4-bridge.ts | normal/host-strict私有加载复用、direct-record及全来源失败传播；Task4 |
| Modify生产 | P/bootstrap/src/zcode-protocol-v4/v4-gateway.ts | actual proof/observer/per-event状态、single flight/strict调度、generation fencing；Task4 |
| Modify生产 | P/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts | prepare/adopt拆分且normal包装合同保持；Task3 |
| Modify生产 | P/bootstrap/src/zcode-protocol-v4/product-projection.ts | strict candidate窄同步advanceRecoveryBoundary；非负安全整数校验与seq/revision提升，业务字段不变；Task3联合旧base修订唯一新增既有source |
| Create生产 | P/bootstrap/src/zcode-protocol/workflow-host-observation-adapter.ts | record-scoped接单/计时/取消/安全终结，factory公开accept/dispose；Task2 |
| Create契约 | P/bootstrap/src/zcode-protocol/workflow-host-observation/module.ts | 精确module manifest；Task2 |
| Create契约 | P/bootstrap/src/zcode-protocol/workflow-host-observation/contract.ts | factory/adapter/依赖端口类型，不引业务owner；Task2 |
| Create契约 | P/bootstrap/src/zcode-protocol/workflow-host-observation/contract.example.ts | 同event两入口接单与dispose示例；Task2 |
| Create契约 | P/bootstrap/src/zcode-protocol/workflow-host-observation/CONTRACT.md | 存储确认/非commit、错误/生命周期/幂等边界；Task2 |
| Create测试 | P/bootstrap/tests/workflow-host-observation/contract.test.ts | 真实Vitest收集的有限contract验证；Task2 |
| Create测试 | P/bootstrap/tests/workflow-host-observation-adapter.test.ts | job/failure/deferred/owner注入，真实store；Task2 |
| Modify测试 | P/core/tests/workflow-run-host-observation.test.ts | append/identity/hook/tail/toolCallId；Task1 |
| Modify测试 | P/bootstrap/tests/conversation-topic-publisher.test.ts | strict候选/adopt与旧reservation/oversize/batch回归；Task3 |
| Modify测试 | P/bootstrap/tests/v4-gateway.test.ts | host recovery与generic waiter/permission/flight回归；Task4 |
| Modify测试 | P/bootstrap/tests/v4-workflow-uncertain-resubscribe.test.ts | 真实lifecycle/store/runtime→hook→wire/client，两profile；Task5 |
| Modify policy（未来） | architecture-policy.yaml | 仅下面一个module块；Task2，不改已有块/例外/baseline/snapshot |

module id=workflow-host-observation、owner=conversation、layers={adapters:.}、requires=[shared,zcode-cli]；roots和publicEntrypoints逐字采用根spec B.9 YAML。requires.shared为公开parser，zcode-cli为既有SessionEvent类型/gateway内部端口。adapter知道计时/取消与存储读取，因此归adapters；不把IO挤进domain。contract/manifest requires必须完全一致；所有新源码均属于以上roots，测试目录单独列出。A的workflow-progress-payload/workflow-telemetry-facts五件与policy块不修改。

未来policy仅新增以下精确块；本次不执行adopt/写policy：

```yaml
- id: workflow-host-observation
  roots:
    - apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation-adapter.ts
    - apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation
    - apps/zcode-cli/packages/bootstrap/tests/workflow-host-observation
  managed: true
  requires: [shared, zcode-cli]
  publicEntrypoints:
    - apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation-adapter.ts
    - apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation/contract.ts
  layers: {adapters: .}
  owner: conversation
```

主任务原库policy为CE77D7FB035F1ED6128C12721996CBAE80E33D53519EFB1728D532A22B490DBB，隔离before为F66AA4649C5BC00BB4E02E5AB8D33E7E1A14EE4F30CB6CE9E78E913624B1281C；不可整文件覆盖。六文档原库实时SHA在本阶段比较时均匹配隔离before（包含P1 catalog/matrix），但未来集成仍需实时复核，不匹配时三方精确增量。

### B Impact Brief（feature-boundary-planner / planning）

| Feature summary字段 | 决定 |
| --- | --- |
| 意图/能力/改动层 | workflow-live-run终态观察；recovery + persistence-observation，不改执行准入 |
| 主seed | core events/host recorder；server-operations subscription；v4-bridge loader；gateway/publisher；UI只读workflowRuns |
| 操作模式/边界 | planning；本阶段只6文档。外部receipt导入、世界效果重放、队列/权限业务、UI样式和总控均out-of-scope |

| UI用户场景/入口 | 共享实现/显示owner | 默认、校验和提交 | 权威/模式/隔离 |
| --- | --- | --- | --- |
| 工具卡读取run/Resume显示，create-workflow renderer | SessionPane buildWorkflowRunByToolCallId→workflowRuns；无新draft | 以shared合法终态决定可恢复字段；Resume既有command，不引新恢复命令 | journal/lifecycle→publisher；desktop/mobile分别profile；不因观察故障重发业务 |
| 详情状态/错误/结果，WorkflowWorkspaceSidePane | 当前run投影头与既有workspace/journal查询分区 | source0不虚增lastEventSequence，不无故重读正文 | 未知节点仍running、completed结果原样；不改owner/parent/remote identity |
| Task Island/status panel | ConversationStatusPanel读取snapshot.workflowRuns | 观察更新状态，不新建accepted队列或执行draft | 同publisher；phone复用attachment，不新起Host/runtime |

共享/差异：三surface共享workflowRuns终态，查询正文与actor transcript仍各自有事实源；A两profile共用reducer但continuous与replayable的delivery/old base边界不同。选项来源、默认/草稿均无B改动；验证唯一shared parser；业务拒绝和投影commit独立。

| Rank | 语义关系 | 当前证据/深度 |
| --- | --- | --- |
| must-inspect | journal已settled→core store→store-stage hook→record adapter→gateway实际admission | events.ts:104-110/:545-563；server-operations:3106-3180/:3587-3595，深度2 |
| must-inspect | strict materialization→candidate/tail→同publisher adoption | bridge:1975-2132；gateway:3234-3465；publisher:648-735，深度2 |
| should-inspect | workflowRuns投影→卡片/详情/Task Island | SessionPane:2565-2601；create-workflow:284/:296；ConversationStatusPanel:118-119 |
| invariant-only | generic cancelled command/permission与世界执行、WorkspaceIdentity | gateway:891-989/:3473-3570；既有执行保护spec；不扩大业务边界 |
| evidence-only | P1 renderer fixture、历史A probe/原库验证 | 展示/正常链证据不能证明B故障或物理网络 |

State owners/commit sinks：业务run=journal/lifecycle；事件身份/append=core单次调用；raw authority=direct record.eventStore；inflight job=record adapter；strictAttempted/proof/failure=gateway同generation per-event；projection/subscription=既有publisher；client仅派生显示。不存在第二accepted队列或业务状态。

Must-preserve：同event幂等/不同event独立、其它generic failure过滤、owner/record/generation fence、safe amend最终同步段、source0不污染journal水位、world/actor/model调用零、两profile严格分开。对应证明为B01–B23及旧generic/permission/hydration回归。

Codegraph evidence：本环境ALL_TOOLS中无codegraph工具，未安装依赖或伪称已运行graph查询；以上为已读源码引用与既有architecture context支持的深度2语义链。图谱capability.workflow-live-run/surface.workflow-run-detail-pane/surface.workflow-tool-card-run-state/surface.workflow-task-island/state.workflow-run-journal可作seed；其尚缺host-reconciliation/recovery边，记graph-drift-candidate。建议delta为该capability增加宿主观察修复边、core/adapter/gateway seed及两profile不变量；本阶段授权仅6文档，因此不改graph YAML，后续另由主任务决定，不能暗改范围。

澄清/剪枝：已批准设计锁定“业务拒绝不等投影”、同id一次重试/一次strict、无force/outbox/轮询、原store IO未知限制；无新的产品取舍。主域为conversation/session、persistence-observation、delivery-recovery。高风险交叉是store阶段×fanout挂起×owner换代、failed缓存×strict loaded replay、同event×不同event×normal/strict flight；主题/语言/provider组合按无业务变化剪枝复用P1，纯执行效果类型以零执行约束剪枝。accepted=B01–B23，pruned=重放/强制确认/新队列/新手机runtime，undefined业务问题=无；真实GUI/跨Host/24h为missing证据，不从本计划推断通过。

Planning handoff：spec/CLI入口/tool chain→本6文档；accepted case catalog与coverage matrix已回填planned；E2E手工转正不在本计划，未来需case-local fixture、受控deferred切点、私有数据/端口、真实网络证据，禁止把P1 props fixture当产品链。技术审查仍需确认新module层/依赖、候选token边界及最小构建provenance；这些是独立工程评审，不扩大业务授权。

### B-Task0：核授权、基线与精确范围

**Files:** 只读AGENTS/CLI AGENTS、根spec/CLI design/tool chain、scope清单、已批准设计；未来policy仅Task2指定块。

- [ ] 确认本节spec/plan独立评审通过及主任务源码授权；复核6文档与12个既有生产文件SHA（含本修订product-projection.ts）和Git状态，保存当时before，保护其它本地改动。默认继续当前隔离树，不新建worktree。
- [ ] 运行node scripts/check-workspace-freshness.mjs、pnpm architecture:check --changed及pnpm architecture:context zcode-cli/workflow-progress-payload/workflow-telemetry-facts；已有context在本次文档阶段exit0不能替代实施时核查。
- [ ] 本阶段没有任何build/test/源码改动。执行前把下面拟议build dry-run tasks/provenance交主任务确认；任务超范围即停在准备阶段，不擅自构建所有依赖。

### B-Task1：core稳定事件及tail前同步交接

**Files:** 上表core4个生产文件、core/tests/workflow-run-host-observation.test.ts。

**Interfaces:** AgentRuntime.recordWorkflowHostObservation(input: DynamicWorkflowRunProgressPayload, onStored: (storedEvent: SessionEvent) => void): Promise<void>；在methods/index.ts显式绑定。events.ts内部appendEventWithHostStoredHandoff(this:AgentRuntimeInternal,event:SessionEvent,traceContext:TraceContext,onStored:(storedEvent:SessionEvent)=>void):Promise<void>，不从core包公开导出。公开appendEvent两参数及旧progress方法不改。

- [ ] RED新增测试名：host stored handoff precedes a pending ordinary sink、settled reject absent retries the same identity once、settled reject present hands off without reappend、lookup unknown never retries、handoff throw does not stop legacy fanout、host toolCallId has no usage upsert、registry rejection after handoff cannot erase stored identity。真实InMemorySessionEventStore、受控deferred、spy append计数；使用现有runtime真实装配，非法输入只验前门，完整拒绝链留Task5。
- [ ] RED断言至少包含expect(appendCalls).toBe(1)、expect(storedEvents).toHaveLength(1)、expect(handoffEvent.id).toBe(storedEvents[0].id)、前置deferred尚未resolve时hook已调用；retry组第2次id严格等于第1次，最多2次；hook throw组只要求安全失败/fanout继续，不伪称已接单。
- [ ] 运行V1（下表）保存真实行为RED；缺方法/环境错误分别说明，不以环境失败冒充目标行为RED。
- [ ] 实现共用私有append阶段：store fulfill并核返回身份后先记已存储，再同步安全hook；隔离hook及诊断异常，继续原durable/usage/fanout。host helper一次创建/冻结event，只有store settled reject且同store权威absent才同event重试一次；present立即交接，未知不猜。tail错误不再append/交接。host提醒一次，无模型通知。
- [ ] 重跑V1 GREEN并评审core增量；spec B01–B04/B19/B23对应，B21真实生命周期端到端在Task5补足。禁止为此改usage-observability或通用store去重合同。

### B-Task2：record adapter、受管契约与protocol装配

**Files:** 上表adapter及5件、bootstrap progress-sink/types/create-app、两新增测试文件；policy仅一个模块块。v4-gateway.ts在本task仅先导出WorkflowObservationOwner/CommitResult和安全错误元数据的type声明，供contract引用，实际ensure/recovery实现及server-operations完整接线属于Task4，避免调用尚未存在的方法。

**Interfaces:** createWorkflowHostObservationAdapter(deps: WorkflowHostObservationAdapterDeps): WorkflowHostObservationAdapter；adapter.accept(event:SessionEvent,forward?:()=>void):void、dispose():void。deps只含isCurrent():boolean、verifyStored(event,signal):Promise<SessionEvent>、ensureCommit(event,owner):Promise<WorkflowHostObservationCommitResult>、report(outcome):void和共用单调now():number；Outcome是安全session/event/run、phase/reasonCode、strictAttempted/elapsedMs闭集，不含任意message/payload。

WorkflowObservationOwner={signal:AbortSignal;deadlineAt:number;now():number;isCurrent():boolean}，只读生命周期能力定义在gateway内部公开type，旧目录→v4使用；v4不得反向import本adapter。onWorkflowHostObservationStored?: (storedEvent:SessionEvent)=>void位于bootstrap app option，构造时就交recorder，不返回commit Promise。getCurrentRecord/verify闭包捕获原record/app/eventStore，不跨record fallback。

- [ ] RED写B05/B08/B11–B14/B19/B22的record job用例：subscription与hook同event join、不同event不串；callback包完整onSessionEvent前置步骤；无record/gateway/foreign/多条同id安全失败；接单同步建timer后才async lookup；dispose先撤销owner、finally清理timer/listener/Map。
- [ ] 先登记精确module块与五件，manifest.requires=[shared,zcode-cli]且publicEntry/roots与spec一致；不改旧A模块、不新增exception/baseline/snapshot。运行architecture context新模块，确认受管后才加行为。
- [ ] 运行V2确认RED；实现deps端口与record闭包装配；合法host且已注入protocol hook时用新recorder并传同一同步hook，已注入时缺方法/拒绝不fallback。明确非protocol/TUI无hook保留旧recorder和A校验。新增路由测试用同时具备新旧spy的runtime，分别证明host+hook、host无hook、legacy+hook、invalid及foreign routing，不以旧fake缺方法推断能力。本task仅对注入deps和app option做单元接线；protocol factory中的normal subscription/hook实例创建在Task4一次完成，届时先核owner再accept(event,()=>onSessionEvent(...))，hook/订阅共用一个adapter，unsubscribe先dispose再移除原subscription。app构造未就绪明确失败，不后台查新record补交。
- [ ] hook接单不得await普通fanout或append Promise；job有catch/finally，永久attempt不在本Map，调用gateway提供的per-event状态。重跑V2 GREEN、architecture检查/新module contract测试，独立审查生命周期与类型边界。

### B-Task3：publisher候选prepare/adopt

**Files:** P/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts、P/bootstrap/src/zcode-protocol-v4/product-projection.ts、P/bootstrap/tests/conversation-topic-publisher.test.ts；仅这三文件，product-projection.ts是联合旧base修订唯一新增既有source，不新增模块/schema或公开package导出。

**Interfaces:** prepareRehydration(events:readonly SessionEvent[],options?:{onPayloadTooLarge?:(error:ProjectionPayloadTooLargeError)=>void;excludedEventIds?:ReadonlySet<string>;requiredEventId?:string}):PreparedConversationRehydration；adoptPreparedRehydration(prepared:PreparedConversationRehydration):void。Prepared为仅本包内部token，含无订阅candidate与真实applied/skipped ids，绑定原publisher/session/epoch，不能序列化或由外部构造。gateway可对无订阅candidate使用现有seedUsage/seedSubagents/seedSharedContextImport/ingest方法；live publisher只在最后adopt更新。

- [ ] RED：prepare reducer throw/目标oversize/被排除失败id时旧projection/log/subscriptions/reservations无变化；候选成功也不提前发帧；adopt后同publisher/epoch、旧reservation不能commit、订阅需按既有边界resync；strict逐事件proof不从batch估计。
- [ ] 运行V3确认RED；从现有rehydrate提取prepare/adopt，原rehydrate成为同步包装且默认oversize/batch/runtimeInitialization/结构相同行patch行为保持。requiredEventId不能跳过；excluded ids在replay前过滤；不把所有loaded ids当实际applied。
- [ ] 重跑V3 GREEN及已有hydration-bound/workflow-runs/eviction回归（V3R），评审普通路径无语义扩展。最终同步adopt前不允许外部异步callback；候选不能带订阅跨publisher替换身份。
- [ ] 联合旧base修订先RED：无runtimeInitialization时candidate seq小于/等于/大于previous；两profile旧base reconnect及same-sub resync必须snapshot并实际apply新事实，epoch不变、旧reservation不能commit；新snapshot base可resume且下一事件形成连续delta；旧baseRevision命令按既有CAS stale。不得修改Task5旧base断言、强制forceSnapshot或用新snapshot冒充旧base。
- [ ] 新窄同步ProductProjection.advanceRecoveryBoundary(minimumSeq,minimumRevision)仅供strict candidate调用：`newSeq=max(candidate.seq,previous.seq+1)`、`newRevision=max(candidate.revision,previous.revision+1)`。参与计算的previous/candidate seq/revision、previous+1及最终值均为非负safe integer，两个previous+1可表示并严格递增，否则安全失败零live adopt；数值验证先于边界写入，不clamp/归零/换epoch。保留真实可选initialization和全部业务字段，不写snapshot返回引用、不伪造事件或增加applied proof。
- [ ] 数值校验/抬水位/最终logical size校验全部在candidate内完成；成功后同步swap live、清log、floor=newSeq、清buffer并失效旧reservation。数值或最终size失败可失效token，但live snapshot/log/floor/subscriptions/reservations原样；先RED覆盖safe integer非法/溢出与抬水位引发最终size超限。普通rehydrate batch/oversize/initialization同结构patch不变。V3/V3R与局部TS/lint真实存证，原Task5作者复跑冻结V5后才判联合缺口关闭。

### B-Task4：gateway实际admission、严格加载与single flight

**Files:** v4-gateway.ts、v4-bridge.ts、server-operations.ts、v4-gateway.test.ts；使用Task3内部token，依赖Task2同record owner/deps类型。Task2只加type与可注入adapter，本task在gateway实现存在后才把protocol factory的真实ensureCommit闭包、onStored及完整subscription接到同一实例，并在unsubscribe前dispose。

**Interfaces:** ensureWorkflowHostObservationCommit(sessionId:string,target:{eventId:string;runId:string},owner:WorkflowObservationOwner):Promise<WorkflowHostObservationCommitResult>；V4GatewayHost新增仅内部loadWorkflowHostObservationProjection(sessionId,target,owner):Promise<PersistedEventsLoadResult>。bridge私有load helper区分normal/workflow-host-strict，返回目标真实raw身份和全部采用字段来源/seed；普通load容错不改。WorkflowHostObservationCommitResult={strictAttempted:boolean}，字段表示同event/generation是否曾消耗唯一strict：从未尝试为false，一旦尝试即保持true，strict成功后重复已commit正常快返仍true，永久失败重复仍沿原reason/attempt且零新strict；不能按本次分支硬编码false。失败的内部WorkflowHostObservationCommitError只带根spec闭集phase/reasonCode/strictAttempted和固定安全message。adapter据此准确报告，不通过timer或猜测维护第二份attempt事实。这个结果只为本地终结诊断，不能上推RunService/tool。

- [ ] RED在describe("workflow host observation recovery")覆盖B06–B18：seen/cursor/loaded-applied伪绿、nonthrow失败、raw gap；old flight和新normal竞争、strict全来源/seed失败、deadline再释放、相同session换record；其它cancelled事件在loaded replay与tail都不进入candidate；最终job移除后重复同event仍只有一次strict，且B13断言首次未尝试false、strict成功后重复快返true、永久失败重复保留原reason/true；adapter不新增attempt owner，后来event不回滚。
- [ ] 运行V4确认RED；在gateway同generation per-event状态独立存actualAdmission、strictAttempted/finalFailure，session dispose清理，普通hydrate转移不重置。actualAdmission只在publisher成功ingest/strict逐事件真实proof写入；observer取消/timeout不调用generic rejectProjectionEventCommit污染命令。
- [ ] 实现原子session flight slot：join旧普通flight但不冒充strict；同deadline内同步取得strict slot+buffer。strict direct-record捕获前后fence，所有要采用字段及seed读取失败传播，不走空fallback/childfallback。未存在的可选能力与读取失败区别对待，不重新采用无法证明的值。
- [ ] 所有await结束后用loaded cursor+recent/buffer补齐candidate；失败id在loaded输入和tail都过滤；只恢复当前合法host目标。最终无await同步核owner/generation/slot/deadline、drain尾部、验目标admission/run后置条件、adopt及raw state切换；之后才flush/index。normal flight只增加必要generation/slot安全检查，不改其fallback/success合同。
- [ ] 重跑V4 GREEN，保留原describe("projection event commit waiter")的权限/abort/timeout/dispose/rehydrate回归；generic applied优先于pre-abort的原顺序不改。独立审查候选失败不半adopt、deadline迟到零写入和per-event永久状态。

### B-Task5：真实拒绝链、pending fanout和两profile联合验收

**Files:** v4-workflow-uncertain-resubscribe.test.ts；不改P1 renderer fixture或UI。

- [ ] 用现有seed/makeService/真实AgentRuntime/同InMemorySessionEventStore与私有SQLite创建拒绝链；调用真实resume/amend产生合法host，零model/actor/driver/world IO。不要直接手工喂errored snapshot，保留unknown节点与completed marker。
- [ ] 增加B21/B22：protocol前安装受控pending普通sink，真实store已存同event但该sink未释放时，onStored hook已接单，job已核实commit/唯一strict且有终结记录。之后close/同id换record再释放，迟到旧callback不重复strict/append、不污染新实例。释放deferred放finally，不能让测试或进程挂住。
- [ ] B17/B18：subscribeReserved→接纳initialWires→dispatch.commit；捕获实际context.notify编码帧，经TopicWireFrameAssembler/schema和client apply接纳；两profile分别验live、emit失败后resync、旧base reconnect。最后assert errored/RecoveryUncertain、无旧resumable/stopReason、未知nodes/已完成结果保留、raw/journal seq正确、Engine事件不增。
- [ ] 执行V5（新的真实core dist先按下表获准构建），记录实际vite resolve与source/dist SHA。failure injection去除后定向回归正常legacy链；静态props或flushNow不替代通知，未跑物理GUI/网络的层级保持missing。
- [ ] finally清理自建订阅/gateway/runtime/service/store、timer、listener、deferred及私有temp；检查路径归属后删除临时目录，零遗留服务。不关闭用户原有服务。

### B-Task6：范围复核、独立审查与精确原库集成（主任务负责）

- [ ] 只核白名单增量，冻结SHA/diff/验证日志及core构建输入；必要定向验证后不重复A整批。根必需typecheck/Lint/architecture、core/bootstrap直接exec类型检查、T-tests及目标CLI Lint分别报告，不把目标命令写成完整CLI通过。完整CLI typecheck/lint只在发现具体覆盖缺口并由主任务另批后执行，不默认展开依赖或生命周期。
- [ ] 独立审查spec/B01–B23、普通路径和实际证据；技术问题由同一写者修复并仅复验受影响项。没有提交/推送/部署步骤。
- [ ] 集成前比原库实时SHA与before；6文档虽当前匹配仍须重核。任一漂移做before/original/current三方精确增量；policy仅新增单模块块，保留原库CE77其余差异，禁止整文件覆盖。A冻结外部档案不可改写。
- [ ] 原库由主任务运行必需标准命令与B定向联合验收，分开保存与隔离结果；真实GUI/网络/跨Host/24h仍是独立验收，不能据B协议通过关闭全部无人值守任务。

### B最小命令、构建与进程生命周期

以下均为**未来实施命令，本文阶段未执行**。R为所选仓库根；V1–V5从R/apps/zcode-cli执行。命名/测试入口以当前package.json确认，不调用全量test或Turbo test（其dependsOn build）。

| ID | cwd / 精确命令 | 覆盖与通过证据 |
| --- | --- | --- |
| V1 | R/apps/zcode-cli：pnpm exec vitest run packages/core/tests/workflow-run-host-observation.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | core host所有选中用例；RED/GREEN退出及逐case |
| V2 | 同上：pnpm exec vitest run packages/bootstrap/tests/workflow-host-observation-adapter.test.ts packages/bootstrap/tests/workflow-host-observation/contract.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | 新module/adapter；依赖未实装时不把装配错误算行为RED |
| V3 | 同上：pnpm exec vitest run packages/bootstrap/tests/conversation-topic-publisher.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | publisher候选与普通reservation语义 |
| V3R | 同上：pnpm exec vitest run packages/bootstrap/tests/conversation-topic-publisher-hydration-bound.test.ts packages/bootstrap/tests/conversation-topic-publisher-workflow-runs.test.ts packages/bootstrap/tests/conversation-topic-publisher-workflow-run-eviction.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | 选中的普通batch/oversize/workflow回归，不是全套 |
| V4 | 同上：pnpm exec vitest run packages/bootstrap/tests/v4-gateway.test.ts -t "workflow host observation recovery\|projection event commit waiter" --maxWorkers=1 --no-file-parallelism --no-cache | 新host与现有generic/permission barrier；记录真实收集数与skip |
| V5 | 同上：pnpm exec vitest run packages/bootstrap/tests/v4-workflow-uncertain-resubscribe.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | 真实公开core dist+bootstrap TS+两profile自动notify/client apply |
| VR | 同上：pnpm exec vitest run packages/core/tests/dynamic-workflow-run-progress.test.ts packages/bootstrap/tests/dynamic-workflow-run-progress-sink.test.ts packages/bootstrap/tests/dynamic-workflow-run-replay.test.ts packages/bootstrap/tests/event-normalizer.test.ts packages/bootstrap/tests/conversation-telemetry-workflow-facts.test.ts --maxWorkers=1 --no-file-parallelism --no-cache | 本B修改接缝的legacy/invalid/TUI兼容与telemetry；不重复无关A测试 |
| B-dry | R：pnpm --dir apps/zcode-cli exec turbo run build --filter=@zcode/core --only --dry=json | 预期恰一个core build任务；依赖dist逐项核已有A原库构建来源，缺失即先审最小额外任务，不加... |
| B-build | R：pnpm --dir apps/zcode-cli exec turbo run build --filter=@zcode/core --only --force | 仅获主任务确认上述dry-run及依赖provenance后执行；source before/after一致、仅core dist许可变化，保存全部输入/输出SHA |
| T-core | R/apps/zcode-cli/packages/core：pnpm exec tsc --noEmit | 直接exec编译器，不用run/typecheck生命周期或Turbo，不触发^build；保存实际cwd/argv/退出 |
| T-bootstrap | R/apps/zcode-cli/packages/bootstrap：pnpm exec tsc --noEmit | 同上；使用已审core dist/declarations，缺具体依赖时另审最小缺口 |
| T-tests | R/apps/zcode-cli：pnpm exec tsc --noEmit --target ESNext --module NodeNext --moduleResolution NodeNext --esModuleInterop --strict --skipLibCheck --types node packages/core/tests/workflow-run-host-observation.test.ts packages/bootstrap/tests/workflow-host-observation-adapter.test.ts packages/bootstrap/tests/v4-workflow-uncertain-resubscribe.test.ts packages/bootstrap/tests/v4-gateway.test.ts packages/bootstrap/tests/conversation-topic-publisher.test.ts packages/bootstrap/src/zcode-protocol/workflow-host-observation/module.ts packages/bootstrap/src/zcode-protocol/workflow-host-observation/contract.ts packages/bootstrap/src/zcode-protocol/workflow-host-observation/contract.example.ts packages/bootstrap/tests/workflow-host-observation/contract.test.ts | 显式本B测试及contract/example/manifest，不包含无关全源 |
| A-check | R：pnpm architecture:check --changed；pnpm architecture:context workflow-host-observation | managed新文件/依赖和0新增违规，不替代真实边界测试 |
| Root final | 原库R：pnpm typecheck；pnpm lint；pnpm architecture:check --changed；另执行T-core/T-bootstrap、T-tests及下方L1 | 根必需命令与受影响两包/测试/22目标Lint分别保存实际结果，不默认完整CLI typecheck/lint；具体额外缺口须另批，core-only B-build授权不扩成^build |

隔离树含既有node_modules.failed-hoisted，不裸跑根Lint扫描它、不删目录或改ignore/规则绕过。根标准pnpm lint由主任务在原库执行；CLI补充采用L1，不能将目标Lint冒充完整CLI通过。完整CLI typecheck/lint不是B默认要求，仅发现具体覆盖缺口后另审范围；不通过Turbo或run脚本暗触发无关build/lifecycle。

**L1绝对路径/JSON合同：**执行时先取当前所选仓库R（由git rev-parse核实）并使用该R/apps/zcode-cli解析的pnpm exec oxlint。将上述白名单22个TS目标逐项resolve成R下绝对路径，保存实际cwd/program/argv、目标JSON、原始stdout JSON/stderr/退出码；禁止用CLI cwd的packages/...相对实参或仅换root cwd。最终22个文件必须全部存在、去重后恰22；阶段子集仅选择当前任务明确适用且已存在的文件，报告真实子集数量，不把15个既有文件或零error/收集不足写成22覆盖。不得用修改override/ignore或缩减适用清单来取得通过。

当前隔离树的精确计划argv如下；它只展示未来命令，**未执行**。原库或后续checkout执行时必须按当时R重新resolve全部路径，不复制下列隔离树绝对前缀。JSON的number_of_files必须等于实际去重目标数（最终22），再结合这份完整绝对argv、文件存在性与解析后的诊断文件路径核覆盖；如少收、多收、路径跑出R或异常非JSON，即验证失败，不根据0 error猜成功。

```json
{
  "cwd": "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli",
  "program": "pnpm",
  "args": [
    "exec",
    "oxlint",
    "--no-ignore",
    "--format",
    "json",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/index.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/events.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-run-progress.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-progress-sink.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/app/types.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation-adapter.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation/module.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation/contract.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-host-observation/contract.example.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/tests/workflow-host-observation/contract.test.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/tests/workflow-host-observation-adapter.test.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/core/tests/workflow-run-host-observation.test.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/tests/v4-gateway.test.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/tests/conversation-topic-publisher.test.ts",
    "C:/Users/Administrator/.codex/worktrees/workflow-ask-stall/ZCode/apps/zcode-cli/packages/bootstrap/tests/v4-workflow-uncertain-resubscribe.test.ts"
  ],
  "expectedFinalFileCount": 22
}
```

**root emit审计：**pnpm typecheck仍按根package.json原命令执行，它的tsc -b会emit，不能与core build、Desktop bundle/E2E或另一typecheck并行。执行前冻结所选源文件/配置及当前产物清单与SHA，执行后记录真实新增/改动/删除产物（含out/host、dist和tsbuildinfo等实际输出）、source before/after及与获准命令的对应关系，保留原退出/日志；不得把root emit当无副作用检查，也不自动授权另build其它包来“修复”账本。若需后续GUI产物，由主任务明确审核最小重建；禁止复用被root emit覆盖的Host产物。

B只需Node/Vitest，零开发服务启动。测试自建资源由本case finally关闭；命令完成后核自有子进程/端口/临时目录已结束。后续若另行获准启动服务，执行者必须记录cwd/命令/PID/端口、验收后关闭并给出重启方式，不能把关闭交给用户。

### B计划自检与交接

需求映射：stable append/阶段交接→Task1；record/同event/永久job边界→Task2；candidate原子性/普通publisher→Task3；proof/strict load/flight/generation/失败过滤→Task4；真实拒绝/前置pending/两profile→Task5；标准检查/原库三方集成→Task6。B01–B04/B23→1；B05/B08/B13/B19/B22→2；B07/B10/B17/B20→3/4；B06/B09/B11/B12/B14–B16→4；B18/B21/B22与真实链补证→5。Review Focus五项均有拥有者和验收，接口名称保持一致。

本轮只保存这6份文档和外部before/diff/SHA证据；生产/测试/依赖/policy/A冻结不变。先独立审查本spec/计划与新module边界，再由主任务授权源码；默认由当前隔离树单写者按任务原地执行、每阶段独立评审，无需用户为流程性执行方式反复确认。没有预先执行任何B测试或构建，未提交。

### B取消合同补充任务（先于Task2/Task4实施）

- B-Task2：仅 failed WorkflowHostObservationOutcome.strictAttempted 扩为 boolean | "unknown"；completed及gateway结果/安全错误仍boolean。取消先撤owner再abort，ensure原Promise直接挂handler，abort返回后仅一次microtask兜底unknown；不得race本地false、缓存attempt或猜异常文本。新增真实deferred端口测试：同步abort元数据true/false、永久pending/unknown错误、先前历史但verify失败、已settled未消费、监听注册顺序、迟到resolve/reject均一次终结和资源清理。invalid允许旧recorder统一A校验，零append/hook/model，不改旧sentinel调用合同。
- B-Task4：ensure同步安装abort listener并同步reject直接返回Promise，安全metadata来自同event/generation历史；注入闭包直接返回，无async/then转发；销毁先取得历史拒绝在途，再清表。用真实gateway与adapter验证strict前false/后true、重复历史、永久失败、未返回strict loader与取消；迟到零adopt，不污染generic waiter。
- B13/B22及Task5保留上述联合断言；Task2端口单测不替代真实装配。验证命令范围不扩，失败unknown仅本地诊断，不上推workflow/tool/wire，不改变业务拒绝和重试上限。
