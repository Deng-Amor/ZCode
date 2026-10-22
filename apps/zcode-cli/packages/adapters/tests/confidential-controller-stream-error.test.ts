import { streamText } from "ai";
import { expect, it, vi } from "vitest";
import { createStreamTextOptions } from "../src/model/runner-options.js";
import { TestProviderConfigFixture } from "./test-provider-config.js";
import { createTestModelProperties } from "./test-model-format.js";

const sentinel = "SYNTHETIC_CONTROLLER_STREAM_ERROR";
const providerId = "synthetic-error-provider";
const modelId = "synthetic-error-model";

async function consumeErrorStream(
  metadata: Parameters<typeof createStreamTextOptions>[0]["request"]["metadata"],
) {
  let requests = 0;
  const fixture = new TestProviderConfigFixture(
    {
      env: {},
      providers: {
        [providerId]: {
          kind: "openai-compatible",
          apiKey: "synthetic-test-key",
          baseURL: "https://stream-error.invalid/v1",
        },
      },
    },
    {
      requestSecurityState: {
        createExecution: () => ({
          protectTransport: ({ transport }) => transport,
          take: () => [],
        }),
      },
      // 所有请求均在内存返回合成错误，禁止回落到真实模型或鉴权网络。
      transport: async () => {
        requests++;
        return new Response(
          JSON.stringify({ error: { type: "invalid_request_error", message: sentinel } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  const resolved = fixture.resolve(
    { providerId, modelId },
    { maxOutputTokens: 1, reasoningLevel: "disabled" },
  );
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = streamText(
      createStreamTextOptions({
        includeModelIO: false,
        resolved: { ...resolved, properties: createTestModelProperties() },
        request: { messages: [{ role: "user", content: "synthetic request" }], metadata },
        statusContext: { providerId, modelId, providerKind: resolved.providerKind } as never,
      }),
    );
    let errorParts = 0;
    let errorPartContainsSentinel = false;
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        errorParts++;
        errorPartContainsSentinel ||=
          part.error instanceof Error && part.error.message.includes(sentinel);
      }
    }
    return {
      requests,
      errorParts,
      errorPartContainsSentinel,
      diagnostics: {
        calls: consoleError.mock.calls.length,
        containsSentinel: consoleError.mock.calls.some((args) =>
          args.some((arg) => arg instanceof Error && arg.message.includes(sentinel)),
        ),
      },
    };
  } finally {
    consoleError.mockRestore();
  }
}

it("keeps the protected stream error part without SDK console diagnostics", async () => {
  const observed = await consumeErrorStream({ confidentialController: true, skipTranscript: true });
  expect(observed.requests).toBe(1);
  expect(observed.errorParts).toBe(1);
  expect(observed.errorPartContainsSentinel).toBe(true);
  expect(observed.diagnostics).toEqual({ calls: 0, containsSentinel: false });
});

it.each([undefined, { skipTranscript: true }])(
  "preserves ordinary SDK stream error diagnostics with metadata %j",
  async (metadata) => {
    const observed = await consumeErrorStream(metadata);
    expect(observed.requests).toBe(1);
    expect(observed.errorParts).toBe(1);
    expect(observed.errorPartContainsSentinel).toBe(true);
    expect(observed.diagnostics).toEqual({ calls: 1, containsSentinel: true });
  },
);
