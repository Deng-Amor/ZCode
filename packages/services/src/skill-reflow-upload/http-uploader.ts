// ============================================================
// Skill 回流 HTTP 上传器（spec docs/specs/ccode-skill-sync-upload.md §5.2 payload 表 / §四 阶段 4-6）
// ============================================================
// - 批量上传会话 = 会话清单 manifest（schemaVersion/triggerType/entryCount/
//   sessionDigest/ccodeRelease/platform，spec §5.2 会话清单表）+ N 条目（§5.2 条目字段表：
//   relativePath/name/contentFiles/contentDigest/lastModified/description?/sourceType）；
//   响应逐条回执（accepted/dedupHit/filterHit + filterCategory，中台 M3-R8）映射为
//   SkillReflowSessionReceipt（contract.ts）。
// - 内容文件由调用方（队列调度/装配层）按 entry.directoryPath 物化后以 files 注入；
//   本上传器只运输与回执映射，不读磁盘、不重算 digest（本卡边界；重试/退避/账本回写
//   归 service.ts 与调度方）。
// - sessionDigest 为客户端侧定义（spec §5.2「客户端侧定义，供会话级核对」）：条目按
//   发送顺序的 contentDigest 以 "\n" 连接后取 SHA-256 hex；基准固化在 schemaVersion 1 内，
//   变更需双方同步（对齐 OQ-2 纪律）。
// - 认证经注入的 AuthTokenProvider（Bearer + tenant-id 头，形态对齐
//   confidential-controller/platform-auth.ts，M6-R1 不新增凭据）；tenantId 不入请求体
//   （M4-R4）。请求纪律：AbortSignal.timeout 超时、redirect:"error"、cache:"no-store"
//   + 请求头 Cache-Control: no-store、响应流式读取并按体积上限截断。
// - 失败按 contract.ts 固定错误码抛 SkillReflowHttpUploadError（SkillReflowError 形态，
//   可直接进状态面 lastError；spec §6.4「不用超时掩盖同步问题」）：401→NEED_LOGIN、
//   403→AUTH_REJECTED、429/业务限流码→RATE_LIMITED、5xx→PLATFORM_UNAVAILABLE、
//   网络失败/超时→NETWORK_UNAVAILABLE、畸形响应/回执缺字段→SCHEMA_REJECTED、
//   响应超限→PAYLOAD_TOO_LARGE。错误消息为固定文案，不携带响应正文与凭据。
// - 端点路径与响应包络（admin-api 风格 { code, data })为客户端侧假设（待中台定稿，
//   中台 PRD §4 头声明 / spec OQ-1）：默认常量仅占位，可经 options 覆写。
// - 回执缺字段防御（M3-R8 消费纪律）：回执必须能唯一定位发送条目（key 精确命中，
//   或 relativePath 在本批内唯一命中）且 outcome 落在固定三值内；否则整批按
//   SCHEMA_REJECTED 抛出——不 ACK 任何条目（条目留队列，重发靠中台 租户+contentDigest
//   幂等去重，不产生重复记录，PRD §4.3），不伪造回执。filterHit 缺 filterCategory
//   容忍为可选字段（contract 中即 optional）。

import { createHash } from "node:crypto";
import type {
  SkillReflowEntry,
  SkillReflowError,
  SkillReflowErrorCode,
  SkillReflowSessionReceipt,
} from "./contract.js";

/** 认证头提供者端口（Bearer + tenant-id；与 expert-skills / audit-telemetry 的
 * 同形端口各自在本模块内声明，不跨模块新建公共包——本卡拍板形态）。 */
export interface AuthTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

/** 上传端点路径（待中台定稿：中台 PRD §4 头声明 / spec OQ-1；占位命名对齐既有 system/* 基线）。 */
export const DEFAULT_SKILL_REFLOW_UPLOAD_PATH = "system/ccode-skill-reflow/sessions";

/** 业务限流错误码默认集合（待中台定稿）。HTTP 429 恒映射 RATE_LIMITED。 */
export const DEFAULT_SKILL_REFLOW_RATE_LIMIT_CODES: readonly (string | number)[] =
  Object.freeze(["RATE_LIMITED", "TOO_MANY_REQUESTS"]);

/** 会话清单 schemaVersion（spec §5.2：初始 1；新增字段可选）。 */
export const SKILL_REFLOW_UPLOAD_SCHEMA_VERSION = 1;

/** 归因 platform 值域（spec §5.2 对齐中台 PRD §4.5：windows/macos/linux；由调用方归一）。 */
export type SkillReflowPlatform = "windows" | "macos" | "linux";

export type SkillReflowTriggerType = "dailyFirstLaunch" | "startupRetry" | "onlineHeartbeat";

/** 已物化的条目内容文件（调用方按 entry.directoryPath 重读后注入；路径相对条目目录）。 */
export interface SkillReflowUploadFile {
  readonly path: string;
  readonly contentBase64: string;
}

