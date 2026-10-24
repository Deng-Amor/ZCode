# CCode PRD 拆项 6：台账、证据校验和压力测试封装

- 批次：ccode-prd-split-20261022（母 PRD `E:\ZCode\docs\prd\ccode-product-prd.md` §8 第 6 项）
- 状态：待评审
- 编写日期：2026-10-22
- 输入真源：母 PRD §4.7、§5、§7 验收场景 6/7；既有设计 spec `E:\ZCode\docs\specs\ccode-provenance-ledger.md`
- 盘点基线：仓库分支 `codex/ccode-update-feed` 当前工作区（含大量未提交改动，一切以实读为准）

## 一、背景与目标

母 PRD §4.7（原文，`ccode-product-prd.md` L85-L90）对本拆项给出四条硬性要求：

1. 「任务台账必须记录来源、任务目标、执行步骤、调用的工具/MCP/数据中台能力、产物位置、关键证据、状态和关闭结论。」（L87）
2. 「台账来源不清、关键证据缺失或必须调用的能力未执行时，任务不能标记为已完成。」（L88）
3. 「Skill 发布、台账写入和验收关闭应经过统一代码校验，而不是仅依赖提示词约束。」（L89）
4. 「校验规则应支持自动化压力测试与回归验证；测试轮次、环境、输入样本、失败记录和结论可追溯。」（L90）

配套约束来自 §5（L96）：「中台不可用时，涉及企业真实数据或必须调用的能力必须明确失败原因，不能生成虚假的完成结论。」以及 §7 验收场景 6（L113）：「用户发起"采集页面并上传图片"任务时，执行记录可证明采集、上传及必要的数据中台/MCP 调用真实发生；缺少上传调用不得标为完成」和场景 7（L114）：「总控专家版本、来源、适用范围和关键调用证据可在台账中追溯；普通聊天导出不包含受控正文。」

概念澄清（防止口径漂移）：

- 本文「台账」指 CCode 产品内的任务台账与证据机制（记录任务来源、步骤、工具调用、产物、证据、关闭结论），不是任何外部调度工具的台账（例如 `E:\ZCode\docs\prd\总控台账.md` 记录的是本次 PRD 拆产派单过程，属于外部调度台账，两者不是同一事物）。
- 本文「压力测试」指对校验规则本身的自动化回归测试：多轮次、多场景输入样本下反复运行校验并记录每轮的环境、输入摘要、退出码与失败清单；不指并发/吞吐类性能压测。

本拆项目标：

1. 把 §4.7 四条要求细化为可实现的台账记录模型、关闭门禁与统一校验规则，并明确与既有 spec `ccode-provenance-ledger.md` 的衔接。
2. 把「不能只靠提示词」落成代码卡点：Skill 发布、台账写入、验收关闭三个入口共用同一套校验规则与错误分类。
3. 把校验规则的回归验证封装为可重复执行的自动化压力测试，测试轮次与结论可追溯（对齐 spec「20 轮验收」）。

## 二、范围（内/外）

范围内：

- 台账记录模型：字段定义（来源、任务目标、执行步骤、调用的工具/MCP/数据中台能力、产物位置、关键证据、状态、关闭结论）及协议/类型落点（`packages/shared` 严格 schema）。
- 关闭门禁（代码校验）：台账来源不清、关键证据缺失、必须调用的能力未执行时，拒绝把任务标记为已完成；跳过验收直接关单被拒绝。
- 统一校验规则与错误分类：Skill 发布、台账写入、验收关闭共用；错误码固定分类并指出可修正字段，不包含凭据或总控正文。
- 可核验证据的定义与实现：按 spec 要求，证据必须是可读取字节、计算 SHA-256 并核验声明摘要的引用；纯时刻、文件名或未归档本地路径不构成可核验证据。
- 运行时来源上下文：sessionId、turnId、toolCallId、workspace identity 由可信工具执行上下文附带，模型不能覆盖。
- 真实调用证据归并：基于协议事件（`tool.call.started` / `tool.call.completed`，按 toolCallId）区分真实执行与文字声称，支撑场景 6 的「采集→上传」链路证明。
- 压力测试封装：spec「20 轮验收」场景的自动化封装，含轮次编号、环境摘要、输入样本摘要、每轮退出码、失败清单与结论的报告产物；修复后重跑受影响轮次的入口。
- 失败语义：中台不可用、证据不可读、状态非法时返回明确失败分类，不生成虚假完成结论。

