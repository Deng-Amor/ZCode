# CCode PRD 拆项 5：总控专家发布、调用编排与企业能力接入

- 批次：ccode-prd-split-20261022（母 PRD `E:\ZCode\docs\prd\ccode-product-prd.md` §8 第 5 项，L122）
- 状态：待评审
- 编写日期：2026-10-22
- 输入真源：母 PRD §4.6（L74-L83）、§2 目标 5/6（L20-L21）、§3（L30-L31）、§5（L95-L96）、§7 验收场景 6/7（L113-L114）；既有 spec `E:\ZCode\docs\specs\ccode-startup-global-prompt.md`、`E:\ZCode\docs\specs\ccode-confidential-controller.md`、`E:\ZCode\docs\specs\ccode-emergency-authorization.md`；`E:\ZCode\AGENTS.md`「CCode 总控 Skill 来源」节（L8-L14）
- 盘点基线：仓库分支 `codex/ccode-update-feed` 当前工作区（大量未提交在途改动，涉及文件在盘点中标注「分支在途」，只描述事实不评价对错；一切以实读为准）
- 保密约束：本文只描述机制，不复制任何受控总控正文内容。

## 一、背景与目标

母 PRD §4.6 首句（L76）定义：「总控专家是 CCode 的任务治理专家，不是用户可编辑或可导出的普通本地 Skill。」围绕该定义，与本拆项直接相关的母 PRD 原文锚点如下（均与原文逐字核对）：

- §2 目标 5（L20）：「总控专家成为 CCode 的任务分派与执行治理入口：它能根据任务决定本地能力、MCP、企业数据中台和后续专业专家的调用顺序；不把总控正文作为普通本地 Skill 文件暴露给用户。」
- §2 目标 6（L21）：「对必须依赖企业真实数据、内部 API 或 MCP 执行的步骤，客户端必须实际调用对应能力，不能以提示词模拟成功。」
- §3 用户与场景（L30）：任务执行者期望「总控专家识别必须调用的 MCP/内部能力并安排执行，不用文字假装已完成」；（L31）管理员/发布者「通过数据中台发布受控版本，客户端只消费已发布版本」。
- §4.6 各条（L78-L83）：
  - L78：「总控专家负责判断任务目标、拆解步骤、分派专业专家、决定本地工具/MCP/企业数据中台的必要调用，并维护任务证据与台账要求。」
  - L79：「对需要真实执行的步骤，必须调用相应 MCP、内部封装方法或数据中台接口。例如页面采集后上传图片，必须实际调用上传能力，不能只输出“已上传”。」
  - L80：「总控正文由数据中台审核发布，客户端使用已发布版本；用户不能从普通 Skill 浏览、导出或覆盖总控正文。」
  - L81：「总控可以引用企业数据中台中的必要步骤、规则和专业能力说明。产品需保留版本、来源和适用范围等可审计元数据，但不把受控正文混入普通聊天记录或导出内容。」
  - L82：「每个版本可按发布策略补充一部分由数据中台提供的内容，用于保持规则和企业数据的一致性；抽取比例、内容边界、失败策略和版本固定方式由中台发布策略定义。」
  - L83：「普通聊天、任务执行、工作流和子任务对总控的适用范围由产品策略明确，不能依赖模型自行猜测是否应启用。」
- §5（L95）：「不记录密码、访问令牌、总控正文、企业敏感数据或私有接口响应到普通日志、会话导出或遥测中。」（L96）：「中台不可用时，涉及企业真实数据或必须调用的能力必须明确失败原因，不能生成虚假的完成结论。」
- §7 验收场景 6（L113）：「用户发起“采集页面并上传图片”任务时，执行记录可证明采集、上传及必要的数据中台/MCP 调用真实发生；缺少上传调用不得标为完成。」场景 7（L114）：「总控专家版本、来源、适用范围和关键调用证据可在台账中追溯；普通聊天导出不包含受控正文。」

现状方面，仓库已存在一条完整的「中台发布 → 客户端消费」总控正文链路（详见三、现状盘点 P1-P8），但「调用编排」与「企业能力接入」两部分基本缺位：没有能力目录与步骤编排契约、没有数据中台 MCP/内部 API 接入面、没有"必须真实调用"的步骤标记，上传类企业能力在仓库内不存在。本拆项目标：

