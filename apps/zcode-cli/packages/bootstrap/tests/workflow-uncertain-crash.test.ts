import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import type { CrashEvidence, CrashInput } from "./fixtures/workflow-uncertain-crash-process.js";

const EVIDENCE_WAIT_MS = 10_000;
const EXIT_WAIT_MS = 3_000;
const NO_BARRIER_WAIT_MS = 50;

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function start(input: CrashInput): { child: ChildProcess; evidence: Promise<CrashEvidence> } {
  const child = fork(new URL("./fixtures/workflow-uncertain-crash-process.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const evidence = new Promise<CrashEvidence>((resolveEvidence, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      onError(new Error(`child exited before evidence: ${code}/${signal}`));
    };
    const armDeadline = (timeoutMs: number) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => onError(new Error("child evidence deadline exceeded")), timeoutMs);
    };
    const onMessage = (
      message:
        | CrashEvidence
        | { type: "listening" | "parked" }
        | { type: "failure"; message: string },
    ) => {
      if (message.type === "listening") child.send(input);
      else if (message.type === "parked") armDeadline(NO_BARRIER_WAIT_MS);
      else if (message.type === "failure") onError(new Error(message.message));
      else {
        cleanup();
        resolveEvidence(message as CrashEvidence);
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    // Vitest 总超时不会中断此 await；IPC 必须主动拒绝，才能进入 finally 清理。
    armDeadline(EVIDENCE_WAIT_MS);
  });
  return { child, evidence };
}

async function killOwnedChild(child: ChildProcess): Promise<unknown[] | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  return await withDeadline(exited, EXIT_WAIT_MS, "killed child exit");
}

async function cleanupFixture(root: string, children: ChildProcess[]): Promise<void> {
  const exits = await Promise.allSettled(children.map(killOwnedChild));
  const path = relative(resolve(tmpdir()), resolve(root));
  if (!path || path.startsWith("..") || isAbsolute(path))
    throw new Error("unsafe fixture cleanup path");
  await rm(root, { recursive: true, force: true });
  const failures = exits.filter(
    (exit): exit is PromiseRejectedResult => exit.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((exit) => exit.reason),
      "fixture child cleanup failed",
    );
}

it("real SQLite/IPC kill preserves completed cache and refuses uncertain world-run without another driver call", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-wf5-crash-"));
  const children: ChildProcess[] = [];
  try {
    const first = start({ root, mode: "first" });
    children.push(first.child);
    const barrier = await first.evidence;
    expect(barrier.type).toBe("barrier");
    expect(barrier.effects).toEqual(["fixture-effect-one", "fixture-effect-two"]);
    expect(barrier.calls).toEqual(barrier.effects);
    expect(barrier.after.map((node) => [node.siteId, node.kind, node.status])).toEqual([
      ["world#1", "world-run", "completed"],
      ["world#2", "world-run", "running"],
    ]);
    const killed = await killOwnedChild(first.child);
    expect(killed).toEqual([null, "SIGKILL"]);

    // 全新进程、同一私有 SQLite；不在父进程伪造节点，也不推测强杀切点。
    const resumed = start({ root, mode: "resume" });
    children.push(resumed.child);
    const resumedExit = once(resumed.child, "exit");
    const result = await resumed.evidence;
    expect(await withDeadline(resumedExit, EXIT_WAIT_MS, "resumed child exit")).toEqual([0, null]);
    expect(result.type).toBe("result");
    expect(result.pid).not.toBe(barrier.pid);
    expect(result.before).toEqual(barrier.after);
    expect(result.after).toEqual(barrier.after);
    expect(result.effects).toEqual(barrier.effects);
    expect(result.effects.filter((effect) => effect === "fixture-effect-one")).toHaveLength(1);
    expect(result.effects.filter((effect) => effect === "fixture-effect-two")).toHaveLength(1);
    expect(result.calls).toEqual([]);
    expect(result.cachedResult).toEqual({ effect: "fixture-effect-one", exitCode: 0 });
    expect(result.rejectionCode).toBe("RecoveryUncertain");
    expect(result.run).toMatchObject({ status: "errored", failure: { code: "RecoveryUncertain" } });
    expect(result.settlement).toMatchObject({
      status: "errored",
      error: { code: "RecoveryUncertain" },
    });
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "node-settled",
        instance: { siteId: "world#1", ordinal: 1 },
        cached: true,
      }),
    );
    expect(result.events.some((event) => event.type === "node-dispatched")).toBe(false);
    console.info(
      JSON.stringify({
        node: process.version,
        cut: "after-world-two-append-sync-before-driver-return",
        first: { pid: barrier.pid, node: barrier.node, exit: killed, nodes: barrier.after },
        resume: { pid: result.pid, node: result.node, exit: [0, null], nodes: result.after },
        effects: result.effects,
        driverCallsOnResume: result.calls,
        cachedResult: result.cachedResult,
        runStatus: result.run?.status,
        rejectionCode: result.rejectionCode,
      }),
    );
  } finally {
    await cleanupFixture(root, children);
  }
}, 45_000);

it("a private child that withholds barrier rejects locally and finally removes its child and SQLite directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-wf5-crash-"));
  const children: ChildProcess[] = [];
  try {
    const stalled = start({ root, mode: "no-barrier" });
    children.push(stalled.child);
    // parked 确认数据库打开后才启动短 deadline，不以 sleep 猜进程切点。
    await expect(stalled.evidence).rejects.toThrow("child evidence deadline exceeded");
  } finally {
    await cleanupFixture(root, children);
  }
  const child = children[0]!;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  console.info(
    JSON.stringify({
      cleanupCase: "no-barrier",
      pid: child.pid,
      exit: [child.exitCode, child.signalCode],
      directoryRemoved: true,
    }),
  );
}, 15_000);