export interface SkillReflowUploadEntry {
  /** 队列条目（含 key/relativePath/contentDigest/lastModified 等回执定位字段）。 */
  readonly entry: SkillReflowEntry;
  /** 可选描述（spec §5.2 条目字段；队列条目不携带，由装配方从扫描/frontmatter 补充）。 */
  readonly description?: string;
  readonly files: readonly SkillReflowUploadFile[];
}

export interface SkillReflowHttpUploaderOptions {
  /** 中台基址（https；与 platform-auth 同校验规则）。 */
  readonly baseUrl: string;
  readonly tokenProvider: AuthTokenProvider;
  /** 归因字段（客户端自报；tenantId 由服务端认证上下文提供，不传，M4-R4）。 */
  readonly attribution: {
    readonly ccodeRelease: string;
    readonly platform: SkillReflowPlatform;
  };
  /** 端点路径覆写（默认 DEFAULT_SKILL_REFLOW_UPLOAD_PATH，待中台定稿占位）。 */
  readonly path?: string;
  /** 注入 fetch（测试用 fake fetch；默认 globalThis.fetch）。 */
  readonly fetchImpl?: typeof fetch;
  /** 请求超时（AbortSignal.timeout）；默认 30s（批量含内容文件，宽于单事件上报）。 */
  readonly timeoutMs?: number;
  /** 受理响应体积上限；默认 256 KiB（回执清单）。 */
  readonly responseLimitBytes?: number;
  /** 业务限流错误码集合覆写。 */
  readonly rateLimitCodes?: readonly (string | number)[];
  /** 可注入时钟（回执 settledAt；生产默认 Date）。 */
  readonly now?: () => Date;
}

/** 固定错误码上传失败（error 可直接进 SkillReflowStatus.lastError）。 */
export class SkillReflowHttpUploadError extends Error {
  constructor(
    public readonly error: SkillReflowError,
  ) {
    super(`skill reflow upload failed: ${error.code}`);
    this.name = "SkillReflowHttpUploadError";
  }
}

export interface SkillReflowHttpUploader {
  /**
   * 发送一次上传会话；成功返回逐条回执（accepted/dedupHit/filterHit 均为终态，
   * 由调用方经 service.recordReceipt 消费）。空条目集零请求、返回空回执。
   */
  uploadSession(input: {
    triggerType: SkillReflowTriggerType;
    entries: readonly SkillReflowUploadEntry[];
  }): Promise<SkillReflowSessionReceipt[]>;
}

const OUTCOMES: ReadonlySet<string> = new Set(["accepted", "dedupHit", "filterHit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 创建回流 HTTP 上传器（单次会话无状态；重试调度归调用方）。 */
export function createSkillReflowHttpUploader(
  options: SkillReflowHttpUploaderOptions,
): SkillReflowHttpUploader {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    // 与 platform-auth 同规则：认证头不得经明文 http 或内嵌凭据的 URL 传输。
    throw new SkillReflowHttpUploadError({
      code: "NETWORK_UNAVAILABLE",
      at: new Date().toISOString(),
    });
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const path = options.path ?? DEFAULT_SKILL_REFLOW_UPLOAD_PATH;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const responseLimit = options.responseLimitBytes ?? 256 * 1024;
  const rateLimitCodes = new Set<string | number>(
    options.rateLimitCodes ?? DEFAULT_SKILL_REFLOW_RATE_LIMIT_CODES,
  );
  const now = options.now ?? (() => new Date());

  function fail(code: SkillReflowErrorCode): never {
    throw new SkillReflowHttpUploadError({ code, at: now().toISOString() });
  }

  function sessionDigestOf(entries: readonly SkillReflowUploadEntry[]): string {
    // 客户端侧定义（spec §5.2）：有序 contentDigest 聚合的 SHA-256；基准随
    // schemaVersion 1 固化，变更需与中台同步（OQ-2 同款纪律）。
    const joined = entries.map((item) => item.entry.contentDigest).join("\n");
    return createHash("sha256").update(joined, "utf8").digest("hex");
  }

  return {
    async uploadSession(input) {
      if (input.entries.length === 0) return [];
      const body = JSON.stringify({
        schemaVersion: SKILL_REFLOW_UPLOAD_SCHEMA_VERSION,
        triggerType: input.triggerType,
        entryCount: input.entries.length,
        sessionDigest: sessionDigestOf(input.entries),
        ccodeRelease: options.attribution.ccodeRelease,
        platform: options.attribution.platform,
        entries: input.entries.map((item) => ({
          key: item.entry.key,
          relativePath: item.entry.relativePath,
          name: item.entry.name,
          sourceType: item.entry.sourceType,
          contentDigest: item.entry.contentDigest,
          lastModified: item.entry.lastModified,
          ...(item.description !== undefined ? { description: item.description } : {}),
          contentFiles: item.files.map((file) => ({
            path: file.path,
            contentBase64: file.contentBase64,
          })),
        })),
      });
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
          body,
          redirect: "error",
          cache: "no-store",
          signal: timeoutSignal,
        });
        if (response.status === 401) fail("NEED_LOGIN");
        if (response.status === 403) fail("AUTH_REJECTED");
        if (response.status === 429) fail("RATE_LIMITED");
        if (!response.ok) {
          // 5xx 等服务端失败：中台侧不可用（与本地网络失败区分，spec §6.4 分类）。
          fail("PLATFORM_UNAVAILABLE");
        }
        if (
          !response.headers.get("content-type")?.toLowerCase().includes("application/json")
        ) {
          fail("SCHEMA_REJECTED");
        }
        const json = await readBoundedJson(response, responseLimit, fail);
        return mapReceipts(json, input.entries, now, rateLimitCodes, fail);
      } catch (error) {
        if (error instanceof SkillReflowHttpUploadError) throw error;
        // 网络异常 / 超时 / 中断：NETWORK_UNAVAILABLE（留队列重试，spec §6.4）。
        fail("NETWORK_UNAVAILABLE");
      } finally {
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    },
  };
}