1. 把 §4.6/§2 目标 5-6 细化为可实现的需求条目：发布与版本消费、适用范围策略显式化、调用编排（本地工具/MCP/企业数据中台调用顺序的决定方式与承载物）、企业能力接入（数据中台 MCP 与内部 API 的客户端接入面）、受控正文不暴露的持续保障。
2. 明确与拆项 6（台账、证据校验和压力测试封装，`E:\ZCode\docs\prd\split\06-ledger-evidence-stress.md`）的接口边界：本拆项产出"哪些步骤被标记为必须真实调用、调用什么能力"，拆项 6 产出"证据归并与关闭门禁"。
3. 把母 PRD 中尚未被任何 spec 覆盖的条目（适用范围策略元数据、专业专家、企业能力接入）列为待定义需求，不虚构"已实现"。

## 二、范围（内/外）

范围内：

- 总控正文的发布→消费链路收口：中台审核发布版本（含 L82 的按发布策略补充内容与版本固定）、客户端只消费已发布版本、版本/来源/适用范围可审计元数据的数据结构与展示口径（不含中台侧发布系统实现）。
- 适用范围策略显式化（L83）：普通聊天、任务执行、工作流、子任务四类范围对总控启用的产品策略定义，策略的配置载体与代码化判定，不依赖模型自行猜测。
- 调用编排：任务步骤计划中「本地工具 / MCP / 企业数据中台 / 后续专业专家」调用的声明、排序与执行路由；步骤被标记为"必须真实调用"（L21、L79）的数据契约与标记来源。
- 企业能力接入：数据中台 MCP 与内部 API 的客户端接入面（认证复用中台登录、超时/重试/状态区分、失败语义对齐 §5 L96），含示例能力「页面采集后上传图片」的上传能力接入要求。
- 受控正文不暴露的持续保障：普通 Skill 面（浏览/导出/覆盖/别名）拦截、普通聊天导出与会话存储不含正文的回归口径（对应验收场景 7 后半句）。
- 与拆项 6 的接口：向台账/证据校验提供「必须真实调用步骤清单 + 实际能力调用事件」所需的最小契约。

范围外：

- 台账记录模型、关闭门禁（"缺少上传调用不得标为完成"的校验实现）、统一代码校验与压力测试封装——拆项 6 范围（其文档 L36-L42 已声明）。
- 中台侧发布服务、知识库「总控skills」文件夹管理、签名私钥与服务端密钥托管、`CcodeLedgerService` 等中台仓库实现；本仓库只做客户端入口、端口与契约测试。
- 总控正文的加密备用包与应急授权协议（`E:\ZCode\docs\specs\ccode-emergency-authorization.md` 已覆盖 ECA-1~ECA-5 分阶段方案）；本拆项只在「版本/来源元数据」处与其衔接。
- 将 CCode 的本地能力迁移至数据中台执行（母 PRD §6 L102 排除）。
- 母 PRD §6（L99-L104）明确排除的：任务续接失败、五分钟授权失败、`Confidential controller: EXECUTION_FAILED` 的根因分析与修复。本拆项只按产品需求梳理，不做根因分析、不提修复方案。
- 外部调度工具的派单台账（`E:\ZCode\docs\prd\总控台账.md`）与 `台账校验.ps1`，与产品内总控机制无关。

## 三、现状盘点

以下每条断言标注实测状态：已实测（附路径与行号/符号名）、推断（说明依据）、待实测。盘点对象为分支 `codex/ccode-update-feed` 当前工作区（含未提交改动）。

1.【已实测】总控正文「发布→消费」链路已在客户端端到端接线。数据中台接口为 `authorize` + `content` 两个 POST 端点（相对 `apiBaseUrl` 的 `system/ccode-controller/authorize` 与 `system/ccode-controller/content`），带 Bearer token 与 `tenant-id` 头，强制 `Cache-Control: no-store` 响应、限制响应体积（`E:\ZCode\packages\services\src\confidential-controller\http-source.ts` L107-L142）。端到端顺序：认证 → authorize 取 grant → 校验版本/摘要/有效期 → download → `verifyManagedSkillBundle` Ed25519 验签 → SHA-256 摘要复核 → 仅接受 `.md` 文件 → 拼接为 `systemPrompt`（`E:\ZCode\packages\services\src\confidential-controller\application.ts` L20-L72，符号 `createControllerApplication`/`assemble`）。与 spec `ccode-startup-global-prompt.md` L7「数据中台仍是内容来源；保留下载时的认证、签名、版本和摘要校验」一致。

