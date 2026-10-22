import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfidentialControllerError,
  type ControllerHttpSourceOptions,
} from "../src/confidential-controller/contract.js";
import { createControllerHttpSource } from "../src/confidential-controller/http-source.js";

const sentinel = "synthetic-secret-must-not-escape";
const identity = { tenantId: "tenant", userId: "user", loginId: "login" };
const grant = { skillId: "controller", version: 1, digest: "a".repeat(64), expiresAt: 1000 };
let timeout: AbortController;
let parent: AbortController;
let requests: string[];

beforeEach(() => {
  timeout = new AbortController();
  parent = new AbortController();
  requests = [];
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  vi.stubGlobal("fetch", async () => {
    throw new Error("Unexpected fetch");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function source(
  getAccessToken: ControllerHttpSourceOptions["getAccessToken"] = async () => "synthetic-token",
) {
  return createControllerHttpSource({
    apiBaseUrl: "https://controller.invalid/api/",
    getAccessToken,
  });
}
function authorize(getAccessToken?: ControllerHttpSourceOptions["getAccessToken"]) {
  return source(getAccessToken).authorize({
    identity,
    skillId: "controller",
    signal: parent.signal,
  });
}
function serve(handler: (signal: AbortSignal) => Promise<Response>) {
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    requests.push(url.pathname);
    expect(init).toMatchObject({ cache: "no-store", redirect: "error", method: "POST" });
    return handler(init.signal as AbortSignal);
  });
}
function reply(body: string = JSON.stringify({ code: 0, data: grant }), init: ResponseInit = {}) {
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    ...init,
  });
}
function network(code: string, causeCode?: string) {
  return Object.assign(new TypeError(sentinel), {
    code,
    cause: { code: causeCode, message: sentinel },
  });
}
async function failure(promise: Promise<unknown>, code: string, transportFailure?: string) {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ConfidentialControllerError);
  expect(error).toHaveProperty("code", code);
  expect((error as { transportFailure?: string }).transportFailure).toBe(transportFailure);
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain(sentinel);
  expect(String(error)).not.toContain(sentinel);
  return error;
}

describe("private HTTP source transport classification", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"])(
    "classifies fetch %s after token success",
    async (code) => {
      serve(async () => {
        throw network(code);
      });
      await failure(authorize(), "UNAVAILABLE", "unavailable-connection");
      expect(requests).toEqual(["/api/system/ccode-controller/authorize"]);
    },
  );
  it("recognizes the shallow Node fetch cause", async () => {
    serve(async () => {
      throw network("", "ECONNREFUSED");
    });
    await failure(authorize(), "UNAVAILABLE", "unavailable-connection");
  });
  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "UNKNOWN",
  ])("rejects %s", async (code) => {
    serve(async () => {
      throw network(code);
    });
    await failure(authorize(), "UNAVAILABLE");
  });
  it("does not let a connection cause override TLS", async () => {
    serve(async () => {
      throw network("ERR_TLS_CERT_ALTNAME_INVALID", "ECONNRESET");
    });
    await failure(authorize(), "UNAVAILABLE");
  });
  it("does not inspect nested causes or messages", async () => {
    serve(async () => {
      throw new TypeError("ECONNREFUSED " + sentinel, {
        cause: { cause: { code: "ECONNREFUSED" } },
      });
    });
    await failure(authorize(), "UNAVAILABLE");
  });
  it("rejects token connection failures without fetching", async () => {
    await failure(
      authorize(async () => {
        throw network("ECONNREFUSED");
      }),
      "UNAVAILABLE",
    );
    expect(requests).toEqual([]);
  });
  it.each(["AUTH_REQUIRED", "IDENTITY_CHANGED"] as const)("preserves token %s", async (code) => {
    await failure(
      authorize(async () => {
        throw new ConfidentialControllerError(code);
      }),
      code,
    );
  });
  it("does not classify a token timeout", async () => {
    await failure(
      authorize(async () => {
        timeout.abort();
        return "token";
      }),
      "CANCELLED",
    );
    expect(requests).toEqual([]);
  });
  it("classifies independent fetch timeout with the existing public cancellation code", async () => {
    serve(async () => {
      timeout.abort();
      throw new DOMException(sentinel, "TimeoutError");
    });
    await failure(authorize(), "CANCELLED", "unavailable-timeout");
  });
  it.each(["connection", "timeout", "auth"])("caller cancellation wins over %s", async (kind) => {
    serve(async () => {
      parent.abort();
      if (kind === "auth") return reply("", { status: 403 });
      if (kind === "timeout") {
        timeout.abort();
        throw new DOMException(sentinel, "AbortError");
      }
      throw network("ECONNRESET");
    });
    await failure(authorize(), "CANCELLED");
  });
  it.each([401, 403, 429, 500, 503])(
    "rejects HTTP %s even when timeout arrives during cleanup",
    async (status) => {
      serve(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                timeout.abort();
              },
            }),
            { status },
          ),
      );
      await failure(
        authorize(),
        status === 401 || status === 403 ? "AUTH_REQUIRED" : "UNAVAILABLE",
      );
    },
  );
  it.each([
    // 中台明确拒绝必须保留授权拒绝语义，不能归入暂时不可用。
    ["business denial", JSON.stringify({ code: 403, msg: sentinel }), {}, "AUTHORIZATION_REJECTED"],
    ["bad JSON", sentinel, {}, "UNAVAILABLE"],
    [
      "missing no-store",
      "{}",
      { headers: { "content-type": "application/json" } },
      "INVALID_RELEASE",
    ],
    ["non JSON", sentinel, { headers: { "content-type": "text/plain" } }, "UNAVAILABLE"],
    ["oversize", "x".repeat(8193), {}, "INVALID_RELEASE"],
    [
      "advertised oversize",
      "{}",
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": "8193",
        },
      },
      "INVALID_RELEASE",
    ],
  ] as const)("rejects %s", async (_name, body, init, code) => {
    serve(async () => reply(body, init));
    await failure(authorize(), code);
  });
  it("keeps a malformed JSON terminal before delayed reader cleanup timeout", async () => {
    serve(async () => {
      const response = reply();
      vi.spyOn(response.body!, "getReader").mockReturnValue({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sentinel) })
          .mockResolvedValueOnce({ done: true }),
        cancel: async () => {
          timeout.abort();
        },
        releaseLock() {},
      } as unknown as ReadableStreamDefaultReader<Uint8Array>);
      return response;
    });
    await failure(authorize(), "UNAVAILABLE");
  });
  it("classifies response read timeout", async () => {
    serve(
      async (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () =>
                controller.error(new DOMException(sentinel, "AbortError")),
              );
            },
            pull() {
              timeout.abort();
            },
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        ),
    );
    await failure(authorize(), "CANCELLED", "unavailable-timeout");
  });
  it("does not upgrade a TLS failure after timeout", async () => {
    serve(async () => {
      timeout.abort();
      throw network("CERT_HAS_EXPIRED");
    });
    await failure(authorize(), "CANCELLED");
  });
  it("preserves success and issues only the primary requests", async () => {
    serve(async () => reply());
    expect(await authorize()).toEqual(grant);
    expect(await source().download({ identity, grant, signal: parent.signal })).toEqual(grant);
    expect(requests).toEqual([
      "/api/system/ccode-controller/authorize",
      "/api/system/ccode-controller/content",
    ]);
  });
});
