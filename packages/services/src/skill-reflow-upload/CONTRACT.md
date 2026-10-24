# skill-reflow-upload

CCode 客户端 skill 回流上传**基础层**（docs/specs/ccode-skill-sync-upload.md，2026-10-22 定稿）：只读扫描用户自有/工作区自建 skill、contentDigest 去重账本、持久化上传队列、日界触发判定与只读状态面。**不含**网络上传器、roots 解析实现（端口注入，权威在 apps 层 `resolveDefaultSkillRoots`）、Main/启动接线、telemetry 集成（后续卡）。

不变量：

- **单一所有者**：上传队列与去重账本的唯一写入者/消费者是 `createSkillReflowUploadService` 的产物；Renderer、Agent 进程、技能加载路径一律不读写（spec §5.1）。触发器、扫描器、上传器是该服务的内部阶段，不是独立写路径。
- **扫描器只读**：对用户技能目录零写入；退出区（`.no-upload` 标记文件 / `private/` 子目录，任意层级命中整棵子树跳过）与范围互斥（保留名「总控派单」/ `expert:` 前缀身份 / `source: remote|plugin|bundled`）只产生计数（`optOutSkipped`/`rangeExcluded`），不读取退出区内容（spec §6.2）。互斥判定是 CLI contracts 同族函数的本地镜像（services 不反向依赖 apps；`identity.ts` 头注释声明同步义务）。
- **digest 覆盖面**：条目 contentDigest = SKILL.md + 条目子树常规文件（嵌套条目目录、private/、`.no-upload`、软链与特殊文件排除）按相对路径排序后的原始字节 SHA-256 聚合；规范化基准未冻结（OQ-2），标识 `SKILL_REFLOW_DIGEST_BASELINE`，基准变更须升级该常量并接受一次预期全量重传。
- **幂等三层**：日界标记 `lastTriggerDate`（本地时区自然日，先落盘再扫描，崩溃不产生当日重复会话）→ 队列同 key 同 digest 至多一条（同 key 变更 digest 替换并重置重试计数）→ 账本内容不变零入队（中台 租户+contentDigest 幂等是第二层兜底）。
- **持久化与恢复**：账本/队列/状态均为单文件 JSON、临时文件+原子替换、操作经 promise 链串行；文件损坏重置为空并 warn（队列丢失由下次触发全量扫描+账本去重重建，账本丢失由中台幂等兜底）。
- **不阻塞**：触发链路任何异常内化为状态面（`SkillReflowStatus`）固定错误码，不抛给调用方；`needLogin` 挂起语义与 `sending/retryableFailed` 状态由后续上传器卡经 mark* 驱动。

与其它模块的交集：roots 解析（`SkillReflowRootProvider` 端口，装配在后续集成卡）；中台条目级回执（`recordReceipt`：accepted/dedupHit 回写账本并出队，filterHit 终态只计数不回写账本）；日志走 `createServiceLogger("skill-reflow-upload")`，任何级别不落条目内容与凭据。
