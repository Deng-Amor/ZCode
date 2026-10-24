import { describe, expect, it } from "vitest";
import {
  AUDIT_TELEMETRY_ENVELOPE_FIELDS,
  AUDIT_TELEMETRY_SCHEMA_VERSION,
  AuditTelemetryValidationError,
  CAPABILITY_EVIDENCE_PAYLOAD_FIELDS,
  RUNTIME_ERROR_PAYLOAD_FIELDS,
  TASK_LIFECYCLE_PAYLOAD_FIELDS,
  auditTelemetryEventSchema,
  capabilityEvidencePayloadSchema,
  mapAgentErrorCategoryToErrorCode,
  normalizeAuditTelemetryPlatform,
  parseAuditTelemetryEvent,
  runtimeErrorPayloadSchema,
  serializeAuditTelemetryEvent,
  taskLifecyclePayloadSchema,
} from "../src/audit-telemetry/index.js";
import {
  COMPLETE_ATTRIBUTION,
  INCOMPLETE_ATTRIBUTION,
  testCapabilityEvent,
  testLifecycleEvent,
  testRuntimeErrorEvent,
} from "./auditTelemetryFixtures.js";

describe("audit telemetry strict schema", () => {
  it("accepts the three canonical event kinds", () => {
    for (const event of [
      testLifecycleEvent(),
      testRuntimeErrorEvent(),
      testCapabilityEvent(),
    ]) {
      expect(parseAuditTelemetryEvent(event)).toEqual(event);
    }
  });

  it("rejects unknown envelope fields (strict), including tenantId which must never enter the request body", () => {
    const contaminated = { ...testLifecycleEvent(), tenantId: "tenant-1" };
    expect(auditTelemetryEventSchema.safeParse(contaminated).success).toBe(
      false,
    );
    expect(() => parseAuditTelemetryEvent(contaminated)).toThrow(
      AuditTelemetryValidationError,
    );
  });

  it("rejects unknown payload fields for every event type", () => {
    const lifecycle = {
      ...testLifecycleEvent(),
      payload: {
        ...testLifecycleEvent().payload,
        userContent: "对话正文不得出网",
      },
    };
    const runtimeError = {
      ...testRuntimeErrorEvent(),
      payload: {
        ...testRuntimeErrorEvent().payload,
        stack: "Error: raw stack",
      },
    };
    const capability = {
      ...testCapabilityEvent(),
      payload: { ...testCapabilityEvent().payload, input: "tool input body" },
    };
    for (const event of [lifecycle, runtimeError, capability]) {
      expect(auditTelemetryEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("rejects a payload that does not match its declared type", () => {
    const mismatched = {
      ...testLifecycleEvent(),
      payload: testRuntimeErrorEvent().payload,
    };
    expect(auditTelemetryEventSchema.safeParse(mismatched).success).toBe(false);
  });

  it("requires a timezone-carrying occurredAt (full date parsing, not a regex)", () => {
    const naive = {
      ...testLifecycleEvent(),
      occurredAt: "2026-10-22T11:00:00",
    };
    expect(auditTelemetryEventSchema.safeParse(naive).success).toBe(false);
    for (const occurredAt of [
      "2026-10-22T11:00:00Z",
      "2026-10-22T11:00:00+08:00",
    ]) {
      expect(
        auditTelemetryEventSchema.safeParse({
          ...testLifecycleEvent(),
          occurredAt,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects non-UUID eventId/commandId and foreign schemaVersion", () => {
    expect(
      auditTelemetryEventSchema.safeParse({
        ...testLifecycleEvent(),
        eventId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      auditTelemetryEventSchema.safeParse({
        ...testLifecycleEvent(),
        commandId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      auditTelemetryEventSchema.safeParse({
        ...testLifecycleEvent(),
        schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION + 1,
      }).success,
    ).toBe(false);
  });

  it("requires attributionIncomplete when skill attribution is missing, and bounds sanitizedSummary", () => {
    const unmarked = {
      ...testLifecycleEvent({ attribution: COMPLETE_ATTRIBUTION }),
    };
    const stripped = {
      ...unmarked,
      attribution: { ccodeRelease: "3.16.2", platform: "windows" },
    };
    expect(auditTelemetryEventSchema.safeParse(stripped).success).toBe(false);
    expect(
      auditTelemetryEventSchema.safeParse({
        ...stripped,
        attributionIncomplete: true,
      }).success,
    ).toBe(true);
    expect(
      auditTelemetryEventSchema.safeParse({
        ...testRuntimeErrorEvent(),
        payload: {
          ...testRuntimeErrorEvent().payload,
          sanitizedSummary: "x".repeat(513),
        },
      }).success,
    ).toBe(false);
  });

  it("keeps whitelist field constants in sync with the strict schemas", () => {
    // 常量是"负面清单的补集"的实现来源：字段增删必须同时改 schema 与常量（测试集守恒）。
    expect([...TASK_LIFECYCLE_PAYLOAD_FIELDS].sort()).toEqual(
      Object.keys(taskLifecyclePayloadSchema.shape).sort(),
    );
    expect([...RUNTIME_ERROR_PAYLOAD_FIELDS].sort()).toEqual(
      Object.keys(runtimeErrorPayloadSchema.shape).sort(),
    );
    expect([...CAPABILITY_EVIDENCE_PAYLOAD_FIELDS].sort()).toEqual(
      Object.keys(capabilityEvidencePayloadSchema.shape).sort(),
    );
    const variant = auditTelemetryEventSchema.safeParse(
      testRuntimeErrorEvent(),
    );
    expect(variant.success).toBe(true);
    if (variant.success) {
      // 归因齐备：attributionIncomplete 不出现（可选项缺省即无键）。
      expect(Object.keys(variant.data).sort()).toEqual(
        [...AUDIT_TELEMETRY_ENVELOPE_FIELDS]
          .filter((f) => f !== "attributionIncomplete")
          .sort(),
      );
    }
    const incomplete = auditTelemetryEventSchema.safeParse(
      testRuntimeErrorEvent({ attribution: INCOMPLETE_ATTRIBUTION }),
    );
    expect(incomplete.success).toBe(true);
    if (incomplete.success) {
      expect(Object.keys(incomplete.data).sort()).toEqual(
        [...AUDIT_TELEMETRY_ENVELOPE_FIELDS].sort(),
      );
    }
  });

  it("serializes with fixed key order and drops unknown fields instead of failing", () => {
    const event = testLifecycleEvent();
    const baseline = serializeAuditTelemetryEvent(event);
    // 同一事件重复序列化：字节稳定（内容冻结前提）。
    expect(serializeAuditTelemetryEvent(event)).toBe(baseline);
    // 键插入序打乱的等值对象：固定键序投影后字节一致。
    const reordered = {
      attribution: event.attribution,
      payload: {
        subjectRef: event.payload.subjectRef,
        lifecycleStatus: event.payload.lifecycleStatus,
      },
      channel: event.channel,
      type: event.type,
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      eventId: event.eventId,
      schemaVersion: event.schemaVersion,
    };
    expect(serializeAuditTelemetryEvent(reordered)).toBe(baseline);
    const contaminated = {
      ...event,
      deviceId: "must-not-leave",
      payload: { ...event.payload, workspaceIdentity: "C:\\Users\\someone" },
    };
    const serialized = serializeAuditTelemetryEvent(contaminated);
    expect(serialized).not.toContain("must-not-leave");
    expect(serialized).not.toContain("workspaceIdentity");
    expect(JSON.parse(serialized)).toEqual(JSON.parse(baseline));
  });

  it("normalizes process.platform and maps agent error categories onto fixed codes", () => {
    expect(normalizeAuditTelemetryPlatform("win32")).toBe("windows");
    expect(normalizeAuditTelemetryPlatform("darwin")).toBe("macos");
    expect(normalizeAuditTelemetryPlatform("linux")).toBe("linux");
    expect(normalizeAuditTelemetryPlatform("freebsd")).toBeUndefined();
    expect(mapAgentErrorCategoryToErrorCode("rate_limit")).toBe(
      "AGENT_RATE_LIMIT",
    );
    expect(mapAgentErrorCategoryToErrorCode("unknown")).toBe("AGENT_UNKNOWN");
  });
});
