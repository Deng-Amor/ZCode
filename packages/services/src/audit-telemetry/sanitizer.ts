import {
  auditTelemetryErrorPhaseSchema,
  auditTelemetryExceptionKindSchema,
  type AuditTelemetryErrorPhase,
  type AuditTelemetryExceptionKind,
} from "./schema.js";

/**
 * 白名单脱敏投影器（spec §5.1.2 sanitizedSummary 铸造 + §5.1.6 负面清单）。
 *
 * 负面清单 7 类（任何通道、任何字段、任何形态不得出网）：对话正文、凭据、受控正文、
 * 私有接口响应正文、工具输入/输出正文、workspace 身份全文、原始错误全文。
 * 白名单实现纪律：投影只按字段集常量挑选（schema.ts），未知字段丢弃而非透传；
 * 本文件处理其中"原始错误全文 → 脱敏摘要"这一条，其余 6 类由 schema 字段集
 * 根本不包含对应字段来保证（结构性排除，测试做全文检索兜底）。
 */

/** sanitizedSummary 上限（spec §5.1.2：≤512 字符）。 */
export const AUDIT_TELEMETRY_SANITIZED_SUMMARY_MAX = 512;

/** 输入摘要为空时的占位标记（schema 要求 sanitizedSummary 至少 1 字符）。 */
export const AUDIT_TELEMETRY_EMPTY_SUMMARY = "[no-summary]";

/**
 * 结构化镜像 CLI `ErrorPayload`/`ErrorAttribution` 的可脱敏输入面
 * （锚点 session.events.ts L1212-L1247）。结构一致即可直接传入真实 ErrorPayload，
 * 不 import CLI contracts（包层级方向：services 不依赖上层应用）。
 * message/detail/underlyingErrorMessage/underlyingErrorDetail/stack/data 携带原始错误正文，
 * 只作脱敏输入，任何原文都不进入投影输出（负面清单 #7）。
 */
export interface AuditTelemetryErrorPayloadInput {
  type?: string;
  code?: string;
  message?: string;
  detail?: string;
  underlyingErrorMessage?: string;
  underlyingErrorDetail?: string;
  stack?: string;
  data?: unknown;
  retryable?: boolean;
  attribution?: {
    source?: string;
    reason?: string;
    errorPhase?: string;
    exceptionKind?: string;
    statusCode?: number;
    retryable?: boolean;
  };
}

/** sanitizeErrorPayload 的白名单输出：脱敏摘要 + 可聚合字段（spec §5.1.2 白名单内）。 */
export interface SanitizedRuntimeErrorProjection {
  sanitizedSummary: string;
  errorPhase?: AuditTelemetryErrorPhase;
  exceptionKind?: AuditTelemetryExceptionKind;
  retryable?: boolean;
  statusCode?: number;
}

const REDACTED_JWT = "[REDACTED:jwt]";
const REDACTED_KEY = "[REDACTED:key]";
const REDACTED_BEARER = "[REDACTED:bearer]";
const REDACTED_HIGH_ENTROPY = "[REDACTED:high-entropy]";

// JWT：三个 base64url 段（头.载荷.签名；alg=none 时签名段可为空）。
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
// `sk-` 前缀 API key（OpenAI 风格等）。
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
// Authorization: Bearer 头。
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// 高熵候选：≥20 位的 base64/base64url/十六进制风格长串，再按字符类别多样性确认。
const HIGH_ENTROPY_CANDIDATE_PATTERN = /[A-Za-z0-9+/_=-]{20,}/g;

function looksLikeHighEntropySecret(token: string): boolean {
  let hasLower = false;
  let hasUpper = false;
  let hasDigit = false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) hasDigit = true;
    else if (code >= 0x41 && code <= 0x5a) hasUpper = true;
    else if (code >= 0x61 && code <= 0x7a) hasLower = true;
  }
  // 大写+小写+数字三类并存的长串：常见于 API key/访问令牌；
  // 纯小写 hex 摘要（如 sha256）、普通单词不命中。
  return hasLower && hasUpper && hasDigit;
}

/**
 * 凭据/密钥打码（spec §5.1.2：模式库对齐中台 M3-R3 第一层的客户端子集）：
 * JWT、`sk-` key、Bearer token、高熵串全文替换为固定掩码，原文零残留。
 * 纯函数、顺序固定（JWT → Bearer → sk- → 高熵），避免掩码被二次部分匹配。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(JWT_PATTERN, REDACTED_JWT)
    .replace(BEARER_PATTERN, REDACTED_BEARER)
    .replace(SK_KEY_PATTERN, REDACTED_KEY)
    .replace(HIGH_ENTROPY_CANDIDATE_PATTERN, (token) =>
      looksLikeHighEntropySecret(token) ? REDACTED_HIGH_ENTROPY : token,
    );
}

// 逐码位剔除控制序列（防换行/控制字符注入的脱敏行为）。
// 2026-10-22：不用正则控制字符类实现——受管模块不允许 lint disable（架构检查
// disable-count 红线），改为码位判定纯函数，语义与原 [\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f] 一致
// （保留 \t \n \r 交给空白折叠处理）。
function stripControlChars(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isControl =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    if (!isControl) out += text[index];
  }
  return out;
}

function buildSanitizedSummary(rawSummary: string): string {
  // 空白折叠：堆栈样多行文本压成单行摘要；先打码后截断，保证 512 字符窗口内不出现未打码前缀。
  const collapsed = stripControlChars(redactSecrets(rawSummary))
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return AUDIT_TELEMETRY_EMPTY_SUMMARY;
  return collapsed.slice(0, AUDIT_TELEMETRY_SANITIZED_SUMMARY_MAX);
}

/**
 * 原始 ErrorPayload → runtime.error 白名单投影：
 * - 剔除 message/detail/underlyingErrorMessage/underlyingErrorDetail/stack/data 原文与 type/code 自由文本；
 * - 生成 sanitizedSummary（打码 + 空白折叠 + 截断 ≤512）；
 * - 仅透传可聚合字段 errorPhase/exceptionKind/retryable/statusCode（A2 同款纪律），
 *   词汇表外的取值按未知字段丢弃，不透传原样字符串。
 * 输出交给信封铸造方组装 payload；越界字段在信封 strict schema 处再次被拒。
 */
export function sanitizeErrorPayload(
  input: AuditTelemetryErrorPayloadInput,
): SanitizedRuntimeErrorProjection {
  // 摘要优先 message，缺失时退 underlyingErrorMessage；两者皆空给占位标记。
  const rawSummary = input.message ?? input.underlyingErrorMessage ?? "";
  const projection: SanitizedRuntimeErrorProjection = {
    sanitizedSummary: buildSanitizedSummary(rawSummary),
  };
  const attribution = input.attribution;
  if (attribution) {
    const phase = auditTelemetryErrorPhaseSchema.safeParse(
      attribution.errorPhase,
    );
    if (phase.success) projection.errorPhase = phase.data;
    const kind = auditTelemetryExceptionKindSchema.safeParse(
      attribution.exceptionKind,
    );
    if (kind.success) projection.exceptionKind = kind.data;
    if (attribution.statusCode !== undefined)
      projection.statusCode = attribution.statusCode;
  }
  const retryable = attribution?.retryable ?? input.retryable;
  if (retryable !== undefined) projection.retryable = retryable;
  return projection;
}