2.【已实测】应用级唯一所有者与登录生命周期缓存已实现。`createControllerApplication` 内 `getBootstrap`（`application.ts` L73-L88）把装配 Promise 缓存在当前身份代次内，失败允许重试、身份切换时 `onIdentityChanged` 作废旧代次并失效通道（L92-L111）；正文只保留内存，无任何落盘路径。桌面 Main 在 import 期实例化一次，注释明示「应用级内存所有者；仅内置验签公钥」（`E:\ZCode\packages\desktop\src\main\index.ts` L666-L692，分支在途未提交）。与 spec L13「application 拥有当前登录代次的一次启动装配 Promise」一致。

3.【已实测】中台端点与信任根硬编码在桌面 Main：`apiBaseUrl: "https://dp.sccsai.com/admin-api/"`，trust `skillId: "controller"`、`name: "总控派单"`、`minimumVersion: 1`、内置 Ed25519 公钥 PEM（`packages\desktop\src\main\index.ts` L682-L691）。全仓库 `dp.sccsai.com` 仅此一处引用（git grep 实测）。注意：该公钥 SPKI SHA-256 实测为 `845e7cbf1f90ef9236cc1810d6f1675a6e0b37129df3d0a0d91ab227b91bff21`（node crypto 计算），与 `ccode-confidential-controller.md` L287-L288 记录的 `af5badd5898fcaaf68ae054373a81c1e9439dd86ac4f10c6159838239b5ed275` 不一致，列入开放问题 OQ-1。〔2026-10-23 勘误结案：两指纹为同一公钥的 DER/PEM 两种哈希口径，非两把钥匙，详见 OQ-1 结案标注〕

4.【已实测】私有进程通道按 spec 装配：Main 创建专用 channel（`packages\desktop\src\main\index.ts` L1942 传入 `createPrivateChannel`；Host 侧 `packages\desktop\src\host\desktopHostProcess.ts` L239/L652）；子进程能力声明经 `ccode-controller-capability.json` 异步核对后才开通道（`E:\ZCode\packages\services\src\zcode-agent\zcodeAgentProcessManager.ts` L487-L496、L543、L1073）；CLI 入口以环境变量 `ZCODE_CONFIDENTIAL_CONTROLLER_IPC` 标记并立即删除（`E:\ZCode\apps\zcode-cli\packages\cli\src\main.ts` L15-L22）。通道协议为一次性 `bootstrap` → `bootstrap-ready`（仅 version/digest/systemPrompt 三字段，30 秒超时，无 complete 步骤）：`E:\ZCode\packages\services\src\confidential-controller\contract.ts` L71-L87、`E:\ZCode\apps\zcode-cli\packages\adapters\src\confidential-controller\bootstrap.ts` L4-L77（符号 `readControllerBootstrap`）。与 spec `ccode-startup-global-prompt.md` L14-L15「Main/Host 复用专用 IPC……CLI 在协议服务就绪前读取配置一次」一致。

5.【已实测】CLI 消费与注入位置：`main.ts` L60-L70 在协议服务启动前一次性读取 bootstrap（登出断开时请求进程关闭，L66-L68），`run.ts` L285 传入 `runZCodeProtocolAgent`，`zcode-protocol-entrypoint.ts` L283-L287 无条件并入所有 `createZCodeApp` 调用的 `runtimeConfig.globalSystemPrompt`（类型声明 `apps\zcode-cli\packages\bootstrap\src\app\types.ts` L843）。注入点为标准 ContextBuilder 的 persona 之后系统段（`E:\ZCode\apps\zcode-cli\packages\core\src\context\builder.ts` L125、L364-L376，符号 `buildGlobalSystemPromptSection`），该段 `preview` 仅输出占位符 `[private global instructions]`（L374）。

6.【已实测】「不作为普通本地 Skill 暴露」当前有三层拦截：(a) 核心 Skill 工具 handler 对保留名只返回确认文本、无私有通道装配时直接拒绝，且对加载结果二次拦截（`E:\ZCode\apps\zcode-cli\packages\core\src\tool\handlers\skill.ts` L40-L49、L82-L86，保留名判定 `apps\zcode-cli\packages\contracts\src\skills\index.ts` L7-L13 符号 `isConfidentialControllerSkill`，NFKC 归一 + 路径分段匹配）；(b) 适配器 SkillPort 包装器在 discover 时过滤本地同名技能并注入仅元数据条目、load 时保留名一律 `UNAVAILABLE`（`E:\ZCode\apps\zcode-cli\packages\adapters\src\confidential-controller\skill-port.ts` L15-L41，符号 `createControllerSkillPort`；接线于 `bootstrap\src\app\create-app.ts` L839-L842、`script-workflow-child-runtime.ts` L312、`workflow-facade.ts` L367）；(c) 随包捆绑副本已从版本管理移除：`git ls-files` 下 `apps\zcode-cli\packages\bundled-skills\skills/` 仅余 `dynamic-workflows`，磁盘上 `总控派单` 目录为空目录（未跟踪）。桌面上下文段另有一条提示词级指令，说明内置总控已作为全局系统指令私有提供、不要调用 Skill 总控派单 激活（`apps\zcode-cli\packages\core\src\context\sections\desktop.ts` L23，分支在途未提交）。

