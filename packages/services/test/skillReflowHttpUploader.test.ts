import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_REFLOW_UPLOAD_PATH,
  SkillReflowHttpUploadError,
  createSkillReflowHttpUploader,
  type AuthTokenProvider,
  type SkillReflowUploadEntry,
} from "../src/skill-reflow-upload/http-uploader.js";
import type { SkillReflowEntry } from "../src/skill-reflow-upload/contract.js";

/** Skill 回流 HTTP 上传器单测（spec §5.2 / §四 阶段 4-6；fake fetch 注入，零真实网络）。 */

const BASE_URL = "https://dp.example.test/";
const FIXED_NOW = new Date("2026-10-22T12:00:00Z");
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

function queueEntry(overrides: Partial<SkillReflowEntry>): SkillReflowEntry {
  return {
    key: "user/root-1/report-helper",
    relativePath: "report-helper",
    name: "report-helper",
    sourceType: "user",
    contentDigest: "cd".repeat(32),
    lastModified: "2026-10-20T08:00:00Z",
    queuedAt: "2026-10-22T09:00:00Z",
    attempts: 0,
    rootId: "root-1",
    directoryPath: "C:/skills/report-helper",
    ...overrides,
  };
}

function uploadEntry(overrides?: {
  entry?: Partial<SkillReflowEntry>;
  description?: string;
}): SkillReflowUploadEntry {
  return {
    entry: queueEntry(overrides?.entry ?? {}),
    ...(overrides?.description !== undefined ? { description: overrides.description } : {}),
    files: [{ path: "SKILL.md", contentBase64: Buffer.from("# helper", "utf8").toString("base64") }],
  };
}

function makeUploader(overrides?: { fetchImpl?: typeof fetch }) {
  return createSkillReflowHttpUploader({
    baseUrl: BASE_URL,
    tokenProvider,
    attribution: { ccodeRelease: "3.16.2", platform: "windows" },
    fetchImpl: overrides?.fetchImpl,
    now: () => FIXED_NOW,
  });
}

function threeEntries(): SkillReflowUploadEntry[] {
  return [
    uploadEntry({ entry: { key: "user/root-1/a", relativePath: "a", name: "a", contentDigest: "01".repeat(32) } }),
    uploadEntry({
      entry: { key: "user/root-1/b", relativePath: "b", name: "b", contentDigest: "02".repeat(32) },
      description: "second helper",
    }),
    uploadEntry({ entry: { key: "workspace/root-2/c", relativePath: "c", name: "c", sourceType: "workspace", contentDigest: "03".repeat(32) } }),
  ];
}

async function failureOf(
  uploader: ReturnType<typeof makeUploader>,
  entries: readonly SkillReflowUploadEntry[],
): Promise<SkillReflowHttpUploadError> {
  return uploader
    .uploadSession({ triggerType: "dailyFirstLaunch", entries })
    .then(() => {
      throw new Error("expected uploadSession to fail");
    }, (cause: unknown) => cause as SkillReflowHttpUploadError);
}

