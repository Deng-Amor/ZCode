// ============================================================
// 专家 skill HTTP transport（spec docs/specs/ccode-expert-skills-distribution.md §6.1 方案 A / §5.4 端口）
// ============================================================
// - 实现 @zcode/shared/expert-skills 的 ExpertSkillTransport 端口（HTTP 形态；MCP 形态
//   属后续卡，通道拍板见中台 PRD OQ-4）。通道只承担运输与授权：验签与信任根独立于
//   通道，由调用方执行（spec §6.1 安全不变量 1），本文件不验签、不缓存。
// - 认证经注入的 AuthTokenProvider（Bearer + tenant-id 头，形态对齐
//   confidential-controller/platform-auth.ts 现状，M6-R1 复用中台登录、不新增凭据）；
//   本 transport 不持有凭据。端口签名中的 identity 参数按契约保留：HTTP 方案下
//   租户/用户由服务端从认证上下文取（M6-R3/M4-R4，不信任客户端自报租户），
//   不把 identity 拼进 URL 或正文；缓存层的按身份隔离（spec §5.2）由调用方完成。
// - 请求纪律对齐 platform-auth/http-source：AbortSignal.timeout 超时、redirect:"error"、
//   cache:"no-store" + 请求头 Cache-Control: no-store（spec §6.1 方案 A / M2-R4）、
//   响应流式读取并按体积上限截断（search 64 KiB 量级；content 沿用 envelopeBytes 量级）。
// - 负向结果按固定错误码抛 ExpertSkillHttpError（UNAVAILABLE/AUTH_REQUIRED 族，
//   spec §6.1「五态可区分、固定错误码、不用超时掩盖同步问题」）；错误消息不携带
//   响应正文、URL 或凭据（M6-R7 / spec §6.7）。M2-R5 适用范围外拒绝的专用固定码
//   待中台端点定稿（PRD OQ-11）后补充，当前按业务拒绝归入 UNAVAILABLE 族。
// - 端点路径与响应包络（admin-api 风格 { code, data }）均为客户端侧假设，
//   「待中台定稿」（中台 PRD §4 头声明 + expert spec OQ-1）：默认常量仅占位，
//   可经 options.paths 覆写，不预设为最终契约。

import {
  MANAGED_SKILL_BUNDLE_LIMITS,
  managedSkillEnvelopeSchema,
} from "@zcode/shared/managed-skills";
import type {
  ExpertSkillCatalogEntry,
  ExpertSkillGetOptions,
  ExpertSkillSearchQuery,
  ExpertSkillTransport,
  NotModified,
} from "@zcode/shared/expert-skills";
import type { ManagedSkillEnvelope } from "@zcode/shared/managed-skills";

/** 认证头提供者端口（Bearer + tenant-id；与 audit-telemetry / skill-reflow-upload 的
 * 同形端口各自在本模块内声明，不跨模块新建公共包——本卡拍板形态）。 */
export interface AuthTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

/** 端点路径模板（待中台定稿：中台 PRD §4 头声明端点命名与路径由中台定）。 */
export interface ExpertSkillHttpPaths {
  /** 检索端点（GET，仅元数据条目，spec §6.1 方案 A「检索」）。 */
  readonly search: string;
  /** 内容端点（GET 签名包，If-None-Match 协商，spec §6.1 方案 A「获取」）。 */
  readonly get: string;
}

/** 默认端点路径（占位，待中台定稿；命名风格对齐既有 system/ccode-controller/* 基线）。 */
export const DEFAULT_EXPERT_SKILL_HTTP_PATHS: Readonly<ExpertSkillHttpPaths> = Object.freeze({
  search: "system/ccode-expert-skills/catalog",
  get: "system/ccode-expert-skills/content",
});

/** 检索响应体积上限默认值（64 KiB 量级，spec §6.1 方案 A「检索」建议）。 */
export const DEFAULT_EXPERT_SKILL_SEARCH_LIMIT_BYTES = 64 * 1024;

export type ExpertSkillHttpErrorCode =
  | "AUTH_REQUIRED"
  | "UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "CANCELLED";

/** 固定错误码负向事件（spec §6.6：可回读、不泄漏内部细节）。 */
export class ExpertSkillHttpError extends Error {
  constructor(
    public readonly code: ExpertSkillHttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExpertSkillHttpError";
  }
}

