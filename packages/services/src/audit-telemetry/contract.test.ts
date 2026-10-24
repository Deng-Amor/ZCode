import { describe, expect, it } from "vitest";
import type { AuditTelemetryEvent } from "#src/audit-telemetry/contract.js";
import {
  AuditTelemetryValidationError,
  parseAuditTelemetryEvent,
  serializeAuditTelemetryEvent,
} from "#src/audit-telemetry/index.js";
import {
  createAuditTelemetryPolicyGate,
  DEFAULT_AUDIT_TELEMETRY_POLICY,
} from "#src/audit-telemetry/policy.js";

const attribution = { ccodeRelease: "3.16.2", platform: "windows" as const };

function lifecycleEvent(): AuditTelemetryEvent {
  return {
    schemaVersion: 1,
    eventId: "123e4567-e89b-42d3-a456-426614174000",
    commandId: "123e4567-e89b-42d3-a456-426614174001",
    occurredAt: "2026-10-22T11:00:00+08:00",
    channel: "lifecycle",
    type: "task.lifecycle",
    payload: {
      lifecycleStatus: "completed",
      subjectRef: { kind: "session", id: "session-1" },
    },
    attribution,
    attributionIncomplete: true,
  };
}

describe("audit-telemetry contract", () => {
  it("serializes deterministically and drops unknown fields instead of passing them through", () => {
    const contaminated = {
      ...lifecycleEvent(),
      tenantId: "tenant-must-not-leave-client",
      payload: {
        ...lifecycleEvent().payload,
        workspacePath: "C:\\Users\\leaker\\repo",
        userContent: "conversation body must not leak",
      },
    } as unknown as AuditTelemetryEvent;
    // 序列化路径：未知字段丢弃（spec §5.1.6）；strict 解析路径：未知字段直接失败。
    const serialized = serializeAuditTelemetryEvent(contaminated);
    expect(serialized).not.toContain("tenant-must-not-leave-client");
    expect(serialized).not.toContain("workspacePath");
    expect(serialized).not.toContain("conversation body must not leak");
    expect(serialized).toBe(serializeAuditTelemetryEvent(lifecycleEvent()));
    expect(() => parseAuditTelemetryEvent(contaminated)).toThrow(
      AuditTelemetryValidationError,
    );
  });

  it("reports schema rejection as AuditTelemetryValidationError with readable issues", () => {
    const invalid = {
      ...lifecycleEvent(),
      payload: { ...lifecycleEvent().payload, lifecycleStatus: "lost" },
    };
    expect(() => serializeAuditTelemetryEvent(invalid)).toThrow(
      AuditTelemetryValidationError,
    );
    let caught: unknown;
    try {
      parseAuditTelemetryEvent(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuditTelemetryValidationError);
    expect(
      (caught as AuditTelemetryValidationError).issues.length,
    ).toBeGreaterThan(0);
  });

  it("defaults to the silent visibility decision (2026-10-22 A3 拍板) and counts drops", () => {
    expect(DEFAULT_AUDIT_TELEMETRY_POLICY.visibility).toBe("silent");
    const gate = createAuditTelemetryPolicyGate();
    expect(gate.decide("lifecycle")).toBe("enqueue");
    // deterministic 采样：注入 random 覆盖默认采样率 0.1 之外即被采样丢弃。
    expect(gate.decide("diagnostic", 0.5)).toBe("dropped-sampled");
    expect(gate.counters()).toEqual({ droppedByPolicy: 0, droppedSampled: 1 });
  });
});
