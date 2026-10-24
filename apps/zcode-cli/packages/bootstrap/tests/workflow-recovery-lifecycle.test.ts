import { describe, expect, it, vi } from "vitest";
import {
  createRecoveryUncertainError,
  InMemoryJournalStore,
  type RunRecord,
  type RunSettlement,
} from "@zcode/dynamic-workflow";
import { createRunServiceLifecycle } from "../src/app/dynamic-workflow-run-lifecycle.js";
import type { RunRegistryEntry } from "../src/app/dynamic-workflow-run-observation.js";
import { reconcileOrphanRuns } from "../src/app/dynamic-workflow-run-reconcile.js";

const RUN = "uncertain-run";
const PARENT = "parent";
const INSTANCE = { siteId: "world#2", ordinal: 1 };

function setup(overrides: Partial<RunRecord> = {}) {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: RUN,
    parentSessionId: PARENT,
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
    inputHash: "hash",
  });
  journal.putNode({
    runId: RUN,
    siteId: "world#1",
    ordinal: 1,
    kind: "world-run",
    status: "completed",
    inputHash: "hash",
    result: "kept",
  });
  const runs = new Map<string, RunRegistryEntry>();
  const lifecycle = createRunServiceLifecycle({ journal, runs, parentSessionId: PARENT });
  const notify = vi.fn();
  lifecycle.subscribeRunSettled(notify);
  const update = vi.spyOn(journal, "updateRunStatus");
  const listNodes = vi.spyOn(journal, "listNodes");
  const append = vi.spyOn(journal, "appendEvent");
  return { journal, runs, lifecycle, notify, update, listNodes, append };
}

async function stoppedEntry(h: ReturnType<typeof setup>) {
  const stopped: RunSettlement = { status: "stopped", reason: "interrupted" };
  const entry: RunRegistryEntry = {
    controller: new AbortController(),
    startedAt: new Date(0),
    cwd: "/fixture",
    scriptText: "",
    settlement: Promise.resolve(stopped),
  };
  h.runs.set(RUN, entry);
  entry.settlement = h.lifecycle.trackSettlement(RUN, entry, Promise.resolve(stopped));
  await entry.settlement;
  h.notify.mockClear();
  return entry;
}

