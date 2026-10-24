// ============================================================
// 审计遥测 HTTP 上报器（spec docs/specs/ccode-audit-telemetry.md §5.2 / §5.3 / §4 出网 alt 分支）
// ============================================================
// - 实现 uploader.ts 的 AuditTelemetryUploader 端口（基础层此前为注入接口无网络实现，
//   本文件是其 HTTP 出网形态）。单次调用无状态：重试、退避、heartbeat、ACK 出队均属
//   队列调度方（Main 侧服务）职责，本上传器只做一次批量 POST + 逐条受理状态映射。
// - 请求形态按 spec §5.3 尾段语义假设：「批量 POST、逐条自带 eventId/commandId、
//   响应逐条受理状态」；批量包络 = 会话清单（schemaVersion + channel）+ N 条 item
//   （item 即入队时冻结的 serializedEvent 解析件，含 eventId/commandId/channel/type/
//   payload/attribution）。serializedEvent 不得改写（内容冻结，spec §4 规则 3 /
//   中台 M4-R2：重放同 ID 同内容幂等）——本上传器只解析与装包，不重铸。
// - 认证经注入的 AuthTokenProvider（Bearer + tenant-id 头，形态对齐
//   confidential-controller/platform-auth.ts，M6-R1 不新增凭据）；tenantId 不入请求体
//   （M4-R4：租户由服务端认证上下文取）。
// - outcome 五分支映射（对齐 spec §4 alt / §5.3 M4 对齐表 / §6.2-§6.6）：
//   accepted（含幂等重放视同受理）→ acknowledgedCommandIds 驱动 ACK 出队；
//   rejected → 死信明细（同批其余条目不受牵连：未 ACK 留队，重发靠 M4-R2 幂等取回
//   原结果，不双计）；rate-limited → 留队退避降速；retryable-failure → 留队指数退避；
//   auth-required → 暂停出网、队列保留。401/403 → auth-required；HTTP 429 或业务限流
//   码 → rate-limited；5xx / 网络失败 / 超时 / 畸形响应 / 不可解释的逐条状态 →
//   retryable-failure（保守留队，不 ACK、不死信）。
// - 端点路径、限流错误码具体值均为客户端侧假设（待中台定稿，PRD OQ-11 / spec
//   OQ-A3）：默认常量仅占位，可经 options 覆写。错误路径不向调用方抛异常（outcome
//   即全部结果），不泄漏响应正文与凭据。

import { AUDIT_TELEMETRY_SCHEMA_VERSION } from "./schema.js";
import type { AuditTelemetryChannel } from "./schema.js";
import type {
  AuditTelemetryRejectionReason,
  AuditTelemetryUploadOutcome,
  AuditTelemetryUploader,
} from "./uploader.js";

/** 认证头提供者端口（Bearer + tenant-id；与 expert-skills / skill-reflow-upload 的
 * 同形端口各自在本模块内声明，不跨模块新建公共包——本卡拍板形态）。 */
export interface AuthTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

/** 上报端点路径（待中台定稿：PRD OQ-11 / spec OQ-A3；占位命名对齐既有 system/* 基线）。 */
export const DEFAULT_AUDIT_TELEMETRY_UPLOAD_PATH = "system/ccode-audit-telemetry/events";

/**
 * 业务限流错误码默认集合（待中台定稿，PRD OQ-11④）。HTTP 429 恒映射 rate-limited；
 * 业务信封 code 命中此集合时同样映射 rate-limited（留队退避、不弃数据，spec §6.4）。
 */
export const DEFAULT_AUDIT_TELEMETRY_RATE_LIMIT_CODES: readonly (string | number)[] =
  Object.freeze(["RATE_LIMITED", "TOO_MANY_REQUESTS"]);

/** 逐条受理状态 → 死信原因的固定映射（spec §6.5 / 中台 M4-R8 兜底三类）。 */
const REJECTION_REASONS: ReadonlySet<string> = new Set([
  "attribution-missing",
  "schema-unknown",
  "sensitive-match",
]);

export interface AuditTelemetryHttpUploaderOptions {
  /** 中台基址（https；与 platform-auth 同校验规则）。 */
  readonly baseUrl: string;
  readonly tokenProvider: AuthTokenProvider;
  /** 端点路径覆写（默认 DEFAULT_AUDIT_TELEMETRY_UPLOAD_PATH，待中台定稿占位）。 */
  readonly path?: string;
  /** 注入 fetch（测试用 fake fetch；默认 globalThis.fetch）。 */
  readonly fetchImpl?: typeof fetch;
  /** 请求超时（AbortSignal.timeout）；默认 15s（对齐 platform-auth）。 */
  readonly timeoutMs?: number;
  /** 受理响应体积上限；默认 64 KiB（逐条状态清单，不含事件回传）。 */
  readonly responseLimitBytes?: number;
  /** 业务限流错误码集合覆写（默认 DEFAULT_AUDIT_TELEMETRY_RATE_LIMIT_CODES）。 */
  readonly rateLimitCodes?: readonly (string | number)[];
}

interface UploadRecord {
  readonly commandId: string;
  readonly serializedEvent: string;
}