describe("skill reflow http uploader", () => {
  it("posts a manifest plus entries and maps mixed three-way receipts", async () => {
    const entries = threeEntries();
    const { fetchImpl, requests } = captureFetch(() =>
      jsonBody({
        code: 0,
        data: {
          receipts: [
            { key: "user/root-1/a", outcome: "accepted" },
            { relativePath: "b", outcome: "dedupHit" },
            { key: "workspace/root-2/c", outcome: "filterHit", filterCategory: "api-key" },
          ],
        },
      }),
    );
    const receipts = await makeUploader({ fetchImpl }).uploadSession({
      triggerType: "dailyFirstLaunch",
      entries,
    });
    expect(receipts).toEqual([
      { key: "user/root-1/a", outcome: "accepted", settledAt: FIXED_NOW.toISOString() },
      { key: "user/root-1/b", outcome: "dedupHit", settledAt: FIXED_NOW.toISOString() },
      {
        key: "workspace/root-2/c",
        outcome: "filterHit",
        filterCategory: "api-key",
        settledAt: FIXED_NOW.toISOString(),
      },
    ]);
    const request = requests[0];
    expect(request.url.pathname).toBe(`/${DEFAULT_SKILL_REFLOW_UPLOAD_PATH}`);
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["tenant-id"]).toBe("tenant-1");
    expect(headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(request.init.body as string) as {
      schemaVersion: number;
      triggerType: string;
      entryCount: number;
      sessionDigest: string;
      ccodeRelease: string;
      platform: string;
      entries: {
        key: string;
        relativePath: string;
        contentDigest: string;
        sourceType: string;
        description?: string;
        contentFiles: { path: string; contentBase64: string }[];
      }[];
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.triggerType).toBe("dailyFirstLaunch");
    expect(body.entryCount).toBe(3);
    expect(body.ccodeRelease).toBe("3.16.2");
    expect(body.platform).toBe("windows");
    const expectedDigest = createHash("sha256")
      .update(entries.map((item) => item.entry.contentDigest).join("\n"), "utf8")
      .digest("hex");
    expect(body.sessionDigest).toBe(expectedDigest);
    expect(body.entries.map((item) => item.key)).toEqual([
      "user/root-1/a",
      "user/root-1/b",
      "workspace/root-2/c",
    ]);
    expect(body.entries[1].description).toBe("second helper");
    expect(body.entries[0].description).toBeUndefined();
    expect(body.entries[0].contentFiles).toEqual([
      { path: "SKILL.md", contentBase64: Buffer.from("# helper", "utf8").toString("base64") },
    ]);
  });

  it("defends against receipts with missing identity or unknown outcome", async () => {
    const entries = threeEntries();
    const badResponses = [
      jsonBody({ code: 0, data: { receipts: [{ outcome: "accepted" }] } }),
      jsonBody({
        code: 0,
        data: { receipts: [{ key: "user/root-1/a", outcome: "mystery" }] },
      }),
      jsonBody({
        code: 0,
        data: { receipts: [{ key: "unknown/key", outcome: "accepted" }] },
      }),
      jsonBody({ code: 0, data: { receipts: [{ key: "user/root-1/a" }] } }),
      jsonBody({ code: 0, data: {} }),
      new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
    ];
    for (const response of badResponses) {
      const { fetchImpl } = captureFetch(() => response);
      const error = await failureOf(makeUploader({ fetchImpl }), entries);
      expect(error).toBeInstanceOf(SkillReflowHttpUploadError);
      expect(error.error.code).toBe("SCHEMA_REJECTED");
      expect(error.error.at).toBe(FIXED_NOW.toISOString());
    }
  });

  it("maps 401/403/429/5xx and network failures to fixed error codes", async () => {
    const entries = threeEntries();
    const cases: { response: () => Response; code: string }[] = [
      { response: () => jsonBody({}, 401), code: "NEED_LOGIN" },
      { response: () => jsonBody({}, 403), code: "AUTH_REJECTED" },
      { response: () => jsonBody({}, 429), code: "RATE_LIMITED" },
      { response: () => jsonBody({ code: "RATE_LIMITED" }), code: "RATE_LIMITED" },
      { response: () => jsonBody({}, 503), code: "PLATFORM_UNAVAILABLE" },
    ];
    for (const item of cases) {
      const { fetchImpl } = captureFetch(item.response);
      const error = await failureOf(makeUploader({ fetchImpl }), entries);
      expect(error.error.code).toBe(item.code);
    }
    const networkFailure = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const networkError = await failureOf(makeUploader({ fetchImpl: networkFailure }), entries);
    expect(networkError.error.code).toBe("NETWORK_UNAVAILABLE");
  });

  it("maps a request timeout to NETWORK_UNAVAILABLE", async () => {
    const timeoutFetch = ((_input: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "TimeoutError"));
        });
      })) as unknown as typeof fetch;
    const uploader = createSkillReflowHttpUploader({
      baseUrl: BASE_URL,
      tokenProvider,
      attribution: { ccodeRelease: "3.16.2", platform: "windows" },
      fetchImpl: timeoutFetch,
      timeoutMs: 10,
      now: () => FIXED_NOW,
    });
    const error = await failureOf(uploader, threeEntries());
    expect(error.error.code).toBe("NETWORK_UNAVAILABLE");
  });

  it("returns an empty receipt list without any network request for an empty session", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonBody({});
    }) as unknown as typeof fetch;
    const receipts = await makeUploader({ fetchImpl }).uploadSession({
      triggerType: "startupRetry",
      entries: [],
    });
    expect(receipts).toEqual([]);
    expect(called).toBe(0);
  });

  it("rejects a non-https base URL at construction", () => {
    expect(() =>
      createSkillReflowHttpUploader({
        baseUrl: "http://dp.example.test/",
        tokenProvider,
        attribution: { ccodeRelease: "3.16.2", platform: "windows" },
        now: () => FIXED_NOW,
      }),
    ).toThrow(SkillReflowHttpUploadError);
  });
});
