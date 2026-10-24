import { randomUUID } from "node:crypto";
import type {
  AuditTelemetryAttribution,
  AuditTelemetryErrorPayloadInput,
  AuditTelemetryEvent,
  AuditTelemetryQueue,
} from "#src/audit-telemetry/contract.js";
import { mapTurnResultToLifecycle } from "#src/audit-telemetry/lifecycle.js";
import { sanitizeErrorPayload } from "#src/audit-telemetry/sanitizer.js";
import {
  AUDIT_TELEMETRY_SCHEMA_VERSION,
  formatAuditTelemetryOccurredAt,
} from "#src/audit-telemetry/schema.js";

/**
 * 最小事件铸造示例：归因来自装配记录；skillVersion/skillDigest 缺失（A7 缺口）时
 * 标记 attributionIncomplete: true，仍可入队（出网决策归策略位，spec §5.1.5 / OQ-A7）。
 */
export function lifecycleEventExample(
  turnResult: string,
  sessionId: string,
  attribution: AuditTelemetryAttribution,
): AuditTelemetryEvent {
  const lifecycleStatus = mapTurnResultToLifecycle(turnResult);
  if (!lifecycleStatus) throw new Error(`unmapped turn result: ${turnResult}`);
  const complete =
    attribution.skillVersion !== undefined &&
    attribution.skillDigest !== undefined;
  return {
    schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    commandId: randomUUID(),
    occurredAt: formatAuditTelemetryOccurredAt(new Date()),
    channel: "lifecycle",
    type: "task.lifecycle",
    payload: {
      lifecycleStatus,
      subjectRef: { kind: "session", id: sessionId },
    },
    attribution,
    ...(complete ? {} : { attributionIncomplete: true }),
  };
}

/** 队列写入示例：原始 ErrorPayload 先脱敏再组装 runtime.error；strict 校验失败即抛错，不落盘。 */
export async function enqueueRuntimeErrorExample(
  queue: AuditTelemetryQueue,
  rawError: AuditTelemetryErrorPayloadInput,
  errorCode: "UNAVAILABLE",
  attribution: AuditTelemetryAttribution,
) {
  const sanitized = sanitizeErrorPayload(rawError);
  const complete =
    attribution.skillVersion !== undefined &&
    attribution.skillDigest !== undefined;
  const event: AuditTelemetryEvent = {
    schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    commandId: randomUUID(),
    occurredAt: formatAuditTelemetryOccurredAt(new Date()),
    channel: "lifecycle",
    type: "runtime.error",
    payload: { errorCode, ...sanitized },
    attribution,
    ...(complete ? {} : { attributionIncomplete: true }),
  };
  return queue.enqueue(event);
}
