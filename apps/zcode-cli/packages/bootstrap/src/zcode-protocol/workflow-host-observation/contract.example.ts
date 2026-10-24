import type { WorkflowHostObservationOutcome } from "./contract.js";

/** 合成诊断示例，不含原始 payload 或错误正文。 */
export const exampleWorkflowHostObservationOutcome: WorkflowHostObservationOutcome = {
  event: "workflow.host_observation.sync.failed",
  sessionId: "example-session",
  eventId: "example-event",
  runId: "example-run",
  phase: "verify",
  reasonCode: "identity_unverifiable",
  strictAttempted: "unknown",
  elapsedMs: 0,
};
