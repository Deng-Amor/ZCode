import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { readControllerBootstrap } from "../src/confidential-controller/bootstrap.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const events = new EventEmitter();
  const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
    callback(null);
    return true;
  });
  const ipc = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    connected: true,
    send,
  };
  const result = readControllerBootstrap(
    ipc as unknown as Parameters<typeof readControllerBootstrap>[0],
  );
  return { events, send, result };
}

it("loads startup configuration once without acquire or complete, regardless of elapsed grant time", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const config = { version: 1, digest: "a".repeat(64), systemPrompt: "SYNTHETIC_GLOBAL_RULE" };
  f.events.emit("message", { type: "bootstrap-ready", requestId: 1, ...config });
  expect(await f.result).toEqual(config);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.send.mock.calls.map(([message]) => message)).toEqual([
    { type: "bootstrap", requestId: 1 },
  ]);
  expect(f.events.listenerCount("message")).toBe(0);
});

it.each([
  { type: "bootstrap-ready", requestId: 1, version: 1, digest: "invalid", systemPrompt: "SECRET" },
  {
    type: "bootstrap-ready",
    requestId: 2,
    version: 1,
    digest: "a".repeat(64),
    systemPrompt: "SECRET",
  },
])("rejects invalid startup responses without including their body", async (event) => {
  const f = fixture();
  f.events.emit("message", event);
  await expect(f.result).rejects.toMatchObject({ code: "INVALID_RELEASE" });
  expect(f.events.listenerCount("message")).toBe(0);
});

it("rejects disconnected startup and removes listeners", async () => {
  const f = fixture();
  f.events.emit("disconnect");
  await expect(f.result).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.events.listenerCount("message")).toBe(0);
});

it("bounds initialization wait without a renewal timer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = expect(f.result).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await vi.advanceTimersByTimeAsync(30_000);
  await result;
});
