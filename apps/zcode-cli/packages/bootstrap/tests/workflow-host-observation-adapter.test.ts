import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createInMemorySessionEventStore,
  type SessionEvent,
  type DynamicWorkflowRunProgressPayload,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import { createWorkflowHostObservationAdapter } from "../src/zcode-protocol/workflow-host-observation-adapter.js";
import type {
  WorkflowHostObservationAdapterDeps,
  WorkflowHostObservationOutcome,
} from "../src/zcode-protocol/workflow-host-observation/contract.js";
import type { WorkflowObservationOwner } from "../src/zcode-protocol-v4/v4-gateway.js";
import { createDynamicWorkflowRunProgressSink } from "../src/app/dynamic-workflow-run-progress-sink.js";
import type { ZCodeAppOptions } from "../src/app/types.js";

const host = {
  runId: "run-host",
  observationSource: "host-reconciliation" as const,
  sequence: 0,
  eventType: "run-settled",
  payload: { status: "errored", error: { code: "RecoveryUncertain", message: "Unknown result" } },
};
function event(id = "event-host", sequenceNumber = 1): SessionEvent {
  return {
    id,
    sessionId: "session-parent",
    traceId: "trace-parent",
    timestamp: new Date(0),
    sequenceNumber,
    type: SessionEventType.DynamicWorkflowRunProgress,
    payload: host,
  } as SessionEvent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup(overrides: Partial<WorkflowHostObservationAdapterDeps> = {}) {
  let current = true;
  let clock = 100;
  const outcomes: WorkflowHostObservationOutcome[] = [];
  const verifyStored = vi.fn(async (input: SessionEvent, _signal: AbortSignal) => input);
  const ensureCommit = vi.fn(async (_input: SessionEvent, _owner: WorkflowObservationOwner) => ({
    strictAttempted: false,
  }));
  const deps: WorkflowHostObservationAdapterDeps = {
    isCurrent: () => current,
    verifyStored,
    ensureCommit,
    report: (outcome) => {
      outcomes.push(outcome);
    },
    now: () => clock,
    ...overrides,
  };
  const adapter = createWorkflowHostObservationAdapter(deps);
  return {
    adapter,
    outcomes,
    verifyStored,
    ensureCommit,
    stale: () => {
      current = false;
    },
    advance: (value: number) => {
      clock += value;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workflow host observation record jobs", () => {
  it("B05/B08 joins hook and subscription by event and still forwards the complete subscription body", async () => {
    const pending = deferred<SessionEvent>();
    const h = setup({ verifyStored: () => pending.promise });
    const steps: string[] = [];
    const input = event();
    h.adapter.accept(input);
    h.adapter.accept(input, () => {
      steps.push("persist", "debug", "ingest");
    });
    h.adapter.accept(input, () => {
      steps.push("duplicate-forward");
    });
    expect(steps).toEqual(["persist", "debug", "ingest"]);
    pending.resolve(input);
    await flush();
    expect(h.ensureCommit).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({
      event: "workflow.host_observation.sync.completed",
      strictAttempted: false,
    });
  });

  it("B05 keeps different events of the same run independent and verifies the stored object", async () => {
    const stored = { ...event(), sequenceNumber: 42 };
    const h = setup({ verifyStored: async (input) => (input.id === stored.id ? stored : input) });
    h.adapter.accept(event());
    h.adapter.accept(event("other-event", 2));
    await flush();
    expect(h.ensureCommit.mock.calls.map(([input]) => input)).toEqual([
      stored,
      event("other-event", 2),
    ]);
    expect(h.ensureCommit.mock.calls[0]?.[0]).toBe(stored);
    expect(h.outcomes).toHaveLength(2);
  });

  it("B08/B19 starts the deadline synchronously before forwarding or asynchronous verification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<SessionEvent>();
    const h = setup({ verifyStored: () => pending.promise });
    h.adapter.accept(event(), () => {
      expect(vi.getTimerCount()).toBe(1);
      expect(h.verifyStored).not.toHaveBeenCalled();
      throw new Error("PRIVATE_FORWARD_BODY");
    });
    await flush();
    expect(h.outcomes).toEqual([]);
    h.advance(25000);
    await vi.advanceTimersByTimeAsync(25000);
    await flush();
    expect(h.outcomes).toMatchObject([
      { phase: "verify", reasonCode: "timeout", strictAttempted: "unknown", elapsedMs: 25000 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(event());
    await flush();
    expect(h.ensureCommit).not.toHaveBeenCalled();
    expect(h.outcomes).toHaveLength(1);
    expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_FORWARD_BODY");
  });

  it("B08 isolates a complete forward failure and still verifies and asks the gateway to commit", async () => {
    const h = setup();
    h.adapter.accept(event(), () => {
      throw new Error("PRIVATE_PRE_INGEST");
    });
    await flush();
    expect(h.verifyStored).toHaveBeenCalledTimes(1);
    expect(h.ensureCommit).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toMatchObject([{ event: "workflow.host_observation.sync.completed" }]);
  });

  it.each(["no-record", "no-gateway", "foreign-store", "duplicate-identity"])(
    "B11 rejects %s at the injected direct-store port without starting commit",
    async () => {
      const h = setup({
        verifyStored: async () => {
          throw {
            phase: "verify",
            reasonCode: "identity_unverifiable",
            strictAttempted: false,
            message: "PRIVATE_STORE",
          };
        },
      });
      h.adapter.accept(event());
      await flush();
      expect(h.ensureCommit).not.toHaveBeenCalled();
      expect(h.outcomes).toMatchObject([
        { phase: "verify", reasonCode: "identity_unverifiable", strictAttempted: "unknown" },
      ]);
      expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_STORE");
    },
  );

  it("B11 rejects an unexpected stored identity before invoking the gateway", async () => {
    const h = setup({ verifyStored: async () => event("foreign-event") });
    h.adapter.accept(event());
    await flush();
    expect(h.ensureCommit).not.toHaveBeenCalled();
    expect(h.outcomes).toMatchObject([{ reasonCode: "identity_unverifiable" }]);
  });

  it("B12 fences a record replaced during direct-store lookup", async () => {
    const pending = deferred<SessionEvent>();
    const h = setup({ verifyStored: () => pending.promise });
    h.adapter.accept(event());
    await flush();
    h.stale();
    pending.resolve(event());
    await flush();
    expect(h.ensureCommit).not.toHaveBeenCalled();
    expect(h.outcomes).toMatchObject([{ reasonCode: "stale_owner", strictAttempted: "unknown" }]);
  });

  it("B12/B14 disposes owners before abort listeners and ignores late commit completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<{ strictAttempted: boolean }>();
    let captured!: WorkflowObservationOwner;
    let activeAtAbort: boolean | undefined;
    const h = setup({
      ensureCommit: async (_input, owner) => {
        captured = owner;
        owner.signal.addEventListener("abort", () => {
          activeAtAbort = owner.isCurrent();
        });
        return pending.promise;
      },
    });
    h.adapter.accept(event());
    await flush();
    expect(captured.deadlineAt).toBe(25100);
    expect(captured.now()).toBe(100);
    h.adapter.dispose();
    await flush();
    expect(activeAtAbort).toBe(false);
    expect(captured.signal.aborted).toBe(true);
    expect(h.outcomes).toMatchObject([{ phase: "dispose", reasonCode: "disposed" }]);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ strictAttempted: true });
    await flush();
    expect(h.outcomes).toHaveLength(1);
  });

  it("B14 settles a pending commit at the total deadline and observes its late rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<{ strictAttempted: boolean }>();
    const h = setup({ ensureCommit: () => pending.promise });
    h.adapter.accept(event());
    await flush();
    h.advance(25000);
    await vi.advanceTimersByTimeAsync(25000);
    await flush();
    expect(h.outcomes).toMatchObject([{ phase: "observe", reasonCode: "timeout" }]);
    expect(vi.getTimerCount()).toBe(0);
    pending.reject(new Error("PRIVATE_LATE_REJECTION"));
    await flush();
    expect(h.outcomes).toHaveLength(1);
  });

  it("B13 removes completed jobs and reads strict history anew on every later handoff", async () => {
    let calls = 0;
    const h = setup({ ensureCommit: async () => ({ strictAttempted: ++calls > 1 }) });
    h.adapter.accept(event());
    await flush();
    h.adapter.accept(event());
    await flush();
    expect(h.outcomes.map((outcome) => outcome.strictAttempted)).toEqual([false, true]);
    expect(h.verifyStored).toHaveBeenCalledTimes(2);
  });

  it("B14 revokes a completed owner and removes its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let captured!: WorkflowObservationOwner;
    const h = setup({
      ensureCommit: async (_input, owner) => {
        captured = owner;
        return { strictAttempted: true };
      },
    });
    h.adapter.accept(event());
    await flush();
    expect(h.outcomes).toMatchObject([{ strictAttempted: true }]);
    expect(captured.isCurrent()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("B13 preserves gateway permanent failure metadata and does not invent another attempt cache", async () => {
    const ensureCommit = vi.fn(async () => {
      throw {
        phase: "strict_load",
        reasonCode: "strict_load_failed",
        strictAttempted: true,
        message: "PRIVATE_GATEWAY",
      };
    });
    const h = setup({ ensureCommit });
    h.adapter.accept(event());
    await flush();
    h.adapter.accept(event());
    await flush();
    expect(ensureCommit).toHaveBeenCalledTimes(2);
    expect(
      h.outcomes.map((outcome) => [outcome.phase, outcome.reasonCode, outcome.strictAttempted]),
    ).toEqual([
      ["strict_load", "strict_load_failed", true],
      ["strict_load", "strict_load_failed", true],
    ]);
    expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_GATEWAY");
  });

  it("redacts unknown errors and invalid identifiers and clears jobs even when reporting throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcomes: WorkflowHostObservationOutcome[] = [];
    const h = setup({
      ensureCommit: async () => {
        throw { phase: "PRIVATE_PHASE", reasonCode: "PRIVATE_REASON", strictAttempted: true };
      },
      report: (outcome) => {
        outcomes.push(outcome);
        throw new Error("PRIVATE_REPORT");
      },
    });
    h.adapter.accept(event("PRIVATE ID / secret"));
    await flush();
    expect(outcomes).toMatchObject([
      {
        eventId: "invalid-event-id",
        phase: "observe",
        reasonCode: "apply_failed",
        strictAttempted: "unknown",
      },
    ]);
    expect(JSON.stringify(outcomes)).not.toMatch(/PRIVATE/);
    expect(vi.getTimerCount()).toBe(0);
    h.adapter.accept(event("PRIVATE ID / secret"));
    await flush();
    expect(outcomes).toHaveLength(2);
  });

  it.each(["legacy", "invalid", "wrong-type", "raw-zero"])(
    "rejects %s before forwarding or lookup",
    async (kind) => {
      const input = event();
      if (kind === "legacy") input.payload = { ...host, observationSource: undefined };
      if (kind === "invalid") input.payload = { ...host, observationSource: "future" };
      if (kind === "wrong-type") input.type = SessionEventType.TurnStarted;
      if (kind === "raw-zero") input.sequenceNumber = 0;
      const forward = vi.fn();
      const h = setup();
      h.adapter.accept(input, forward);
      await flush();
      expect(forward).not.toHaveBeenCalled();
      expect(h.verifyStored).not.toHaveBeenCalled();
      expect(h.outcomes).toMatchObject([{ phase: "handoff", reasonCode: "invalid_observation" }]);
    },
  );

  it("B22 rejects an unavailable owner or a callback arriving after dispose without forwarding", async () => {
    const h = setup();
    h.stale();
    const forward = vi.fn();
    h.adapter.accept(event(), forward);
    await flush();
    expect(h.outcomes).toMatchObject([{ reasonCode: "stale_owner" }]);
    h.adapter.dispose();
    h.adapter.accept(event("late-event"), forward);
    await flush();
    expect(forward).not.toHaveBeenCalled();
    expect(h.verifyStored).not.toHaveBeenCalled();
    expect(h.outcomes[1]).toMatchObject({ phase: "dispose", reasonCode: "disposed" });
  });

  it.each([
    { cancel: "timeout", attempted: true, earlyListener: true },
    { cancel: "timeout", attempted: false, earlyListener: false },
    { cancel: "dispose", attempted: true, earlyListener: false },
    { cancel: "dispose", attempted: false, earlyListener: true },
  ])(
    "uses the direct gateway abort settlement before local fallback %j",
    async ({ cancel, attempted, earlyListener }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = deferred<{ strictAttempted: boolean }>();
      let ownerAtAbort: boolean | undefined;
      let listenerCleaned = false;
      const deps: Partial<WorkflowHostObservationAdapterDeps> = {
        verifyStored: async (input, signal) => {
          if (earlyListener)
            signal.addEventListener(
              "abort",
              () => {
                ownerAtAbort = false;
              },
              { once: true },
            );
          return input;
        },
        ensureCommit: (_input, owner) => {
          const abort = () => {
            ownerAtAbort = owner.isCurrent();
            pending.reject({
              phase: cancel === "dispose" ? "dispose" : "strict_load",
              reasonCode: cancel === "dispose" ? "disposed" : "timeout",
              strictAttempted: attempted,
            });
            owner.signal.removeEventListener("abort", abort);
            listenerCleaned = true;
          };
          owner.signal.addEventListener("abort", abort, { once: true });
          return pending.promise;
        },
      };
      const h = setup(deps);
      h.adapter.accept(event());
      await flush();
      if (cancel === "dispose") h.adapter.dispose();
      else {
        h.advance(25000);
        await vi.advanceTimersByTimeAsync(25000);
      }
      await flush();
      expect(h.outcomes).toHaveLength(1);
      expect(h.outcomes[0]).toMatchObject({
        event: "workflow.host_observation.sync.failed",
        strictAttempted: attempted,
        reasonCode: cancel === "dispose" ? "disposed" : "timeout",
      });
      expect(ownerAtAbort).toBe(false);
      expect(listenerCleaned).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["timeout", "dispose"])(
    "bounds an unresponsive ensure port on %s with unknown metadata",
    async (cancel) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = deferred<{ strictAttempted: boolean }>();
      const h = setup({ ensureCommit: () => pending.promise });
      h.adapter.accept(event());
      await flush();
      if (cancel === "dispose") h.adapter.dispose();
      else {
        h.advance(25000);
        await vi.advanceTimersByTimeAsync(25000);
      }
      await flush();
      expect(h.outcomes).toMatchObject([
        { strictAttempted: "unknown", reasonCode: cancel === "dispose" ? "disposed" : "timeout" },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve({ strictAttempted: true });
      await flush();
      expect(h.outcomes).toHaveLength(1);
    },
  );

  it.each(["fulfilled", "rejected"])(
    "preserves %s gateway metadata when disposed before its handler runs",
    async (kind) => {
      const pending = deferred<{ strictAttempted: boolean }>();
      const h = setup({ ensureCommit: () => pending.promise });
      h.adapter.accept(event());
      await flush();
      if (kind === "fulfilled") pending.resolve({ strictAttempted: true });
      else pending.reject({ phase: "dispose", reasonCode: "disposed", strictAttempted: true });
      h.adapter.dispose();
      await flush();
      expect(h.outcomes).toMatchObject([
        {
          event: "workflow.host_observation.sync.failed",
          strictAttempted: true,
          reasonCode: "disposed",
        },
      ]);
      expect(h.outcomes).toHaveLength(1);
    },
  );

  it("does not infer false when a later job fails in verify after a previous strict success", async () => {
    let verified = 0;
    const h = setup({
      verifyStored: async (input) => {
        if (++verified > 1) throw new Error("PRIVATE_VERIFY");
        return input;
      },
      ensureCommit: async () => ({ strictAttempted: true }),
    });
    h.adapter.accept(event());
    await flush();
    h.adapter.accept(event());
    await flush();
    expect(h.outcomes.map((outcome) => outcome.strictAttempted)).toEqual([true, "unknown"]);
  });

  it("isolates throwing metadata accessors instead of leaking an unhandled job rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({
      ensureCommit: () =>
        Promise.reject({
          get phase() {
            throw new Error("PRIVATE_ACCESSOR");
          },
        }),
    });
    h.adapter.accept(event());
    await flush();
    expect(h.outcomes).toMatchObject([
      { phase: "observe", reasonCode: "apply_failed", strictAttempted: "unknown" },
    ]);
    expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_ACCESSOR");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates a throwing fulfillment accessor and clears the job without an unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let requests = 0;
    const ensureCommit = vi.fn(() =>
      Promise.resolve(
        ++requests === 1
          ? {
              get strictAttempted(): boolean {
                throw new Error("PRIVATE_FULFILLMENT_ACCESSOR");
              },
            }
          : { strictAttempted: false },
      ),
    );
    const h = setup({ ensureCommit });
    try {
      h.adapter.accept(event());
      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(h.outcomes).toMatchObject([
        {
          event: "workflow.host_observation.sync.failed",
          phase: "observe",
          reasonCode: "apply_failed",
          strictAttempted: "unknown",
        },
      ]);
      expect(h.outcomes).toHaveLength(1);
      expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_FULFILLMENT_ACCESSOR");
      expect(vi.getTimerCount()).toBe(0);
      h.adapter.accept(event());
      await flush();
      expect(ensureCommit).toHaveBeenCalledTimes(2);
      expect(h.outcomes).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.adapter.dispose();
      await flush();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([false, true])(
    "reads a stateful fulfillment accessor once before reporting with dispose=%s",
    async (dispose) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let reads = 0;
      const pending = deferred<{ strictAttempted: boolean }>();
      const h = setup({ ensureCommit: () => pending.promise });
      h.adapter.accept(event());
      await flush();
      pending.resolve({
        get strictAttempted(): boolean {
          reads += 1;
          return reads === 1 ? true : ("PRIVATE_CHANGED_VALUE" as unknown as boolean);
        },
      });
      if (dispose) h.adapter.dispose();
      await flush();
      expect(reads).toBe(1);
      expect(h.outcomes).toMatchObject([
        dispose
          ? {
              event: "workflow.host_observation.sync.failed",
              reasonCode: "disposed",
              strictAttempted: true,
            }
          : { event: "workflow.host_observation.sync.completed", strictAttempted: true },
      ]);
      expect(h.outcomes).toHaveLength(1);
      expect(JSON.stringify(h.outcomes)).not.toContain("PRIVATE_CHANGED_VALUE");
      expect(vi.getTimerCount()).toBe(0);
      h.adapter.dispose();
      await flush();
      expect(h.outcomes).toHaveLength(1);
    },
  );
});

describe("workflow host stored hook app option and progress sink", () => {
  it.each([true, false])(
    "keeps invalid input on the real A validation boundary with hook=%s",
    async (withHook) => {
      const eventStore = createInMemorySessionEventStore();
      const modelFactory = vi.fn(() => {
        throw new Error("must not create model");
      });
      const sessionId = createSessionId("invalid-host");
      const runtime = new AgentRuntime(
        sessionId,
        { workingDirectory: "/fixture" },
        { eventStore, modelFactory },
      );
      const hook = vi.fn();
      const warn = vi.fn();
      const record = vi.spyOn(runtime, "recordWorkflowHostObservation");
      const legacy = vi.spyOn(runtime, "recordDynamicWorkflowRunProgress");
      const notify = vi.spyOn(
        runtime as unknown as { enqueueBackgroundTaskNotification(notification: unknown): void },
        "enqueueBackgroundTaskNotification",
      );
      try {
        const sink = createDynamicWorkflowRunProgressSink({
          sessionId,
          getRuntime: () => runtime,
          logger: { warn } as never,
          ...(withHook ? { onWorkflowHostObservationStored: hook } : {}),
        });
        sink({
          ...host,
          observationSource: "PRIVATE_SOURCE",
          payload: { secret: "PRIVATE_PAYLOAD" },
        } as unknown as DynamicWorkflowRunProgressPayload);
        await flush();
        expect(legacy).toHaveBeenCalledTimes(1);
        expect(record).not.toHaveBeenCalled();
        expect(await eventStore.getEvents(sessionId)).toEqual([]);
        expect(hook).not.toHaveBeenCalled();
        expect(modelFactory).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            sourceClassification: "invalid",
            reasonCode: "append_rejected",
          }),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
      } finally {
        runtime.beginShutdown();
        await runtime.closeBrowserSession();
      }
    },
  );

  it("checks foreign parent routing before either recorder or stored hook", () => {
    const legacy = vi.fn(async () => {});
    const record = vi.fn(async () => {});
    const hook = vi.fn();
    const sink = createDynamicWorkflowRunProgressSink({
      sessionId: createSessionId("parent"),
      getRuntime: () =>
        ({
          recordDynamicWorkflowRunProgress: legacy,
          recordWorkflowHostObservation: record,
        }) as unknown as AgentRuntime,
      onWorkflowHostObservationStored: hook,
    });
    sink(host, { parentSessionId: "foreign-parent" });
    expect(record).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("B19 passes the synchronous app hook at recorder invocation while its tail remains pending", async () => {
    const stored = event();
    const seen: SessionEvent[] = [];
    const options: Pick<ZCodeAppOptions, "onWorkflowHostObservationStored"> = {
      onWorkflowHostObservationStored: (input) => {
        seen.push(input);
      },
    };
    const legacy = vi.fn(async () => {});
    const record = vi.fn((_input, onStored: (input: SessionEvent) => void) => {
      onStored(stored);
      return new Promise<void>(() => {});
    });
    const sink = createDynamicWorkflowRunProgressSink({
      sessionId: createSessionId("parent"),
      getRuntime: () =>
        ({
          recordDynamicWorkflowRunProgress: legacy,
          recordWorkflowHostObservation: record,
        }) as unknown as AgentRuntime,
      ...options,
    });
    expect(sink(host)).toBeUndefined();
    expect(seen).toEqual([stored]);
    expect(legacy).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(host, options.onWorkflowHostObservationStored);
  });

  it("keeps the non-protocol TUI and Engine paths on the legacy recorder", () => {
    const legacy = vi.fn(async () => {});
    const record = vi.fn(async () => {});
    const hook = vi.fn();
    const getRuntime = () =>
      ({
        recordDynamicWorkflowRunProgress: legacy,
        recordWorkflowHostObservation: record,
      }) as unknown as AgentRuntime;
    const tui = createDynamicWorkflowRunProgressSink({
      sessionId: createSessionId("parent"),
      getRuntime,
    });
    tui(host);
    const protocol = createDynamicWorkflowRunProgressSink({
      sessionId: createSessionId("parent"),
      getRuntime,
      onWorkflowHostObservationStored: hook,
    });
    const engine = {
      runId: "engine-run",
      sequence: 2,
      eventType: "run-settled",
      payload: { status: "completed" },
    };
    protocol(engine);
    expect(legacy.mock.calls).toEqual([[host], [engine]]);
    expect(record).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "rejected"])(
    "never falls back after the injected host recorder fails %s",
    async (mode) => {
      const legacy = vi.fn(async () => {});
      const hook = vi.fn();
      const warn = vi.fn();
      const record = vi.fn(() => {
        if (mode === "synchronous") throw new Error("PRIVATE_RECORDER");
        return Promise.reject(new Error("PRIVATE_RECORDER"));
      });
      const sink = createDynamicWorkflowRunProgressSink({
        sessionId: createSessionId("parent"),
        getRuntime: () =>
          ({
            recordDynamicWorkflowRunProgress: legacy,
            recordWorkflowHostObservation: record,
          }) as unknown as AgentRuntime,
        onWorkflowHostObservationStored: hook,
        logger: { warn } as never,
      });
      expect(() => sink(host)).not.toThrow();
      await flush();
      expect(record).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_RECORDER");
    },
  );
});