export interface ExpertSkillHttpTransportOptions {
  /** 中台基址（https；与 platform-auth 同校验规则）。 */
  readonly baseUrl: string;
  readonly tokenProvider: AuthTokenProvider;
  /** 端点路径覆写（默认 DEFAULT_EXPERT_SKILL_HTTP_PATHS，待中台定稿占位）。 */
  readonly paths?: Partial<ExpertSkillHttpPaths>;
  /** 注入 fetch（测试用 fake fetch；默认 globalThis.fetch）。 */
  readonly fetchImpl?: typeof fetch;
  /** 请求超时（AbortSignal.timeout）；默认 15s（对齐 platform-auth）。 */
  readonly timeoutMs?: number;
  /** 检索响应体积上限；默认 64 KiB。 */
  readonly searchResponseLimitBytes?: number;
  /** 内容响应体积上限；默认 envelopeBytes + 8192 余量（对齐 controller http-source）。 */
  readonly contentResponseLimitBytes?: number;
}

function errorFor(code: ExpertSkillHttpErrorCode): ExpertSkillHttpError {
  // 消息为固定文案：不携带响应正文/头/URL，凭据与内部细节不落错误（M6-R7）。
  const text: Record<ExpertSkillHttpErrorCode, string> = {
    AUTH_REQUIRED: "expert skill http transport: authentication required",
    UNAVAILABLE: "expert skill http transport: endpoint unavailable",
    PAYLOAD_TOO_LARGE: "expert skill http transport: response exceeds size limit",
    CANCELLED: "expert skill http transport: cancelled",
  };
  return new ExpertSkillHttpError(code, text[code]);
}

