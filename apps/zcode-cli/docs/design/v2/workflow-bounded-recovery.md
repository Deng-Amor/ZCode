# Workflow finite model recovery (WF-4)

规范及状态所有者、时序和验收场景见仓库 [WF-4 spec](../../../../../docs/specs/workflow-bounded-recovery.md)。本条替代旧workflow无限模型失败重驱合同；已实现并通过本地分层验证；客户端 E2E 与 24 小时长时运行仍未验收。

WorkflowFinite 使用已有adapter maxAttempts配置（默认首次+10次重试），保留workflow错误分类；Core每turn累计10次流恢复不变。Driver最终瞬态失败以RecoveryExhausted结束单ask，不再自动开新turn。普通会话、SingleAttempt fallback、合法排队豁免不变。脚本catch/allSettled决定兄弟任务是否继续；不承诺整个ask墙钟或总请求数上限，不重放未知副作用。