7.【已实测】诊断与转录屏蔽：runtime.config.globalSystemPrompt 非空时，模型句柄统一附加 `confidentialController: true, startupGlobalSystemPrompt: true, skipTranscript: true` 元数据（`E:\ZCode\apps\zcode-cli\packages\core\src\runtime\methods\runtime-model.ts` L75-L88，符号 `withRuntimeInvocationLayer`）；runner 对该类请求关闭 debugDir、logger 与 modelIoFullRetention（`E:\ZCode\apps\zcode-cli\packages\adapters\src\model\runner.ts` L369-L385）。git grep 全仓库无任何把 globalSystemPrompt 写入会话存储/导出的代码路径（引用点仅 context/runtime 注入链，见盘点 5）。对应 spec L17「模型诊断及请求转录需屏蔽含全局正文的 payload」与母 PRD §5 L95。

8.【已实测】版本/来源/适用范围元数据现状：私有通道 payload 仅 `version`/`digest`/`systemPrompt` 三字段（`packages\services\src\confidential-controller\contract.ts` L71-L75 `ControllerBootstrap`）；全仓库无 `controllerVersion`/`controller_version`/`controllerDigest` 等任务级审计字段传播（git grep 零命中）。即母 PRD L81 要求的「版本、来源和适用范围等可审计元数据」目前只有版本号+摘要，来源与适用范围字段不存在，也没有任何任务/台账记录消费它们。

9.【已实测】适用范围策略现状：启动全局提示词对装配了 bootstrap 的 CLI 进程内全部模型请求生效（`zcode-protocol-entrypoint.ts` L285 无条件并入，无按会话类型/聊天-任务区分的条件分支）；子代理显式继承（`apps\zcode-cli\packages\core\src\runtime\methods\subagent.ts` L293 与 `apps\zcode-cli\packages\core\src\subagent\context-builder.ts` L128）；「普通聊天不调用总控」只存在于提示词级文案（`skill-port.ts` L8 的 description 与 `skill.ts` L135 的指引），不存在代码化的「聊天/任务/工作流/子任务」适用范围配置。这与 `E:\ZCode\AGENTS.md` L13「总控在客户端认证后统一装配，普通聊天、工作任务、恢复及子任务继承同一启动配置」口径一致，但与母 PRD L83「适用范围由产品策略明确，不能依赖模型自行猜测」存在差距（差距定性见开放问题 OQ-3）。

10.【已实测】遗留的按运行授权/绑定机制仍在代码中但在当前装配下休眠：工具执行前的总控就绪门 `assertControllerReady` 与激活函数 `activateConfidentialController` 仅在 `deps.createConfidentialControllerScope` 存在时挂载（`E:\ZCode\apps\zcode-cli\packages\core\src\runtime\helpers\runtime-tools.ts` L185-L206）；工作流版本绑定 `prepareWorkflowController`（`E:\ZCode\apps\zcode-cli\packages\bootstrap\src\app\script-workflow-child-runtime.ts` L45-L73，绑定键 `workflow:<kind>:<runId>`，L66 报错文案「请先在父任务中激活总控派单，再启动工作流。」）与会话存储绑定端口（`E:\ZCode\apps\zcode-cli\packages\contracts\src\interfaces\session-store.port.ts` L1100-L1109，可选方法、仅存非秘密 version/digest）；而 `main.ts` L99-L103 传给 run 的依赖只有 `globalSystemPrompt`，未设置 `createConfidentialControllerScope`（全仓库无生产侧构造点，仅类型声明与透传：`cli\src\cli-types.ts` L53、`cli\src\run.ts` L286、`bootstrap\src\zcode-protocol-entrypoint.ts` L320）。因此当前实际生效的是启动全局提示词路线（spec `ccode-startup-global-prompt.md` L5 明确「取代……缓存、短期租约、按请求 acquire/use/complete 和总控激活要求」），旧 scope 门与 `acquire`/`complete` 私有消息（`contract.ts` L77-L80）处于不激活状态。

