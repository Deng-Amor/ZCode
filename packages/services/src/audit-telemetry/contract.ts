import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { AuditTelemetryChannel, AuditTelemetryEvent } from "./schema.js";

/**
 * audit-telemetry 模块公共契约（docs/specs/ccode-audit-telemetry.md，2026-10-22 定稿）。
 * 本文件只声明端口与结果类型；数据 schema 见 schema.ts，纯映射见 lifecycle.ts，
 * 脱敏投影见 sanitizer.ts，策略位见 policy.ts，上报端口见 uploader.ts，磁盘队列实现见 queue.ts。
 */

/** 队列内的一条冻结记录：serializedEvent 为入队时的白名单投影 + 固定键序字节串。 */
export interface AuditTelemetryQueueRecord {
  readonly commandId: string;
  readonly channel: AuditTelemetryChannel;
  readonly serializedEvent: string;
  readonly byteLength: number;
}

export type AuditTelemetryEnqueueStatus =
  | "enqueued"
  /** 同 commandId 同字节重放：幂等命中，不重复入队（中台 M4-R2 客户端义务）。 */
  | "duplicate-replay"
  /** 同 commandId 异内容：拒绝入队并计数，不改写已冻结名义。 */
  | "command-id-conflict"
  /** 单条事件字节超过队列上限：拒绝入队（容量淘汰语义只针对"最老"，不针对新事件）。 */
  | "rejected-oversized";

export interface AuditTelemetryEnqueueResult {
  readonly status: AuditTelemetryEnqueueStatus;
  /** 本次调用淘汰的最老条数（含补报事件入队引发的连带淘汰）。 */
  readonly droppedOldest: number;
  /** 队列生命周期内累计淘汰条数。 */
  readonly droppedOldestTotal: number;
}

export interface AuditTelemetryQueueStats {
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly droppedOldestTotal: number;
  readonly commandIdConflicts: number;
  readonly recoveredCorruptLines: number;
}

/**
 * 磁盘队列端口（唯一持久化所有者）：FIFO、按登录身份隔离、容量淘汰、内容冻结、
 * 重启恢复、ACK 出队。take 不出队——ACK 以中台逐条受理状态为准；未 ACK 记录重试时
 * 重放同一 serializedEvent 字节（不换 commandId、不改内容）。
 */
export interface AuditTelemetryQueue {
  /** 事件先经 strict schema 校验与白名单投影序列化，失败抛 AuditTelemetryValidationError。 */
  enqueue(event: AuditTelemetryEvent): Promise<AuditTelemetryEnqueueResult>;
  /** 取最老的至多 limit 条（可按通道过滤）；不改变队列状态。 */
  take(
    limit: number,
    channel?: AuditTelemetryChannel,
  ): Promise<readonly AuditTelemetryQueueRecord[]>;
  /** 按受理 commandId 出队；未知 id 忽略；返回实际出队条数。 */
  ack(commandIds: readonly string[]): Promise<number>;
  stats(): Promise<AuditTelemetryQueueStats>;
  /** 等待在途写操作收尾；不删除队列文件（跨重启保留）。 */
  dispose(): Promise<void>;
}

// 以下三个磁盘队列配置类型于 2026-10-22 自 queue.ts 移入契约层：
// 契约文件此前从实现文件转出口这些类型形成 contract → queue → contract 循环依赖，
// 被架构检查（cycle）拦截；类型归契约、实现单向导入契约后消除。
/** 磁盘队列容量上限（默认常数与实现见 queue.ts；超限语义：淘汰最老并计数）。 */
export interface AuditTelemetryDiskQueueLimits {
  maxRecords: number;
  maxBytes: number;
}

/** 队列按登录身份隔离的键（tenantId+userId；loginId 不参与隔离，见 queue.ts 说明）。 */
export interface AuditTelemetryQueueIdentity {
  readonly tenantId: string;
  readonly userId: string;
}

export interface AuditTelemetryDiskQueueOptions {
  storageDirectory: string;
  identity: AuditTelemetryQueueIdentity;
  limits?: Partial<AuditTelemetryDiskQueueLimits>;
  /**
   * 容量淘汰后的低频补报计数事件铸造器（spec §5.2）：参数为累计 droppedOldest。
   * 归因注入由铸造方（后续卡的采集器装配层）完成；返回 undefined 表示本次不补报。
   * 事件类型固定为 runtime.error + errorCode=AUDIT_QUEUE_OVERFLOW + channel=diagnostic。
   */
  mintOverflowEvent?: (
    droppedOldestTotal: number,
  ) => AuditTelemetryEvent | undefined;
  logger?: ServiceLogger;
}

export type {
  AuditTelemetryChannel,
  AuditTelemetryEventType,
  AuditTelemetryEvent,
  AuditTelemetryPlatform,
  AuditTelemetrySubjectRef,
  AuditTelemetryAttribution,
  AuditTelemetryLifecycleStatus,
  AuditTelemetryErrorCode,
  AuditTelemetryErrorPhase,
  AuditTelemetryExceptionKind,
  TaskLifecyclePayload,
  RuntimeErrorPayload,
  CapabilityEvidencePayload,
  CapabilityEvidenceSkillMetadata,
} from "./schema.js";
export type {
  AuditTelemetryErrorPayloadInput,
  SanitizedRuntimeErrorProjection,
} from "./sanitizer.js";
export type {
  AuditTelemetryManagementPolicy,
  AuditTelemetryPolicyCounters,
  AuditTelemetryPolicyGate,
  AuditTelemetryPolicyVerdict,
  AuditTelemetryVisibility,
} from "./policy.js";
export type {
  AuditTelemetryUploader,
  AuditTelemetryUploadOutcome,
  AuditTelemetryRejectionReason,
} from "./uploader.js";
