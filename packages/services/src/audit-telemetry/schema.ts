import { z } from "zod";

/**
 * CCode 审计遥测事件模型（docs/specs/ccode-audit-telemetry.md §5.1，2026-10-22 定稿）。
 *
 * 边界：本文件只定义数据契约（strict schema + 白名单投影 + 确定性序列化），不做网络、
 * 不订阅 CLI 事件总线、不做 Main 进程集成（后续卡）。不复用既有模型 API 遥测
 * （apps/zcode-cli/packages/telemetry/，OTLP/ARMS 面）的出口与 schema，仅按 spec 对齐词汇。
 */

/** 信封 schema 版本（spec §5.1.4）；N-1 兼容义务归服务端（中台 M4-R5）。递增规则见 OQ-A4。 */
export const AUDIT_TELEMETRY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 基础词汇
// ---------------------------------------------------------------------------

/** 两档频率通道（拍板 #2 / 中台 M4-R7）：lifecycle 准实时，diagnostic 批量+采样。 */
export const auditTelemetryChannelSchema = z.enum(["lifecycle", "diagnostic"]);
export type AuditTelemetryChannel = z.infer<typeof auditTelemetryChannelSchema>;

export const auditTelemetryEventTypeSchema = z.enum([
  "task.lifecycle",
  "runtime.error",
  "capability.evidence",
  "diagnostic.bundle",
]);
export type AuditTelemetryEventType = z.infer<
  typeof auditTelemetryEventTypeSchema
>;

/** platform 归一值域（spec §5.1.5，对齐中台 PRD §4.5）。 */
export const auditTelemetryPlatformSchema = z.enum([
  "windows",
  "macos",
  "linux",
]);
export type AuditTelemetryPlatform = z.infer<
  typeof auditTelemetryPlatformSchema
>;

/**
 * `process.platform` 归一（win32→windows、darwin→macos、linux→linux）。
 * 未知输入返回 undefined，由调用方决定处置；不猜测默认值（spec §5.1.5 值域纪律）。
 */
