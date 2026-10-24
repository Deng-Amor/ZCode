import { describe, expect, it } from "vitest";
import type {
  AuditTelemetryAttribution,
  AuditTelemetryEvent,
  AuditTelemetryQueue,
} from "../src/audit-telemetry/index.js";
import { createAuditTelemetryPolicyGate } from "../src/audit-telemetry/index.js";
import { createAuditTelemetryCollector } from "../src/audit-telemetry/collector.js";

class FakeSource {
  private listener: ((event: Parameters<Parameters<FakeSource["subscribe"]>[0]>[0]) => void) | undefined;
  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(event: any): void { this.listener?.(event); }
}

function queue(): { queue: AuditTelemetryQueue; events: AuditTelemetryEvent[] } {
  const events: AuditTelemetryEvent[] = [];
  return {
    events,
    queue: {
      enqueue: async (event) => { events.push(event); return { status: "enqueued", droppedOldest: 0, droppedOldestTotal: 0 }; },
      take: async () => [], ack: async () => 0, stats: async () => ({ pendingRecords: 0, pendingBytes: 0, droppedOldestTotal: 0, commandIdConflicts: 0, recoveredCorruptLines: 0 }), dispose: async () => undefined,
    },
  };
}

const attribution: AuditTelemetryAttribution = { ccodeRelease: "1.0.0", platform: "windows", skillVersion: "v1", skillDigest: "d" };

describe("createAuditTelemetryCollector", () => {
  it("maps terminal events, sanitizes errors, and marks incomplete attribution", async () => {
    const source = new FakeSource();
    const target = queue();
    const collector = createAuditTelemetryCollector({ source, queue: target.queue, attribution: () => ({ ccodeRelease: "1.0.0", platform: "windows" }), now: () => new Date("2026-10-23T00:00:00.000Z"), uuid: (() => { let i = 0; return () => `00000000-0000-4000-8000-00000000000${++i}`; })() });
    collector.start(); collector.start();
    source.emit({ kind: "turn", result: "cancelled", subjectRef: { kind: "session", id: "s1" } });
    source.emit({ kind: "error", error: { message: "bad sk-test-secret-123456789", code: "UNAVAILABLE" }, errorCode: "UNAVAILABLE" });
    await collector.flush();
    expect(target.events).toHaveLength(2);
    expect(target.events[0].payload).toMatchObject({ lifecycleStatus: "stopped" });
    expect(JSON.stringify(target.events[1])).not.toContain("sk-test-secret-123456789");
    expect(target.events[0]).toMatchObject({ attributionIncomplete: true });
    expect(collector.counters()).toMatchObject({ received: 2, minted: 2, droppedInvalid: 0 });
  });

  it("stops consuming, rejects unknown states, and counts policy drops", async () => {
    const source = new FakeSource(); const target = queue();
    const collector = createAuditTelemetryCollector({ source, queue: target.queue, attribution: () => attribution, policy: createAuditTelemetryPolicyGate({ visibility: "silent", channels: { lifecycle: { enabled: true }, diagnostic: { enabled: false, samplingRate: 1 } } }), now: () => new Date(), uuid: () => "00000000-0000-4000-8000-000000000001" });
    collector.start();
    source.emit({ kind: "turn", result: "mystery", subjectRef: { kind: "session", id: "s1" } });
    source.emit({ kind: "error", error: { message: "x" }, errorCode: "UNAVAILABLE" });
    await collector.flush();
    expect(target.events).toHaveLength(0);
    expect(collector.counters()).toMatchObject({ received: 2, droppedInvalid: 1, droppedByPolicy: 1 });
    collector.stop(); source.emit({ kind: "turn", result: "success", subjectRef: { kind: "session", id: "s1" } }); await collector.flush();
    expect(target.events).toHaveLength(0);
  });
});
