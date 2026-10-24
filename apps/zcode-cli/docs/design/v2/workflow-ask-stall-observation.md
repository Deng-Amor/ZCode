# 单 ask 模型重试停滞观察

2026-10-21，设计已独立审查，实现及定向回归完成，静态验证结果以实施报告为准。

产品规则、事件精确签名及验收场景见仓库根目录
`docs/specs/workflow-ask-stall-observation.md`，实施计划见
`docs/superpowers/plans/2026-10-21-workflow-ask-stall-observation.md`。

CLI Driver 每个在飞 ask 独立观察持续模型重试，20 分钟无自己的模型成功才通知；
其他 ask 成功不清除此时钟。原 run 级 clock 保持。Engine 以 node-stalled 记录纯观察，
经既有 RunProgress 向父会话发普通模型可读后台文本，包含 runId 与完整 ask identity。
不新增 workflowNotification kind，不冒用 run stall，不改变节点状态、自动重跑或工具超时。
取消、完成、失败、dispose 清理实例时钟，迟到状态不能归属下一 ask。

WF-4 更新：Driver外层无限重驱已由有限恢复合同替代，ask观察仅由有效网络retry上膛；Core恢复仍不新增触发源。见workflow-bounded-recovery.md，旧WF3证据仅记录历史行为。
