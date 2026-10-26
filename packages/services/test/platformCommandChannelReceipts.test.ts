import { describe, expect, it } from "vitest";
import {
  createCommandChannelReceiptUploader,
  DEFAULT_COMMAND_CHANNEL_RECEIPT_PATH,
} from "../src/platform-command-channel/http-receipts.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const HEADERS = { authorization: "Bearer test-token", "tenant-id": "7" };

function makeUploader(fetchImpl: typeof fetch) {
  return createCommandChannelReceiptUploader({
    baseUrl: "https://example.test/admin-api/",
    tokenProvider: { getHeaders: async () => ({ ...HEADERS }) },
    fetchImpl,
  });
}

describe("createCommandChannelReceiptUploader", () => {
  it("空批次零请求", async () => {
    let called = 0;
    const uploader = makeUploader((async () => {
      called += 1;
      return jsonResponse(200, { code: 0 });
    }) as unknown as typeof fetch);
    expect(await uploader.upload([])).toBe("accepted");
    expect(called).toBe(0);
  });

  it("POST 到既定端点，体为 {schemaVersion,receipts}，认证头透传", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const uploader = makeUploader((async (input, init) => {
      captured = { url: String(input), init: init as RequestInit };
      return jsonResponse(200, { code: 0 });
    }) as unknown as typeof fetch);
    const outcome = await uploader.upload(['{"status":"executed","commandId":"c-1","resultRef":"ref"}']);
    expect(outcome).toBe("accepted");
    expect(captured?.url).toBe(`https://example.test/admin-api/${DEFAULT_COMMAND_CHANNEL_RECEIPT_PATH}`);
    const body = JSON.parse(String(captured?.init?.body));
    expect(body).toEqual({
      schemaVersion: 1,
      receipts: [{ status: "executed", commandId: "c-1", resultRef: "ref" }],
    });
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("tenant-id")).toBe("7");
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("HTTP 401/403 与业务 401/403 → auth-required", async () => {
    const a = makeUploader((async () => jsonResponse(401, { code: 401 })) as unknown as typeof fetch);
    expect(await a.upload(["{}"])).toBe("auth-required");
    const b = makeUploader((async () => jsonResponse(200, { code: 403 })) as unknown as typeof fetch);
    expect(await b.upload(["{}"])).toBe("auth-required");
  });

  it("HTTP 429 → rate-limited；5xx/非 JSON/畸形体 → retryable", async () => {
    const limited = makeUploader((async () => jsonResponse(429, { code: 429 })) as unknown as typeof fetch);
    expect(await limited.upload(["{}"])).toBe("rate-limited");
    const serverError = makeUploader((async () => jsonResponse(503, { code: 503 })) as unknown as typeof fetch);
    expect(await serverError.upload(["{}"])).toBe("retryable");
    const notJson = makeUploader((async () => new Response("oops", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch);
    expect(await notJson.upload(["{}"])).toBe("retryable");
    const badCode = makeUploader((async () => jsonResponse(200, { code: 500 })) as unknown as typeof fetch);
    expect(await badCode.upload(["{}"])).toBe("retryable");
  });

  it("网络异常/超时 → retryable；缓冲内非法 JSON → retryable", async () => {
    const networkError = makeUploader((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(await networkError.upload(["{}"])).toBe("retryable");
    const localCorrupt = makeUploader((async () => jsonResponse(200, { code: 0 })) as unknown as typeof fetch);
    expect(await localCorrupt.upload(["{not-json"])).toBe("retryable");
  });

  it("明文 http 基址构造即抛（认证头不得走非 TLS）", () => {
    expect(() =>
      createCommandChannelReceiptUploader({
        baseUrl: "http://example.test/",
        tokenProvider: { getHeaders: async () => ({}) },
      }),
    ).toThrow();
  });
});
