# CCode PRD 拆项4：ZCode 项目与会话导入

- 任务卡：20261022-04R（总控台账第 22 行，E:\ZCode\docs\prd\总控台账.md）
- 母 PRD：E:\ZCode\docs\prd\ccode-product-prd.md（v1.0，待评审），本卡承接 §8「后续拆分」第 4 项（ccode-product-prd.md#L121）
- 对应母 PRD 条目：§2 目标 4、§3 用户场景「从 ZCode 迁移的员工」、§4.2 第 4/5 条（导入边界与结果报告）、§4.5 全部、§7 验收场景 4（后半）与 5
- 盘点基线：仓库分支 `codex/ccode-update-feed` 当前工作区（含大量未提交改动），盘点时间 2026-10-22，全部以工作区实读为准
- 边界声明：本文档只做需求拆分与现状锚定，不改任何代码；对用户真实 `~/.zcode` 数据目录不枚举、不读取，仅引用代码中的路径常量

## 一、背景与目标

CCode 与 ZCode（原版）在本机并存且数据目录互相隔离（拆项1 已固化该现状）。对从 ZCode 迁移过来的员工，需要一条**用户主动触发、默认复制、可核对结果**的导入链路。母 PRD 相关原文锚定如下（引用与 ccode-product-prd.md 原文逐字一致，行号为当前文件行号）：

- §2 目标 4（L19）：
  > 用户可导入已有 ZCode 项目与可迁移的会话历史，并明确查看导入结果与不可导入项。
- §3 用户场景（L29）：
  > 从 Zcode 迁移的员工 | 导入项目、会话与工作目录 | 可选择导入范围，原数据不被删除，导入结果可核对
- §4.2 第 4 条（L47）：
  > 需要导入 ZCode 数据时，只能通过用户触发的导入流程读取；导入默认复制，不能删除或迁移走原始 ZCode 数据。
- §4.2 第 5 条（L48）：
  > 导入完成后生成清晰的结果：成功项目/会话数、跳过原因、需人工处理的内容。
- §4.5 全部五条（L68-72）：
  > - 提供“从 ZCode 导入”入口，支持选择：项目、会话历史、收藏/置顶、工作目录映射和模型配置。
  > - 导入前展示来源路径、预计数量、重复项处理策略及不支持的数据类型。
  > - 会话导入保留原始时间、标题、消息与附件引用；无法访问的附件要显示缺失状态，不阻断其他会话。
  > - 同一来源重复导入应能识别已导入内容，避免生成重复任务。
  > - 用户可选择只导入项目、不导入会话，或反向选择。
- §6 不在本期范围（L104）：
  > 直接删除、改写或接管用户原有的 ZCode 数据目录。
- §7 验收场景 4 后半（L111）与场景 5（L112）：
  > 安装 CCode 不会创建、修改或读取 ZCode 默认数据目录；用户主动导入后，ZCode 原数据仍完整可用。
  > 用户导入项目和会话后，重复导入不会制造重复记录；缺失附件能被标识。

**锚定校验结论**：母 PRD §4.5 与 §4.2 第 4/5 条、§7 场景 4/5 之间未发现口径矛盾，可原样承接；与仓库现状的差距全部列入「三、现状盘点」与「四、需求细化」，不自行改母 PRD 口径。发现的两个需要拍板的口径冲突（重复导入去重键与既有 Claude 导入哲学不一致、`migration_source` 枚举未建模 ZCode 来源）列入「七、开放问题」。

本卡目标：把 §4.5 的五条需求落成可实施、可验收的拆分需求，明确数据所有者与写入路径边界，固化客观验收判据。

## 二、范围（内/外）

### 范围内

- **导入入口**：设置页（含 onboarding 复用，与既有迁移向导入口关系见 O8）提供「从 ZCode 导入」入口；来源默认为本机 ZCode 默认数据根 `~/.zcode`（仅代码常量引用，不预设用户目录内容）。
- **导入范围选择**（§4.5 第 1 条五类）：
  1. 项目（Host 侧 `projects`/`project_roots`/`hosts` 组织态）
  2. 会话历史（CLI 侧 `session`/`message`/`part` 会话事实 + Host 侧 tasks 行）
  3. 收藏/置顶（Host 侧 `tasks.pinned`、`projects.pinned` 组织态）
  4. 工作目录映射（导入会话/项目的 `workspace_path`、绑定目录 `cwd`/`root_path` 的呈现与映射规则）
  5. 模型配置（ZCode 侧模型/提供商偏好配置的复制，具体子项见 O5）