describe("WF5 recovery lifecycle", () => {
  it("persists before repairing terminal and future settlement, then notifies without engine events", async () => {
    const h = setup();
    const entry = await stoppedEntry(h);
    const oldPromise = entry.settlement;
    const nodes = h.journal.listNodes(RUN, { kinds: "all", withResult: true });
    const observed: unknown[] = [];
    h.lifecycle.subscribeRunSettled(() =>
      observed.push({
        record: h.journal.getRun(RUN),
        terminal: entry.terminal,
        promiseChanged: entry.settlement !== oldPromise,
      }),
    );
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(h.journal.getRun(RUN)).toMatchObject({
      status: "errored",
      failure: { code: "RecoveryUncertain" },
    });
    expect(h.journal.getRun(RUN)?.stopReason).toBeUndefined();
    expect(h.journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual(nodes);
    await expect(oldPromise).resolves.toMatchObject({ status: "stopped" });
    await expect(entry.settlement).resolves.toBe(entry.terminal);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      {
        record: expect.objectContaining({
          status: "errored",
          failure: expect.objectContaining({ code: "RecoveryUncertain" }),
        }),
        terminal: expect.objectContaining({
          status: "errored",
          error: expect.objectContaining({ code: "RecoveryUncertain" }),
        }),
        promiseChanged: true,
      },
    ]);
    const completedAt = entry.completedAt;
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(entry.completedAt).toBe(completedAt);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not fabricate an entry and repeats without writes or notices", () => {
    const h = setup({ status: "pending" });
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(h.journal.getRun(RUN)?.status).toBe("errored");
    expect(h.runs.size).toBe(0);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("repairs a stale stopped cache without rewriting an already uncertain journal", async () => {
    const h = setup({
      status: "errored",
      failure: createRecoveryUncertainError(RUN, INSTANCE).toJSON(),
    });
    const entry = await stoppedEntry(h);
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(entry.terminal).toMatchObject({
      status: "errored",
      error: { code: "RecoveryUncertain" },
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("propagates a database failure without changing cache, promise, timestamp or notices and can retry", async () => {
    const h = setup();
    const entry = await stoppedEntry(h);
    const before = {
      terminal: entry.terminal,
      settlement: entry.settlement,
      completedAt: entry.completedAt,
    };
    const failure = new Error("fixture database unavailable");
    h.update.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow(failure);
    expect(entry.terminal).toBe(before.terminal);
    expect(entry.settlement).toBe(before.settlement);
    expect(entry.completedAt).toBe(before.completedAt);
    expect(h.journal.getRun(RUN)?.status).toBe("stopped");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE);
    expect(entry.terminal?.status).toBe("errored");
  });

  it.each([
    { parentSessionId: "foreign" },
    { status: "completed" as const, result: "kept" },
    { status: "errored" as const, failure: { code: "DriverError" as const, message: "other" } },
    { stopReason: "superseded" as const, supersededBy: "successor" },
  ])("rejects ineligible record %j before reading nodes or writing", (record) => {
    const h = setup(record);
    const before = h.journal.getRun(RUN);
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow(
      "owned, inactive, eligible run",
    );
    expect(h.journal.getRun(RUN)).toEqual(before);
    expect(h.listNodes).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("rejects a live registry even if the journal is stopped", () => {
    const h = setup();
    h.runs.set(RUN, {
      controller: new AbortController(),
      startedAt: new Date(),
      cwd: "/fixture",
      scriptText: "",
      settlement: new Promise(() => {}),
    });
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow(
      "owned, inactive, eligible run",
    );
    expect(h.listNodes).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("rechecks the node identity instead of trusting the caller", () => {
    const h = setup();
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, { ...INSTANCE, ordinal: 2 })).toThrow(
      "matching uncertain world-run",
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("rejects a node that has completed since preflight", () => {
    const h = setup();
    h.journal.putNode({
      runId: RUN,
      ...INSTANCE,
      kind: "world-run",
      status: "completed",
      inputHash: "hash",
      result: "done",
    });
    expect(() => h.lifecycle.reconcileUncertainRecovery(RUN, INSTANCE)).toThrow(
      "matching uncertain world-run",
    );
    expect(h.update).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("keeps constructor write failures within the warning boundary", () => {
    const h = setup({ status: "running" });
    const journal = Object.assign(h.journal, {
      listNonTerminalRuns: () => [h.journal.getRun(RUN)!],
    });
    const warn = vi.fn();
    h.update.mockImplementationOnce(() => {
      throw new Error("fixture database unavailable");
    });
    expect(() =>
      reconcileOrphanRuns({
        journal,
        parentSessionId: PARENT,
        reconcileUncertainRecovery: h.lifecycle.reconcileUncertainRecovery,
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "Dynamic workflow orphan run reconciliation failed",
      expect.objectContaining({
        event: "dynamic_workflow.run.reconcile_failed",
        runId: RUN,
      }),
    );
    expect(h.journal.getRun(RUN)?.status).toBe("running");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("converges uncertain orphans through the lifecycle owner and preserves ordinary interruption", () => {
    const h = setup({ status: "running" });
    h.journal.createRun({
      runId: "safe",
      parentSessionId: PARENT,
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "running",
    });
    h.journal.createRun({
      runId: "foreign",
      parentSessionId: "other",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "running",
    });
    const journal = Object.assign(h.journal, {
      listNonTerminalRuns: () => [
        h.journal.getRun(RUN)!,
        h.journal.getRun("safe")!,
        h.journal.getRun("foreign")!,
      ],
    });
    reconcileOrphanRuns({
      journal,
      parentSessionId: PARENT,
      reconcileUncertainRecovery: h.lifecycle.reconcileUncertainRecovery,
    });
    expect(h.journal.getRun(RUN)?.failure?.code).toBe("RecoveryUncertain");
    expect(h.journal.getRun("safe")).toMatchObject({
      status: "stopped",
      failure: { code: "Interrupted" },
    });
    expect(h.journal.getRun("foreign")?.status).toBe("running");
    expect(h.append).not.toHaveBeenCalled();
  });
});
