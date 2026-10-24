import type { WorkflowLifecycleFactFromProgress } from "./contract.js";

export const exampleWorkflowFactBase: Parameters<WorkflowLifecycleFactFromProgress>[0] = {
  version: 1,
  eventId: "example-event",
  eventSeq: 1,
  occurredAt: 0,
  sessionId: "example-session",
};

/** 宿主观察不能冒充 Engine 生命周期记账。 */
export const exampleHostTelemetryObservation: Parameters<WorkflowLifecycleFactFromProgress>[1] = {
  runId: "example-workflow-run",
  observationSource: "host-reconciliation",
  sequence: 0,
  eventType: "run-settled",
  payload: {
    status: "errored",
    error: { code: "RecoveryUncertain", message: "Unknown external result" },
  },
};
