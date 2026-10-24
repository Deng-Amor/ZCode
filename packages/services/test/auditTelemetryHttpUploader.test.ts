import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_TELEMETRY_UPLOAD_PATH,
  createAuditTelemetryHttpUploader,
  type AuthTokenProvider,
} from "../src/audit-telemetry/http-uploader.js";
import {
  AUDIT_TELEMETRY_SCHEMA_VERSION,
  serializeAuditTelemetryEvent,
} from "../src/audit-telemetry/index.js";
import { testLifecycleEvent, testRuntimeErrorEvent } from "./auditTelemetryFixtures.js";

/** 审计遥测 HTTP 上报器单测（spec §5.2/§5.3；fake fetch 注入，零真实网络）。 */

const BASE_URL = "https://dp.example.test/";
const tokenProvider: AuthTokenProvider = {
  async getHeaders() {
    return { Authorization: "Bearer test-token", "tenant-id": "tenant-1" };
  },
};

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

function captureFetch(responseFactory: () => Response): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    requests.push({ url: new URL(input.toString()), init });
    return responseFactory();
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeUploader(overrides?: {
  fetchImpl?: typeof fetch;
  responseLimitBytes?: number;
}) {
  return createAuditTelemetryHttpUploader({
    baseUrl: BASE_URL,
    tokenProvider,
    fetchImpl: overrides?.fetchImpl,
    responseLimitBytes: overrides?.responseLimitBytes,
  });
}

function batchOfTwo() {
  const lifecycle = testLifecycleEvent();
  const runtimeError = testRuntimeErrorEvent();
  return {
    channel: "lifecycle" as const,
    records: [
      { commandId: lifecycle.commandId, serializedEvent: serializeAuditTelemetryEvent(lifecycle) },
      {
        commandId: runtimeError.commandId,
        serializedEvent: serializeAuditTelemetryEvent(runtimeError),
      },
    ],
    events: [lifecycle, runtimeError],
  };
}

