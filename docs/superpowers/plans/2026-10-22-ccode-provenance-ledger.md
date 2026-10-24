# CCode 来源台账门禁实施计划

**Goal:** CCode 专用台账工具接入中台唯一业务状态，写入、关单与 Skill 发布必须核验来源及证据。
**Architecture:** CLI 注入运行上下文，经既有私有通道与 Main 账号认证转发；中台服务拥有事务状态及审计历史，知识库提供有权限、摘要绑定的证据。
**Tech Stack:** TypeScript/Zod/Vitest、Java 17/Spring/MyBatis/PostgreSQL、隔离数据库与接口测试。
**Spec:** `docs/specs/ccode-provenance-ledger.md`

## 约束与执行

- 当前两个仓库都有大量未提交集成代码，必须保留；基于当前文件，不以 HEAD 重建旧功能。仅修改明确所属文件，不自动提交、推送或部署。
- 用户已明确选择全链路；流程性设计及计划由独立 Agent 评审，主 Agent 决策并复核。
- 使用 subagent-driven-development 分离中台与客户端实施，主 Agent 集成验证；实现前各端必须取得失败测试证据。
- 不复制核心 Skill 正文、不执行附件脚本、不改变客户端自动更新策略。
- 草稿 Markdown 不是权威台账；现有会话/工作流完成状态不等于正式业务验收。

## 共享协议（两端必须一致）

中台入口：`POST /admin-api/system/ccode-controller/ledger/command`，既有 `{code:0,data}` 响应。正常 data 为 LedgerRecord；固定业务错误保留失败，不返回原异常。

`LedgerCommand` 严格字段：

- `action`: submit|get|review|close。
- `commandId`: UUID（get 也携带，只有写命令持久幂等）。
- `source`: `{taskId, sessionId, turnId, toolCallId, workspaceIdentity, skillVersion, skillDigest}`；字符串非空最大 256 字符，workspaceIdentity 最大 4096；版本正安全整数、摘要小写 SHA-256。仅 Runtime 注入，不进入模型输入 schema。
- submit：`entry`；不得有 recordId/expectedRevision/review。
- get：`recordId` UUID。
- review：`recordId`, `expectedRevision` 正整数, `review`。
- close：`recordId`, `expectedRevision` 正整数。

`LedgerEntry`: `purpose`=task|skill-release, `objectId`(1..256), `title`(1..256), `claim`=observation|hypothesis|root-cause, `statement`(1..8192), `occurredAt`(ISO8601 带时区), `evidence`(1..16), 可选 `supersedesRecordId` UUID。skill-release 必须有 `target={knowledgeFileId:正安全整数,sourceArchiveDigest:SHA256,skillId:"controller",version:正安全整数}`，task 禁止 target。

`EvidenceRef`: `{fileId:正安全整数,sha256:SHA256,startLine?:正整数,endLine?:正整数}`；行范围成对，UTF-8 文本中的实际行，限制单文件 2 MiB/合计 16 MiB，拒绝空内容；只允许知识库有读取权限的 APPROVED 文件。原始内容不进入普通日志。

`LedgerReview`: `decision`=accept|reject, `criterion`(1..4096), `result`(1..8192), `evidence`(1..16), 可选 `reproduction`/`counterEvidence`(1..4096)。accept hypothesis 拒绝；accept root-cause 时后两字段必填；所有操作均不能自动推断事实真伪。

`LedgerRecord`: `{id:UUID,revision:正整数,status:submitted|accepted|rejected|closed,entry,source,review?:LedgerReview,createdAt:ISO时间,updatedAt:ISO时间}`。不向模型返回账号令牌、核心 Skill 正文或原始证据字节。

## Task 1 — 中台权威台账与发布门禁

仓库 `E:/github/cs-platform-service`。所属文件：biz 知识库 `service/ccodeledger/`、`controller/CcodeLedgerController.java`；新增专属 SQL migration；既有 `CcodeControllerKnowledgeService/Controller` 发布绑定；system `CcodeControllerService`/ReleaseDO/Mapper 仅为发布来源绑定作必要变化，不引入 system→biz 依赖。先读取既有类型与权限实现。

