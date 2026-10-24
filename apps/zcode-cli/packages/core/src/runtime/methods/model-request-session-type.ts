import { ModelRequestSessionType, ModelRetryBudget, type SessionTaskType } from "@zcode/contracts";

/**
 * 模型请求按宿主 session 做粗分类；workflow child 不是 subagent，服务端统计统一归 other。
 */
export function resolveModelRequestSessionTypeFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRequestSessionType {
  if (taskType === "subagent_child") return ModelRequestSessionType.Subagent;
  if (taskType === "selection_side_chat") return ModelRequestSessionType.SideChat;
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRequestSessionType.Other;
  }
  return ModelRequestSessionType.Main;
}

/**
 * workflow actor（含嵌套 workflow 的 actor）使用有限 workflow 预算：保留专用错误分类，
 * 请求次数由 adapter 的既有 maxAttempts 约束，耗尽后交还 Core / Driver 结算。
 * 其余 session（主会话、subagent、fork…）沿用 adapter 的默认预算。
 */
export function resolveModelRetryBudgetFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRetryBudget {
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRetryBudget.WorkflowFinite;
  }
  return ModelRetryBudget.Default;
}
