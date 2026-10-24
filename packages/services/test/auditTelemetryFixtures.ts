import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuditTelemetryAttribution,
  AuditTelemetryChannel,
  AuditTelemetryErrorCode,
  AuditTelemetryEvent,
  AuditTelemetryLifecycleStatus,
} from "../src/audit-telemetry/index.js";
import { AUDIT_TELEMETRY_SCHEMA_VERSION } from "../src/audit-telemetry/index.js";

/** 审计遥测单测共享夹具：确定性 UUID、三类事件工厂、临时目录。 */

export const COMPLETE_ATTRIBUTION: AuditTelemetryAttribution = {
  ccodeRelease: "3.16.2",
  platform: "windows",
  skillVersion: "2",
  skillDigest: "6a".repeat(32),
};

export const INCOMPLETE_ATTRIBUTION: AuditTelemetryAttribution = {
  ccodeRelease: "3.16.2",
  platform: "macos",
};

let uuidCounter = 0;

/** 确定性合法 UUID（格式合法、每次调用不同），保证测试可回读且 commandId 不碰撞。 */
export function nextTestUuid(prefix = 1): string {
  uuidCounter += 1;
  const hex =
    `${prefix.toString(16).padStart(4, "0")}${uuidCounter.toString(16)}`.padStart(
      12,
      "0",
    );
  return `00000000-0000-4000-8000-${hex.slice(0, 12)}`;
}

export function testLifecycleEvent(options?: {
  commandId?: string;
  channel?: AuditTelemetryChannel;
  lifecycleStatus?: AuditTelemetryLifecycleStatus;
  subjectId?: string;
  attribution?: AuditTelemetryAttribution;
}): AuditTelemetryEvent {
  const attribution = options?.attribution ?? COMPLETE_ATTRIBUTION;
  const complete =
    attribution.skillVersion !== undefined &&
    attribution.skillDigest !== undefined;
  return {
    schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
    eventId: nextTestUuid(2),
    commandId: options?.commandId ?? nextTestUuid(1),
    occurredAt: "2026-10-22T11:00:00+08:00",
    channel: options?.channel ?? "lifecycle",
    type: "task.lifecycle",
    payload: {
      lifecycleStatus: options?.lifecycleStatus ?? "completed",
      subjectRef: { kind: "session", id: options?.subjectId ?? "session-1" },
    },
    attribution,
    ...(complete ? {} : { attributionIncomplete: true }),
  };
}

export function testRuntimeErrorEvent(options?: {
  commandId?: string;
  channel?: AuditTelemetryChannel;
  errorCode?: AuditTelemetryErrorCode;
  sanitizedSummary?: string;
  attribution?: AuditTelemetryAttribution;
}): AuditTelemetryEvent {
  const attribution = options?.attribution ?? COMPLETE_ATTRIBUTION;
  const complete =
    attribution.skillVersion !== undefined &&
    attribution.skillDigest !== undefined;
  return {
    schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
    eventId: nextTestUuid(3),
    commandId: options?.commandId ?? nextTestUuid(1),
    occurredAt: "2026-10-22T11:00:00+08:00",
    channel: options?.channel ?? "diagnostic",
    type: "runtime.error",
    payload: {
      errorCode: options?.errorCode ?? "AGENT_NETWORK",
      sanitizedSummary:
        options?.sanitizedSummary ?? "model request failed after retries",
    },
    attribution,
    ...(complete ? {} : { attributionIncomplete: true }),
  };
}

export function testCapabilityEvent(options?: {
  commandId?: string;
  channel?: AuditTelemetryChannel;
  toolCallId?: string;
  resultStatus?: "started" | "completed" | "failed" | "denied";
  durationMs?: number;
  attribution?: AuditTelemetryAttribution;
}): AuditTelemetryEvent {
  const attribution = options?.attribution ?? COMPLETE_ATTRIBUTION;
  const complete =
    attribution.skillVersion !== undefined &&
    attribution.skillDigest !== undefined;
  return {
    schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
    eventId: nextTestUuid(4),
    commandId: options?.commandId ?? nextTestUuid(1),
    occurredAt: "2026-10-22T11:00:00+08:00",
    channel: options?.channel ?? "diagnostic",
    type: "capability.evidence",
    payload: {
      toolCallId: options?.toolCallId ?? "tool-call-1",
      toolName: "Read",
      resultStatus: options?.resultStatus ?? "completed",
      ...(options?.durationMs !== undefined
        ? { durationMs: options.durationMs }
        : {}),
      skillMetadata: {
        name: "audit",
        qualifiedName: "audit",
        source: "plugin",
        version: "2",
        digest: "6b".repeat(32),
      },
      subjectRef: { kind: "session", id: "session-1" },
    },
    attribution,
    ...(complete ? {} : { attributionIncomplete: true }),
  };
}

export async function makeAuditTelemetryTestDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "audit-telemetry-test-"));
}

export async function removeAuditTelemetryTestDirectory(
  directory: string,
): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
