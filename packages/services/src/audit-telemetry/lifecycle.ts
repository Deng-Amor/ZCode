import type { AuditTelemetryLifecycleStatus } from "./schema.js";

/**
 * 生命周期映射表（spec §5.1.1，纯函数，无 IO）。
 *
 * 现有多套状态词汇并存且均无台账语义（spec A5），遥测生命周期词汇是**独立投影枚举**：
 * 不改任何既有 schema、不加语义超载。输入词汇在本地声明为字符串联合并标注实测锚点——
 * 权威定义位于 apps/zcode-cli/packages/contracts（CLI 应用层，在 services 之上，
 * 反向依赖会破坏包层级方向）与 packages/services/src/task-facts/contract.ts；
 * 结构一致即可直接传入，未知词汇返回 undefined（显式未知处理，不静默归并）。
 */

/** 锚点：session.events.ts L650-L657（回合终态）。 */
export type AuditTelemetryTurnResultType =
  | "success"
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export const TURN_RESULT_TO_LIFECYCLE: Readonly<
  Record<AuditTelemetryTurnResultType, AuditTelemetryLifecycleStatus>
> = {
  success: "completed",
  // "cancelled"：用户主动中断（TurnComplete 注释明示），映射 stopped（拍板 #1 原文词汇）。
  cancelled: "stopped",
  error_max_turns: "failed",
  error_max_budget: "failed",
  error_during_execution: "failed",
  error_max_tool_calls: "failed",
};

/** 锚点：task-facts/contract.ts L15（CliTaskFacts.lastOutcome）。 */
export type AuditTelemetryCliTaskLastOutcome =
  | "completed"
  | "interrupted"
  | "error";

export const CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE: Readonly<
  Record<AuditTelemetryCliTaskLastOutcome, AuditTelemetryLifecycleStatus>
> = {
  completed: "completed",
  interrupted: "stopped",
  error: "failed",
};

/** 锚点：session.events.ts L961-L968（BackgroundTaskStatus 8 值）。 */
export type AuditTelemetryBackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

/**
 * `running` 非终态、不在 spec §5.1.1 映射表内 → 不映射（undefined）；
 * 后台任务的 started 事件由采集侧按 background_task_started 另行铸造，不经此表。
 * `lost` → stopped 按 spec §5.1.1 表值实现，**归并待评审（OQ-A2）**：
 * 评审若改判 failed，只需改本表值与对应单测断言（单测中显式标注待定项）。
 * `timed_out`/`spawn_error` → failed 为同表归并结果。
 */
export const BACKGROUND_TASK_STATUS_TO_LIFECYCLE: Readonly<
  Partial<
    Record<AuditTelemetryBackgroundTaskStatus, AuditTelemetryLifecycleStatus>
  >
> = {
  completed: "completed",
  cancelled: "stopped",
  failed: "failed",
  timed_out: "failed",
  spawn_error: "failed",
  // OQ-A2 待评审：lost 现按 stopped 归并（spec 表值）。
  lost: "stopped",
};

/** 锚点：packages/shared/src/zcode-protocol/index.ts L3290-L3296（zcodeSavedWorkflowRunStatusSchema）。 */
export type AuditTelemetrySavedWorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "errored"
  | "stopped";

export const SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE: Readonly<
  Record<AuditTelemetrySavedWorkflowRunStatus, AuditTelemetryLifecycleStatus>
> = {
  pending: "started",
  running: "started",
  completed: "completed",
  errored: "failed",
  stopped: "stopped",
};

/** 总控装配失败码族（spec A4；bootstrap.ts L16-L27 码值，本地镜像，见 schema.ts 说明）。 */
export type AuditTelemetryBootstrapFailureCode =
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_REJECTED"
  | "AUTH_REQUIRED"
  | "IDENTITY_CHANGED"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "EXECUTION_FAILED"
  | "INVALID_RELEASE"
  | "VERSION_CHANGED"
  | "CAPACITY_EXCEEDED";

/**
 * bootstrap 失败码族落到的运行异常 → error（spec §5.1.1 表末行）。
 * 语义边界：error = 运行环境/系统级异常终止，区别于任务自身执行失败 failed（OQ-A2 待评审边界）。
 */
export const BOOTSTRAP_FAILURE_TO_LIFECYCLE: Readonly<
  Record<AuditTelemetryBootstrapFailureCode, "error">
> = {
  AUTHORIZATION_EXPIRED: "error",
  AUTHORIZATION_REJECTED: "error",
  AUTH_REQUIRED: "error",
  IDENTITY_CHANGED: "error",
  CANCELLED: "error",
  UNAVAILABLE: "error",
  EXECUTION_FAILED: "error",
  INVALID_RELEASE: "error",
  VERSION_CHANGED: "error",
  CAPACITY_EXCEEDED: "error",
};

// ---------------------------------------------------------------------------
// 映射纯函数：未知词汇返回 undefined（调用方决定丢弃或本地计数），绝不抛出。
// ---------------------------------------------------------------------------

export function mapTurnResultToLifecycle(
  value: string,
): AuditTelemetryLifecycleStatus | undefined {
  return TURN_RESULT_TO_LIFECYCLE[value as AuditTelemetryTurnResultType];
}

export function mapCliTaskLastOutcomeToLifecycle(
  value: string,
): AuditTelemetryLifecycleStatus | undefined {
  return CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE[
    value as AuditTelemetryCliTaskLastOutcome
  ];
}

export function mapBackgroundTaskStatusToLifecycle(
  value: string,
): AuditTelemetryLifecycleStatus | undefined {
  return BACKGROUND_TASK_STATUS_TO_LIFECYCLE[
    value as AuditTelemetryBackgroundTaskStatus
  ];
}

export function mapSavedWorkflowRunStatusToLifecycle(
  value: string,
): AuditTelemetryLifecycleStatus | undefined {
  return SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE[
    value as AuditTelemetrySavedWorkflowRunStatus
  ];
}

export function mapBootstrapFailureToLifecycle(
  value: string,
): "error" | undefined {
  return BOOTSTRAP_FAILURE_TO_LIFECYCLE[
    value as AuditTelemetryBootstrapFailureCode
  ];
}
