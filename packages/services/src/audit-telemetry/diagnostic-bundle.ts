import { randomUUID } from "node:crypto";
import { formatAuditTelemetryOccurredAt, type AuditTelemetryAttribution, type AuditTelemetryEvent } from "./schema.js";
import type { AuditTelemetryPolicyGate } from "./policy.js";
import type { AuditTelemetryQueue } from "./contract.js";

/**
 * Bundle 事件只携带结构化元数据（无自由文本），不经 collector 脱敏映射管线，直接过策略门入队，
 * 对齐 spec §6A 的引用入队语义。附件上传端点 OQ-A3 未定稿，本卡不做任何上传。
 */
export interface DiagnosticBundleArchiveBuilder {
  build(): Promise<{ path: string; fileName: string; sizeBytes: number; digestHex: string }>;
}
export type DiagnosticBundleTriggerOutcome = { triggered: boolean; skipReason?: "alreadyTriggeredToday" | "droppedByPolicy" | "buildFailed"; event?: AuditTelemetryEvent };
export interface DiagnosticBundleTriggerCounters { errorTriggered: number; dailyTriggered: number; skippedSameDay: number; droppedByPolicy: number; failed: number }
export interface DiagnosticBundleTriggerOptions { builder: DiagnosticBundleArchiveBuilder; policyGate: AuditTelemetryPolicyGate; queue: Pick<AuditTelemetryQueue, "enqueue">; attribution: AuditTelemetryAttribution; now?: () => Date; uuid?: () => string }
export interface DiagnosticBundleTrigger { triggerOnError(reason: "task_failed" | "crash_recovery" | "controller_bootstrap_failed"): Promise<DiagnosticBundleTriggerOutcome>; runDailyDigest(): Promise<DiagnosticBundleTriggerOutcome>; counters(): DiagnosticBundleTriggerCounters }

export function createDiagnosticBundleTrigger(options: DiagnosticBundleTriggerOptions): DiagnosticBundleTrigger {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  let errorDay: string | undefined;
  let dailyDay: string | undefined;
  const counts: DiagnosticBundleTriggerCounters = { errorTriggered: 0, dailyTriggered: 0, skippedSameDay: 0, droppedByPolicy: 0, failed: 0 };
  // 本地自然日（spec §6A 与 skill-reflow 触发同语义）；不得用 toISOString 的 UTC 日键，
  // 否则 UTC+8 环境会在本地早 8 点翻日，同臂同日幂等窗口错位。
  const localDayKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  async function run(trigger: "error" | "daily_digest", reason: "task_failed" | "crash_recovery" | "controller_bootstrap_failed" | "daily_window"): Promise<DiagnosticBundleTriggerOutcome> {
    const day = localDayKey(now());
    if ((trigger === "error" ? errorDay : dailyDay) === day) { counts.skippedSameDay += 1; return { triggered: false, skipReason: "alreadyTriggeredToday" }; }
    try {
      const archive = await options.builder.build();
      const event: AuditTelemetryEvent = { schemaVersion: 1, eventId: uuid(), commandId: uuid(), occurredAt: formatAuditTelemetryOccurredAt(now()), channel: "diagnostic", type: "diagnostic.bundle", payload: { trigger, reason, archiveDigest: archive.digestHex, archiveSizeBytes: archive.sizeBytes, archiveTraceId: uuid(), archiveFileName: archive.fileName }, attribution: options.attribution, ...(options.attribution.skillVersion && options.attribution.skillDigest ? {} : { attributionIncomplete: true }) };
      if (options.policyGate.decide("diagnostic", 0) !== "enqueue") { counts.droppedByPolicy += 1; return { triggered: false, skipReason: "droppedByPolicy" }; }
      await options.queue.enqueue(event);
      if (trigger === "error") { errorDay = day; counts.errorTriggered += 1; } else { dailyDay = day; counts.dailyTriggered += 1; }
      return { triggered: true, event };
    } catch { counts.failed += 1; return { triggered: false, skipReason: "buildFailed" }; }
  }
  return { triggerOnError: (reason) => run("error", reason), runDailyDigest: () => run("daily_digest", "daily_window"), counters: () => ({ ...counts }) };
}
