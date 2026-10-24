import { expect, expectTypeOf, it } from "vitest";
import { workflowLifecycleFactFromProgress } from "../../src/zcode-protocol-v4/conversation-telemetry-workflow-facts.js";
import type { WorkflowLifecycleFactFromProgress } from "../../src/zcode-protocol-v4/workflow-telemetry-facts/contract.js";
import {
  exampleHostTelemetryObservation,
  exampleWorkflowFactBase,
} from "../../src/zcode-protocol-v4/workflow-telemetry-facts/contract.example.js";

it("keeps the real signature and excludes host or invalid observations from Engine facts", () => {
  expectTypeOf(
    workflowLifecycleFactFromProgress,
  ).toEqualTypeOf<WorkflowLifecycleFactFromProgress>();
  expect(
    workflowLifecycleFactFromProgress(exampleWorkflowFactBase, exampleHostTelemetryObservation),
  ).toBeNull();
  expect(
    workflowLifecycleFactFromProgress(exampleWorkflowFactBase, {
      ...exampleHostTelemetryObservation,
      launchInputId: "example-input",
    }),
  ).toBeNull();
});

it("retains the ordinary Engine settlement lifecycle fact", () => {
  expect(
    workflowLifecycleFactFromProgress(exampleWorkflowFactBase, {
      runId: "example-workflow-run",
      sequence: 7,
      eventType: "run-settled",
      launchInputId: "example-input",
      payload: { status: "completed" },
    }),
  ).toMatchObject({
    kind: "workflow.lifecycle",
    phase: "run-settled",
    runId: "example-workflow-run",
    status: "completed",
    sourceCommandId: "example-input",
  });
});
