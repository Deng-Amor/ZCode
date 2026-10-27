import { z } from "zod";

/**
 * 服务端指令/订阅通道信封契约（中台 PRD v0.2.1 §3.7 M7 / §4.7，2026-10-22）。
 *
 * 边界：本文件只定义数据契约（strict schema + 固定键序序列化），不做网络传输
 * （transport 端口注入归后续卡）、不做 Main 装配。契约↔实现单向导入，禁止循环。
 *
 * 两段式解析：
 * 1) 基础信封 strict schema——type 放行任意非空字符串，让枚举外类型**穿过 schema**，
 *    由处理核心的类型白名单判 UNKNOWN_TYPE（M7-R3「客户端对未知类型拒绝」/ S11-d：
 *    伪造 `exec` 必须回 UNKNOWN_TYPE，而不是 MALFORMED）；
 * 2) 已知类型再按 type 分支做全量 strict 校验（params 结构、幂等键归属、未知字段）。
 */

/** 信封 schema 版本（§4.7 envelopeVersion）；v2 起的协商机制归中台 OQ，v1 客户端对未知版本回 MALFORMED。 */
export const COMMAND_CHANNEL_ENVELOPE_VERSION = 1;

// ---------------------------------------------------------------------------
// 类型词汇（固定枚举，M7-R2 通告 / M7-R3 指令）
// ---------------------------------------------------------------------------

export const commandChannelNoticeTypeSchema = z.enum([
  "skill.update.notice",
  "skill.revoke.notice",
  "policy.update",
]);
export type CommandChannelNoticeType = z.infer<
  typeof commandChannelNoticeTypeSchema
>;

export const commandChannelCommandTypeSchema = z.enum([
  "command.pull_chat_logs",
  "command.pull_run_logs",
  "command.pull_skill_usage_stats",
]);
export type CommandChannelCommandType = z.infer<
  typeof commandChannelCommandTypeSchema
>;

export type CommandChannelKnownType =
  | CommandChannelNoticeType
  | CommandChannelCommandType;

/** 指令类型白名单（处理核心 UNKNOWN_TYPE 双保险与策略门共用同一来源）。 */
export const COMMAND_CHANNEL_COMMAND_TYPES = [
  "command.pull_chat_logs",
  "command.pull_run_logs",
  "command.pull_skill_usage_stats",
] as const satisfies readonly CommandChannelCommandType[];

// ---------------------------------------------------------------------------
// params 分支 schema（按 type 严格分支；不含任何正文，M7-R2）
// ---------------------------------------------------------------------------

/** 通告类参数：只带版本/digest/序号（digest 为中台侧摘要字符串，格式由中台定，客户端只要求非空）。 */
export const commandChannelNoticeParamsSchema = z.strictObject({
  version: z.number().int().min(1),
  digest: z.string().min(1),
  seq: z.number().int().min(0),
});
export type CommandChannelNoticeParams = z.infer<
  typeof commandChannelNoticeParamsSchema
>;