11.【已实测】MCP 调用基础设施完整存在，但没有面向企业数据中台的接入：运行时经 `registerMcpTools` 注册 MCP 工具（`E:\ZCode\apps\zcode-cli\packages\core\src\runtime\methods\mcp.ts` L7、L41-L50 符号 `startMcpStartup`），配置、连接池、stdio 传输与 OAuth 在 `apps\zcode-cli\packages\adapters\src\mcp\*` 与 `bootstrap\src\mcp-config.ts`；仓库根与 packages 下无数据中台 MCP 服务器配置（根 `.mcp.json` 不存在，`dp.sccsai.com` 仅 desktop main 一处，见盘点 3）。「上传图片」类企业能力工具不存在（对 `uploadImage|upload_image|image-upload` 的 git grep 在 CLI 包内零命中）。

12.【已实测】「必须真实调用」的判定与证据现状：不存在任何代码级门禁（对 `requiredToolCall|mustInvoke|evidenceCheck` 全仓库 git grep 零命中）；任务终态由模型驱动，无"必须调用能力未执行则不得完成"的校验（该门禁属拆项 6）。真实调用证据的原料存在：会话事件流定义了 `tool_call_scheduled`/`tool_call_started`/`tool_call_progress`/`tool_call_result`/`tool_call_error`（`E:\ZCode\apps\zcode-cli\packages\contracts\src\events\session.events.ts` L135-L139），按 toolCallId 关联，可支撑「执行记录可回读到调用条目」类判据。

13.【推断】动态工作流（dynamic-workflow）actor 的全局段继承：动态工作流子 Runtime 经由 bootstrap 应用装配路径创建（`dynamic-workflow-run-submit.ts` L93/L158/L494 的 `prepareController` 钩子在当前装配下为空操作返回 undefined，不阻断），其模型请求复用子代理/应用级 ContextBuilder（盘点 5、9 的注入点），故推断 actor 请求同样携带全局段；依据是 `subagent/context-builder.ts` L128 的统一 section 构造与 entrypoint 的无条件并入，未逐一追踪 `dynamic-workflow-runtime` 在途改动（`harness.ts` 等属分支在途文件）——该链路的实机验证列入「待实测」。

14.【已实测】分支在途状态：`codex/ccode-update-feed` 分支共 236 条未提交变更（`git status --porcelain` 实测）。与本拆项直接相关的在途文件：`apps\zcode-cli\packages\bootstrap\src\app\create-app.ts`（含 `createControllerSkillPort` 接线，盘点 6b）、`apps\zcode-cli\packages\core\src\context\sections\desktop.ts`（盘点 6c）、`packages\desktop\src\main\index.ts`（盘点 3）均「M」未提交；`dynamic-workflow-run-*.ts`、`workflow-driver*.ts` 等工作流驱动文件大量在途；另有未跟踪计划文档 `E:\ZCode\docs\superpowers\plans\2026-10-21-confidential-controller.md`（中台内存总控实施计划，标注「保留已有 dirty；不提交、推送或讲解」）。本文盘点按当前工作区字节实读，不预测在途改动走向。

15.【已实测】发布策略「按版本补充中台内容」当前未实施：`ccode-startup-global-prompt.md` L5 明确「此阶段不实施此前讨论的 85%/15% 分片」；客户端下载的是单一签名 bundle 的全部 `.md` 文件拼接（`application.ts` L61-L66），无抽取比例、内容边界或分片参数。母 PRD L82 把该能力定义为「由中台发布策略定义」，属于目标态而非现状。

## 四、需求细化

### 4.1 发布与版本消费

- R1.1 客户端只消费中台已发布版本：保留现有「authorize → download → 验签 → 摘要复核」链路（盘点 1），中台侧发布/撤销/最低版本策略不在本仓库实现；客户端不得自签或修改信任根（对齐 spec `ccode-confidential-controller.md` L290「客户端不得自签或修改信任根」）。
- R1.2 版本元数据扩展：私有通道 payload 与装配结果在 version/digest 之外补充「来源」（skillId、发布通道/租户标识）与「适用范围」（见 4.2）字段，字段进入可审计元数据面（台账消费由拆项 6 承接）；扩展字段不得携带正文。
- R1.3 版本固定语义：一次登录生命周期内固定同一装配结果（现状已满足，盘点 2）；登录生命周期结束后（登出/换账号/退出）旧正文随进程停止失效（现状：通道断开触发 CLI 关闭，`main.ts` L66-L68）。重新登录按新授权取新版本；中台撤销/明确拒绝时不回退本地副本（对齐母 PRD L96 与 spec L122）。
- R1.4 L82 的「按发布策略补充中台内容」列为目标态：抽取比例、内容边界、失败策略、版本固定方式全部由中台发布策略定义并随版本下发，客户端只做消费与验签，不自建抽取逻辑（对齐盘点 15 现状；实施排期依赖中台侧策略冻结，见开放问题 OQ-2）。

