import { expect, expectTypeOf, it } from "vitest";
import { createWorkflowHostObservationAdapter } from "../../src/zcode-protocol/workflow-host-observation-adapter.js";
import type { WorkflowHostObservationAdapterFactory } from "../../src/zcode-protocol/workflow-host-observation/contract.js";
import { exampleWorkflowHostObservationOutcome } from "../../src/zcode-protocol/workflow-host-observation/contract.example.js";
import { workflowHostObservationModule } from "../../src/zcode-protocol/workflow-host-observation/module.js";

it("exposes a synchronous record lifecycle without a commit receipt or another attempt owner", () => {
  expectTypeOf(
    createWorkflowHostObservationAdapter,
  ).toEqualTypeOf<WorkflowHostObservationAdapterFactory>();
  expect(workflowHostObservationModule.requires).toEqual(["shared", "zcode-cli"]);
  expect(exampleWorkflowHostObservationOutcome).toEqual({
    event: "workflow.host_observation.sync.failed",
    sessionId: "example-session",
    eventId: "example-event",
    runId: "example-run",
    phase: "verify",
    reasonCode: "identity_unverifiable",
    strictAttempted: "unknown",
    elapsedMs: 0,
  });
});