export function normalizeAuditTelemetryPlatform(
  raw: string,
): AuditTelemetryPlatform | undefined {
  switch (raw) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

/**
 * 任务主体引用（spec §5.1.1）：kind 区分会话/后台任务/工作流运行/运行环境；
 * id 为本地稳定标识的不透明字符串，不含用户内容。同一任务的 started 与终态靠它关联。
 */
export const auditTelemetrySubjectRefSchema = z.strictObject({
  kind: z.enum(["session", "background_task", "workflow_run", "runtime"]),
  id: z.string().min(1),
});
export type AuditTelemetrySubjectRef = z.infer<
  typeof auditTelemetrySubjectRefSchema
>;

/**
 * occurredAt：带时区（Z 或 ±HH:MM）的时间字符串。zod datetime 执行完整日期解析，
 * 不以字符串正则替代日期解析（spec §5.1.4，provenance-ledger L24 同款纪律）。
 */
export const auditTelemetryOccurredAtSchema = z.iso.datetime({ offset: true });

/** 铸造时的 occurredAt 写入格式：UTC ISO 字符串（补传不改写时间，spec §6.9）。 */
export function formatAuditTelemetryOccurredAt(at: Date): string {
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// 固定错误码族（spec §5.1.2）
// ---------------------------------------------------------------------------

/**
 * 固定错误码（可聚合，不含内部细节）：
 * - 前 10 个直接采用 `ConfidentialControllerError` 码值（总控装配失败码族，
 *   apps/zcode-cli/packages/adapters/src/confidential-controller/bootstrap.ts L16-L27；码值在此
 *   本地声明是因为 CLI contracts 位于 services 之上，不能反向依赖）；
 * - `AGENT_*` 由既有模型 API 遥测的 `AgentTelemetryErrorCategory` 11 值映射
 *   （apps/zcode-cli/packages/contracts/src/telemetry/agent-execution.ts L41-L52）；
 * - `AUDIT_QUEUE_OVERFLOW` 专用于本地队列容量淘汰后的低频补报计数事件（spec §5.2）。
 */
export const auditTelemetryErrorCodeSchema = z.enum([
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REJECTED",
  "AUTH_REQUIRED",
  "IDENTITY_CHANGED",
  "CANCELLED",
  "UNAVAILABLE",
  "EXECUTION_FAILED",
  "INVALID_RELEASE",
  "VERSION_CHANGED",
  "CAPACITY_EXCEEDED",
  "AGENT_CONFIGURATION",
  "AGENT_AUTHENTICATION",
  "AGENT_PERMISSION",
  "AGENT_RATE_LIMIT",
  "AGENT_TIMEOUT",
  "AGENT_NETWORK",
  "AGENT_PROVIDER",
  "AGENT_PARSE",
  "AGENT_CANCELLED",
  "AGENT_INTERNAL",
  "AGENT_UNKNOWN",
  "AUDIT_QUEUE_OVERFLOW",
]);
export type AuditTelemetryErrorCode = z.infer<
  typeof auditTelemetryErrorCodeSchema
>;

/** AgentTelemetryErrorCategory 输入词汇（本地镜像，锚点见上；结构一致即可互换）。 */
export type AuditTelemetryAgentErrorCategory =
  | "configuration"
  | "authentication"
  | "permission"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider"
  | "parse"
  | "cancelled"
  | "internal"
  | "unknown";

/** 模型/网络/工具类错误分类 → 可聚合固定码（spec §5.1.2 第二类来源）。 */
export function mapAgentErrorCategoryToErrorCode(
  category: AuditTelemetryAgentErrorCategory,
): AuditTelemetryErrorCode {
  return `AGENT_${category.toUpperCase()}` as AuditTelemetryErrorCode;
}

/** 判断外部错误码是否已是审计遥测固定码（总控装配码族为恒等子集）。 */
export function isAuditTelemetryErrorCode(
  value: string,
): value is AuditTelemetryErrorCode {
  return auditTelemetryErrorCodeSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// 可聚合错误词汇（复用既有 telemetry 词汇，spec §5.1.2；锚点 contracts/src/telemetry/index.ts L53/L62）
// ---------------------------------------------------------------------------

export const auditTelemetryErrorPhaseSchema = z.enum([
  "prepare",
  "configuration",
  "connect",
  "response",
  "stream",
  "parse",
  "validation",
  "unhandled",
]);
export type AuditTelemetryErrorPhase = z.infer<
  typeof auditTelemetryErrorPhaseSchema
>;

export const auditTelemetryExceptionKindSchema = z.enum([
  "api_call",
  "generic",
  "protocol",
  "provider_business",
  "transport",
  "type_error",
  "validation",
]);
export type AuditTelemetryExceptionKind = z.infer<
  typeof auditTelemetryExceptionKindSchema
>;

// ---------------------------------------------------------------------------
// 三类事件 payload（白名单 strict schema；负面清单见 spec §5.1.6）
// ---------------------------------------------------------------------------

/** 任务生命周期状态（拍板 #1 原文词汇，独立投影枚举，不改任何既有 schema，spec §5.1.1）。 */
export const auditTelemetryLifecycleStatusSchema = z.enum([
  "started",
  "stopped",
  "failed",
  "completed",
  "error",
]);
export type AuditTelemetryLifecycleStatus = z.infer<
  typeof auditTelemetryLifecycleStatusSchema
>;

export const taskLifecyclePayloadSchema = z.strictObject({
  lifecycleStatus: auditTelemetryLifecycleStatusSchema,
  subjectRef: auditTelemetrySubjectRefSchema,
});
export type TaskLifecyclePayload = z.infer<typeof taskLifecyclePayloadSchema>;

/**
 * 运行错误 payload：只含固定错误码 + 脱敏摘要 + 可聚合字段。
 * 不含 ErrorPayload.message/detail/underlyingErrorMessage/stack/data 原文（负面清单 #7）。
 */
export const runtimeErrorPayloadSchema = z.strictObject({
  errorCode: auditTelemetryErrorCodeSchema,
  sanitizedSummary: z.string().min(1).max(512),
  errorPhase: auditTelemetryErrorPhaseSchema.optional(),
  exceptionKind: auditTelemetryExceptionKindSchema.optional(),
  retryable: z.boolean().optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
});
export type RuntimeErrorPayload = z.infer<typeof runtimeErrorPayloadSchema>;

/**
 * 能力调用证据 skill 归因：现有 SkillTelemetryMetadata 四字段 + version/digest
 * （spec §5.1.3 / A7 缺口；锚点 contracts/src/skills/index.ts L70-L76）。
 */
export const capabilityEvidenceSkillMetadataSchema = z.strictObject({
  name: z.string().min(1).optional(),
  qualifiedName: z.string().min(1).optional(),
  pluginId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  digest: z.string().min(1).optional(),
});
export type CapabilityEvidenceSkillMetadata = z.infer<
  typeof capabilityEvidenceSkillMetadataSchema
>;

/**
 * 能力调用证据 payload：只含元数据。工具 input、result.content、display 一律不出现
 * （spec §5.1.3「只含元数据」；负面清单 #5）。
 */
export const capabilityEvidencePayloadSchema = z.strictObject({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  resultStatus: z.enum(["started", "completed", "failed", "denied"]),
  durationMs: z.number().int().min(0).optional(),
  skillMetadata: capabilityEvidenceSkillMetadataSchema.optional(),
  pluginId: z.string().min(1).optional(),
  subjectRef: auditTelemetrySubjectRefSchema,
});
export type CapabilityEvidencePayload = z.infer<
  typeof capabilityEvidencePayloadSchema
>;

export const diagnosticBundlePayloadSchema = z.strictObject({
  trigger: z.enum(["error", "daily_digest"]),
  reason: z.enum([
    "task_failed",
    "crash_recovery",
    "controller_bootstrap_failed",
    "daily_window",
  ]),
  archiveDigest: z.string().regex(/^[0-9a-f]{64}$/),
  archiveSizeBytes: z.number().int().min(0),
  archiveTraceId: z.string().min(1),
  archiveFileName: z.string().min(1),
});
export type DiagnosticBundlePayload = z.infer<
  typeof diagnosticBundlePayloadSchema
>;

// ---------------------------------------------------------------------------
// 归因组与事件信封（spec §5.1.4 / §5.1.5）
// ---------------------------------------------------------------------------

/**
 * 归因字段（拍板 #5）：tenantId 不入请求体（服务端从认证上下文补全，中台 M4-R4），
 * 由 strict schema 对未知字段的拒绝兜底（含 tenantId/deviceId/workspace 身份等一切越界键）。
 * skillVersion/skillDigest 可缺失（A7 缺口），缺失时信封必须标记 attributionIncomplete。
 */
export const auditTelemetryAttributionSchema = z.strictObject({
  ccodeRelease: z.string().min(1),
  platform: auditTelemetryPlatformSchema,
  skillVersion: z.string().min(1).optional(),
  skillDigest: z.string().min(1).optional(),
});
export type AuditTelemetryAttribution = z.infer<
  typeof auditTelemetryAttributionSchema
>;

const envelopeCommonFields = {
  schemaVersion: z.literal(AUDIT_TELEMETRY_SCHEMA_VERSION),
  eventId: z.uuid(),
  commandId: z.uuid(),
  occurredAt: auditTelemetryOccurredAtSchema,
  channel: auditTelemetryChannelSchema,
  attribution: auditTelemetryAttributionSchema,
  attributionIncomplete: z.literal(true).optional(),
} as const;

/**
 * 事件通用信封：schemaVersion/eventId(UUID)/commandId(UUID 幂等键)/occurredAt(带时区)/
 * channel/type/payload/attribution。未知字段在 strict parse 下直接失败（trust boundary），
 * 在序列化路径上经白名单投影丢弃（见 serializeAuditTelemetryEvent，spec §5.1.6）。
 */
export const auditTelemetryEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...envelopeCommonFields,
      type: z.literal("task.lifecycle"),
      payload: taskLifecyclePayloadSchema,
    }),
    z.strictObject({
      ...envelopeCommonFields,
      type: z.literal("runtime.error"),
      payload: runtimeErrorPayloadSchema,
    }),
    z.strictObject({
      ...envelopeCommonFields,
      type: z.literal("capability.evidence"),
      payload: capabilityEvidencePayloadSchema,
    }),
    z.strictObject({
      ...envelopeCommonFields,
      type: z.literal("diagnostic.bundle"),
      channel: z.literal("diagnostic"),
      payload: diagnosticBundlePayloadSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    // 归因不完整仍可入队，但必须显式标记，供本地计数与出网决策回读（spec §5.1.5 / OQ-A7）。
    const { attribution, attributionIncomplete } = event;
    if (
      (!attribution.skillVersion || !attribution.skillDigest) &&
      attributionIncomplete !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["attributionIncomplete"],
        message:
          "skillVersion/skillDigest 缺失时必须标记 attributionIncomplete: true",
      });
    }
  });