function fail(code: ExpertSkillHttpErrorCode): never {
  throw errorFor(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** 解包 admin-api 风格 { code, data } 业务信封（形态待中台定稿，对齐 platform-auth）。 */
function unwrapPlatformEnvelope(json: unknown): unknown {
  if (!isRecord(json) || typeof json.code !== "number") fail("UNAVAILABLE");
  if (json.code === 401 || json.code === 403) fail("AUTH_REQUIRED");
  if (json.code !== 0 || !("data" in json)) fail("UNAVAILABLE");
  return json.data;
}

function toCatalogEntry(value: unknown): ExpertSkillCatalogEntry {
  if (
    !isRecord(value) ||
    typeof value.skillId !== "string" ||
    value.skillId.length === 0 ||
    value.skillId.length > 256 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    typeof value.summary !== "string" ||
    value.summary.length > 4096 ||
    typeof value.scopeRef !== "string" ||
    value.scopeRef.length > 256 ||
    !Array.isArray(value.domainTags) ||
    value.domainTags.some((tag) => typeof tag !== "string" || tag.length > 128) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version <= 0 ||
    !isHex64(value.digest)
  ) {
    // 畸形目录条目按不可用处理：不猜测部分字段（spec §6.1 固定错误码）。
    fail("UNAVAILABLE");
  }
  return {
    skillId: value.skillId,
    name: value.name,
    domainTags: [...value.domainTags] as string[],
    summary: value.summary,
    version: value.version,
    digest: value.digest,
    scopeRef: value.scopeRef,
  };
}

/** HTTP 方案 A 的 ExpertSkillTransport 实现（spec §6.1 方案 A / §5.4 端口）。 */
export function createExpertSkillHttpTransport(
  options: ExpertSkillHttpTransportOptions,
): ExpertSkillTransport {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    // 与 platform-auth 同规则：认证头不得经明文 http 或内嵌凭据的 URL 传输。
    fail("UNAVAILABLE");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const paths: ExpertSkillHttpPaths = {
    ...DEFAULT_EXPERT_SKILL_HTTP_PATHS,
    ...options.paths,
  };
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const searchLimit =
    options.searchResponseLimitBytes ?? DEFAULT_EXPERT_SKILL_SEARCH_LIMIT_BYTES;
  const contentLimit =
    options.contentResponseLimitBytes ??
    MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes + 8192;

  async function request(
    path: string,
    init: {
      method: "GET";
      searchParams: URLSearchParams;
      extraHeaders?: Record<string, string>;
      maxBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(path, base);
    url.search = init.searchParams.toString();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const classify = (error: unknown): ExpertSkillHttpErrorCode => {
      if (init.signal?.aborted) return "CANCELLED";
      if (
        timeoutSignal.aborted &&
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        // 超时是独立的可分类失败，不与连接失败混同（spec §6.1：不用超时掩盖同步问题）。
        return "UNAVAILABLE";
      }
      if (error instanceof ExpertSkillHttpError) return error.code;
      return signal.aborted ? "CANCELLED" : "UNAVAILABLE";
    };
    let response: Response | undefined;
    try {
      // tokenProvider 可能等待刷新；返回后先核对取消，再发请求。
      const headers = { ...(await options.tokenProvider.getHeaders()) };
      if (signal.aborted) fail("CANCELLED");
      response = await doFetch(url, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          ...headers,
          ...init.extraHeaders,
        },
        redirect: "error",
        cache: "no-store",
        signal,
      });
      if (response.status === 304) return { status: 304, json: undefined };
      if (response.status === 401 || response.status === 403) fail("AUTH_REQUIRED");
      if (
        !response.ok ||
        !response.headers.get("content-type")?.toLowerCase().includes("application/json")
      ) {
        fail("UNAVAILABLE");
      }
      const json = await readBoundedJson(response, init.maxBytes);
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof ExpertSkillHttpError) throw error;
      // 直接构造抛出（不用 never 辅助函数）：catch 带 finally 时 TS 控制流分析
      // 无法证明函数必然抛出，会误报缺 return。
      throw errorFor(classify(error));
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    const advertised = response.headers.get("content-length");
    if (
      advertised !== null &&
      (!/^\d+$/u.test(advertised) || Number(advertised) > maxBytes)
    ) {
      fail("PAYLOAD_TOO_LARGE");
    }
    if (!response.body) fail("UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) fail("PAYLOAD_TOO_LARGE");
        chunks.push(chunk.value);
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks)));
      } catch {
        // 畸形响应（非法 JSON/非法 UTF-8）按不可用处理，不泄漏响应字节。
        fail("UNAVAILABLE");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return {
    async search(identity, query: ExpertSkillSearchQuery, signal) {
      // identity 不入请求（见文件头注释）；查询参数按领域标签/关键词透传（粒度待中台定，OQ-6）。
      void identity;
      const params = new URLSearchParams();
      for (const tag of query.domainTags ?? []) params.append("domainTags", tag);
      for (const keyword of query.keywords ?? []) params.append("keywords", keyword);
      const { json } = await request(paths.search, {
        method: "GET",
        searchParams: params,
        maxBytes: searchLimit,
        signal,
      });
      const data = unwrapPlatformEnvelope(json);
      if (!Array.isArray(data) || data.length > 10_000) fail("UNAVAILABLE");
      return data.map(toCatalogEntry);
    },
    async get(
      identity,
      skillId,
      getOptions?: ExpertSkillGetOptions,
      signal?,
    ): Promise<ManagedSkillEnvelope | NotModified> {
      void identity;
      if (typeof skillId !== "string" || skillId.length === 0 || skillId.length > 256) {
        fail("UNAVAILABLE");
      }
      const params = new URLSearchParams({ skillId });
      const cachedDigest = getOptions?.cachedDigest;
      if (cachedDigest !== undefined && !isHex64(cachedDigest)) fail("UNAVAILABLE");
      const { status, json } = await request(paths.get, {
        method: "GET",
        searchParams: params,
        // digest 协商（M2-R4）：If-None-Match 语义，ETag 采用引号包裹形态（RFC 9110）。
        ...(cachedDigest !== undefined
          ? { extraHeaders: { "If-None-Match": `"${cachedDigest}"` } }
          : {}),
        maxBytes: contentLimit,
        signal,
      });
      if (status === 304) {
        // 内容未变化：轻量未变更响应，不重传正文（spec §6.1 方案 A「协商」）。
        return { notModified: true, ...(cachedDigest ? { digest: cachedDigest } : {}) };
      }
      const data = unwrapPlatformEnvelope(json);
      // 复用 shared 契约 schema 解析签名包（本卡要求；验签由调用方独立执行）。
      const parsed = managedSkillEnvelopeSchema.safeParse(data);
      if (!parsed.success) fail("UNAVAILABLE");
      return parsed.data;
    },
  };
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