describe("audit telemetry http uploader: outcome mapping", () => {
  it("maps an all-accepted batch and posts schemaVersion + per-item event fields", async () => {
    const batch = batchOfTwo();
    const { fetchImpl, requests } = captureFetch(() =>
      jsonBody({
        code: 0,
        data: {
          results: [
            { commandId: batch.events[0].commandId, status: "accepted" },
            { commandId: batch.events[1].commandId, status: "accepted" },
          ],
        },
      }),
    );
    const uploader = makeUploader({ fetchImpl });
    const outcome = await uploader.upload(batch);
    expect(outcome).toEqual({
      kind: "accepted",
      acknowledgedCommandIds: [batch.events[0].commandId, batch.events[1].commandId],
    });
    const request = requests[0];
    expect(request.url.pathname).toBe(`/${DEFAULT_AUDIT_TELEMETRY_UPLOAD_PATH}`);
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["tenant-id"]).toBe("tenant-1");
    expect(headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(request.init.body as string) as {
      schemaVersion: number;
      channel: string;
      items: { eventId: string; commandId: string; channel: string; payload: unknown }[];
    };
    expect(body.schemaVersion).toBe(AUDIT_TELEMETRY_SCHEMA_VERSION);
    expect(body.channel).toBe("lifecycle");
    expect(body.items).toHaveLength(2);
    expect(body.items[0].commandId).toBe(batch.events[0].commandId);
    expect(body.items[0].eventId).toBe(batch.events[0].eventId);
    expect(body.items[0].channel).toBe(batch.events[0].channel);
    expect(body.items[0].payload).toEqual(batch.events[0].payload);
  });

  it("maps a mixed accepted/rejected batch to rejected with dead-letter details", async () => {
    const batch = batchOfTwo();
    const { fetchImpl } = captureFetch(() =>
      jsonBody({
        code: 0,
        data: {
          results: [
            { commandId: batch.events[0].commandId, status: "accepted" },
            { commandId: batch.events[1].commandId, status: "rejected", reason: "sensitive-match" },
          ],
        },
      }),
    );
    const uploader = makeUploader({ fetchImpl });
    const outcome = await uploader.upload(batch);
    expect(outcome).toEqual({
      kind: "rejected",
      reasons: [{ commandId: batch.events[1].commandId, reason: "sensitive-match" }],
    });
  });

  it("maps HTTP 401 and business code 401 to auth-required", async () => {
    const batch = batchOfTwo();
    const http401 = captureFetch(() => jsonBody({}, 401));
    expect(await makeUploader({ fetchImpl: http401.fetchImpl }).upload(batch)).toEqual({
      kind: "auth-required",
    });
    const business401 = captureFetch(() => jsonBody({ code: 401 }));
    expect(await makeUploader({ fetchImpl: business401.fetchImpl }).upload(batch)).toEqual({
      kind: "auth-required",
    });
  });

  it("maps HTTP 429 and business rate-limit codes to rate-limited", async () => {
    const batch = batchOfTwo();
    const http429 = captureFetch(() => jsonBody({}, 429));
    expect(await makeUploader({ fetchImpl: http429.fetchImpl }).upload(batch)).toEqual({
      kind: "rate-limited",
    });
    const businessLimit = captureFetch(() => jsonBody({ code: "RATE_LIMITED" }));
    expect(await makeUploader({ fetchImpl: businessLimit.fetchImpl }).upload(batch)).toEqual({
      kind: "rate-limited",
    });
  });

  it("maps 5xx, network failure, and timeout to retryable-failure", async () => {
    const batch = batchOfTwo();
    const serverError = captureFetch(() => jsonBody({}, 503));
    expect(await makeUploader({ fetchImpl: serverError.fetchImpl }).upload(batch)).toEqual({
      kind: "retryable-failure",
    });
    const networkFailure = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await makeUploader({ fetchImpl: networkFailure }).upload(batch)).toEqual({
      kind: "retryable-failure",
    });
    const timeoutFetch = ((_input: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "TimeoutError"));
        });
      })) as unknown as typeof fetch;
    expect(
      await createAuditTelemetryHttpUploader({
        baseUrl: BASE_URL,
        tokenProvider,
        fetchImpl: timeoutFetch,
        timeoutMs: 10,
      }).upload(batch),
    ).toEqual({ kind: "retryable-failure" });
  });

  it("maps malformed responses and uninterpretable per-item statuses to retryable-failure", async () => {
    const batch = batchOfTwo();
    const cases: Response[] = [
      jsonBody({ code: 0, data: { results: [{ status: "accepted" }] } }),
      jsonBody({
        code: 0,
        data: { results: [{ commandId: batch.events[0].commandId, status: "mystery" }] },
      }),
      jsonBody({
        code: 0,
        data: {
          results: [{ commandId: batch.events[0].commandId, status: "rejected", reason: "odd" }],
        },
      }),
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      jsonBody({ code: 0, data: {} }),
    ];
    for (const response of cases) {
      const { fetchImpl } = captureFetch(() => response);
      const outcome = await makeUploader({ fetchImpl }).upload(batch);
      expect(outcome).toEqual({ kind: "retryable-failure" });
    }
  });

  it("maps an oversized acceptance response to retryable-failure", async () => {
    const batch = batchOfTwo();
    const big = jsonBody({
      code: 0,
      data: { results: [{ commandId: batch.events[0].commandId, status: "accepted" }] },
    });
    const { fetchImpl } = captureFetch(() => big);
    const outcome = await makeUploader({ fetchImpl, responseLimitBytes: 16 }).upload(batch);
    expect(outcome).toEqual({ kind: "retryable-failure" });
  });

  it("returns accepted without any network request for an empty batch", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonBody({});
    }) as unknown as typeof fetch;
    const outcome = await makeUploader({ fetchImpl }).upload({ channel: "lifecycle", records: [] });
    expect(outcome).toEqual({ kind: "accepted", acknowledgedCommandIds: [] });
    expect(called).toBe(0);
  });

  it("maps a corrupt frozen serializedEvent to retryable-failure without network", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonBody({});
    }) as unknown as typeof fetch;
    const outcome = await makeUploader({ fetchImpl }).upload({
      channel: "lifecycle",
      records: [{ commandId: "00000000-0000-4000-8000-000000000001", serializedEvent: "{corrupt" }],
    });
    expect(outcome).toEqual({ kind: "retryable-failure" });
    expect(called).toBe(0);
  });

  it("rejects a non-https base URL at construction", () => {
    expect(() =>
      createAuditTelemetryHttpUploader({
        baseUrl: "http://dp.example.test/",
        tokenProvider,
      }),
    ).toThrow();
  });
});
