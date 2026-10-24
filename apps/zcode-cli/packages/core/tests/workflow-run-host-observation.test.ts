import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionEventStore,
  createSessionId,
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
  type Logger,
} from "@zcode/contracts";
import { AgentRuntime, type AgentRuntimeDeps } from "../src/index.js";

const host = {
  runId: "uncertain-host",
  observationSource: "host-reconciliation",
  sequence: 0,
  eventType: "run-settled",
  payload: {
    status: "errored",
    error: { code: "RecoveryUncertain", message: "Unknown external result" },
  },
} as const;
function setup(extraDeps: Partial<AgentRuntimeDeps> = {}) {
  const eventStore = createInMemorySessionEventStore();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child(): Logger {
      return logger;
    },
  };
  const modelFactory = vi.fn<AgentRuntimeDeps["modelFactory"]>(() => {
    throw new Error("observation must not create model");
  });
  const runtime = new AgentRuntime(
    createSessionId("parent-host"),
    { workingDirectory: "/fixture" },
    { eventStore, modelFactory, logger, ...extraDeps },
  );
  const events: SessionEvent[] = [];
  const unsubscribe = runtime.subscribeEvents({
    onSessionEvent: (event) => {
      events.push(event);
    },
  });
  const notify = vi.spyOn(
    runtime as unknown as { enqueueBackgroundTaskNotification: (notification: unknown) => void },
    "enqueueBackgroundTaskNotification",
  );
  return { runtime, eventStore, logger, modelFactory, events, unsubscribe, notify };
}