### 4.2 适用范围策略显式化（母 PRD L83）

- R2.1 定义产品级适用范围矩阵：普通聊天 / 任务执行 / 工作流 / 子任务四类范围各自是否启用总控全局段；策略默认值与合法取值形成文档与配置 schema（落点建议 `packages/shared`，与既有 zcode-protocol 类型同层）。
- R2.2 代码化判定：装配时按策略决定该 CLI 进程/该类会话是否注入 `globalSystemPrompt`（现状为无条件注入，盘点 9）；判定发生在客户端代码，不依赖提示词文案或模型自觉。
- R2.3 策略变更与审计：策略值随版本元数据可追溯（进入 R1.2 的元数据面）；策略禁用某范围时，该范围的模型请求 system 段不含总控 section，且该事实可通过脱敏诊断（占位符存在性）验证。
- R2.4 与既有口径对齐：`E:\ZCode\AGENTS.md` L13 与 spec `ccode-confidential-controller.md` L43（「普通聊天不激活总控」为旧默认路径描述）存在口径差，需评审拍板统一（开放问题 OQ-3）。

### 4.3 调用编排（母 PRD L78-L79、§2 目标 5-6）

- R3.1 步骤计划契约：总控产出的任务拆解步骤需携带结构化的能力调用声明——步骤类型（本地工具 / MCP 工具 / 数据中台接口 / 内部封装方法 / 专业专家）、目标能力标识、顺序与依赖。承载形态（扩展工作流步骤 schema 或独立计划对象）在实现前评审；协议改动须同步 `packages/shared` 的 zcode-protocol 严格类型与运行时校验（对齐 `E:\ZCode\AGENTS.md`「进程、协议与远程控制」节）。
- R3.2 "必须真实调用"标记：对必须依赖企业真实数据、内部 API 或 MCP 的步骤（母 PRD L21），在步骤声明中置 `requiresRealInvocation` 类标记；标记由产品规则与总控正文规则决定，进入拆项 6 的关闭门禁输入（缺该调用则不得标记完成）。本拆项只负责标记的产生与传递，不实现门禁。
- R3.3 专业专家：母 PRD L20「后续专业专家」与 L78「分派专业专家」目前无任何机制承载（现状盘点未发现对应代码）。最小形态需定义（复用子代理 profile、或中台发布的专家 skill、或后续独立专家通道），在定义前不得宣称已支持（开放问题 OQ-4）。
- R3.4 编排的执行边界：本地编排、本地执行不变（母 PRD §6 L102 排除整体迁移中台）；编排决定调用顺序（L20），执行仍走既有工具/MCP 运行时（盘点 11），不新建第二套工具执行路径。

### 4.4 企业能力接入（母 PRD L79、§5 L96-L97）

- R4.1 数据中台 MCP / 内部 API 接入面：为中台发布的企业能力（如上传）定义客户端接入方式（MCP 服务器配置经中台下发、或经既有中台 HTTP 通道的内部封装方法）；认证复用中台登录身份（复用 `platform-auth` 的 token 体系，不新增第二套凭据）。
- R4.2 示例能力验收基线：「页面采集后上传图片」必须有真实上传能力可调用（现状不存在，盘点 11）；在能力未配置/未授权时，任务失败状态与原因可区分（等待中/需要登录/需要权限/执行失败，对齐 §5 L97），不得以提示词输出「已上传」代替。
- R4.3 失败语义：中台不可用时，必须真实调用的步骤按固定错误分类失败（复用/对齐 `ConfidentialControllerError` 既有错误码族，`contract.ts` 中已定义 AUTHORIZATION_EXPIRED/AUTHORIZATION_REJECTED/AUTH_REQUIRED/IDENTITY_CHANGED/CANCELLED/UNAVAILABLE/EXECUTION_FAILED/INVALID_RELEASE/VERSION_CHANGED/CAPACITY_EXCEEDED，见 `apps\zcode-cli\packages\adapters\src\confidential-controller\bootstrap.ts` L16-L27）；不生成虚假完成结论（门禁本体属拆项 6）。
- R4.4 安全边界：企业能力接口响应不得进入普通日志/遥测/导出（§5 L95）；调用证据（toolCallId、能力标识、结果状态）进入拆项 6 的证据归并，不携带响应正文中的企业敏感数据。

