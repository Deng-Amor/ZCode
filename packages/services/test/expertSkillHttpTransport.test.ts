import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPERT_SKILL_HTTP_PATHS,
  ExpertSkillHttpError,
  createExpertSkillHttpTransport,
  type AuthTokenProvider,
} from "../src/expert-skills/http-transport.js";

/** 专家 skill HTTP transport 单测（spec §6.1 方案 A；fake fetch 注入，零真实网络）。 */

const BASE_URL = "https://dp.example.test/";
const tokenProvider: AuthTokenProvider = {
  async getHeaders() {
    return { Authorization: "Bearer test-token", "tenant-id": "tenant-1" };
  },
};

const DIGEST = "ab".repeat(32);
const SIGNATURE = "s".repeat(88);

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

function captureFetch(responseFactory: (request: CapturedRequest) => Response): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const request: CapturedRequest = { url: new URL(input.toString()), init };
    requests.push(request);
    return responseFactory(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function platformJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalogEntryJson() {
  return {
    skillId: "pdd-ops",
    name: "拼多多运营专家",
    domainTags: ["e-commerce", "pdd"],
    summary: "拼多多投放与选品领域知识",
    version: 3,
    digest: DIGEST,
    scopeRef: "tenant:1",
  };
}

function makeTransport(overrides?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  contentResponseLimitBytes?: number;
}) {
  return createExpertSkillHttpTransport({
    baseUrl: BASE_URL,
    tokenProvider,
    fetchImpl: overrides?.fetchImpl,
    timeoutMs: overrides?.timeoutMs,
    contentResponseLimitBytes: overrides?.contentResponseLimitBytes,
  });
}

function hangingFetch(): typeof fetch {
  return ((_input: URL, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const rejectWithAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) rejectWithAbort();
      else signal?.addEventListener("abort", rejectWithAbort);
    })) as unknown as typeof fetch;
}

describe("expert skill http transport: search", () => {
  it("parses catalog entries from a 200 response and sends metadata-only GET", async () => {
    const { fetchImpl, requests } = captureFetch(() =>
      platformJson([catalogEntryJson(), catalogEntryJson()]),
    );
    const transport = makeTransport({ fetchImpl });
    const entries = await transport.search(
      "tenant-1:user-1",
      { domainTags: ["e-commerce"], keywords: ["投放"] },
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      skillId: "pdd-ops",
      name: "拼多多运营专家",
      domainTags: ["e-commerce", "pdd"],
      summary: "拼多多投放与选品领域知识",
      version: 3,
      digest: DIGEST,
      scopeRef: "tenant:1",
    });
    const request = requests[0];
    expect(request.url.pathname).toBe(`/${DEFAULT_EXPERT_SKILL_HTTP_PATHS.search}`);
    expect(request.url.searchParams.getAll("domainTags")).toEqual(["e-commerce"]);
    expect(request.url.searchParams.getAll("keywords")).toEqual(["投放"]);
    // identity 不入请求（M6-R3：租户由认证上下文取，不信任客户端自报）。
    expect(request.url.searchParams.has("identity")).toBe(false);
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["tenant-id"]).toBe("tenant-1");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(request.init.method).toBe("GET");
  });

  it("maps a 401 response to AUTH_REQUIRED", async () => {
    const { fetchImpl } = captureFetch(
      () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );
    const transport = makeTransport({ fetchImpl });
    const error = await transport
      .search("tenant-1:user-1", {})
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("AUTH_REQUIRED");
  });
});

describe("expert skill http transport: get", () => {
  it("parses the managed-skill envelope from a 200 response", async () => {
    const envelope = {
      schemaVersion: 1,
      payloadBase64: Buffer.from("{}", "utf8").toString("base64"),
      signatureBase64: SIGNATURE,
    };
    const { fetchImpl, requests } = captureFetch(() => platformJson(envelope));
    const transport = makeTransport({ fetchImpl });
    const result = await transport.get("tenant-1:user-1", "pdd-ops");
    expect(result).toEqual(envelope);
    expect(requests[0].url.pathname).toBe(`/${DEFAULT_EXPERT_SKILL_HTTP_PATHS.get}`);
    expect(requests[0].url.searchParams.get("skillId")).toBe("pdd-ops");
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBeUndefined();
  });

  it("sends If-None-Match with the cached digest and maps 304 to NotModified", async () => {
    const { fetchImpl, requests } = captureFetch(
      () => new Response(null, { status: 304, headers: { "content-type": "application/json" } }),
    );
    const transport = makeTransport({ fetchImpl });
    const result = await transport.get("tenant-1:user-1", "pdd-ops", {
      cachedDigest: DIGEST,
    });
    expect(result).toEqual({ notModified: true, digest: DIGEST });
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe(`"${DIGEST}"`);
  });

  it("maps an oversized content response to PAYLOAD_TOO_LARGE", async () => {
    const big = platformJson({ schemaVersion: 1, payloadBase64: "A".repeat(512), signatureBase64: SIGNATURE });
    const { fetchImpl } = captureFetch(() => big);
    const transport = makeTransport({ fetchImpl, contentResponseLimitBytes: 128 });
    const error = await transport
      .get("tenant-1:user-1", "pdd-ops")
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("maps a schema-violating envelope to UNAVAILABLE", async () => {
    const badEnvelope = {
      schemaVersion: 1,
      payloadBase64: "AAAA",
      signatureBase64: "too-short",
    };
    const { fetchImpl } = captureFetch(() => platformJson(badEnvelope));
    const transport = makeTransport({ fetchImpl });
    const error = await transport
      .get("tenant-1:user-1", "pdd-ops")
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("UNAVAILABLE");
  });

  it("maps a request timeout to UNAVAILABLE with a fixed error code", async () => {
    const timeoutFetch = ((_input: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "TimeoutError"));
        });
      })) as unknown as typeof fetch;
    const transport = makeTransport({ fetchImpl: timeoutFetch, timeoutMs: 10 });
    const error = await transport
      .get("tenant-1:user-1", "pdd-ops")
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("UNAVAILABLE");
  });

  it("maps caller cancellation to CANCELLED", async () => {
    const transport = makeTransport({ fetchImpl: hangingFetch() });
    const controller = new AbortController();
    const pending = transport.get("tenant-1:user-1", "pdd-ops", undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const error = await pending.then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("CANCELLED");
  });

  it("maps a malformed JSON response to UNAVAILABLE", async () => {
    const { fetchImpl } = captureFetch(
      () => new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const transport = makeTransport({ fetchImpl });
    const error = await transport
      .get("tenant-1:user-1", "pdd-ops")
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpertSkillHttpError);
    expect((error as ExpertSkillHttpError).code).toBe("UNAVAILABLE");
  });

  it("rejects a non-https base URL at construction", () => {
    expect(() =>
      createExpertSkillHttpTransport({
        baseUrl: "http://dp.example.test/",
        tokenProvider,
      }),
    ).toThrow(ExpertSkillHttpError);
  });
});