interface ItemResult {
  readonly commandId?: unknown;
  readonly status?: unknown;
  readonly reason?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 创建 HTTP 上报器（无状态；每次 upload 独立完成一次批量 POST 与 outcome 映射）。 */
export function createAuditTelemetryHttpUploader(
  options: AuditTelemetryHttpUploaderOptions,
): AuditTelemetryUploader {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    // 与 platform-auth 同规则：认证头不得经明文 http 或内嵌凭据的 URL 传输。
    // 配置错误属同步问题，直接抛出供装配方发现，不用 outcome 掩盖。
    throw new Error("audit telemetry uploader: invalid baseUrl");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const path = options.path ?? DEFAULT_AUDIT_TELEMETRY_UPLOAD_PATH;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const responseLimit = options.responseLimitBytes ?? 64 * 1024;
  const rateLimitCodes = new Set<string | number>(
    options.rateLimitCodes ?? DEFAULT_AUDIT_TELEMETRY_RATE_LIMIT_CODES,
  );

  async function postBatch(
    channel: AuditTelemetryChannel,
    items: unknown[],
  ): Promise<AuditTelemetryUploadOutcome> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let response: Response | undefined;
    try {
      const headers = { ...(await options.tokenProvider.getHeaders()) };
      response = await doFetch(new URL(path, base), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...headers,
        },
        body: JSON.stringify({
          schemaVersion: AUDIT_TELEMETRY_SCHEMA_VERSION,
          channel,
          items,
        }),
        redirect: "error",
        cache: "no-store",
        signal: timeoutSignal,
      });
      if (response.status === 401 || response.status === 403) {
        // 认证失败：暂停出网、队列保留、等重新登录（spec §6.6；认证丢失不清队列）。
        return { kind: "auth-required" };
      }
      if (response.status === 429) {
        // 限流：留队 + 退避降速，不弃数据（spec §6.4 / 中台 M4-R6）。
        return { kind: "rate-limited" };
      }
      if (
        !response.ok ||
        !response.headers.get("content-type")?.toLowerCase().includes("application/json")
      ) {
        // 5xx / 非 JSON：网络失败或中台不可用 → 留队重试（spec §6.2）。
        return { kind: "retryable-failure" };
      }
      const json = await readBoundedJson(response, responseLimit);
      return mapResponseBody(json, rateLimitCodes);
    } catch {
      // 网络异常 / 超时 / 读取越限 / 畸形 JSON：一律保守留队（retryable-failure），
      // 不 ACK、不死信；错误细节不进入 outcome（可回读性由固定分支保证）。
      return { kind: "retryable-failure" };
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  return {
    async upload(input: {
      channel: AuditTelemetryChannel;
      records: readonly UploadRecord[];
    }): Promise<AuditTelemetryUploadOutcome> {
      if (input.records.length === 0) {
        // 空批次零请求（对齐「未命中零请求」的运输纪律；ACK 空集为幂等 no-op）。
        return { kind: "accepted", acknowledgedCommandIds: [] };
      }
      const items: unknown[] = [];
      for (const record of input.records) {
        try {
          items.push(JSON.parse(record.serializedEvent));
        } catch {
          // serializedEvent 由队列冻结写入，解析失败属本地缺陷：保守留队，
          // 由调度方计数排查，不在运输层擅自丢弃或死信。
          return { kind: "retryable-failure" };
        }
      }
      return postBatch(input.channel, items);
    },
  };
}

/** 200 响应体 → outcome：业务信封限流/鉴权码优先，其次逐条受理状态聚合。 */
function mapResponseBody(
  json: unknown,
  rateLimitCodes: ReadonlySet<string | number>,
): AuditTelemetryUploadOutcome {
  if (
    !isRecord(json) ||
    (typeof json.code !== "number" && typeof json.code !== "string")
  ) {
    return { kind: "retryable-failure" };
  }
  // 业务码允许字符串形态（限流码具体值待中台定，PRD OQ-11；HTTP 状态码语义仍按数字比对）。
  if (json.code === 401 || json.code === 403) return { kind: "auth-required" };
  if (rateLimitCodes.has(json.code)) return { kind: "rate-limited" };
  if (json.code !== 0 || !isRecord(json.data) || !Array.isArray(json.data.results)) {
    // 未知业务码：不可解释即保守留队，不 ACK、不死信（M4-R5 未知版本同理不重试同批
    // 的语义由调度方按批次处理；运输层只保证不丢、不误 ACK）。
    return { kind: "retryable-failure" };
  }
  const accepted: string[] = [];
  const rejected: { commandId: string; reason: AuditTelemetryRejectionReason }[] = [];
  const sentIds = new Set<string>();
  for (const raw of json.data.results as unknown[]) {
    const item: ItemResult = isRecord(raw) ? raw : {};
    const commandId = item.commandId;
    if (typeof commandId !== "string" || commandId.length === 0 || sentIds.has(commandId)) {
      // 回执缺 commandId 或重复回执：无法定位队列记录，保守留队重发（幂等安全）。
      return { kind: "retryable-failure" };
    }
    sentIds.add(commandId);
    if (item.status === "accepted") {
      accepted.push(commandId);
      continue;
    }
    if (item.status === "rejected") {
      if (typeof item.reason !== "string" || !REJECTION_REASONS.has(item.reason)) {
        // 死信原因必须落在固定三分类内；未知原因不得伪造死信记录。
        return { kind: "retryable-failure" };
      }
      rejected.push({ commandId, reason: item.reason as AuditTelemetryRejectionReason });
      continue;
    }
    // 未知逐条状态：不可解释，保守留队。
    return { kind: "retryable-failure" };
  }
  if (rejected.length > 0) {
    // 混合批次取 rejected：死信明细必须达调度方（不重试，spec §6.5）；已受理的
    // 同批条目未 ACK 留队，重发靠 M4-R2 幂等（同 ID 同内容返回原结果，不双计）。
    return { kind: "rejected", reasons: rejected };
  }
  return { kind: "accepted", acknowledgedCommandIds: accepted };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/u.test(advertised) || Number(advertised) > maxBytes)
  ) {
    throw new Error("response exceeds size limit");
  }
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("response exceeds size limit");
      chunks.push(chunk.value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks));
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
