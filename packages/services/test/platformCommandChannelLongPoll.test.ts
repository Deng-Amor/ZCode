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
      sleep: async () => { /* 注入空 sleep：空轮询节奏不引入真实等待 */ },
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

  test("paces consecutive empty polls with the minimum interval when the server returns early", async () => {
    // 2026-10-26 与中台对齐：服务端空结果提前返回时，客户端按请求起点间隔≥minEmptyPollIntervalMs 自限。
    const waits: number[] = [];
    let calls = 0;
    let transport: ReturnType<typeof createLongPollTransport>;
    transport = createLongPollTransport({
      endpoint: "https://example.test/poll",
      fetchImpl: async () => {
        calls += 1;
        if (calls >= 3) queueMicrotask(() => { void transport.stop(); });
        return new Response(JSON.stringify({ envelopes: [], nextCursor: String(calls) }), { status: 200 });
      },
      processEnvelope: async () => { throw new Error("empty poll must not process envelopes"); },
      sleep: async (ms) => { waits.push(ms); },
      now: () => new Date(0), // 固定时钟：请求耗时为 0，节奏间隔取满额
      minEmptyPollIntervalMs: 5_000,
    });
    await transport.start();
    expect(calls).toBe(3);
    expect(waits).toEqual([5_000, 5_000]);
  });

  test("does not credit server hold time already spent inside the request interval", async () => {
    // 服务端 hold 满 minInterval 后返回空结果：起点间隔已达标，客户端零补等。
    const waits: number[] = [];
    let clock = 0;
    let transport: ReturnType<typeof createLongPollTransport>;
    transport = createLongPollTransport({
      endpoint: "https://example.test/poll",
      fetchImpl: async () => {
        clock += 5_000; // 模拟服务端 hold 5s 后才响应
        queueMicrotask(() => { void transport.stop(); });
        return new Response(JSON.stringify({ envelopes: [], nextCursor: "1" }), { status: 200 });
      },
      processEnvelope: async () => { throw new Error("unexpected"); },
      sleep: async (ms) => { waits.push(ms); clock += ms; },
      now: () => new Date(clock),
      minEmptyPollIntervalMs: 5_000,
    });
    await transport.start();
    expect(waits).toEqual([]);
  });

  test("polls carrying envelopes are not paced", async () => {
    const waits: number[] = [];
    const received: unknown[] = [];
    let calls = 0;
    let transport: ReturnType<typeof createLongPollTransport>;
    transport = createLongPollTransport({
      endpoint: "https://example.test/poll",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ envelopes: [{ n: calls }], nextCursor: String(calls) }), { status: 200 });
      },
      processEnvelope: async (envelope) => {
        received.push(envelope);
        if (received.length >= 2) queueMicrotask(() => { void transport.stop(); });
      },
      sleep: async (ms) => { waits.push(ms); },
      now: () => new Date(0),
      minEmptyPollIntervalMs: 5_000,
    });
    await transport.start();
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    expect(waits).toEqual([]);
  });
});
