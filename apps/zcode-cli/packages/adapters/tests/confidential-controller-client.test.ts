import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import {
  createPrivateControllerClient,
  PrivateControllerError,
} from "../src/confidential-controller/index.js";

const version = 2;
const digest = "a".repeat(64);
const instruction = "SYNTHETIC_PRIVATE_CONTROLLER_INSTRUCTION";
const candidate = { answer: 7 };

function startUse() {
  const events = new EventEmitter();
  const commands: Array<{ type: string; requestId: number }> = [];
  let completeSent!: () => void;
  const completeCheckpoint = new Promise<void>((resolve) => {
    completeSent = resolve;
  });
  const transport = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    connected: true,
    send(command: (typeof commands)[number], callback: (error: Error | null) => void) {
      commands.push(command);
      callback(null);
      if (command.type === "complete") completeSent();
      return true;
    },
    disconnect() {
      if (!transport.connected) return;
      transport.connected = false;
      events.emit("disconnect");
    },
  };
  const client = createPrivateControllerClient(
    transport as unknown as Parameters<typeof createPrivateControllerClient>[0],
  );
  const fulfilled = vi.fn((value: unknown) => value);
  const rejected = vi.fn((error: unknown) => error);
  const result = client.use(async () => candidate, { version });
  const observed = result.then(fulfilled, rejected);
  const requestId = commands[0]!.requestId;
  return {
    commands,
    requestId,
    events,
    transport,
    completeCheckpoint,
    fulfilled,
    rejected,
    observed,
    ready() {
      events.emit("message", { type: "ready", requestId, version, digest, instruction });
    },
    async cleanup() {
      client.dispose();
      await observed;
      expect(events.listenerCount("message")).toBe(0);
      expect(events.listenerCount("disconnect")).toBe(0);
    },
  };
}

it("keeps use pending after consume finishes until completed arrives", async () => {
  const test = startUse();
  try {
    test.ready();
    await test.completeCheckpoint;
    await Promise.resolve();
    expect(test.fulfilled).not.toHaveBeenCalled();
    expect(test.rejected).not.toHaveBeenCalled();
    expect(test.commands.filter((command) => command.type === "complete")).toHaveLength(1);
  } finally {
    await test.cleanup();
  }
});

it("resolves the screened result only after matching completed", async () => {
  const test = startUse();
  try {
    test.ready();
    await test.completeCheckpoint;
    await Promise.resolve();
    expect(test.fulfilled).not.toHaveBeenCalled();
    expect(test.rejected).not.toHaveBeenCalled();
    test.events.emit("message", { type: "completed", requestId: test.requestId });
    expect(await test.observed).toEqual({ version, digest, value: candidate });
    expect(test.fulfilled).toHaveBeenCalledTimes(1);
    expect(test.rejected).not.toHaveBeenCalled();
    expect(test.commands).toEqual([
      { type: "acquire", requestId: test.requestId, version },
      { type: "complete", requestId: test.requestId },
    ]);
  } finally {
    await test.cleanup();
  }
});

it.each([
  ["failed", "IDENTITY_CHANGED"],
  ["disconnect", "UNAVAILABLE"],
] as const)("rejects the buffered candidate on %s before completed", async (event, code) => {
  const test = startUse();
  try {
    test.ready();
    await test.completeCheckpoint;
    await Promise.resolve();
    expect(test.fulfilled).not.toHaveBeenCalled();
    expect(test.rejected).not.toHaveBeenCalled();
    if (event === "failed") {
      test.events.emit("message", { type: "failed", requestId: test.requestId, code });
    } else {
      test.transport.disconnect();
    }
    const error = await test.observed;
    expect(error).toBeInstanceOf(PrivateControllerError);
    expect(error).toMatchObject({ code });
    expect(test.rejected).toHaveBeenCalledTimes(1);
    expect(test.fulfilled).not.toHaveBeenCalled();
    test.events.emit("message", { type: "completed", requestId: test.requestId });
    await Promise.resolve();
    expect(test.fulfilled).not.toHaveBeenCalled();
    expect(test.rejected).toHaveBeenCalledTimes(1);
  } finally {
    await test.cleanup();
  }
});
