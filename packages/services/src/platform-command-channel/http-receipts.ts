/**
 * 指令/通告回执上行（2026-10-25 与中台对齐定稿，PRD §4.7）：
 * POST system/ccode-commands/receipts，体 {"schemaVersion":1,"receipts":[<响应对象>...]}。
 * 认证复用 M6-R1（Bearer + tenant-id 头，由注入 tokenProvider 提供）。
 * 响应语义与遥测上传器同族：业务 code=0 → 整批受理（调用方清空缓冲）；
 * HTTP/业务 401/403 → auth-required（暂停出网、缓冲保留）；HTTP 429 → rate-limited；
 * 其余（5xx/非 JSON/畸形）→ retryable（保留重发）。重发按 commandId/noticeId 幂等，
 * 由中台侧消化重复。本上传器无状态，重试与缓冲归装配方（Main wiring）。
 */
export interface CommandChannelReceiptTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

/** 回执上行端点（中台已确认沿用；与 poll 端点同 system/ccode-commands 前缀）。 */
export const DEFAULT_COMMAND_CHANNEL_RECEIPT_PATH = "system/ccode-commands/receipts";

export type CommandChannelReceiptUploadOutcome =
  | "accepted"
  | "retryable"
  | "rate-limited"
  | "auth-required";

export interface CommandChannelReceiptUploaderOptions {
  readonly baseUrl: string;
  readonly tokenProvider: CommandChannelReceiptTokenProvider;
  readonly path?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly responseLimitBytes?: number;
}

const RECEIPTS_SCHEMA_VERSION = 1;
const MAX_RECEIPTS_PER_BATCH = 100;

export interface CommandChannelReceiptUploader {
  /** 单批上行；空数组零请求。receipts 为处理核心产出的固定键序序列化字节。 */
  upload(serializedReceipts: readonly string[]): Promise<CommandChannelReceiptUploadOutcome>;
}

export function createCommandChannelReceiptUploader(
  options: CommandChannelReceiptUploaderOptions,
): CommandChannelReceiptUploader {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    // 与 platform-auth 同规则：认证头不得经明文 http 或内嵌凭据的 URL 传输。
    throw new Error("command channel receipt uploader: invalid baseUrl");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const path = options.path ?? DEFAULT_COMMAND_CHANNEL_RECEIPT_PATH;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const responseLimit = options.responseLimitBytes ?? 64 * 1024;

  return {
    async upload(serializedReceipts) {
      if (serializedReceipts.length === 0) return "accepted";
      const batch = serializedReceipts.slice(0, MAX_RECEIPTS_PER_BATCH);
      let receipts: unknown[];
      try {
        receipts = batch.map((serialized) => JSON.parse(serialized) as unknown);
      } catch {
        // 缓冲内容由本地处理核心产出，解析失败属本地缺陷：保守保留重发。
        return "retryable";
      }
      let response: Response | undefined;
      try {
        const headers = { ...(await options.tokenProvider.getHeaders()) };
        response = await doFetch(new URL(path, base), {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
          body: JSON.stringify({ schemaVersion: RECEIPTS_SCHEMA_VERSION, receipts }),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 401 || response.status === 403) return "auth-required";
        if (response.status === 429) return "rate-limited";
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          return "retryable";
        }
        const json = await readBoundedJson(response, responseLimit);
        if (typeof json !== "object" || json === null) return "retryable";
        const code = (json as { code?: unknown }).code;
        if (code === 401 || code === 403) return "auth-required";
        if (code !== 0) return "retryable";
        return "accepted";
      } catch {
        return "retryable";
      } finally {
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    },
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maxBytes)) {
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks)));
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