- **导入前预览**（§4.5 第 2 条）：来源路径、预计数量（项目数/会话数）、重复项处理策略、不支持的数据类型清单。
- **导入执行语义**（§4.5 第 3、4、5 条 + §4.2 第 4 条）：默认复制、只读打开来源库、原数据不被删除/移动/改写；保留原始时间/标题/消息/附件引用；缺失附件显示缺失状态且不阻断其他会话；同一来源重复导入可识别已导入内容；项目与会话可任选其一。
- **导入结果报告**（§4.2 第 5 条）：成功项目/会话数、逐项跳过原因、需人工处理内容（含缺失附件统计）。

### 范围外

- CCode 数据目录隔离、打包态品牌根注入、升级时的一次性 CLI 库快照迁移（拆项1，`docs/specs/ccode-storage-isolation.md` 已覆盖；本卡只消费其边界结论，见断言 I-2）。
- 「安装 CCode 不读取 ZCode 目录」的前半句验收（拆项1 场景 A4/A5）；本卡只覆盖 §7 场景 4 的后半句（主动导入后原数据完整可用）。
- 登录态恢复（拆项2）、自有更新通道（拆项3）、总控专家（拆项5）、台账校验（拆项6）。
- `restore-legacy-sessions` 官方插件的既有能力（ACP 旧版 `~/.zcode/v2/sessions` 快照恢复）：属存量能力，本卡不改其行为，只作为幂等写入模式参考（断言 I-6）。
- Claude Code / 外部 Agent（Codex、OpenCode 等）的技能/命令/MCP 导入：既有 `settings-sync` external-agent 系列与本卡无关，仅作交互模式参考（断言 I-7）。
- 跨机器迁移（源目录不在本机，如从备份盘/他人机器导入）：母 PRD 未明确，本卡限定同机导入，跨机映射列入 O4。
- 母 PRD §6 排除项：任务续接故障、五分钟授权、`Confidential controller: EXECUTION_FAILED` 修复。

## 三、现状盘点

