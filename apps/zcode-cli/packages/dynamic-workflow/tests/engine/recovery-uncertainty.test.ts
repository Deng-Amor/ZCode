import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  type NodeRecord,
  type WorldReadOp,
} from "../../src/engine/index.js";
import { FakeDriver } from "./fake-driver.js";

const RUN = "recovery-run";
const ARGS = ["fixture-command"];

function setup() {
  const journal = new InMemoryJournalStore();
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map(),
    validate: () => [],
  });
  return { journal, driver, engine };
}

function node(siteId: string, status: NodeRecord["status"], op: WorldReadOp = "run"): NodeRecord {
  return {
    runId: RUN,
    siteId,
    ordinal: 1,
    kind: op === "run" ? "world-run" : "world-read",
    inputHash: inputHash({ op, args: ARGS }),
    status,
    ...(status === "completed" ? { result: "cached" } : {}),
    ...(status === "failed"
      ? { error: { code: "DriverError" as const, message: "cached failure" } }
      : {}),
  };
}

describe("recovery uncertainty", () => {
  it("exports a pure finder with lexical site and numeric ordinal ordering", () => {
    const nodes = Object.freeze([
      Object.freeze({ ...node("a", "running", "grep"), ordinal: 0 }),
      Object.freeze(node("a", "completed")),
      Object.freeze(node("a", "failed")),
      Object.freeze(node("z", "running")),
      Object.freeze({ ...node("b", "running"), ordinal: 10 }),
      Object.freeze({ ...node("b", "running"), ordinal: 2 }),
    ]);
    expect(publicApi.findUncertainWorldRun(nodes)).toEqual({ siteId: "b", ordinal: 2 });
    expect(publicApi.findUncertainWorldRun([...nodes].reverse())).toEqual({
      siteId: "b",
      ordinal: 2,
    });
    expect(publicApi.findUncertainWorldRun(nodes.slice(0, 3))).toBeUndefined();
    expect(publicApi.findUncertainWorldRun([])).toBeUndefined();
  });

  it("exports a stable error carrying only run and instance identification", () => {
    const error = publicApi.createRecoveryUncertainError(RUN, { siteId: "world#2", ordinal: 3 });
    expect(error.toJSON()).toEqual({ code: "RecoveryUncertain", message: error.message });
    expect(error.message).toContain(RUN);
    expect(error.message).toContain("world#2");
    expect(error.message).toContain("3");
    expect(error.message).not.toContain(ARGS[0]);
  });

  it("preserves completed cache and uncertain row, fails the run, and blocks effects after catch", async () => {
    const { journal, driver, engine } = setup();
    const completed = node("world#1", "completed");
    const uncertain = node("world#2", "running");
    journal.putNode(completed);
    journal.putNode(uncertain);
    await expect(engine.worldRead("world#1", "run", ARGS)).resolves.toBe("cached");
    const pending = engine.worldRead("world#2", "run", ARGS);
    // 旧实现会派发效果；主动完成假执行，确保 RED 是行为差异而不是测试超时。
    driver.worldReads[0]?.deferred.resolve("replayed");
    await expect(pending).rejects.toMatchObject({ code: "RecoveryUncertain" });
    await expect(engine.worldRead("world#3", "run", ARGS)).rejects.toMatchObject({
      code: "RecoveryUncertain",
    });
    expect(driver.worldReads).toHaveLength(0);
    expect(journal.getRun(RUN)).toMatchObject({
      status: "errored",
      failure: { code: "RecoveryUncertain" },
    });
    expect(journal.getNode(RUN, "world#1", 1)).toEqual(completed);
    expect(journal.getNode(RUN, "world#2", 1)).toEqual(uncertain);
    expect(journal.getNode(RUN, "world#3", 1)).toBeUndefined();
    await engine.settled;
  });

  it.each(["grep", "run"] as const)("executes %s when safe", async (op) => {
    const { journal, driver, engine } = setup();
    if (op === "grep") journal.putNode(node("world", "running", op));
    const pending = engine.worldRead("world", op, ARGS);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]!.deferred.resolve("live");
    await expect(pending).resolves.toBe("live");
    expect(journal.getNode(RUN, "world", 1)).toMatchObject({ status: "completed", result: "live" });
    engine.stop("user");
    await engine.settled;
  });

  it("replays failed cache without execution", async () => {
    const { journal, driver, engine } = setup();
    journal.putNode(node("world", "failed"));
    await expect(engine.worldRead("world", "run", ARGS)).rejects.toMatchObject({
      code: "DriverError",
      message: "cached failure",
    });
    expect(driver.worldReads).toHaveLength(0);
    engine.stop("user");
    await engine.settled;
  });

  it("checks input hash before uncertainty", async () => {
    const { journal, driver, engine } = setup();
    const uncertain = node("world", "running");
    journal.putNode(uncertain);
    await expect(engine.worldRead("world", "run", ["changed"])).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    expect(driver.worldReads).toHaveLength(0);
    expect(journal.getNode(RUN, "world", 1)).toEqual(uncertain);
    await engine.settled;
  });
});