/** 时间段（带时区时间字符串；from<to 与时窗上限属 scope 语义，见 processor 的 SCOPE_INVALID 校验）。 */
export const commandChannelTimeRangeSchema = z.strictObject({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
export type CommandChannelTimeRange = z.infer<
  typeof commandChannelTimeRangeSchema
>;

/**
 * 聊天日志指令 scope：sessionId 与 timeRange 结构上均可选（M7-R3「sessionId 范围/时间段」）；
 * 「至少一个必须存在」与 sessionId 格式/长度是 scope 语义，由处理核心判 SCOPE_INVALID
 * （若放进 schema 会错报 MALFORMED，与任务卡 20261022-C4 的原因码分工冲突）。
 */
export const commandChannelChatLogsScopeSchema = z.strictObject({
  sessionId: z.string().optional(),
  timeRange: commandChannelTimeRangeSchema.optional(),
});

/** 运行日志/使用统计指令 scope：仅时间段（M7-R3）。 */
export const commandChannelTimeOnlyScopeSchema = z.strictObject({
  timeRange: commandChannelTimeRangeSchema,
});

export const commandChannelChatLogsParamsSchema = z.strictObject({
  scope: commandChannelChatLogsScopeSchema,
});
export type CommandChannelChatLogsParams = z.infer<
  typeof commandChannelChatLogsParamsSchema
>;

export const commandChannelTimeOnlyParamsSchema = z.strictObject({
  scope: commandChannelTimeOnlyScopeSchema,
});
export type CommandChannelTimeOnlyParams = z.infer<
  typeof commandChannelTimeOnlyParamsSchema
>;

// ---------------------------------------------------------------------------
// 信封 schema：基础（放行未知 type）+ 已知类型全量分支
// ---------------------------------------------------------------------------

/**
 * 基础信封（第一阶段）：type 为任意非空字符串（未知类型延后到白名单判 UNKNOWN_TYPE）；
 * commandId/noticeId 在此层均可选（幂等键归属正确性由已知类型分支判定），
 * params 必须是 JSON 对象。未知字段直接失败（trust boundary）。
 */
// 信封携带的定向 deviceId（2026-10-27 与中台对齐）：服务端签名信封含 deviceId，
// 基础层接收并在处理核验签后与本机注册 ID 逐字匹配。沿用 device-registration 的
// 小写 8-4-4-4-12 手写正则而非 z.uuid()——服务端 ID 未固定 UUID version/variant。
const envelopeDeviceId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .optional();

export const commandChannelEnvelopeBaseSchema = z.strictObject({
  envelopeVersion: z.literal(COMMAND_CHANNEL_ENVELOPE_VERSION),
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  signature: z.string().min(1),
  commandId: z.uuid().optional(),
  noticeId: z.uuid().optional(),
  deviceId: envelopeDeviceId,
});
export type CommandChannelEnvelopeBase = z.infer<
  typeof commandChannelEnvelopeBaseSchema
>;

const envelopeCommonFields = {
  envelopeVersion: z.literal(COMMAND_CHANNEL_ENVELOPE_VERSION),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  signature: z.string().min(1),
  deviceId: envelopeDeviceId,
} as const;

export const skillUpdateNoticeEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("skill.update.notice"),
  noticeId: z.uuid(),
  params: commandChannelNoticeParamsSchema,
});
export type SkillUpdateNoticeEnvelope = z.infer<
  typeof skillUpdateNoticeEnvelopeSchema
>;

export const skillRevokeNoticeEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("skill.revoke.notice"),
  noticeId: z.uuid(),
  params: commandChannelNoticeParamsSchema,
});
export type SkillRevokeNoticeEnvelope = z.infer<
  typeof skillRevokeNoticeEnvelopeSchema
>;

export const policyUpdateNoticeEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("policy.update"),
  noticeId: z.uuid(),
  params: commandChannelNoticeParamsSchema,
});
export type PolicyUpdateNoticeEnvelope = z.infer<
  typeof policyUpdateNoticeEnvelopeSchema
>;

export const pullChatLogsCommandEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("command.pull_chat_logs"),
  commandId: z.uuid(),
  params: commandChannelChatLogsParamsSchema,
});
export type PullChatLogsCommandEnvelope = z.infer<
  typeof pullChatLogsCommandEnvelopeSchema
>;

export const pullRunLogsCommandEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("command.pull_run_logs"),
  commandId: z.uuid(),
  params: commandChannelTimeOnlyParamsSchema,
});
export type PullRunLogsCommandEnvelope = z.infer<
  typeof pullRunLogsCommandEnvelopeSchema
>;

export const pullSkillUsageStatsCommandEnvelopeSchema = z.strictObject({
  ...envelopeCommonFields,
  type: z.literal("command.pull_skill_usage_stats"),
  commandId: z.uuid(),
  params: commandChannelTimeOnlyParamsSchema,
});
export type PullSkillUsageStatsCommandEnvelope = z.infer<
  typeof pullSkillUsageStatsCommandEnvelopeSchema
>;

export type CommandChannelNoticeEnvelope =
  | SkillUpdateNoticeEnvelope
  | SkillRevokeNoticeEnvelope
  | PolicyUpdateNoticeEnvelope;

export type CommandChannelCommandEnvelope =
  | PullChatLogsCommandEnvelope
  | PullRunLogsCommandEnvelope
  | PullSkillUsageStatsCommandEnvelope;

export type CommandChannelEnvelope =
  | CommandChannelNoticeEnvelope
  | CommandChannelCommandEnvelope;

// ---------------------------------------------------------------------------
// 客户端响应（§4.7：executed 附结果摘要引用 / rejected 固定原因码；数据本体经独立上传回传）
// ---------------------------------------------------------------------------

export const commandChannelRejectionReasonSchema = z.enum([
  "POLICY_DISABLED",
  "SCOPE_INVALID",
  "EXPIRED",
  "UNKNOWN_TYPE",
  "INVALID_SIGNATURE",
  "MALFORMED",
]);
export type CommandChannelRejectionReason = z.infer<
  typeof commandChannelRejectionReasonSchema
>;

export interface CommandChannelExecutedResponse {
  readonly status: "executed";
  readonly commandId: string;
  /** 结果摘要引用：数据本体不经本响应携带，经独立上传回传（§4.7）。 */
  readonly resultRef: string;
}