范围外：

- 中台侧 `CcodeLedgerService`、PostgreSQL 事务/行锁、知识库证据存储与 `knowledge/publish` 发布链路的实现（属中台仓库，本仓库只做客户端入口、端口与契约测试；见开放问题 OQ-1）。
- 总控正文的签名、加密、私有通道与内存加载机制（已有 `docs/specs/ccode-confidential-controller.md` 与 `docs/specs/ccode-startup-global-prompt.md` 覆盖；拆项 5 范围）。
- 场景 7 中「普通聊天导出不包含受控正文」的导出脱敏主体（拆项 5 范围；本拆项只保证台账侧不混入受控正文）。
- 外部调度工具的派单台账与校验脚本（如 `总控台账.md` 引用的 `台账校验.ps1`），与产品内台账无关。
- 并发/吞吐/延迟类性能压测。
- 母 PRD §6 排除项：任务续接失败、五分钟授权失败、`Confidential controller: EXECUTION_FAILED` 的修复。
- 把一般聊天结束或现有工作流运行完成改造成业务验收关单（spec L9 明确不做）。

## 三、现状盘点

以下每条断言标注实测状态：已实测（附路径与行号/符号）、推断（说明依据）、待实测。盘点对象为分支 `codex/ccode-update-feed` 当前工作区。

1.【已实测】产品内台账/证据机制目前只有设计、没有代码。对 `packages/`、`apps/`、`scripts/` 的全部 TS 源码（排除 dist 与 .d.ts）执行 `rg -i "ledger|provenance"` 零命中；唯一载体是 `E:\ZCode\docs\specs\ccode-provenance-ledger.md`，其 L3 明确「状态：设计中，未实现、未部署。用户于 2026-10-22 明确选择接入 CCode 的台账写入、验收关单与 Skill 发布入口」。源码中出现 "evidence" 的文件（如 `packages/desktop/test/remoteToolExecutionEvidence.test.ts`、`packages/services/test/localUsageEvidence.test.ts`）均为测试命名习惯，不含运行时证据存储。

2.【已实测】「Skill 发布」已有一个可参照的代码卡点，但没有台账绑定。`E:\ZCode\scripts\publish-managed-skill.mts` 的 `publishManagedSkill()`（L48 起）在发布前完成 Ed25519 签名并调用 `verifyManagedSkillBundle` 自校验（L125），且拒绝硬链接输入、源内私钥、体积超限、输出嵌套（L56-L98）；`E:\ZCode\packages\shared\src\managed-skills\verify.ts` 的 `verifyManagedSkillBundle`（L45 起）校验 envelope schema、签名（L84）、身份一致（L98）、版本下限（L101）、逐文件 SHA-256（L117）、路径安全（L19-L43、L104-L129）与根 SKILL.md 存在（L130），错误统一为 `ManagedSkillBundleError` 固定分类（`packages/shared/src/managed-skills/contract.ts` L53、L65）。缺口：整条链路只覆盖签名与内容完整性，没有 spec L40 要求的「关闭记录 ID/修订绑定、发布前重验台账已 closed」。

