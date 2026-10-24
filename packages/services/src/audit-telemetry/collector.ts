import { randomUUID } from "node:crypto";
import type {
  AuditTelemetryAttribution,
  AuditTelemetryErrorPayloadInput,
  AuditTelemetryEvent,
  AuditTelemetryQueue,
} from "./contract.js";
import {
  isAuditTelemetryErrorCode,
  type AuditTelemetryChannel,
  AUDIT_TELEMETRY_SCHEMA_VERSION,
  formatAuditTelemetryOccurredAt,
} from "./schema.js";
import {
  mapBackgroundTaskStatusToLifecycle,
  mapBootstrapFailureToLifecycle,
  mapCliTaskLastOutcomeToLifecycle,
  mapSavedWorkflowRunStatusToLifecycle,
  mapTurnResultToLifecycle,
} from "./lifecycle.js";
import { sanitizeErrorPayload } from "./sanitizer.js";
import { createAuditTelemetryPolicyGate, type AuditTelemetryPolicyGate } from "./policy.js";

export type AuditTelemetryRawEvent =
  | { kind: "turn"; result: string; subjectRef: AuditTelemetryEvent["payload"] extends { subjectRef: infer T } ? T : never; channel?: "lifecycle" }
  | { kind: "cliTask" | "backgroundTask" | "workflowRun" | "bootstrapFailure"; status: string; subjectRef: Extract<AuditTelemetryEvent, { type: "task.lifecycle" }>["payload"]["subjectRef"]; channel?: "lifecycle" }
  | { kind: "error"; error: AuditTelemetryErrorPayloadInput; errorCode: string; channel?: AuditTelemetryChannel }
  | { kind: "tool"; toolCallId: string; toolName: string; resultStatus: "started" | "completed" | "failed" | "denied"; subjectRef: Extract<AuditTelemetryEvent, { type: "task.lifecycle" }>["payload"]["subjectRef"]; durationMs?: number; pluginId?: string; skillMetadata?: Record<string, string>; channel?: "diagnostic" };

export interface AuditTelemetryEventSource {
  subscribe(listener: (event: AuditTelemetryRawEvent) => void): () => void;
}
export type AuditTelemetryAttributionSource = () => AuditTelemetryAttribution;
export interface AuditTelemetryCollectorCounters { readonly received: number; readonly minted: number; readonly droppedByPolicy: number; readonly droppedInvalid: number; }
export interface AuditTelemetryCollector {
  start(): void;
  stop(): void;
  dispose(): void;
  flush(): Promise<void>;
  counters(): AuditTelemetryCollectorCounters;
}
export interface AuditTelemetryCollectorOptions {
  source: AuditTelemetryEventSource;
  attribution: AuditTelemetryAttributionSource;
  queue: AuditTelemetryQueue;
  policy?: AuditTelemetryPolicyGate;
  now?: () => Date;
  uuid?: () => string;
}

export function createAuditTelemetryCollector(options: AuditTelemetryCollectorOptions): AuditTelemetryCollector {
  const policy = options.policy ?? createAuditTelemetryPolicyGate();
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  let unsubscribe: (() => void) | undefined;
  let received = 0; let minted = 0; let droppedByPolicy = 0; let droppedInvalid = 0;
  let pending = Promise.resolve();

  function envelope(channel: AuditTelemetryChannel, type: AuditTelemetryEvent["type"], payload: AuditTelemetryEvent["payload"]): AuditTelemetryEvent {
    const attribution = options.attribution();
    const incomplete = attribution.skillVersion === undefined || attribution.skillDigest === undefined;
    return { schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION, eventId: uuid(), commandId: uuid(), occurredAt: formatAuditTelemetryOccurredAt(now()), channel, type, payload, attribution, ...(incomplete ? { attributionIncomplete: true } : {}) } as AuditTelemetryEvent;
  }
  function lifecycle(event: Extract<AuditTelemetryRawEvent, { kind: "turn" | "cliTask" | "backgroundTask" | "workflowRun" | "bootstrapFailure" }>) {
    const map = event.kind === "turn" ? mapTurnResultToLifecycle : event.kind === "cliTask" ? mapCliTaskLastOutcomeToLifecycle : event.kind === "backgroundTask" ? mapBackgroundTaskStatusToLifecycle : event.kind === "workflowRun" ? mapSavedWorkflowRunStatusToLifecycle : mapBootstrapFailureToLifecycle;
    const status = map(event.kind === "turn" ? event.result : event.status);
    if (!status) return undefined;
    return envelope("lifecycle", "task.lifecycle", { lifecycleStatus: status, subjectRef: event.subjectRef });
  }
  function mint(raw: AuditTelemetryRawEvent): AuditTelemetryEvent | undefined {
    if (raw.kind !== "error" && raw.kind !== "tool") {
      return lifecycle(raw);
    }
    if (raw.kind === "error") {
      if (!isAuditTelemetryErrorCode(raw.errorCode)) return undefined;
      return envelope(raw.channel ?? "diagnostic", "runtime.error", { errorCode: raw.errorCode, ...sanitizeErrorPayload(raw.error) });
    }
    return envelope(raw.channel ?? "diagnostic", "capability.evidence", { toolCallId: raw.toolCallId, toolName: raw.toolName, resultStatus: raw.resultStatus, durationMs: raw.durationMs, pluginId: raw.pluginId, skillMetadata: raw.skillMetadata, subjectRef: raw.subjectRef });
  }
  function consume(raw: AuditTelemetryRawEvent): void {
    received += 1;
    try {
      const event = mint(raw);
      if (!event) { droppedInvalid += 1; return; }
      const verdict = policy.decide(event.channel, 0);
      if (verdict !== "enqueue") { droppedByPolicy += 1; return; }
      minted += 1;
      pending = pending.then(() => options.queue.enqueue(event).then(() => undefined)).catch(() => { droppedInvalid += 1; });
    } catch { droppedInvalid += 1; }
  }
  return {
    start() { if (!unsubscribe) unsubscribe = options.source.subscribe(consume); },
    stop() { unsubscribe?.(); unsubscribe = undefined; },
    dispose() { unsubscribe?.(); unsubscribe = undefined; },
    flush() { return pending; },
    counters() { return { received, minted, droppedByPolicy, droppedInvalid }; },
  };
}