### 4.5 受控正文不暴露的持续保障（母 PRD L80-L81、场景 7 后半句）

- R5.1 保留并回归三层 Skill 面拦截（盘点 6：core handler、adapter skill port、捆绑副本不随包），任何新增 Skill 入口（浏览、导出、复制、别名、插件注入）都要经过保留名判定 `isConfidentialControllerSkill`。
- R5.2 导出脱敏口径：普通聊天导出、会话历史、分享、压缩摘要与遥测均不含正文——现状靠「不持久化 + preview 占位 + skipTranscript」保障（盘点 5、7），需以回归用例固化「导出产物全文搜索正文特征零命中」类判据。
- R5.3 用户索取内部规则时使用固定公开回复（对齐 spec `ccode-confidential-controller.md` L175 的公开答复口径）；公开能力介绍不受限。

## 五、验收场景

以下判据均可回读核对，不以"完成/成功"类空话表述。

1. 场景 A（真实调用编排，母 PRD 场景 6 前半）：在配置了上传 MCP 能力的环境发起「采集页面并上传图片」任务，执行记录（会话事件流，`session.events.ts` L135-L139 定义的 `tool_call_started`/`tool_call_result`）中可按 toolCallId 回读到采集工具调用条目与上传 MCP 调用条目，且两事件的工具名与步骤计划（4.3 R3.1 契约）中声明的目标能力标识一致；步骤计划中标记 `requiresRealInvocation` 的步骤，其执行记录缺少对应调用条目时，任务状态字段不得为 completed（门禁本体由拆项 6 实现，本场景验收两者的衔接字段完整可达）。
2. 场景 B（发布→消费版本链，母 PRD 场景 7 前半）：管理员在中台发布新版本 controller 后，客户端退出并重新登录，CLI 私有通道 `bootstrap-ready` 消息中的 `version` 与中台发布版本一致；`digest` 与该版本正文 SHA-256 一致；旧登录代次的 CLI 进程已退出（可回读进程清单或断连日志）。签名/摘要不符时装配失败并返回固定错误码（INVALID_RELEASE），不进入工作区。
3. 场景 C（不作为普通 Skill 暴露，母 PRD L80、场景 7 后半句）：已登录桌面环境中，Skill 列表内「总控派单」条目的 path/directory 为空（仅元数据）；调用 Skill 工具「总控派单」只返回授权确认文本，不返回正文；经 loadSkill 路径读取该名返回 UNAVAILABLE；对导出的普通聊天记录执行正文特征全文搜索（以 bootstrap-ready 消息中 systemPrompt 的任意非空片段为特征）零命中。
4. 场景 D（适用范围策略显式化，母 PRD L83）：产品配置中存在聊天/任务/工作流/子任务四类范围的适用范围策略字段及其默认值文档；策略禁用「普通聊天」后，聊天会话的模型请求脱敏诊断中不出现全局总控 section 占位记录，而任务会话仍出现；策略值随版本元数据可回读（来源、版本、适用范围三字段齐备）。
5. 场景 E（中台不可用失败语义，母 PRD §5 L96）：断开中台后启动客户端，装配失败仅显示固定错误分类（如 AUTH_REQUIRED/UNAVAILABLE），不回退任何本地副本（磁盘上不存在正文文件，`bundled-skills` 下无总控文件可回读核实）；标记必须真实调用的任务步骤失败终态为执行失败并携带原因分类，任务状态字段不得为 completed。

## 六、依赖与里程碑

依赖：

- 既有 spec 基线：`ccode-startup-global-prompt.md`（当前默认执行路径）、`ccode-confidential-controller.md`（发布/授权/隔离与中台唯一来源补充）、`ccode-emergency-authorization.md`（备用包仅元数据衔接）；`E:\ZCode\AGENTS.md` L8-L14 产品约束（数据中台唯一来源、禁止明文入包/入本地技能目录/无授权离线回退）。
- 代码基线：`packages/services/src/confidential-controller/*`（应用所有者、HTTP source、私有通道）、`apps/zcode-cli/packages/adapters/src/confidential-controller/*`（bootstrap、skill-port、遗留 scope）、`packages/desktop/src/main/index.ts` 装配点——均为分支在途状态（盘点 14），实施前需以落地分支重估。
- 兄弟拆项：拆项 1（品牌与数据目录）、拆项 2（登录态恢复）为本拆项运行前提（登录→装配顺序）；拆项 6 消费本拆项的步骤标记与调用事件契约；拆项 3（更新通道）无直接耦合。
- 外部依赖：中台侧发布策略（L82 分片参数）、企业能力 API/MCP 规格、生产信任根确认（OQ-1）。

