import { describe, expect, test } from "vitest";
import { createLongPollTransport } from "../src/platform-command-channel/long-poll-transport.js";

describe("platform command channel long poll", () => {
  test("routes envelopes and advances the cursor", async () => {
    const requests: string[] = [];
    const received: unknown[] = [];
    const responses = [
      { envelopes: [{ type: "notice" }], nextCursor: "2" },
      { envelopes: [], nextCursor: "3" },
    ];
    let transport: ReturnType<typeof createLongPollTransport>;
    transport = createLongPollTransport({
      endpoint: "https://example.test/poll",
      cursor: "1",
      fetchImpl: async (url) => {
        requests.push(String(url));
        if (requests.length === 2) queueMicrotask(() => { void transport.stop(); });
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      },
      processEnvelope: async (envelope) => { received.push(envelope); },
      now: () => new Date(0),
    });
    await transport.start();
    expect(received).toEqual([{ type: "notice" }]);
    expect(requests[0]).toContain("cursor=1");
    expect(requests[1]).toContain("cursor=2");
    expect(transport.cursor()).toBe("3");
  });

  test("reconnects with capped exponential backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    let transport: ReturnType<typeof createLongPollTransport>;
    transport = createLongPollTransport({
      endpoint: "https://example.test/poll",
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error("offline");
        return new Response(JSON.stringify({ envelopes: [{ done: true }], nextCursor: "1" }), { status: 200 });
      },
      processEnvelope: async () => { void transport.stop(); },
      sleep: async (ms) => { waits.push(ms); },
      backoff: { initialMs: 10, multiplier: 2, maxMs: 15 },
    });
    await transport.start();
    expect(waits).toEqual([10, 15]);
  });
});