3.【已实测】发布校验已具备 12 个回归用例的测试范式，可直接作为「统一代码校验 + 回归」模板。`E:\ZCode\packages\shared\test\publishManagedSkill.test.ts`（describe L62）覆盖：真实 CLI 全链路发布并用独立公钥验证（L145）、缺参数 usage（L99）、拒绝签名私钥硬链接（L108）、拒绝源内复制私钥（L114）、staging 清理（L123）、超限拒绝（L139）、拒绝覆盖已有版本（L164）、拒绝签名材料（L171）、拒绝输出嵌套（L177）、拒绝目录链接（L183）、拒绝非法版本（L195）等。

4.【已实测】任务/运行状态字段现状：多套状态词汇存在，但没有一套携带台账语义。
   - 会话状态 `zcodeSessionStatusSchema`（`E:\ZCode\packages\shared\src\zcode-protocol-legacy-types.ts` L77-L84：idle/running/waiting/paused/completed/error）；
   - 保存的工作流运行状态 `zcodeSavedWorkflowRunStatusSchema`（`E:\ZCode\packages\shared\src\zcode-protocol\index.ts` L3290-L3296：pending/running/completed/errored/stopped，L3289 注释明确三终态词汇）；
   - 活动工具调用 `zcodeActiveToolCallSchema`（index.ts L1298-L1306，status：pending/running/completed/failed/denied）；
   - 会话任务事实 `CliTaskFacts`（`E:\ZCode\packages\services\src\task-facts\contract.ts` L12-L17）仅有 meta/titleSource/lastOutcome（completed/interrupted/error）/deleted。
   以上任何一处都没有「来源、执行步骤、调用的工具/MCP/中台能力、产物位置、关键证据、关闭结论」字段，也不存在「证据缺失则禁止 completed」的门禁逻辑。

5.【已实测】可复用的测试/回归基建齐全。根 `package.json` scripts：`test:unit`（vitest run，排除 desktop E2E）、`test:unit:affected`（`E:\ZCode\scripts\run-affected-unit-tests.mjs`，Vitest 官方 changed/related 选择）、`verify:pre-push`（lint + db:schema:check + test:architecture + architecture:check --changed + test:unit:affected --scope push 的串联）；`E:\ZCode\.husky\pre-push` 实际执行 `pnpm run verify:pre-push`；根 `E:\ZCode\vitest.config.ts` 定义 `unit`（L112）与 `fork-isolated`（L133）两个 project（真实进程/串行组）。测试文件落点：`packages/services/test/`、`packages/shared/test/`、`apps/zcode-cli/packages/*/test(s)/`。文档契约：`E:\ZCode\docs\testing\pre-push-hook.md`（affected 语义与回归验收清单）、`E:\ZCode\docs\ci\affected-unit-test-baseline.md`（首次推送基线策略）。另实测：本 checkout 无 `.github/workflows` 目录，即当前不存在 GitHub Actions 工作流——压力测试的「轮次与环境可追溯」目前只能落在本地报告产物与 pre-push/手动命令入口上。

6.【已实测】「真实调用 vs 文字声称」已有事件流判别范式。`E:\ZCode\packages\desktop\test\remoteToolExecutionEvidence.test.ts`（describe L8）解析 `tool.call.started` / `tool.call.completed` 协议事件，按 toolCallId 统计真实执行次数并排除权限等冗余事件——这是把场景 6「执行记录可证明采集、上传真实发生」做成代码判据的现成参照。