/** 200 响应体 → 回执数组（业务信封限流/鉴权码优先；逐条回执做缺字段防御）。 */
function mapReceipts(
  json: unknown,
  entries: readonly SkillReflowUploadEntry[],
  now: () => Date,
  rateLimitCodes: ReadonlySet<string | number>,
  fail: (code: SkillReflowErrorCode) => never,
): SkillReflowSessionReceipt[] {
  if (
    !isRecord(json) ||
    (typeof json.code !== "number" && typeof json.code !== "string")
  ) {
    fail("SCHEMA_REJECTED");
  }
  // 业务码允许字符串形态（限流码具体值待中台定；HTTP 状态码语义仍按数字比对）。
  if (json.code === 401 || json.code === 403) fail("NEED_LOGIN");
  if (rateLimitCodes.has(json.code)) fail("RATE_LIMITED");
  if (json.code !== 0 || !isRecord(json.data) || !Array.isArray(json.data.receipts)) {
    fail("SCHEMA_REJECTED");
  }
  const keyToReceipt = new Map<string, SkillReflowSessionReceipt>();
  const relativePathCounts = new Map<string, number>();
  for (const item of entries) {
    relativePathCounts.set(
      item.entry.relativePath,
      (relativePathCounts.get(item.entry.relativePath) ?? 0) + 1,
    );
  }
  for (const raw of json.data.receipts as unknown[]) {
    if (!isRecord(raw)) fail("SCHEMA_REJECTED");
    // 回执定位：key 精确命中，或 relativePath 在本批内唯一命中（OQ-1：relativePath
    // 为本地 skill 标识提案，服务端可能只回该字段）。
    let key: string | undefined =
      typeof raw.key === "string" && raw.key.length > 0 ? raw.key : undefined;
    if (key === undefined && typeof raw.relativePath === "string" && raw.relativePath.length > 0) {
      if (relativePathCounts.get(raw.relativePath) !== 1) {
        // 无 key 且 relativePath 缺失或歧义：无法唯一定位本地条目，整批防御失败。
        fail("SCHEMA_REJECTED");
      }
      const matched = entries.find(
        (item) => item.entry.relativePath === raw.relativePath,
      )?.entry.key;
      key = matched;
    }
    if (key === undefined || !entries.some((item) => item.entry.key === key)) {
      // 回执指向未知条目：不可消费，防御失败（不伪造、不静默丢弃）。
      fail("SCHEMA_REJECTED");
    }
    if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome)) {
      fail("SCHEMA_REJECTED");
    }
    if (keyToReceipt.has(key)) {
      // 同一 key 双回执：无法判定终态归属，防御失败（不取后值覆盖）。
      fail("SCHEMA_REJECTED");
    }
    const filterCategory =
      typeof raw.filterCategory === "string" && raw.filterCategory.length > 0
        ? raw.filterCategory
        : undefined;
    keyToReceipt.set(key, {
      key,
      outcome: raw.outcome as SkillReflowSessionReceipt["outcome"],
      // filterHit 缺 filterCategory 容忍（contract 可选；本地只留类别，M3-R8）。
      ...(filterCategory !== undefined ? { filterCategory } : {}),
      settledAt: now().toISOString(),
    });
  }
  return [...keyToReceipt.values()];
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  fail: (code: SkillReflowErrorCode) => never,
): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/u.test(advertised) || Number(advertised) > maxBytes)
  ) {
    fail("PAYLOAD_TOO_LARGE");
  }
  if (!response.body) fail("SCHEMA_REJECTED");
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
      // 畸形响应按 schema 拒绝处理（固定错误码，不泄漏响应字节）。
      fail("SCHEMA_REJECTED");
    }
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
