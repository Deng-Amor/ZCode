import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  WorkflowEngine,
  type NodeRecord,
  type RunEvent,
  type RunRecord,
  type RunSettlement,
  type WorkflowDriver,
} from "@zcode/dynamic-workflow";

export interface CrashInput {
  root: string;
  mode: "first" | "resume" | "no-barrier";
}
export interface CrashEvidence {
  type: "barrier" | "result";
  node: string;
  pid: number;
  before: NodeRecord[];
  after: NodeRecord[];
  effects: string[];
  calls: string[];
  events: RunEvent[];
  run: RunRecord | undefined;
  settlement?: RunSettlement;
  rejectionCode?: string;
  cachedResult?: unknown;
}

const RUN_ID = "run-wf5-private";
const SCRIPT = 'await world.run("fixture-effect-one"); await world.run("fixture-effect-two");';
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("hex");
const FIRST = "fixture-effect-one";
const SECOND = "fixture-effect-two";

async function send(message: object): Promise<void> {
  await new Promise<void>((resolveSend, reject) => {
    if (!process.send) return reject(new Error("fixture requires IPC"));
    process.send(message, (error) => (error ? reject(error) : resolveSend()));
  });
}

function within(root: string, leaf: string): string {
  assert(isAbsolute(root));
  const path = resolve(root, leaf);
  const child = relative(root, path);
  assert(child && !child.startsWith("..") && !isAbsolute(child), "fixture path escaped root");
  return path;
}

async function run(input: CrashInput): Promise<void> {
  const effectPath = within(input.root, "effects.jsonl");
  const store = await createSqliteSessionStore({ dbPath: within(input.root, "session.sqlite") });
  try {
    if (input.mode === "no-barrier") {
      // 清理回归：真实 SQLite 已打开，此后故意不发 barrier/result，由父进程 deadline 拒绝。
      await send({ type: "parked" });
      await new Promise<never>(() => {
        process.on("message", () => {});
      });
    }
    const journal = store.workflowJournalStore();
    const before = journal.listNodes(RUN_ID, { kinds: "all", withResult: true });
    const events: RunEvent[] = [];
    const calls: string[] = [];
    const effects = async () =>
      (await readFile(effectPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
    const unreachable = (): never => {
      throw new Error("unexpected actor/model call");
    };
    const driver: WorkflowDriver = {
      journal,
      emit: (event) => events.push(event),
      createActorSession: unreachable,
      startAsk: unreachable,
      respondToSubmit: unreachable,
      cancelAsk: unreachable,
      async executeWorldRead(op, args) {
        assert.equal(op, "run");
        assert.equal(args.length, 1);
        const effect = String(args[0]);
        calls.push(effect);
        const file = await open(effectPath, "a");
        try {
          await file.write(`${JSON.stringify(effect)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        if (input.mode === "first" && effect === SECOND) {
          // 真效果已 sync、running 节点已落盘，而 driver 尚未返回，父进程在此精确强杀。
          await send({
            type: "barrier",
            node: process.version,
            pid: process.pid,
            before,
            after: journal.listNodes(RUN_ID, { kinds: "all", withResult: true }),
            effects: await effects(),
            calls,
            events,
            run: journal.getRun(RUN_ID),
          } satisfies CrashEvidence);
          await new Promise<never>(() => {
            process.on("message", () => {});
          });
        }
        return { effect, exitCode: 0 };
      },
    };
    const engine = new WorkflowEngine({
      runId: RUN_ID,
      driver,
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      validate: () => [],
      scriptText: SCRIPT,
      scriptHash: SCRIPT_HASH,
      parentSessionId: "session-wf5-private",
      cwd: within(input.root, "workspace"),
    });
    const cachedResult = await engine.worldRead("world#1", "run", [FIRST]);
    let rejectionCode: string | undefined;
    try {
      await engine.worldRead("world#2", "run", [SECOND]);
      throw new Error("uncertain world-run unexpectedly returned");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      rejectionCode = String(error.code);
    }
    assert.equal(input.mode, "resume");
    const settlement = await engine.settled;
    await send({
      type: "result",
      node: process.version,
      pid: process.pid,
      before,
      after: journal.listNodes(RUN_ID, { kinds: "all", withResult: true }),
      effects: await effects(),
      calls,
      events,
      run: journal.getRun(RUN_ID),
      settlement,
      rejectionCode,
      cachedResult,
    } satisfies CrashEvidence);
  } finally {
    store.close();
  }
}

process.once("message", (input: CrashInput) => {
  void run(input)
    .catch(async (error: unknown) => {
      await send({
        type: "failure",
        message: error instanceof Error ? error.stack : String(error),
      });
      process.exitCode = 1;
    })
    .finally(() => process.disconnect());
});
await send({ type: "listening" });