以下断言基于当前工作区实读。标注约定：**已实测**（附路径与行号/符号名，本轮实际读取源码）；**推断**（说明依据）；**待实测**（本轮未覆盖）。另注：任务卡所列参考文档 `E:\ZCode\docs\specs\zcodeplan-import.md`、`external-agent-commands-import.md`、`restore-legacy-sessions-official-plugin.md` 在 `docs\specs\` 下均不存在，实际位于 `E:\ZCode\docs\` 根目录（已逐一实读）；`zcodeplan-import.md` 内容是 zcode-server Go 源码附加说明，与会话导入功能无关，不作为本卡依据。

### 3.1 数据布局与目录差异

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| I-1 | CCode 打包态数据根独立于 ZCode：`app.isPackaged` 时 `ZCODE_DESKTOP_HOME_DIR`/`ZCODE_DATA_BASE_DIR` = `appData/{CCode \| CCode Preview}/data`，其下统一用 `.zcode/{v2,cli}` 子布局；ZCode 原版数据根为 `homedir()/.zcode`。两侧**同构 schema、不同根目录**，导入即同版本库间的选择性复制 | `E:\ZCode\packages\desktop\src\main\desktopEarlyDataBaseDirBootstrap.ts` L9-14、L22-26；`E:\ZCode\apps\zcode-cli\packages\adapters\src\storage\session-store\paths.ts` L8-15（`getDefaultSessionDbPath`）；`E:\ZCode\docs\specs\ccode-storage-isolation.md` | 已实测 |
| I-2 | 已存在一条**自动、一次性、非用户选择**的升级迁移：仅当品牌根已有 `v2/tasks-index.sqlite` 且独立 CLI 库缺失时，把 `~/.zcode/cli/db/db.sqlite` 以只读 SQLite backup 快照复制到品牌库（quick_check + 全表行数核对 + 硬链接原子发布 + 目标存在绝不覆盖）。它不提供项目/会话选择、不覆盖 §4.5 的导入入口需求；且复制的是整库，与「用户选择性导入」并存时构成重复导入风险（见 O6） | `E:\ZCode\apps\zcode-cli\packages\adapters\src\storage\session-store\paths.ts` L26-65（`migrateLegacyDesktopSessionDb`）；legacy 指针注入 `E:\ZCode\packages\desktop\src\main\desktopEarlyDataBaseDirBootstrap.ts` L27-31 | 已实测（代码）；运行验收未执行 |
| I-3 | 会话事实与组织态分库且写者唯一（2026-09 收口重构不变量）：CLI `db.sqlite`（`session`/`message`/`part` 表，存在性=软删除 `time_deleted`、标题+`title_source`、`time_created/updated`）唯一写者 CLI；Host `v2/tasks-index.sqlite`（`tasks` 表含 `workspace_key`、`pinned`、`archived`、`unread_at`、`cli_*` 镜像列，`projects`/`hosts`/`project_roots`/`remote_project_entries` 组织态表）唯一写者 Host/taskIndexSyncer。`tasks` 表唯一约束 `ON CONFLICT(workspace_key, task_id)` | CLI：`E:\ZCode\apps\zcode-cli\packages\adapters\src\storage\session-store\repositories\sessions.ts` L20-74（`createSession` 支持显式 `time.created/updated`）、L128-138（`softDeleteSession`）；Host：`E:\ZCode\packages\services\src\session\taskIndexRepo.ts` L45-77（`TaskIndexRow`）、L819-827（`ON CONFLICT(workspace_key, task_id) DO UPDATE`）、`E:\ZCode\packages\services\src\project-storage\schema.ts` L3-21（`PROJECT_SCHEMA_SQL`）、L23-36（`TASK_PROJECT_COLUMNS`）；设计依据 `E:\ZCode\.agents\skills\session-management\SKILL.md` 第 1、2 节 | 已实测 |
| I-4 | Host 任务索引路径与 workspace 身份键已收口：`getTasksIndexDatabasePath()` = `{dataBaseDir}/.zcode/v2/tasks-index.sqlite`；`workspaceKey = workspaceIdentity?.trim() \|\| workspacePath`；会话快照目录 hash = workspaceKey 的 SHA-256 前 12 位（`v2/sessions/{hash}/{taskId}.json` legacy 备份） | `E:\ZCode\packages\services\src\paths.ts` L188-191、L193-204（`getWorkspaceKey`/`getWorkspaceHash`）、L211-218（`getLegacyTaskSessionSnapshotPath`） | 已实测 |
| I-5 | 服务层已有按 dataBaseDir 复制 `.zcode/v2` 的工具 `copyDataDirectory`（递归、`force:false`、排除 `setting.json*`、跳过符号链接），当前用于用户切换数据目录，可作为项目/置顶等 Host 态复制的参考，但**不区分项目/会话粒度** | `E:\ZCode\packages\services\src\paths.ts` L245-269 | 已实测 |

### 3.2 会话导入语义现状（时间/标题/消息/附件）

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| I-6 | `restore-legacy-sessions` 官方插件提供旧版会话恢复的**幂等写入模式**：稳定恢复 id（`restoredTaskId = acpSessionId \|\| legacyTaskId`，不新建 id），task-index 按 `ON CONFLICT(workspace_key, task_id) DO UPDATE` upsert；恢复前做时间戳备份；provider 统一写 `glm`（否则任务列表被过滤）；刻意不写 `migration_source`（该枚举保留给 Claude Code 导入专线） | `E:\ZCode\apps\zcode-cli\packages\restore-legacy-sessions-plugin\skills\restore-legacy-sessions\scripts\restore-conversation.mjs` L283-321（id 派生）、L367-386（upsert）；`E:\ZCode\docs\restore-legacy-sessions-official-plugin.md`「行为边界」节；`E:\ZCode\docs\migration\legacy-session-restore-skill.md` L29、L56 | 已实测 |
| I-7 | Claude Code 原生导入是现有完整「扫描→选择→导入→结果」管线，但**重复导入不去重**：每次导入经 `createImportedSession` 新建 CLI 会话（新 taskId/新 traceId），适配层注释明确「显式重新导入产生新 CLI 会话，不能用来源 hash 覆盖已删除或已继续对话的记录」；扫描阶段也不把已导入项从候选中过滤。这与 §4.5 第 4 条「同一来源重复导入应能识别已导入内容，避免生成重复任务」**不满足**（差距，非母 PRD 矛盾） | `E:\ZCode\packages\services\src\session\claude-native\claudeNativeSessionImportService.ts` L42-169（`importClaudeNativeSessions`，无已导入检查）；`E:\ZCode\packages\services\src\zcode-agent\zcodeTaskServiceAdapter.ts` L2750-2770（`importClaudeSessions` 适配层，L2767 注释）；扫描不过滤已导入：`E:\ZCode\packages\services\src\session\claude-native\claudeNativeSessionImportRepo.ts` L128-207（`scanImportableSessions`） | 已实测 |
| I-8 | 导入会话的时间与消息保序机制已存在（CLI 侧）：`session/create` 的 `importedHistory` 路径按来源 `createdAt/updatedAt` 建 session；消息 id 确定性派生（`{sessionId}_import_{index}`）；时间戳收敛为单调递增以保序；重复导入同一 sessionId 会先 `removePreviousImportedSessionHistory` 清除旧导入消息再写（按 `migrationSource` 元数据匹配） | `E:\ZCode\apps\zcode-cli\packages\bootstrap\src\zcode-protocol\server-operations.ts` L1148-1231（`createSession` 含 `time:{created,updated}` L1163-1166、清旧 L1169-1173、确定性 id L1185、单调时间 L1177-1184） | 已实测 |
| I-9 | 附件以**绝对路径引用**为主：GUI 协议附件（image/file/audio/video/pdf）优先携带 `localPath`（桌面真实本地路径），大文件不进协议正文；CLI runtime 侧映射为 `path` 引用读取；输入历史附件为 JSON 列。**没有任何「附件缺失」的展示态建模**——`ZCodePrompt*Attachment` 只有存在字段，无 missing 状态 | `E:\ZCode\packages\shared\src\zcode-task-types-core.ts` L193-219（`ZCodePromptImageAttachment.localPath` L204、`ZCodePromptFileAttachment.localPath` L218 及注释）；`E:\ZCode\apps\zcode-cli\packages\bootstrap\src\zcode-protocol\server-operations.ts` L535-598（localPath→path 映射）；输入历史 `E:\ZCode\apps\zcode-cli\packages\adapters\src\storage\session-store\rows.ts` L80-88（`InputHistoryRow.attachments`） | 已实测（类型与写入路径）；消息渲染层缺失态 UI 待实测 |
| I-10 | 任务列表可见性按 provider 过滤：ZCode Agent 列表入口只展示 `provider = glm` 的行（旧 Claude Code 导入的 provider 例外已取消）。ZCode 原版库内会话本就是 glm runtime 产物，导入后可见性无过滤问题；恢复/导入写库时 provider 必须保持 `glm` | `E:\ZCode\packages\services\src\session\taskIndexRepo.ts` L32-41（`appendZCodeAgentIndexedProviderFilter` 及注释）；佐证 `restore-conversation.mjs` L302 注释（「必须按 glm 写入，否则任务列表会被过滤掉」） | 已实测 |
| I-11 | `migration_source` 枚举当前只建模 `"claudeCode"` 一个值，类型注释明确「后续其它来源继续在这里扩展」；realtime schema 同步收紧为同值。若 ZCode 导入需要来源标记，须扩展该枚举并同步 `zcodeTaskMigrationSourceRealtimeValues` 与校验 schema | `E:\ZCode\packages\shared\src\zcode-task-types-core.ts` L60-61（`ZCodeTaskMigrationSource`）；`E:\ZCode\packages\shared\src\task-realtime-core.ts` L30-32、L67；`E:\ZCode\packages\shared\src\validation.ts` L1803 | 已实测 |

### 3.3 入口与交互现状

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| I-12 | **不存在「从 ZCode 导入」入口**：UI 与服务层检索 `从 ZCode` / `importFromZCode` / `zcode-import` / `legacyImport` 零命中（命中的均为无关注释/测试文案）；§4.5 第 1 条所需入口为全新能力 | `E:\ZCode\packages\ui\src`、`E:\ZCode\packages\services\src`、`E:\ZCode\apps\zcode-cli\packages` 全量 rg 检索（2026-10-22 执行，零有效命中） | 已实测（检索） |
| I-13 | 现有 onboarding 迁移向导（Sessions→Skills→MCP→Commands→AGENTS.md→Migration 六步）只覆盖 Claude Code 来源与外部 Agent 资源导入；Sessions 步仅选 workspace 范围、不启动导入，Migration 步统一执行并展示结果摘要——该「选择与执行分离 + 结果摘要」结构可作为 ZCode 导入交互的复用骨架 | `E:\ZCode\docs\ui\onboarding-migration-flow.md`（Current Flow/Sessions 步语义）；UI 状态 `E:\ZCode\packages\ui\src\hooks\useClaudeSessionMigration.ts` L61-115（desktopOnly 能力判定）、L147-192（扫描）、L194-240（导入与结果回填）；服务接口 `E:\ZCode\packages\services\src\session\zcodeTaskService.ts` L571-583（`scanImportableClaudeSessions`/`importClaudeSessions` 声明） | 已实测 |
| I-14 | 外部 Agent 资源导入（技能/命令/MCP/插件）的服务端来源表与「软链/复制、同名跳过、全局/项目目标」策略集中于 settings-sync，其弹窗交互（两层来源树、全选、导入目标、完成结果列表）是既有的导入 UI 范式 | `E:\ZCode\packages\services\src\settings-sync\settingsSyncService.ts` L62-329（四组 `SUPPORTED_*_AGENT_SOURCES` 来源表）；`E:\ZCode\docs\external-agent-commands-import.md`（导入策略与 UI 行为） | 已实测 |
| I-15 | Host 索引行可由 CLI 事实自动补齐：taskIndexSyncer 在 workspace 首次 sessions-index 基线时 `seedMissingRowsFromInitialSnapshot` 批量镜像缺失行（不广播、不覆盖产品壳状态）。意味着若走「整库/批量复制 CLI 库」路线，Host 行可在打开对应 workspace 时惰性补齐；但**未打开的 workspace 不会自动出现**，项目/置顶等组织态仍需 Host 侧显式导入 | `E:\ZCode\packages\services\src\zcode-agent\zcodeTaskIndexSyncer.ts` L708-741（`seedMissingRowsFromInitialSnapshot` 及注释） | 已实测 |
| I-16 | 模型/提供商配置落点：GLM 配置目录为 `{dataBaseDir}/.zcode/cli`（`getProviderWorkspaceConfigDir`，不做 workspace 隔离）；模型偏好的具体文件粒度（哪些键属于「模型配置」可导入子集）未在本轮逐一核验 | `E:\ZCode\packages\services\src\paths.ts` L229-238 | 路径已实测；配置粒度待实测 |
| I-17 | 会话绑定目录（cwd）创建后永不变、项目移动只改归属（重构不变量 I2），且 `workspaceKey` 只做身份判等、执行路径永远用 `workspacePath`（不变量 I1）——「工作目录映射」导入项必须遵守：导入不改会话绑定目录，只允许在**新建行时**落映射后的路径 | `E:\ZCode\.agents\skills\session-management\SKILL.md` 不变量 I1、I2（第 2 节表格）；代码佐证 `taskIndexRepo.ts` L105-122（workspaceKey 投影规则） | 已实测（skill + 代码） |

## 四、需求细化

以下 R 编号承接母 PRD 原文，逐条落成仓库需求；每条标注所依赖的现状断言与新增点。实现约束（R8）优先级最高。

### R8 数据所有者与写入路径（实现前提，源自 session-management 不变量）

- R8.1 会话事实（存在性、标题、时间、正文、消息/附件 parts）只能经 CLI session store 写入目标 `db.sqlite`；Host 不得直写 CLI 库。ZCode→CCode 导入建议复用「协议 `session/create` + `importedHistory`」或等价的 CLI 侧写入端点（断言 I-8 已有该路径），不得在 services 层直接 INSERT 目标 CLI 库。
- R8.2 组织态（projects/roots/hosts、pinned、archived）只能经 Host taskIndexRepo/project-storage 写入目标 `v2/tasks-index.sqlite`，且新列遵守「schema 只加不删、`ON CONFLICT(workspace_key, task_id)` 保留」纪律。
- R8.3 来源库一律以**只读**方式打开（`readOnly: true`，参照 I-2 快照迁移做法），不 attach 可写、不修复、不 checkpoint 来源库；来源路径仅允许 `~/.zcode` 及其子路径（或用户显式选择的等价 ZCode 数据根），不得枚举其他用户目录。
- R8.4 导入是**一次性批处理**，不建立持续同步；不得写入来源库任何标记（区别于某些迁移方案的来源打标）。

### R1 导入入口与范围选择（§4.5 第 1 条）

- R1.1 设置页提供「从 ZCode 导入」入口；默认来源为 ZCode 默认数据根（代码常量 `homedir()/.zcode`，见断言 I-1），允许用户显式改选其他 ZCode 数据根路径（该路径必须含 `.zcode/v2/tasks-index.sqlite` 或 `.zcode/cli/db/db.sqlite` 才被接受为有效来源）。
- R1.2 五类范围独立勾选：项目 / 会话历史 / 收藏/置顶 / 工作目录映射 / 模型配置；收藏/置顶仅在同时导入对应会话/项目时生效（置顶是 Host 组织态，无宿主行的置顶无意义）。
- R1.3 桌面端限定（参照 I-13 `desktopOnly` 判定）：来源库在本机文件系统；远程 workspace / Web 端不展示该入口。

### R2 导入前预览（§4.5 第 2 条）

- R2.1 预览页必须展示：来源根路径；预计导入项目数与会话数（分别来自来源 `v2/tasks-index.sqlite` 的 projects/tasks 未删行与来源 CLI 库 session 未删行）；不支持的数据类型清单（首版至少列出：remote hosts/远程项目入口、分组（task_groups）、定时/闲时任务、Bots、工作流运行记录——按 I-3/I-15 这些属 Host 组织态或运行态，是否纳入后续版本）。
- R2.2 重复项处理策略在预览中明示（默认策略按 O1 拍板结果落定：识别为「已导入」并跳过，或按稳定 id 幂等 upsert），并允许用户在执行前查看将被跳过的清单。
- R2.3 预览读取只读、可重复执行（重扫不产生副作用）。

### R3 会话导入语义（§4.5 第 3 条）

- R3.1 保留原始时间：目标 session 行 `time_created/time_updated` 取来源值（CLI `createSession` 已支持显式 `time`，断言 I-3/I-8）；消息时间保序收敛沿用 I-8 的单调递增策略，不因导入改写来源相对顺序。
- R3.2 保留标题与 `title_source`（用户 override 优先级不因导入丢失，对应不变量 I8「快照永不覆盖 override」）。
- R3.3 保留消息与附件引用：消息正文、parts、附件 `localPath` 原样复制（路径语义见 R5 工作目录映射）；附件本体不强制复制（附件在用户工作目录内，属工作目录映射范畴）。
- R3.4 **缺失附件不阻断**：单个会话的附件引用指向不可访问路径时，该会话仍导入成功；在会话视图与导入结果中显示「附件缺失」状态（当前无此展示态，需新增建模，见 O3）；缺失不改变会话时间/标题等其他字段。
- R3.5 单会话失败不阻断批次：导入按会话粒度事务化，失败项进入结果报告 `failed` 列表（复用 I-13 的 `ZCodeImportSessionsResult { imported, skipped, failed }` 形状并扩展项目维度）。

### R4 重复导入识别（§4.5 第 4 条）

- R4.1 必须存在**确定性去重键**，重复导入同一来源时已导入内容被识别。候选方案见 O1；无论拍板哪种，验收判据以「同来源连续导入两次，目标 tasks 行数增量 = 0 且 CLI session 行数增量 = 0」为准（五、场景 A1）。
- R4.2 去重识别不得依赖来源库写入（配合 R8.4，标记只能落目标侧）。
- R4.3 去重需覆盖 I-2 一次性快照迁移已带入的会话（同一批内容经自动迁移进入后再经导入入口导入，不得重复；见 O6）。

### R5 范围项落地细则（§4.5 第 1、5 条）

- R5.1 **项目**：来源 `projects`/`project_roots`/`hosts`（本地 host 部分）复制到目标库；名称冲突（目标同 host 同名未删项目，受 `idx_projects_host_name` 唯一索引约束，断言 I-3）按「导入为 `原名 (ZCode)`」或跳过处理，预览中说明。
- R5.2 **只导项目不导会话 / 只导会话不导项目**（§4.5 第 5 条）：两种组合都必须可用。只导项目时项目为空容器（合法状态，0 root 本地项目自动建默认 root 的规则需豁免导入场景）；只导会话时未归类会话进入任务区（`project_id IS NULL` 合法，断言 I-17/收口重构）。
- R5.3 **收藏/置顶**：随会话/项目行一并写入目标 `pinned` 列；与目标已有同 id 行合并时保留目标侧用户已变更的置顶状态（目标侧用户操作优先于来源）。
- R5.4 **工作目录映射**：同机导入默认映射为恒等（来源 `workspace_path`/`root_path` 在目标机仍有效）；预览中列出会话绑定目录与项目 roots 的绝对路径清单供用户确认存在性；目录不存在的会话标记为「需人工处理」但不阻断（与 R3.4 同理）。导入后不得改写已创建会话的绑定目录（不变量 I2）。
- R5.5 **模型配置**：按 O5 拍板的子集（最小为默认模型/思考级别偏好）从来源配置复制到目标 `{品牌根}/.zcode/cli` 对应位置；不得整目录覆盖目标配置（避免把 ZCode 运行时状态、凭据缓存带入 CCode）。

### R6 复制语义边界（§4.2 第 4 条）

- R6.1 导入全程对来源只读；执行前后来源 `cli/db/db.sqlite`、`v2/tasks-index.sqlite` 及其 `-wal`/`-shm` 文件内容不变（验收场景 A2 以字节哈希核对）。
- R6.2 不删除、不移动、不重命名来源任何文件；不修改来源目录 mtime 之外还要避免 checkpoint 行为（只读打开即可满足）。
- R6.3 导入失败中途退出不得留下半写状态影响来源（来源天然无写；目标侧按 R3.5 会话粒度事务 + 项目粒度事务回滚）。

### R7 导入结果报告（§4.2 第 5 条）

- R7.1 完成页展示：成功项目数、成功会话数、逐项跳过原因（已导入/名称冲突/目录缺失/不支持类型）、失败原因、需人工处理项（缺失附件统计、目录不存在清单）。
- R7.2 结果结构复用/扩展 `ZCodeImportSessionsResult`（`packages/shared` 既有形状，断言 I-13），项目维度并列返回；报告数据可被 E2E 断言读取（不只 UI 文案）。

## 五、验收场景

每条为可回读的客观判据（静态判据注明确切文件与检索式；运行判据注明操作、观察点与量化口径）。A1-A5 对应母 PRD §7 场景 5 与 §4.5/§4.2 条目；A6 对应 §7 场景 4 后半。

- **A1 重复导入幂等（§4.5 第 4 条 / §7 场景 5）**：构造含 ≥2 个项目、≥3 个会话的 ZCode 来源目录（fixture，不触碰真实用户目录），对同一目标连续执行两次全量导入。判据：第二次执行后目标 `v2/tasks-index.sqlite` 中 `select count(*) from tasks where deleted=0` 与第一次执行后相等（增量=0）；目标 CLI `db.sqlite` 中 `select count(*) from session where time_deleted is null` 增量=0；第二次结果报告中全部条目归类为「已导入跳过」（`skipped` 计数=第一次 `imported` 计数，`imported`=0）。
- **A2 来源只读（§4.2 第 4 条 / §7 场景 4 后半）**：导入执行前后对来源 `~/.zcode/cli/db/db.sqlite`、`~/.zcode/v2/tasks-index.sqlite` 及同目录 `-wal`/`-shm` 计算字节哈希（含文件 mtime 记录），全部一致；来源目录文件清单（含子目录 `v2/sessions`、`cli`）导入前后 diff 为空。
- **A3 缺失附件标识且不阻断（§4.5 第 3 条 / §7 场景 5）**：来源 fixture 中 1 个会话含 `localPath` 指向不存在文件的附件、另 1 个会话正常。判据：两个会话均导入成功（`imported`=2，`failed`=0）；结果报告「需人工处理」含缺失附件计数 ≥1；打开缺失附件会话，该附件渲染为缺失态（可检索的 UI 状态标识或测试可达的 data 属性），其余消息与会话正常打开。
- **A4 选择性导入（§4.5 第 5 条）**：仅勾选「项目」执行导入后，目标 `projects` 未删行数增加 = 预览项目数，而 `tasks` 未删行数与 CLI session 未删行数增量均为 0；仅勾选「会话历史」执行导入后，目标 `tasks` 行数增加 = 预览会话数，`projects` 行数不变。
- **A5 结果报告可回读（§4.2 第 5 条）**：一次混合导入（含 1 个名称冲突项目、1 个缺失目录会话）后，结果结构中 `imported.projects/sessions`、`skipped[]`（含 reason 字段，逐项可枚举）、`failed[]`、`needsAttention[]`（缺失附件/目录清单）与实际 fixture 计数一致；UI 完成页展示的四个数字与服务返回值一致（E2E 读取同一数据源）。
- **A6 入口存在性（§4.5 第 1 条，静态）**：回读 `E:\ZCode\packages\ui\src`（设置页组件）存在「从 ZCode 导入」入口的稳定文案键/组件符号（检索式如 `rg -n "从 ZCode 导入" packages/ui/src` 有命中，或存在 `ZCodeImport*` 命名的入口组件）；非桌面端（Web/远程 workspace）该入口不可见（能力判定复用 I-13 的 desktopOnly 模式）。
- **A7 类型检查与 lint（AGENTS.md 纪律）**：实现合入前 `pnpm typecheck` 与 `pnpm lint` 真实通过；涉及 schema 变更（如 `migration_source` 扩枚举）时 `schema.baseline.sql` 与 migration `touchedTables` 同步更新且逐表哈希单测存在（session-management 第 4 节纪律）。

## 六、依赖与里程碑

### 依赖

- **上游拆项**：拆项1「品牌与数据目录隔离」（`E:\ZCode\docs\prd\split\01-brand-and-data-isolation.md`）的 R3.4 导入边界与 D1-D6 现状是本卡前提；本卡不重述目录隔离判据。
- **上游 spec（已存在，实现前必须重读）**：`E:\ZCode\docs\specs\ccode-storage-isolation.md`（一次性快照迁移与只读约束）、`E:\ZCode\docs\restore-legacy-sessions-official-plugin.md`（幂等恢复行为边界）、`E:\ZCode\docs\migration\legacy-session-restore-skill.md`（`migration_source` 语义保留裁决）、`E:\ZCode\docs\ui\onboarding-migration-flow.md`（既有迁移向导交互）、`E:\ZCode\docs\external-agent-commands-import.md`（外部 Agent 导入 UI 范式）。
- **设计纪律**：`E:\ZCode\.agents\skills\session-management\SKILL.md`（两库写者唯一、schema 只加不删、`ON CONFLICT(workspace_key, task_id)` 保留、cwd 永不变）；改动命中该 skill 列出的文件时按其检查清单执行。
- **协议面**：如需新增 RPC（导入扫描/预览/执行），按 `E:\ZCode\AGENTS.md` 同步更新 `packages/shared/src/zcode-protocol/index.ts` 并提供运行时校验。
- **外部输入**：开放问题 O1（去重键）与 O5（模型配置子集）阻塞 R4/R5.5 编码；O3（缺失态建模）阻塞 R3.4 的 UI 部分；其余不阻塞判据固化。
- **测试环境**：A1-A5 需要可运行的桌面产物与构造的 ZCode 来源 fixture（禁止使用真实用户 `~/.zcode`）。

### 里程碑

- **M1 判据固化（本卡交付）**：本文档评审通过，现状盘点（I-1~I-17）与验收场景（A1-A7）成为拆项4 回读基线。
- **M2 服务层管线**：O1/O5 拍板后实现来源扫描/预览/导入执行（含去重、只读打开、结果结构扩展），配套单测（fixture 前后哈希、重复导入幂等）。
- **M3 入口与结果 UI**：设置页入口、范围选择、预览页、完成报告页；复用 onboarding/settings-sync 既有交互骨架（I-13/I-14）。
- **M4 运行验收**：在打包产物上执行 A1-A5（含 I-2 自动迁移交叉场景 O6），结果记入总控台账；未执行部分如实标注，不宣称完成。

## 七、开放问题

- **O1 重复导入去重键（阻塞 R4/M2）**：母 PRD §4.5 第 4 条要求重复导入识别；但既有 Claude Code 导入管线刻意「每次导入新建会话」（断言 I-7，注释明确不用来源 hash 覆盖），而 restore 插件用稳定 id 幂等 upsert（断言 I-6）。两种哲学并存，ZCode 导入必须拍板其一：(a) 稳定来源键（如来源 sessionId 直接复用 + `ON CONFLICT(workspace_key, task_id)` upsert）；(b) 目标侧记录「来源指纹」（来源库路径+sessionId 集合）作为跳过依据；(c) 沿用新建+靠扫描过滤。选项 (a) 与「目标侧用户已删除/已继续对话的会话被重新导入覆盖」存在张力（I-7 注释即为此顾虑），需产品明确「重复导入时目标侧用户后续操作优先」的具体语义。本卡不自行拍板。
- **O2 `migration_source` 枚举扩展（阻塞 R4 实现细节）**：若拍板需要来源标记（用于列表展示「来自 ZCode」或去重），须把 `"zcode"` 加入 `ZCodeTaskMigrationSource`（`packages/shared/src/zcode-task-types-core.ts` L60-61）并同步 realtime 枚举与校验 schema；但 `docs/migration/legacy-session-restore-skill.md` 裁决该字段「保留给 Claude Code 原生导入」，扩枚举是对该裁决的修订，需在 spec 层先改口径。
- **O3 附件缺失展示态建模（阻塞 R3.4 UI）**：当前附件类型无 missing 状态（断言 I-9），需新增协议/UI 状态（只读展示用，不引入附件重传交互）；落点（part metadata vs 渲染层判定 `localPath` 可访问性）待设计，倾向导入时一次性判定并落结果报告 + 渲染层按需探测，避免每帧文件系统探测。
- **O4 跨机/跨盘符映射（不阻塞同机首版）**：母 PRD「工作目录映射」未定义映射表交互；本卡 R5.4 限定同机恒等映射。跨机导入（来源路径在目标机不存在）是否提供用户编辑映射表，留待后续版本拍板。
- **O5 模型配置导入子集（阻塞 R5.5）**：`{dataBaseDir}/.zcode/cli` 配置目录混合了模型偏好、运行时状态与凭据缓存（断言 I-16 待实测项）；需拍板白名单（如仅默认模型/思考级别），否则整目录复制违反「新安装不读取/覆盖」精神与 R6 边界。
- **O6 与一次性快照迁移的交叉（阻塞 R4.3）**：I-2 自动迁移（升级场景，整库快照）可能已把同一批 `~/.zcode` 会话带入 CCode；随后用户再走导入入口时去重键必须把「已随快照迁入」识别为已导入。两链路的去重口径需统一设计，且自动迁移的触发条件（品牌 tasks-index 已存在）与导入入口的预设计算需互斥或幂等。
- **O7 Host 组织态导入与 syncer 对账（M2 设计输入）**：批量写入 tasks 行（含 `cli_*` 镜像列）时，taskIndexSyncer 的镜像与 `handoff_pending` 对账逻辑（断言 I-15；`taskIndexRepo.ts` L873 `handoff_pending` 位）如何避免把导入行误判为待交接/待镜像，需在设计阶段给出写入顺序与列填充规则。
- **O8 入口归属（M3 设计输入）**：「从 ZCode 导入」放设置页独立入口，还是并入现有 onboarding 迁移向导（I-13）作为新的来源 tab。母 PRD 只要求「提供入口」；拆项1 已把 onboarding 的 Claude 迁移排除在外，两者并列不冲突，但交互上应避免两个入口都能导会话造成用户困惑（若并存需在预览中互相感知已导入项）。
