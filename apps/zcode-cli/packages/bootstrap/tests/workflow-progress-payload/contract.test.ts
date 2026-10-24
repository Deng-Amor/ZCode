import { expect, expectTypeOf, it } from "vitest";
import {
  toHostReconciliationProgress,
  toProgressPayload,
  toProtocolEvent,
} from "../../src/app/dynamic-workflow-run-progress-payload.js";
import type {
  HostReconciliationSerializer,
  WorkflowProgressSerializer,
  WorkflowProtocolEventSerializer,
} from "../../src/app/workflow-progress-payload/contract.js";
import { exampleHostReconciliationInput } from "../../src/app/workflow-progress-payload/contract.example.js";

it("keeps real public serializer signatures and the independent host observation contract", () => {
  expectTypeOf(toHostReconciliationProgress).toEqualTypeOf<HostReconciliationSerializer>();
  expectTypeOf(toProgressPayload).toEqualTypeOf<WorkflowProgressSerializer>();
  expectTypeOf(toProtocolEvent).toEqualTypeOf<WorkflowProtocolEventSerializer>();
  expect(toHostReconciliationProgress(exampleHostReconciliationInput)).toMatchObject({
    runId: "example-workflow-run",
    observationSource: "host-reconciliation",
    sequence: 0,
    eventType: "run-settled",
    payload: { status: "errored", error: { code: "RecoveryUncertain" } },
  });
});

it("keeps ordinary Engine progress and journal envelopes on their existing serialization path", () => {
  const settled = { type: "run-settled", status: "stopped", stopReason: "interrupted" } as const;
  expect(toProtocolEvent(7, settled)).toEqual({
    sequence: 7,
    type: "run-settled",
    payload: { status: "stopped", stopReason: "interrupted" },
  });
  const progress = toProgressPayload({
    runId: "example-workflow-run",
    sequence: 7,
    event: settled,
  });
  expect(progress).toMatchObject({
    sequence: 7,
    eventType: "run-settled",
    payload: { status: "stopped", resumable: true },
  });
  expect(progress).not.toHaveProperty("observationSource");
});