7.【已实测】总控客户端侧现行落点缺少台账所需的运行时来源上下文。`E:\ZCode\packages\services\src\confidential-controller\` 目录（16 个文件：contract.ts、private-channel.ts、encrypted-release.ts、memory-cache.ts 等）是总控正文传输/解密/缓存的现行实现；对其 contract.ts 检索 `sessionId|turnId|toolCallId|workspaceIdentity` 零命中，spec L15 要求的「可信工具执行上下文附带 sessionId、turnId、toolCallId、workspace identity，模型不能覆盖」尚无任何落点。

8.【推断】台账服务的归属分层：正式台账状态唯一所有者是中台 `CcodeLedgerService`（spec L13，PostgreSQL 事务及行锁），本仓库承担的是 ControllerLedger 专用工具、运行时端口、Main 鉴权转发与本地校验/测试封装（spec L34-L36）。依据：spec 明文 + 本仓库内无任何中台业务服务代码（services 目录为桌面/客户端业务层）。因此本拆项在本仓库的工作面是客户端入口与校验/测试，中台侧实现需另立工程。

9.【待实测】中台 `knowledge/publish` 发布链路现状。spec L40 要求「既有 knowledge/publish 增加关闭记录 ID/修订绑定」，该链路在中台侧仓库，本仓库无法实读核实其现有权限模型与发布事务；台账绑定改造的可行性评估需待中台代码可达后补测。

10.【待实测】压力测试环境可得性：spec L66 要求「隔离数据库/模拟网络……验证 Windows CCode/Node 与 Java 服务、隔离 PostgreSQL」。隔离 PostgreSQL 与 Java 服务在本仓库环境（Windows、无 CI 工作流）中的搭建方式与固定成本未实测，直接影响里程碑 M3 的排期置信度。

## 四、需求细化

以下需求均锚定母 PRD §4.7（L87-L90）、§5（L96）与 §7 场景 6/7（L113-L114），并与 `ccode-provenance-ledger.md` 对齐；如两者口径出现矛盾，以「开放问题」上报，不自行改口径。

- FR-1 台账记录模型（锚点 §4.7 L87）：在 `packages/shared` 定义任务台账记录的严格 schema（zod，`.strict()`），字段至少覆盖：来源上下文（sessionId/turnId/toolCallId/workspace identity）、任务目标、执行步骤、调用的工具/MCP/数据中台能力清单、产物位置、关键证据引用集合、状态、关闭结论、修订号与 Skill 版本及摘要。记录状态机遵循 spec L26：submitted → accepted/rejected → closed，转换必须携带 expectedRevision，rejected/closed 的勘误走 supersedesRecordId 新建记录。
- FR-2 关闭门禁（锚点 §4.7 L88、场景 6 L113）：提供代码级校验函数/工具，判定「台账来源不清 / 关键证据缺失 / 必须调用的能力未执行」三种情况并拒绝推进到 completed/closed。判据不依赖提示词：来源字段缺失或不可信、证据引用未通过核验、声明的必须能力在执行记录（FR-5 事件归并结果）中没有对应真实调用事件时，校验返回固定错误码。业务验收关闭状态独立于现有 sessionStatus / savedWorkflowRunStatus 词汇（spec L9：不把一般聊天结束或工作流运行完成改成业务验收关单），现有状态字段不加语义超载。
- FR-3 统一代码校验（锚点 §4.7 L89）：Skill 发布（扩展 `publishManagedSkill` / `verifyManagedSkillBundle` 链路）、台账写入、验收关闭三个入口调用同一份校验规则包（建议落 `packages/shared/src/`，与 managed-skills 的 `ManagedSkillBundleError` 同风格：固定错误码 + 可修正字段，禁止在错误信息中携带凭据或总控正文）。本地 Git hook 仅辅助预检、不作为不可绕过的安全边界（spec L7），不可绕过的校验在运行时端口与中台服务端。
- FR-4 可核验证据（锚点 §4.7 L87、spec L17）：证据引用必须指向有读取权限的已归档文件，校验时读取实际字节、计算 SHA-256 并比对声明摘要；文本证据验证 UTF-8 与行范围。拒绝纯时刻、孤立文件名、未归档本地路径作为证据（对应 spec 验收轮次 9、11、12）。
- FR-5 真实调用证据归并（锚点场景 6 L113）：基于协议事件流（`tool.call.started`/`tool.call.completed`，按 toolCallId）生成「必须能力已实际执行」的判定输入；同一能力多次执行均保留，权限事件等冗余数据不计入。复用 `remoteToolExecutionEvidence` 的解析范式。
- FR-6 运行时来源上下文（锚点 §4.7 L87、spec L15）：ControllerLedger 工具的每次提交由 runtime 从可信执行上下文附带 sessionId、turnId、toolCallId、workspace identity；schema 层拒绝模型伪造/覆盖这些字段（工具入参中携带同名字段时校验失败）。
- FR-7 失败语义（锚点 §5 L96）：中台不可用、证据不可读、状态非法、超时等场景返回固定失败分类（区分「等待中/需要登录/需要权限/执行失败」），任何失败路径不得产生「已完成」或「已关闭」状态的写入；幂等命令 ID 语义遵循 spec L24（同命令同内容幂等返回原结果，同 ID 异内容拒绝）。
- FR-8 压力测试封装（锚点 §4.7 L90、spec L66-L89）：把 spec 的 20 轮验收场景封装为可重复运行的自动化回归（建议形如 `pnpm test:ledger-stress` 的一次性入口或 npm script），每轮输入为受控样本夹具，输出结构化报告：轮次编号、场景名、环境摘要（OS/Node/依赖版本/数据库形态）、输入样本摘要、预期判定、实际判定、退出码、失败记录、结论。修复后可只重跑受影响轮次及成功对照（spec L89）。报告为机器可读格式（JSON/JSONL），路径固定可发现；「20 轮不以重复成功样本冒充」（spec L66）。回归纳入 `verify:pre-push` 的 affected 选择范围（新增校验代码与测试同包，自然进入 Vitest 选择）。

## 五、验收场景

以下均为可回读的客观判据，不使用「完成/成功」类空话。

1. 缺失上传调用证据的关闭被拒绝（对应母 PRD 场景 6 与 FR-2/FR-5）：构造任务样本——台账声明「采集页面并上传图片」，执行记录事件流中只有采集的 `tool.call.started/completed`、没有上传能力的对应事件——运行关闭校验后，进程退出码非 0，错误输出包含固定错误码（如 MISSING_REQUIRED_CAPABILITY）并指出缺失的能力标识；同一样本补齐上传事件后重跑，校验退出码为 0。
2. 证据不可核验时台账写入被拒绝（对应 FR-4 与 spec 轮次 9/12）：构造两条台账提交样本——a) 证据字段只含本地路径与时刻、无可读取字节与摘要；b) 证据声明摘要与实际读取字节计算的 SHA-256 不一致——两条提交均退出码非 0，错误码分别为非法证据类型与摘要不一致，且错误信息不包含证据正文或任何凭据。
3. 状态机与幂等回归（对应 FR-1/FR-7 与 spec 轮次 8/16）：脚本化执行——a) 对 submitted 记录直接发起 close（未经过 accept）被拒绝且记录状态不变；b) 同一命令 ID 重复提交相同内容，两次返回相同的记录 ID/修订号；c) 同一命令 ID 提交不同内容被拒绝；三种情况退出码与状态断言写入压力测试报告对应轮次行。
4. Skill 发布的台账绑定门禁（对应 FR-3 与 spec L40）：构造 purpose=skill-release 的发布请求——a) 不携带已 closed 的台账记录 ID/修订；b) 携带的记录状态为 accepted 而非 closed——两种请求发布均被拒绝，拒绝错误码可在发布工具输出中回读；对照样本（记录已 closed 且目标摘要吻合）发布成功且发布记录中含台账 ID/修订。
5. 模型不能伪造来源上下文（对应 FR-6 与 spec L15）：在工具调用入参中显式携带 sessionId/turnId/workspaceIdentity 字段的样本，校验以固定错误码拒绝；不携带这些字段的正常提交由 runtime 注入上下文成功，记录中的来源字段与注入值一致（报告可回读比对）。
6. 压力测试可追溯性（对应 FR-8 与 §4.7 L90）：运行完整压力测试入口后，在固定路径生成机器可读报告文件，逐轮包含：轮次编号、场景名、环境摘要、输入样本摘要、预期判定、实际判定、退出码、结论；人为制造某轮失败（例如篡改一个样本夹具）后重跑，报告中该轮失败记录非空、结论为失败且不含「通过」字样；修复后仅重跑受影响轮次，报告中该轮转为通过且其余轮次结果保留原值。

## 六、依赖与里程碑

依赖：

- 拆项 5（总控专家发布、调用编排与企业能力接入）：ControllerLedger 工具挂在总控运行链路上，「必须调用的能力」清单与总控编排决策同源；台账中的 Skill 版本及摘要字段依赖拆项 5 的版本固定机制。
- 中台工程（本仓库外）：`CcodeLedgerService`、知识库证据存储、`knowledge/publish` 台账绑定（见 OQ-1/OQ-2）；客户端端口与契约测试可先以中台契约 mock 推进，但验收场景 1-4 的端到端形态需中台联调。
- 拆项 3（自有更新通道与发布流程）：Skill 发布门禁的最终执行位置与发布流水线衔接（本拆项只负责校验规则与拒绝语义）。
- 既有测试基建（已实测可用）：根 Vitest `unit`/`fork-isolated` project、`verify:pre-push` affected 选择、`scripts/run-affected-unit-tests.mjs`。

里程碑：

- M1 记录模型与校验规则包：FR-1/FR-3/FR-4 的 shared schema + 纯函数校验器 + 错误分类，单元测试先行（范式对齐 `publishManagedSkill.test.ts`）；不接中台。
- M2 关闭门禁与证据归并：FR-2/FR-5/FR-6，含事件归并判定与来源上下文注入/拒绝；以夹具样本驱动，验收场景 1、2、5 在本地可回读。
- M3 压力测试封装与中台联调：FR-7/FR-8 落地为可重复入口与报告产物；接入中台 mock/真实环境后跑通 20 轮并产出首轮完整报告（环境可得性风险见盘点第 10 条）。
- M4 发布门禁合入与回归收口：FR-3 的 Skill 发布绑定改造、验收场景 3、4、6 全量回读；受影响轮次重跑机制冻结，报告格式定版。

## 七、开放问题

- OQ-1【归属与排期】中台侧 `CcodeLedgerService` 与 `knowledge/publish` 改造在中台仓库的工程归属、排期与接口契约由谁定稿？本仓库端口 mock 与真实契约的偏差如何回收？（盘点第 8、9 条）
- OQ-2【待实测】中台 `knowledge/publish` 现有权限模型与发布事务形态未知，spec L40 的「关闭记录 ID/修订绑定、发布前重验」对既有发布协议是否为破坏性变更需中台侧评估。
- OQ-3【口径确认】母 PRD L88「任务不能标记为已完成」的「任务」与 spec 的业务台账记录是否同一对象？现有 `zcodeSessionStatusSchema` 的 completed 与业务验收 closed 是两个层次（spec L9 已明确不改聊天/工作流完成语义），建议拍板：PRD 场景 6 的「不得标为完成」按业务台账关闭门禁执行，现有会话/工作流状态词汇不动——需总控确认该解读。
- OQ-4【测试环境】隔离 PostgreSQL/Java 服务的 20 轮验收环境在无 CI 工作流的 Windows 本地如何标准化（容器？固定脚本？）；「独立审查报告」（spec L89）的审查人与存档位置未定义。
- OQ-5【追溯载体】压力测试报告的固定路径与保留策略（是否入库、保留多少轮历史）未定；若不入库，「结论可追溯」对外如何举证。
- OQ-6【边界】统一校验规则包同时被运行时端口、发布脚本与压力测试消费时的发布/版本策略（monorepo 内直接源码引用，还是随 `@zcode/shared` 发版）待定。