export interface CommandChannelRejectedResponse {
  readonly status: "rejected";
  /** MALFORMED/UNKNOWN_TYPE 时可能无法可靠取到幂等键，best-effort 携带。 */
  readonly commandId?: string;
  readonly noticeId?: string;
  readonly reason: CommandChannelRejectionReason;
}

/** 通告分发回执：通告不进命令处理（M7-R2），分发成功即回 dispatched。 */
export interface CommandChannelDispatchedResponse {
  readonly status: "dispatched";
  readonly noticeId: string;
}

export type CommandChannelResponse =
  | CommandChannelExecutedResponse
  | CommandChannelRejectedResponse
  | CommandChannelDispatchedResponse;

/** 响应固定键序：同 commandId 重放必须返回字节一致的响应（M7-R4 幂等）。 */
const RESPONSE_FIELD_ORDER = [
  "status",
  "commandId",
  "noticeId",
  "reason",
  "resultRef",
] as const;

export function serializeCommandChannelResponse(
  response: CommandChannelResponse,
): string {
  // 联合类型按固定键序读取：以索引签名视图访问（键序白名单即上方常量，无越界风险）。
  const source = response as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const field of RESPONSE_FIELD_ORDER) {
    const value = source[field];
    if (value !== undefined) ordered[field] = value;
  }
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// 解析（两段式）与时间工具
// ---------------------------------------------------------------------------

export type ParsedCommandChannelEnvelope =
  | {
      readonly kind: "notice";
      readonly envelope: CommandChannelNoticeEnvelope;
      /** 基础信封（含未按 type 收窄的原样字段）：验签端口统一按此形态输入（M7-R7 同一安全信封）。 */
      readonly base: CommandChannelEnvelopeBase;
    }
  | {
      readonly kind: "command";
      readonly envelope: CommandChannelCommandEnvelope;
      readonly base: CommandChannelEnvelopeBase;
    }
  | { readonly kind: "unknown-type"; readonly base: CommandChannelEnvelopeBase };

/** strict schema 校验失败（未知字段、结构不符、已知类型 params/幂等键不合法等）。 */
export class CommandChannelValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "CommandChannelValidationError";
  }
}

function toValidationError(error: z.ZodError): CommandChannelValidationError {
  return new CommandChannelValidationError(
    `command channel envelope rejected: ${error.message}`,
    error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    ),
  );
}

/**
 * 两段式 strict 解析：基础信封失败抛 CommandChannelValidationError（处理核心映射 MALFORMED）；
 * 未知 type 返回 { kind: "unknown-type" }（处理核心在验签与过期之后映射 UNKNOWN_TYPE）。
 * base 一并返回：验签端口的输入形态统一为基础信封（未知类型没有可收窄的全量信封）。
 */
export function parseCommandChannelEnvelope(
  value: unknown,
): ParsedCommandChannelEnvelope {
  const base = commandChannelEnvelopeBaseSchema.safeParse(value);
  if (!base.success) throw toValidationError(base.error);
  const baseEnvelope: CommandChannelEnvelopeBase = base.data;
  switch (baseEnvelope.type) {
    case "skill.update.notice":
    case "skill.revoke.notice":
    case "policy.update": {
      const schema =
        baseEnvelope.type === "skill.update.notice"
          ? skillUpdateNoticeEnvelopeSchema
          : baseEnvelope.type === "skill.revoke.notice"
            ? skillRevokeNoticeEnvelopeSchema
            : policyUpdateNoticeEnvelopeSchema;
      const result = schema.safeParse(value);
      if (!result.success) throw toValidationError(result.error);
      return {
        kind: "notice",
        envelope: result.data,
        base: baseEnvelope,
      };
    }
    case "command.pull_chat_logs":
    case "command.pull_run_logs":
    case "command.pull_skill_usage_stats": {
      const schema =
        baseEnvelope.type === "command.pull_chat_logs"
          ? pullChatLogsCommandEnvelopeSchema
          : baseEnvelope.type === "command.pull_run_logs"
            ? pullRunLogsCommandEnvelopeSchema
            : pullSkillUsageStatsCommandEnvelopeSchema;
      const result = schema.safeParse(value);
      if (!result.success) throw toValidationError(result.error);
      return {
        kind: "command",
        envelope: result.data,
        base: baseEnvelope,
      };
    }
    default:
      return { kind: "unknown-type", base: baseEnvelope };
  }
}

/** 铸造/审计用时间写入格式：UTC ISO 字符串。 */
export function formatCommandChannelTimestamp(at: Date): string {
  return at.toISOString();
}
