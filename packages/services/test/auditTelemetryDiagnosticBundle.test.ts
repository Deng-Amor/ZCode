import { describe, expect, it } from "vitest";
import {
  createDiagnosticBundleTrigger,
  createAuditTelemetryPolicyGate,
  parseAuditTelemetryEvent,
  serializeAuditTelemetryEvent,
  type AuditTelemetryAttribution,
  type AuditTelemetryEvent,
} from "../src/audit-telemetry/index.js";

const attribution: AuditTelemetryAttribution = {
  ccodeRelease: "3.16.2",
  platform: "windows",
  skillVersion: "1",
  skillDigest: "a".repeat(64),
};
const archive = {
  path: "ignored",
  fileName: "diagnostic.zip",
  sizeBytes: 42,
  digestHex: "b".repeat(64),
};

function setup(builder = { build: async () => archive }) {
  const events: AuditTelemetryEvent[] = [];
  const queue = { enqueue: async (event: AuditTelemetryEvent) => { events.push(event); return {} as never; } };
  const trigger = createDiagnosticBundleTrigger({
    builder,
    policyGate: createAuditTelemetryPolicyGate({
      visibility: "silent",
      channels: { lifecycle: { enabled: true }, diagnostic: { enabled: true, samplingRate: 1 } },
    }),
    queue,
    attribution,
    now: () => new Date("2026-10-23T10:00:00Z"),
    uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
  });
  return { trigger, events };
}

describe("diagnostic bundle trigger", () => {
  it("enqueues a strict diagnostic error event with archive metadata", async () => {
    const { trigger, events } = setup();
    const result = await trigger.triggerOnError("task_failed");
    expect(result.triggered).toBe(true);
    expect(events).toHaveLength(1);
    expect(parseAuditTelemetryEvent(events[0])).toEqual(events[0]);
    expect(events[0]).toMatchObject({ channel: "diagnostic", type: "diagnostic.bundle", payload: { trigger: "error", archiveDigest: archive.digestHex, archiveSizeBytes: 42, archiveTraceId: expect.any(String), archiveFileName: "diagnostic.zip" } });
  });

  it("enforces same-arm same-day idempotency", async () => {
    const { trigger, events } = setup();
    await trigger.triggerOnError("crash_recovery");
    expect(await trigger.triggerOnError("task_failed")).toEqual({ triggered: false, skipReason: "alreadyTriggeredToday" });
    expect(events).toHaveLength(1);
  });

  it("keeps the daily arm independent from the error arm", async () => {
    const { trigger, events } = setup();
    await trigger.triggerOnError("task_failed");
    expect((await trigger.runDailyDigest()).triggered).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("drops when diagnostic policy is closed", async () => {
    const trigger = createDiagnosticBundleTrigger({ ...({} as never), builder: { build: async () => archive }, policyGate: createAuditTelemetryPolicyGate({ visibility: "silent", channels: { lifecycle: { enabled: true }, diagnostic: { enabled: false, samplingRate: 1 } } }), queue: { enqueue: async () => undefined as never }, attribution, now: () => new Date("2026-10-23T10:00:00Z"), uuid: () => "00000000-0000-4000-8000-000000000001" });
    expect(await trigger.triggerOnError("controller_bootstrap_failed")).toEqual({ triggered: false, skipReason: "droppedByPolicy" });
  });

  it("contains builder failures and counts them", async () => {
    const { trigger, events } = setup({ build: async () => { throw new Error("fail"); } });
    await expect(trigger.triggerOnError("task_failed")).resolves.toEqual({ triggered: false, skipReason: "buildFailed" });
    expect(trigger.counters()).toMatchObject({ failed: 1 });
    expect(events).toHaveLength(0);
  });

  it("round-trips through deterministic serialization", async () => {
    const { trigger } = setup();
    const event = (await trigger.runDailyDigest()).event!;
    expect(parseAuditTelemetryEvent(JSON.parse(serializeAuditTelemetryEvent(event)))).toEqual(event);
  });
});
