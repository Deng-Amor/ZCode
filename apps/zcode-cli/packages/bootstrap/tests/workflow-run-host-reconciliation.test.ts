import { describe, expect, it, vi } from "vitest";
import { InMemoryJournalStore, type RunRecord } from "@zcode/dynamic-workflow";
import { createSessionId } from "@zcode/contracts";
import { createRunServiceLifecycle } from "../src/app/dynamic-workflow-run-lifecycle.js";
import type { RunRegistryEntry } from "../src/app/dynamic-workflow-run-observation.js";
import * as progressPayload from "../src/app/dynamic-workflow-run-progress-payload.js";
import { createDynamicWorkflowRunProgressSink } from "../src/app/dynamic-workflow-run-progress-sink.js";

const RUN = "host-uncertain-run";
const INSTANCE = { siteId: "world#2", ordinal: 1 };
function setup(overrides: Partial<RunRecord> = {}) {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: RUN,
    parentSessionId: "parent",
    toolCallId: "original-tool",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "stopped",
    stopReason: "interrupted",
    ...overrides,
  });
  journal.putNode({
    runId: RUN,
    ...INSTANCE,
    kind: "world-run",
    status: "running",
    inputHash: "synthetic",
  });
  journal.putNode({
    runId: RUN,
    siteId: "kept",
    ordinal: 1,
    kind: "world-run",
    status: "completed",
    inputHash: "kept",
    result: "kept-result",
  });
  const runs = new Map<string, RunRegistryEntry>();
  const seen: unknown[] = [];
  const observer = vi.fn((notice: unknown) =>
    seen.push({ notice, row: journal.getRun(RUN), terminal: runs.get(RUN)?.terminal }),
  );
  const lifecycle = createRunServiceLifecycle({
    journal,
    runs,
    parentSessionId: "parent",
    onRunReconciled: observer,
  });
  return { journal, runs, seen, observer, lifecycle };
}

describe("host reconciliation observation producer", () => {
  it.each([
    { source: "host-reconciliation", phase: "runtime_unavailable" },
    { source: "future", phase: "runtime_unavailable" },
    { source: "host-reconciliation", phase: "append_rejected" },
    { source: "future", phase: "append_rejected" },
  ])(
    "redacts host/invalid failure text while retaining a safe diagnostic %j",
    async ({ source, phase }) => {
      const warn = vi.fn();
      const sentinel = "PRIVATE_FAILURE_SENTINEL";
      const getRuntime =
        phase === "runtime_unavailable"
          ? () => {
              throw new Error(sentinel);
            }
          : ((() => ({
              recordDynamicWorkflowRunProgress: async () => {
                throw new Error(sentinel);
              },
            })) as never);
      const sink = createDynamicWorkflowRunProgressSink({
        sessionId: createSessionId("host-parent"),
        getRuntime,
        logger: { warn } as never,
      });
      sink({
        runId: RUN,
        observationSource: source,
        eventType: "run-settled",
        sequence: 0,
        payload: {
          status: "errored",
          error: { code: "RecoveryUncertain", message: "Unknown external result" },
        },
      } as Parameters<typeof sink>[0]);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          runId: RUN,
          sessionId: "sess_host-parent",
          reasonCode: phase,
          sourceClassification:
            source === "host-reconciliation" ? "host-reconciliation" : "invalid",
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    },
  );
  it("publishes only after durable and terminal cache agree, without changing nodes or Engine events", () => {
    const h = setup();
    h.runs.set(RUN, {
      controller: new AbortController(),
      startedAt: new Date(0),
      cwd: "/fixture",
      scriptText: "",
      terminal: { status: "stopped", reason: "interrupted" },
      settlement: Promise.resolve({ status: "stopped", reason: "interrupted" }),
    });
    const nodes = h.journal.listNodes(RUN, { kinds: "all", withResult: true });
    const append = vi.spyOn(h.journal, "appendEvent");
    const update = vi.spyOn(h.journal, "updateRunStatus");
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(h.observer).toHaveBeenCalledTimes(1);
    expect(h.seen[0]).toMatchObject({
      notice: { runId: RUN, toolCallId: "original-tool", error: { code: "RecoveryUncertain" } },
      row: { status: "errored", failure: { code: "RecoveryUncertain" } },
      terminal: { status: "errored" },
    });
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(h.observer).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    expect(h.journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual(nodes);
  });

  it("does not publish or repair cache after a failed business write", () => {
    const h = setup();
    vi.spyOn(h.journal, "updateRunStatus").mockImplementation(() => {
      throw new Error("write failed");
    });
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow("write failed");
    expect(h.observer).not.toHaveBeenCalled();
    expect(h.journal.getRun(RUN)?.status).toBe("stopped");
  });

  it.each([
    { parentSessionId: "foreign" },
    { status: "completed" },
    { stopReason: "superseded", supersededBy: "next" },
  ] as Partial<RunRecord>[])("does not publish for ineligible row %j", (overrides) => {
    const h = setup(overrides);
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow();
    expect(h.observer).not.toHaveBeenCalled();
  });

  it("does not publish for a live owner or a mismatched uncertain node", () => {
    const h = setup();
    h.runs.set(RUN, {
      controller: new AbortController(),
      startedAt: new Date(),
      cwd: "/fixture",
      scriptText: "",
      settlement: new Promise(() => {}),
    });
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow();
    h.runs.clear();
    expect(() =>
      h.lifecycle.reconcileUncertainRecovery(RUN, { ...INSTANCE, ordinal: 9 }),
    ).toThrow();
    expect(h.observer).not.toHaveBeenCalled();
  });

  it("bounds only the safe message and preserves original identity in a strict non-journal observation", () => {
    const build = progressPayload.toHostReconciliationProgress;
    const result = build({
      runId: RUN,
      toolCallId: "original-tool",
      error: { code: "RecoveryUncertain", message: "x".repeat(3000) },
    });
    expect(result).toEqual({
      runId: RUN,
      toolCallId: "original-tool",
      observationSource: "host-reconciliation",
      sequence: 0,
      eventType: "run-settled",
      payload: {
        status: "errored",
        error: { code: "RecoveryUncertain", message: "x".repeat(2048) },
      },
    });
    expect(() =>
      build({ runId: "../unsafe", error: { code: "RecoveryUncertain", message: "unknown" } }),
    ).toThrow();
  });

  it("reports parent/run identity when runtime append is unavailable or rejected", async () => {
    const warn = vi.fn();
    const sessionId = createSessionId("host-parent");
    const progress = { runId: RUN, sequence: 0, eventType: "run-settled", payload: {} };
    createDynamicWorkflowRunProgressSink({
      sessionId,
      logger: { warn } as never,
      getRuntime: () => {
        throw new Error("unavailable");
      },
    })(progress);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        runId: RUN,
        sessionId: "sess_host-parent",
        reason: "runtime_unavailable",
      }),
    );
    warn.mockClear();
    const record = vi.fn(async () => {
      throw new Error("append rejected");
    });
    createDynamicWorkflowRunProgressSink({
      sessionId,
      logger: { warn } as never,
      getRuntime: (() => ({ recordDynamicWorkflowRunProgress: record })) as never,
    })(progress);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          runId: RUN,
          sessionId: "sess_host-parent",
          reason: "append_rejected",
        }),
      ),
    );
    warn.mockClear();
    createDynamicWorkflowRunProgressSink({
      sessionId,
      logger: { warn } as never,
      getRuntime: (() => ({ recordDynamicWorkflowRunProgress: record })) as never,
    })(progress, { parentSessionId: "foreign" });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
