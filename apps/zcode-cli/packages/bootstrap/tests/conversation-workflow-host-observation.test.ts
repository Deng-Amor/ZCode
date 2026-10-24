import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { normalizeConversationEvent } from "../src/zcode-protocol-v4/event-normalizer.js";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";

const host = {
  runId: "host-run",
  observationSource: "host-reconciliation",
  sequence: 0,
  eventType: "run-settled",
  payload: { status: "errored", error: { code: "RecoveryUncertain", message: "Unknown outcome" } },
};
function event(payload: unknown, sequenceNumber = 1): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: "parent",
    traceId: "trace",
    timestamp: new Date(0),
    sequenceNumber,
    type: SessionEventType.DynamicWorkflowRunProgress,
    payload,
  } as SessionEvent;
}

describe("projection host observation boundary", () => {
  it.each([
    { deliveryProfile: "continuous" as const, workflowRunDeltas: true },
    { deliveryProfile: "continuous" as const, workflowRunDeltas: false },
    { deliveryProfile: "replayable" as const, workflowRunDeltas: true },
    { deliveryProfile: "replayable" as const, workflowRunDeltas: false },
  ])("publishes host terminal changes through supported snapshot/delta shapes %j", (options) => {
    const publisher = new ConversationTopicPublisher("parent", "epoch");
    publisher.ingest(
      event({
        runId: "host-run",
        sequence: 8,
        eventType: "run-settled",
        payload: { status: "stopped", resumable: true, stopReason: "interrupted" },
      }),
    );
    const subscription = publisher.subscribe({ connectionId: "compat-client", ...options });
    if (subscription.frame?.payload.kind !== "snapshot")
      throw new Error("initial snapshot missing");
    const initial = subscription.frame.payload.snapshot;
    publisher.ingest(event(host, 2));
    const update = publisher.flush(subscription.ack.subscriptionId);
    expect(conversationTopicFrameSchema.safeParse(update).success).toBe(true);
    if (update?.payload.kind !== "deltas") throw new Error("terminal delta missing");
    expect(update.payload.deltas.map((delta) => delta.op)).toEqual([
      options.workflowRunDeltas ? "workflowRun.updated" : "state.updated",
    ]);
    const applied = applyConversationDeltas(initial, update.payload.deltas);
    expect(applied.workflowRuns?.runs[0]).toMatchObject({
      status: "errored",
      error: "Unknown outcome",
      lastEventSequence: 8,
    });
    expect(applied.workflowRuns?.runs[0]).not.toHaveProperty("resumable");
    expect(applied.workflowRuns?.runs[0]).not.toHaveProperty("stopReason");
  });
  it("rejects explicit invalid host sources at the existing normalization boundary", () => {
    expect(() =>
      normalizeConversationEvent(event({ ...host, observationSource: "future" })),
    ).toThrow("Invalid workflow run observation: unsupported_source");
  });
  it("rejects invalid history safely and retains the gateway apply-failure receipt", async () => {
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      emitWireFrame: () => {},
      executeCommand: async () => {
        throw new Error("unexpected execution");
      },
    });
    try {
      expect(() =>
        gateway.ingest("parent", event({ ...host, launchInputId: "private-marker" })),
      ).toThrow("Invalid workflow run observation: invalid_host_observation");
      await expect(gateway.waitForProjectionEventCommit("parent", "event-1")).rejects.toMatchObject(
        { reasonCode: "fault.projectionEventCommit.applyFailed" },
      );
    } finally {
      gateway.dispose();
    }
  });
  it.each(["live", "hydration"])(
    "rejects malformed history before any %s projection mutation",
    (mode) => {
      const projection = new ProductProjection("parent", "epoch");
      if (mode === "hydration") projection.beginHydrationReplay();
      const prior = structuredClone(projection.getSnapshot());
      const invalid = event({ ...host, launchInputId: "private-marker" });
      expect(() =>
        mode === "live" ? projection.applyEvent(invalid) : projection.applyHydrationEvent(invalid),
      ).toThrow("invalid_host_observation");
      expect(projection.getSnapshot()).toEqual(prior);
    },
  );

  it("updates terminal projection through the normal reducer and omits duplicate Engine telemetry", () => {
    const projection = new ProductProjection("parent", "epoch");
    projection.applyEvent(
      event({
        runId: "host-run",
        eventType: "run-settled",
        sequence: 8,
        payload: { status: "stopped", stopReason: "interrupted", resumable: true },
      }),
    );
    const changes = projection.applyEvent(event(host, 2));
    expect(changes.length).toBeGreaterThan(0);
    expect(projection.getSnapshot().workflowRuns?.runs[0]).toMatchObject({
      status: "errored",
      error: "Unknown outcome",
      lastEventSequence: 8,
    });
    expect(projection.getSnapshot().workflowRuns?.runs[0]).not.toHaveProperty("resumable");
    const normalizer = new ConversationTelemetryFactNormalizer();
    const engine = { ...host, launchInputId: "input" };
    delete (engine as Partial<typeof host>).observationSource;
    expect(normalizer.normalize("parent", event(engine))).not.toBeNull();
    expect(normalizer.normalize("parent", event({ ...host, launchInputId: "input" }))).toBeNull();
    expect(normalizer.normalize("parent", event(host))).toBeNull();
  });
});