里程碑（建议顺序，均以前序完成与评审为条件）：

- M1 适用范围策略 schema 与装配判定落地（R2.1-R2.2），含策略可回读验收（场景 D）。
- M2 版本/来源/适用范围元数据扩展与私有通道字段演进（R1.2），打通场景 B。
- M3 步骤计划契约与 requiresRealInvocation 标记（R3.1-R3.2），与拆项 6 联调场景 A 判据。
- M4 企业能力接入面与上传示例能力（R4.1-R4.2），完成场景 A 全链路与场景 E。
- M5 导出脱敏与 Skill 面拦截回归固化（R5.1-R5.2），完成场景 C。
- 专业专家（R3.3）待产品定义后单列里程碑，不阻塞 M1-M5。

## 七、开放问题

- OQ-1【事实矛盾，需管理员/中台确认】桌面 Main 内置信任公钥的 SPKI SHA-256 实测为 `845e7cbf...bff21`（`packages\desktop\src\main\index.ts` L688-L689，node crypto 计算），而 `ccode-confidential-controller.md` L287-L288 记录首次发布信任根指纹为 `af5badd5...ed275`。两者不一致：可能为 spec 记录后公钥已轮换但 spec 未更新，或代码内置了非生产信任根。本拆项不改口径，按代码现状盘点，需中台管理员确认当前有效信任根后再决定改代码还是改 spec。**〔2026-10-23 已结案：同钥异码〕**总控对 Main 内置同一份 PEM 实算复核：`845e7cbf...bff21`=SPKI DER 字节 SHA-256，`af5badd5...ed275`=PEM 全文（含尾换行）SHA-256——**同一把公钥**，原 spec 记录口径表述不严谨所致；无轮换、代码即首次发布信任根、无需改。今后指纹统一 SPKI DER SHA-256 口径。结案证据：`ccode-confidential-controller.md`「中台唯一来源补充」节 2026-10-23 结案标注。
- OQ-2【口径确认】母 PRD L82 描述「每个版本可按发布策略补充一部分由数据中台提供的内容」，而 `ccode-startup-global-prompt.md` L5 明确「此阶段不实施此前讨论的 85%/15% 分片」。本拆项按「L82 为目标态能力、由中台发布策略定义、客户端仅消费」理解，不与 spec 现阶段声明冲突；若评审认为 L82 要求本期实施，需先冻结中台发布策略参数。
- OQ-3【口径差，需产品拍板】母 PRD L83 要求适用范围「由产品策略明确」；现状（AGENTS.md L13、spec `ccode-confidential-controller.md` 头部「默认运行路径已由启动全局提示词规范替代」）是认证后统一装配、四类范围全部继承，且旧 spec 用户目标 L43「普通聊天不激活总控」与现默认路径表述不一致。「普通聊天是否注入总控全局段」需产品明确，R2 的默认值矩阵依赖该拍板。
- OQ-4【能力缺失，需产品定义】「后续专业专家/分派专业专家」（母 PRD L20、L78）在仓库内无任何承载机制（现状盘点未发现对应代码或 spec）。最小形态（子代理 profile / 中台发布专家 skill / 独立通道）未定义前，R3.3 不能排期。
- OQ-5【外部规格未定】企业能力接入（R4）依赖中台侧 API/MCP 规格：除 `system/ccode-controller/authorize|content` 外，本仓库无任何中台企业能力端点信息（盘点 3、11）。上传能力的端点、鉴权与错误码规格需中台提供后才能固化 R4.1-R4.3 契约。
- OQ-6【遗留机制去留】旧按运行授权机制（acquire/complete 私有消息、assertControllerReady 门、prepareWorkflowController 绑定、session-store 绑定端口，盘点 10）在当前装配下休眠但代码仍在。启动全局提示词路线定稿后，这些路径是清理、保留为后续阶段能力、还是转为 L82 版本固定语义的一部分，需与 spec 所有者共同决定，避免双路径歧义。
- OQ-7【待实测】动态工作流 actor 的全局段继承链路（盘点 13）为推断，需在实机环境用脱敏诊断核实 actor 请求均含全局 section；`dynamic-workflow-run-*` 系列分支在途改动（盘点 14）可能影响该链路，落地前需重估。