export type AuditTelemetryEvent = z.infer<typeof auditTelemetryEventSchema>;

// ---------------------------------------------------------------------------
// 白名单字段集常量（strict schema 的补集即负面清单；投影与测试共用同一来源）
// ---------------------------------------------------------------------------

export const AUDIT_TELEMETRY_ENVELOPE_FIELDS = [
  "schemaVersion",
  "eventId",
  "commandId",
  "occurredAt",
  "channel",
  "type",
  "payload",
  "attribution",
  "attributionIncomplete",
] as const;

export const TASK_LIFECYCLE_PAYLOAD_FIELDS = [
  "lifecycleStatus",
  "subjectRef",
] as const;

export const RUNTIME_ERROR_PAYLOAD_FIELDS = [
  "errorCode",
  "sanitizedSummary",
  "errorPhase",
  "exceptionKind",
  "retryable",
  "statusCode",
] as const;

export const CAPABILITY_EVIDENCE_PAYLOAD_FIELDS = [
  "toolCallId",
  "toolName",
  "resultStatus",
  "durationMs",
  "skillMetadata",
  "pluginId",
  "subjectRef",
] as const;

export const DIAGNOSTIC_BUNDLE_PAYLOAD_FIELDS = [
  "trigger",
  "reason",
  "archiveDigest",
  "archiveSizeBytes",
  "archiveTraceId",
  "archiveFileName",
] as const;