- [ ] 失败测试覆盖真实 owner 的 submit、review、close、权限、证据摘要、假设不得验收、发布缺绑定拒绝。
- [ ] 契约明确严格 JSON 字段和日期解析；服务端身份不读请求体。写命令唯一键为 tenant/user/commandId，命令内容摘要绑定完整操作；幂等重放返回原快照。
- [ ] 使用现态表及不可变命令审计表，同一事务持久化；锁顺序台账→目录→文件ID。并发 revision 只允许一个成功，回滚不能留下半记录。
- [ ] submit 初始 revision1；review 从 submitted 到 accepted/rejected revision+1；close 只从 accepted 到 closed revision+1。内容修改用新记录+supersedes；新命令重复 close 拒绝。
- [ ] 读取及证据权限走现有服务；review 权限细分 approve/reject；close/publish 沿用 publish。当前来源为认证客户端声明，不能独立证明本机会话事实。
- [ ] knowledge/publish 新增 ledgerRecordId/ledgerRevision；必须 closed、skill-release 及严格目标匹配，实际消费密文字节摘要和签名版本再次检查。记录发布绑定。
- [ ] 编译并运行定向 JUnit、隔离 PostgreSQL 并发/幂等/事务测试；记录不能执行的检查。禁止使用生产数据库或自动执行 migration。

## Task 2 — CCode Runtime、私有通道与正式工具

仓库 `E:/ZCode`。共享 web-safe 契约可放 `packages/shared/src/managed-skills/ledger.ts` 并从公共入口导出；CLI contracts 使用自己的 Zod 运行时 schema 并用共享 JSON fixtures 对照，避免跨工程内部导入。复用 confidential-controller 已管理模块，不扩大通用 RPC。

- [ ] 失败测试覆盖严格命令解析、模型无法注入 source/tenant/user、登录失效、取消、跨 peer 响应隔离和端到端 submit/review/close。
- [ ] `ControllerLedger` 工具 schema 只接受 action/commandId/entry/recordId/expectedRevision/review，Runtime 注入 source（taskId 使用运行绑定键）。源自实际上下文，缺失不能编造。
- [ ] `ConfidentialControllerExecutionPort` 添加可选 `ledger(command, source, signal)` 能力；旧运行端口缺失时明确不可用。Runtime 必须已激活且绑定当前 Skill，旧运行回包拒绝。
- [ ] 私有协议增加 `ledger` command 与 `ledger-result` terminal event；严格 schema，载荷最大 128 KiB，复用单调ID/并发上限/超时/取消。Host 保持仅路由。
- [ ] `CcodePlatformAuth` 提供私有认证 command 方法，取得当前 access token，合并登录世代与取消信号，使用固定 HTTPS 相对路由；Main application 注入，不暴露 token。
- [ ] 工具接入现有 registry、tool context 与 executor；补充桌面系统上下文说明正式台账入口和草稿区别，不改核心总控正文。
- [ ] 执行目标 Vitest、CLI typecheck/lint、根 typecheck/lint/architecture；不运行未经要求的全套测试。

## Task 3 — 交叉验证与封装

- [ ] 独立评审两端实际代码与协议 fixture；修复发现并重跑必要测试。
- [ ] 建立对应 spec 20 轮的可执行矩阵，每轮有输入/预期/实际/副作用证据；覆盖真实 owner、私有传输与 mock HTTP、真实隔离数据库并发。环境/入口未覆盖必须明确标出，不能写全部通过。
- [ ] 输出测试报告和接口部署迁移说明；只有20轮及必需检查通过后才封装本地客户端构建/服务端可部署产物。不会自动更改线上中台、官网或已安装客户端。
- [ ] 停止本任务临时服务；保留用户已运行应用。记录启动目录及命令。

## 评审重点与裁定

- evidence/file 权限与内容摘要均需验证；非空或 Test-Path 不能冒充真实性。
- 同命令幂等先于证据重验但后于身份/权限；新操作重验，读取到的字节才是消费对象。
- 外部 OSS 不受数据库锁保护，只承诺实际读取摘要一致，不能宣称消灭所有外部竞态。
- 发布绑定新 Skill 目标与运行 Skill 来源是不同字段。
- Ruling：用户允许业务校验开发不等于授权中台生产迁移或覆盖已发布包，先交付可验证代码和封装，线上部署另按用户明确要求。