describe("runtime host observation boundary", () => {
  it("records a stable safe diagnostic for a malformed non-string run identity", async () => {
    const h = setup();
    try {
      await expect(
        h.runtime.recordDynamicWorkflowRunProgress({
          ...host,
          runId: { toString: "private-marker" },
        } as unknown as DynamicWorkflowRunProgressPayload),
      ).rejects.toThrow("invalid_host_observation");
      expect(h.events).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          runId: "invalid-run-id",
          reasonCode: "invalid_host_observation",
        }),
      );
      expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("private-marker");
    } finally {
      h.unsubscribe();
      h.runtime.beginShutdown();
      await h.runtime.closeBrowserSession();
    }
  });
  it("appends a real out-of-turn event with a raw sequence while preserving the zero journal cursor", async () => {
    const h = setup();
    try {
      await h.runtime.recordDynamicWorkflowRunProgress(host);
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({
        type: SessionEventType.DynamicWorkflowRunProgress,
        sequenceNumber: 1,
        payload: host,
      });
      expect(h.events[0]?.turnId).toBeUndefined();
      expect(await h.eventStore.getEvents(createSessionId("parent-host"))).toEqual(h.events);
      expect(h.runtime.getSessionEventStore()).toBe(h.eventStore);
      expect(h.modelFactory).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    } finally {
      h.unsubscribe();
      h.runtime.beginShutdown();
      await h.runtime.closeBrowserSession();
    }
  });

  it.each([undefined, null, "future", "host-reconciliation"])(
    "rejects malformed source %s before append and notifications",
    async (source) => {
      const h = setup();
      try {
        const invalid = {
          ...host,
          observationSource: source,
          payload: { ...host.payload, launchInputId: "private" },
        };
        await expect(
          h.runtime.recordDynamicWorkflowRunProgress(
            invalid as unknown as DynamicWorkflowRunProgressPayload,
          ),
        ).rejects.toThrow();
        expect(h.events).toHaveLength(0);
        expect(await h.eventStore.getLatestSequenceNumber(createSessionId("parent-host"))).toBe(0);
        expect(h.notify).not.toHaveBeenCalled();
        expect(h.modelFactory).not.toHaveBeenCalled();
        expect(h.logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            runId: "uncertain-host",
            sessionId: "sess_parent-host",
            reasonCode: expect.any(String),
          }),
        );
        expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("private");
      } finally {
        h.unsubscribe();
        h.runtime.beginShutdown();
        await h.runtime.closeBrowserSession();
      }
    },
  );
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("stable host stored handoff", () => {
  const harnesses: ReturnType<typeof setup>[] = [];
  function harness(extraDeps: Partial<AgentRuntimeDeps> = {}) {
    const h = setup(extraDeps);
    harnesses.push(h);
    return h;
  }
  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      h.unsubscribe();
      h.runtime.beginShutdown();
      await h.runtime.closeBrowserSession();
    }
    vi.restoreAllMocks();
  });

  it("host stored handoff precedes a pending ordinary sink", async () => {
    const pending = deferred();
    const entered = deferred();
    const h = harness({
      eventSink: {
        onSessionEvent: () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const append = vi.spyOn(h.eventStore, "append");
    const handoff = vi.fn();
    let settled = false;
    const recording = h.runtime.recordWorkflowHostObservation(host, handoff).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      const appendCalls = append.mock.calls.length;
      const storedEvents = await h.eventStore.getEvents(createSessionId("parent-host"));
      expect(appendCalls).toBe(1);
      expect(storedEvents).toHaveLength(1);
      expect(handoff).toHaveBeenCalledTimes(1);
      const handoffEvent = handoff.mock.calls[0]![0] as SessionEvent;
      expect(handoffEvent.id).toBe(storedEvents[0]!.id);
      expect(handoffEvent.sequenceNumber).toBe(1);
      expect(handoffEvent.turnId).toBeUndefined();
      expect(settled).toBe(false);
      expect(h.events).toEqual([]);
    } finally {
      pending.resolve();
      await recording;
    }
  });

  it("settled reject absent retries the same identity once", async () => {
    const h = harness();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const append = vi
      .spyOn(h.eventStore, "append")
      .mockRejectedValueOnce(new Error("append rejected"))
      .mockImplementation(realAppend);
    const handoff = vi.fn();
    await h.runtime.recordWorkflowHostObservation(host, handoff);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![0]).toBe(append.mock.calls[0]![0]);
    expect(append.mock.calls[1]![0].id).toBe(append.mock.calls[0]![0].id);
    const storedEvents = await h.eventStore.getEvents(createSessionId("parent-host"));
    expect(storedEvents).toHaveLength(1);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]![0].id).toBe(storedEvents[0]!.id);
  });

  it("settled reject present hands off without reappend", async () => {
    const h = harness();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const append = vi.spyOn(h.eventStore, "append").mockImplementation(async (event) => {
      await realAppend(event);
      throw new Error("rejected after storage");
    });
    const handoff = vi.fn();
    await h.runtime.recordWorkflowHostObservation(host, handoff);
    const appendCalls = append.mock.calls.length;
    const storedEvents = await h.eventStore.getEvents(createSessionId("parent-host"));
    expect(appendCalls).toBe(1);
    expect(storedEvents).toHaveLength(1);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]![0].id).toBe(storedEvents[0]!.id);
    expect(h.events).toEqual([]);
  });

  it("lookup unknown never retries", async () => {
    const h = harness();
    const append = vi.spyOn(h.eventStore, "append").mockRejectedValue(new Error("private append"));
    vi.spyOn(h.eventStore, "getEvents").mockRejectedValue(new Error("private lookup"));
    const handoff = vi.fn();
    await expect(h.runtime.recordWorkflowHostObservation(host, handoff)).rejects.toThrow();
    expect(append).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("private");
  });

  it("handoff throw does not stop legacy fanout", async () => {
    const h = harness();
    const append = vi.spyOn(h.eventStore, "append");
    const handoff = vi.fn(() => {
      throw new Error("private handoff");
    });
    h.logger.warn.mockImplementation(() => {
      throw new Error("diagnostic failed");
    });
    await h.runtime.recordWorkflowHostObservation(host, handoff);
    expect(append).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.id).toBe(
      (await h.eventStore.getEvents(createSessionId("parent-host")))[0]!.id,
    );
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.modelFactory).not.toHaveBeenCalled();
  });

  it("host toolCallId has no usage upsert", async () => {
    const usage = {
      recordModelUsage: vi.fn(),
      upsertToolUsage: vi.fn(),
      upsertTurnUsage: vi.fn(),
      pruneUsage: vi.fn(),
    };
    const h = harness({ sessionStore: usage as never });
    const handoff = vi.fn();
    await h.runtime.recordWorkflowHostObservation(
      { ...host, toolCallId: "host-tool-call" },
      handoff,
    );
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
    expect(usage.upsertToolUsage).not.toHaveBeenCalled();
    expect(usage.recordModelUsage).not.toHaveBeenCalled();
    expect(usage.upsertTurnUsage).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.modelFactory).not.toHaveBeenCalled();
  });

  it("registry rejection after handoff cannot erase stored identity", async () => {
    const usage = {
      recordModelUsage: vi.fn(),
      upsertToolUsage: vi.fn(),
      upsertTurnUsage: vi.fn(),
      pruneUsage: vi.fn(),
    };
    const h = harness({ sessionStore: usage as never });
    const append = vi.spyOn(h.eventStore, "append");
    const registry = h.runtime.getToolRegistry();
    const handoff = vi.fn();
    vi.spyOn(registry, "get").mockImplementation(() => {
      expect(handoff).toHaveBeenCalledTimes(1);
      throw new Error("registry rejected");
    });
    await expect(
      h.runtime.recordWorkflowHostObservation({ ...host, toolCallId: "host-tool-call" }, handoff),
    ).rejects.toThrow("registry rejected");
    expect(append).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
    const storedEvents = await h.eventStore.getEvents(createSessionId("parent-host"));
    expect(storedEvents).toHaveLength(1);
    expect(handoff.mock.calls[0]![0].id).toBe(storedEvents[0]!.id);
    expect(h.events).toEqual([]);
    expect(usage.upsertToolUsage).not.toHaveBeenCalled();
  });

  it("a second rejected absent append never starts a third attempt", async () => {
    const h = harness();
    const append = vi.spyOn(h.eventStore, "append").mockRejectedValue(new Error("append rejected"));
    const handoff = vi.fn();
    await expect(h.runtime.recordWorkflowHostObservation(host, handoff)).rejects.toThrow();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![0]).toBe(append.mock.calls[0]![0]);
    expect(handoff).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "conflict", "invalid-sequence"])(
    "rejects %s identity without retry",
    async (kind) => {
      const h = harness();
      const realAppend = h.eventStore.append.bind(h.eventStore);
      const append = vi.spyOn(h.eventStore, "append").mockImplementation(async (event) => {
        await realAppend(
          kind === "conflict" ? { ...event, sessionId: createSessionId("foreign") } : event,
        );
        throw new Error("append rejected");
      });
      const realGet = h.eventStore.getEvents.bind(h.eventStore);
      vi.spyOn(h.eventStore, "getEvents").mockImplementation(async () => {
        const rows = await realGet(
          createSessionId(kind === "conflict" ? "foreign" : "parent-host"),
        );
        return kind === "duplicate"
          ? [...rows, ...rows]
          : kind === "invalid-sequence"
            ? rows.map((event) => ({ ...event, sequenceNumber: 0 }))
            : rows;
      });
      const handoff = vi.fn();
      await expect(h.runtime.recordWorkflowHostObservation(host, handoff)).rejects.toThrow();
      expect(append).toHaveBeenCalledTimes(1);
      expect(handoff).not.toHaveBeenCalled();
    },
  );

  it("rejects legacy input at the host-only front door", async () => {
    const h = harness();
    const append = vi.spyOn(h.eventStore, "append");
    const handoff = vi.fn();
    await expect(
      h.runtime.recordWorkflowHostObservation(
        {
          runId: host.runId,
          sequence: 1,
          eventType: "run-settled",
          payload: host.payload,
        },
        handoff,
      ),
    ).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("an unsettled append cannot start lookup, retry, or handoff", async () => {
    const h = harness();
    const gate = deferred();
    const entered = deferred();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const append = vi.spyOn(h.eventStore, "append").mockImplementation(async (event) => {
      entered.resolve();
      await gate.promise;
      return realAppend(event);
    });
    const lookup = vi.spyOn(h.eventStore, "getEvents");
    const handoff = vi.fn();
    const recording = h.runtime.recordWorkflowHostObservation(host, handoff);
    try {
      await entered.promise;
      expect(append).toHaveBeenCalledTimes(1);
      expect(lookup).not.toHaveBeenCalled();
      expect(handoff).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await recording;
    }
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("an unsettled authoritative lookup cannot start retry or handoff", async () => {
    const h = harness();
    const gate = deferred();
    const entered = deferred();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const realGet = h.eventStore.getEvents.bind(h.eventStore);
    const append = vi
      .spyOn(h.eventStore, "append")
      .mockRejectedValueOnce(new Error("append rejected"))
      .mockImplementation(realAppend);
    vi.spyOn(h.eventStore, "getEvents").mockImplementation(async (sessionId) => {
      entered.resolve();
      await gate.promise;
      return realGet(sessionId);
    });
    const handoff = vi.fn();
    const recording = h.runtime.recordWorkflowHostObservation(host, handoff);
    try {
      await entered.promise;
      expect(append).toHaveBeenCalledTimes(1);
      expect(handoff).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await recording;
    }
    expect(append).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("a shutdown during lookup forbids retry and handoff", async () => {
    const h = harness();
    const gate = deferred();
    const entered = deferred();
    const append = vi.spyOn(h.eventStore, "append").mockRejectedValue(new Error("append rejected"));
    vi.spyOn(h.eventStore, "getEvents").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return [];
    });
    const handoff = vi.fn();
    const result = h.runtime
      .recordWorkflowHostObservation(host, handoff)
      .catch((error: unknown) => error);
    await entered.promise;
    h.runtime.beginShutdown();
    gate.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(append).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("caller mutation while append is pending cannot change the prepared identity", async () => {
    const h = harness();
    const gate = deferred();
    const entered = deferred();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const append = vi.spyOn(h.eventStore, "append").mockImplementation(async (event) => {
      entered.resolve();
      await gate.promise;
      return realAppend(event);
    });
    const input = { ...host, payload: { ...host.payload, error: { ...host.payload.error } } };
    const handoff = vi.fn();
    const recording = h.runtime.recordWorkflowHostObservation(input, handoff);
    await entered.promise;
    Object.assign(input, { runId: "changed-run" });
    Object.assign(input.payload.error, { message: "changed message" });
    gate.resolve();
    await recording;
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]![0].payload).toEqual(host);
    expect(Object.isFrozen(append.mock.calls[0]![0])).toBe(true);
    expect(Object.isFrozen(append.mock.calls[0]![0].payload)).toBe(true);
  });

  it("a fulfilled conflicting identity is neither handed off nor retried", async () => {
    const h = harness();
    const realAppend = h.eventStore.append.bind(h.eventStore);
    const append = vi.spyOn(h.eventStore, "append").mockImplementation(async (event) => {
      const stored = await realAppend(event);
      return { ...stored, payload: { ...host, runId: "conflicting-run" } };
    });
    const lookup = vi.spyOn(h.eventStore, "getEvents");
    const handoff = vi.fn();
    await expect(h.runtime.recordWorkflowHostObservation(host, handoff)).rejects.toThrow(
      "identity unverifiable",
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});
