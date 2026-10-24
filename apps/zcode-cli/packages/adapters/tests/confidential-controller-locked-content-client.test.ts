import { describe, expect, it, vi } from "vitest";
import { createLockedContentClient } from "../src/confidential-controller/locked-content-client.js";

function port() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    posted: [] as unknown[],
    closed: false,
    on(event: "message" | "close", listener: (value: unknown) => void) { listeners.set(event, listener); },
    postMessage(message: unknown) { this.posted.push(message); },
    emit(event: "message" | "close", value?: unknown) { listeners.get(event)?.(value); },
    start: vi.fn(),
  };
}

describe("createLockedContentClient", () => {
  it("correlates concurrent successful responses", async () => {
    const p = port(); const client = createLockedContentClient(p, { timeoutMs: 100 });
    const one = client.load(); const two = client.load();
    const [a, b] = p.posted as { requestId: number }[];
    p.emit("message", { data: { type: "locked-content-ready", requestId: b.requestId, version: 2, digest: "b".repeat(64), skillMd: "two" } });
    p.emit("message", { data: { type: "locked-content-ready", requestId: a.requestId, version: 1, digest: "a".repeat(64), skillMd: "one" } });
    await expect(one).resolves.toMatchObject({ skillMd: "one" });
    await expect(two).resolves.toMatchObject({ skillMd: "two" });
  });
  it("maps timeout, close, malformed and failed responses to unavailable without resolving", async () => {
    const p = port(); const client = createLockedContentClient(p, { timeoutMs: 5 });
    const timeout = client.load(); await expect(timeout).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const closed = client.load(); p.emit("close"); await expect(closed).rejects.toMatchObject({ code: "UNAVAILABLE" });
    p.emit("message", { data: { type: "locked-content-ready", requestId: 999, version: 1, digest: "x" } });
  });
});