export const CAPABILITY_EVIDENCE_SKILL_METADATA_FIELDS = [
  "name",
  "qualifiedName",
  "pluginId",
  "source",
  "version",
  "digest",
] as const;

// ---------------------------------------------------------------------------
// 校验与确定性序列化
// ---------------------------------------------------------------------------

/** 事件校验失败（strict schema 拒绝：未知字段、类型不符、归因标记缺失等）。 */
export class AuditTelemetryValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "AuditTelemetryValidationError";
  }
}

function toValidationError(error: z.ZodError): AuditTelemetryValidationError {
  return new AuditTelemetryValidationError(
    `audit telemetry event rejected: ${error.message}`,
    error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    ),
  );
}

/** strict 解析：未知字段直接失败（供信任边界使用，如跨进程消息入口）。 */
export function parseAuditTelemetryEvent(value: unknown): AuditTelemetryEvent {
  const result = auditTelemetryEventSchema.safeParse(value);
  if (!result.success) throw toValidationError(result.error);
  return result.data;
}

function pickPresent(
  source: object,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field as keyof typeof source] !== undefined) {
      out[field] = source[field as keyof typeof source];
    }
  }
  return out;
}

function projectSubjectRef(value: object): Record<string, unknown> {
  return pickPresent(value, ["kind", "id"]);
}

/** 白名单投影：未知字段丢弃而非透传（spec §5.1.6 序列化纪律），键序固定保证字节稳定。 */
function projectEvent(value: Record<string, unknown>): Record<string, unknown> {
  // 修复 TS2339：投影输入按索引签名读取（信封键动态挑选），object 形参不允许属性访问。
  const type = value.type as string | undefined;
  const payload = (value.payload ?? {}) as Record<string, unknown>;
  let projectedPayload: Record<string, unknown>;
  switch (type) {
    case "task.lifecycle":
      projectedPayload = pickPresent(payload, TASK_LIFECYCLE_PAYLOAD_FIELDS);
      break;
    case "runtime.error":
      projectedPayload = pickPresent(payload, RUNTIME_ERROR_PAYLOAD_FIELDS);
      break;
    case "capability.evidence":
      projectedPayload = pickPresent(
        payload,
        CAPABILITY_EVIDENCE_PAYLOAD_FIELDS,
      );
      if (payload.skillMetadata !== undefined) {
        projectedPayload.skillMetadata = pickPresent(
          payload.skillMetadata as object,
          CAPABILITY_EVIDENCE_SKILL_METADATA_FIELDS,
        );
      }
      break;
    case "diagnostic.bundle":
      projectedPayload = pickPresent(payload, DIAGNOSTIC_BUNDLE_PAYLOAD_FIELDS);
      break;
    default:
      throw new AuditTelemetryValidationError(
        `unknown audit telemetry event type: ${String(type)}`,
        [`type: ${String(type)}`],
      );
  }
  if (projectedPayload.subjectRef !== undefined) {
    projectedPayload.subjectRef = projectSubjectRef(
      projectedPayload.subjectRef as object,
    );
  }
  const envelope = pickPresent(value, AUDIT_TELEMETRY_ENVELOPE_FIELDS);
  envelope.type = type;
  envelope.payload = projectedPayload;
  const attribution = (value.attribution ?? {}) as object;
  envelope.attribution = pickPresent(attribution, [
    "ccodeRelease",
    "platform",
    "skillVersion",
    "skillDigest",
  ]);
  return envelope;
}

/**
 * 确定性序列化（内容冻结基础，spec §4 规则 3）：
 * 1) 白名单投影丢弃未知字段（负面清单不出网）；2) strict schema 校验投影结果；
 * 3) 固定键序 JSON 字符串——同事件重放/重启恢复得到同一字节序列。
 */
export function serializeAuditTelemetryEvent(event: object): string {
  const projected = projectEvent(event as Record<string, unknown>);
  const result = auditTelemetryEventSchema.safeParse(projected);
  if (!result.success) throw toValidationError(result.error);
  return JSON.stringify(projected);
}
