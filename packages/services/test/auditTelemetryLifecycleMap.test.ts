import { describe, expect, it } from "vitest";
import {
  BACKGROUND_TASK_STATUS_TO_LIFECYCLE,
  BOOTSTRAP_FAILURE_TO_LIFECYCLE,
  CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE,
  SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE,
  TURN_RESULT_TO_LIFECYCLE,
  mapBackgroundTaskStatusToLifecycle,
  mapBootstrapFailureToLifecycle,
  mapCliTaskLastOutcomeToLifecycle,
  mapSavedWorkflowRunStatusToLifecycle,
  mapTurnResultToLifecycle,
} from "../src/audit-telemetry/index.js";

/**
 * 生命周期映射表逐项断言（spec §5.1.1 / 验收 AT-10：映射表断言在测试报告中逐条可回读）。
 */

describe("audit telemetry lifecycle mapping", () => {
  it("maps TurnResultType item by item (session.events.ts L650-L657)", () => {
    expect(TURN_RESULT_TO_LIFECYCLE.success).toBe("completed");
    expect(mapTurnResultToLifecycle("success")).toBe("completed");
    // cancelled：用户主动中断 → stopped。
    expect(TURN_RESULT_TO_LIFECYCLE.cancelled).toBe("stopped");
    expect(mapTurnResultToLifecycle("cancelled")).toBe("stopped");
    // 四个 error_* 回合失败终态 → failed。
    for (const value of [
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ] as const) {
      expect(TURN_RESULT_TO_LIFECYCLE[value]).toBe("failed");
      expect(mapTurnResultToLifecycle(value)).toBe("failed");
    }
    expect(mapTurnResultToLifecycle("success-ish")).toBeUndefined();
  });

  it("maps CliTaskFacts.lastOutcome item by item (task-facts/contract.ts L15)", () => {
    expect(CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE.completed).toBe("completed");
    expect(CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE.interrupted).toBe("stopped");
    expect(CLI_TASK_LAST_OUTCOME_TO_LIFECYCLE.error).toBe("failed");
    expect(mapCliTaskLastOutcomeToLifecycle("completed")).toBe("completed");
    expect(mapCliTaskLastOutcomeToLifecycle("interrupted")).toBe("stopped");
    expect(mapCliTaskLastOutcomeToLifecycle("error")).toBe("failed");
    expect(mapCliTaskLastOutcomeToLifecycle("deleted")).toBeUndefined();
  });

  it("maps BackgroundTaskStatus item by item (session.events.ts L961-L968)", () => {
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.completed).toBe("completed");
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.cancelled).toBe("stopped");
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.failed).toBe("failed");
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.timed_out).toBe("failed");
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.spawn_error).toBe("failed");
    expect(mapBackgroundTaskStatusToLifecycle("completed")).toBe("completed");
    expect(mapBackgroundTaskStatusToLifecycle("cancelled")).toBe("stopped");
    expect(mapBackgroundTaskStatusToLifecycle("failed")).toBe("failed");
    expect(mapBackgroundTaskStatusToLifecycle("timed_out")).toBe("failed");
    expect(mapBackgroundTaskStatusToLifecycle("spawn_error")).toBe("failed");
    // 【待定项，OQ-A2 待评审】lost 现按 spec §5.1.1 表值归并 stopped；
    // 评审若改判 failed，须同步修改映射表与本断言。
    expect(BACKGROUND_TASK_STATUS_TO_LIFECYCLE.lost).toBe("stopped");
    expect(mapBackgroundTaskStatusToLifecycle("lost")).toBe("stopped");
    // running 非终态，不在映射表内 → 不映射（started 由 background_task_started 采集侧另行铸造）。
    expect(mapBackgroundTaskStatusToLifecycle("running")).toBeUndefined();
  });

  it("maps saved workflow run status item by item (zcode-protocol L3290-L3296)", () => {
    expect(SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE.pending).toBe("started");
    expect(SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE.running).toBe("started");
    expect(SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE.completed).toBe("completed");
    expect(SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE.errored).toBe("failed");
    expect(SAVED_WORKFLOW_RUN_STATUS_TO_LIFECYCLE.stopped).toBe("stopped");
    for (const [input, expected] of [
      ["pending", "started"],
      ["running", "started"],
      ["completed", "completed"],
      ["errored", "failed"],
      ["stopped", "stopped"],
    ] as const) {
      expect(mapSavedWorkflowRunStatusToLifecycle(input)).toBe(expected);
    }
    expect(mapSavedWorkflowRunStatusToLifecycle("paused")).toBeUndefined();
  });

  it("maps every bootstrap failure code to the runtime error lifecycle (A4 code family)", () => {
    const codes = Object.keys(BOOTSTRAP_FAILURE_TO_LIFECYCLE);
    expect(codes).toEqual([
      "AUTHORIZATION_EXPIRED",
      "AUTHORIZATION_REJECTED",
      "AUTH_REQUIRED",
      "IDENTITY_CHANGED",
      "CANCELLED",
      "UNAVAILABLE",
      "EXECUTION_FAILED",
      "INVALID_RELEASE",
      "VERSION_CHANGED",
      "CAPACITY_EXCEEDED",
    ]);
    for (const code of codes) {
      expect(
        BOOTSTRAP_FAILURE_TO_LIFECYCLE[
          code as keyof typeof BOOTSTRAP_FAILURE_TO_LIFECYCLE
        ],
      ).toBe("error");
      expect(mapBootstrapFailureToLifecycle(code)).toBe("error");
    }
    expect(
      mapBootstrapFailureToLifecycle("NOT_A_BOOTSTRAP_CODE"),
    ).toBeUndefined();
  });
});
