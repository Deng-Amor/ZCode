import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";
import { resolveE2EWorkerChromiumProfileDir } from "./e2e-worker-isolation.js";

export const RECOVERY_PENDING_SPEC =
  "test/e2e/conversation-session/manual-review/pending/conversation-session-workflow-recovery-uncertain.test.ts";
const MANIFEST = "workflow-recovery-seed.json";
const originalHomes = [process.env.HOME, process.env.USERPROFILE, userInfo().homedir].filter(
  (value): value is string => Boolean(value),
);
const normalized = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function matchesWorkflowRecoverySpec(specs: string[], desktopDir: string): boolean {
  const target = normalized(resolve(desktopDir, RECOVERY_PENDING_SPEC));
  return specs.some(
    (spec) =>
      normalized(resolve(desktopDir, spec.startsWith("file:") ? fileURLToPath(spec) : spec)) ===
      target,
  );
}

export function recoveryChildPath(root: string, path: string): string {
  const absolute = resolve(path);
  const child = relative(resolve(root), absolute);
  assert(
    child && !child.startsWith("..") && !isAbsolute(child),
    "recovery fixture path escaped private root",
  );
  return absolute;
}

// 检查每个现存祖先，不能只检查最后一级：junction 可把私有目录重定向到真实用户数据。
export async function assertRecoveryPath(root: string, path: string): Promise<string> {
  const absolute = recoveryChildPath(root, path);
  let cursor = absolute;
  while (true) {
    try {
      const info = await lstat(cursor);
      assert(!info.isSymbolicLink(), "recovery fixture rejects symlink/junction paths");
      assert.equal(
        normalized(await realpath(cursor)),
        normalized(cursor),
        "recovery fixture real path mismatch",
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

export interface RecoverySeedManifest {
  version: 1;
  seedCount: 1;
  runRoot: string;
  home: string;
  runId: string;
  sessionId: string;
  controlSessionId: string;
  toolCallId: string;
  inputId: string;
  pendingSpec: string;
  invocationId: string;
  seed: { scriptHash: string; sites: string[]; imports: unknown[]; eventCount: number };
  baseline: RecoveryFacts;
}

/** WDIO already owns a separate run/worker-specific Chromium profile, not the database HOME. */
export async function assertWorkflowRecoveryProfile(path: string): Promise<string> {
  const runId = process.env.ZCODE_E2E_RUN_ID;
  const workerId = process.env.ZCODE_E2E_WORKER_ID;
  assert(runId && /^wf5-ui-[0-9a-f]{32}$/i.test(runId) && workerId);
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const root = resolve(desktop, ".e2e-cache", runId, "chromium-profiles");
  const expected = resolveE2EWorkerChromiumProfileDir(root, workerId);
  assert.equal(normalized(path), normalized(expected), "unexpected Chromium profile owner");
  return await assertRecoveryPath(root, path);
}

export async function validateWorkflowRecoveryHome(
  home: string,
  repoRoot: string,
): Promise<string> {
  assert(
    process.env.ZCODE_E2E_HOME_DIR && isAbsolute(process.env.ZCODE_E2E_HOME_DIR),
    "explicit absolute E2E HOME required",
  );
  assert.equal(normalized(home), normalized(process.env.ZCODE_E2E_HOME_DIR));
  const runId = process.env.ZCODE_E2E_RUN_ID;
  assert(
    runId && /^wf5-ui-[0-9a-f]{32}$/i.test(runId),
    "P2 requires a fresh wf5-ui-UUID runner identity",
  );
  // HOME 不是允许根的来源。已审 runner 独立配置 artifact 目录；本轮命令将它固定在
  // 会话 handoff/e2e-runs 下。这里只接受同一 run 的 artifacts/home 精确兄弟布局。
  const configuredArtifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
  assert(
    configuredArtifacts && isAbsolute(configuredArtifacts),
    "explicit absolute artifact plan required",
  );
  const artifacts = resolve(configuredArtifacts);
  assert.equal(basename(artifacts), "artifacts", "unexpected artifact plan directory");
  const runRoot = dirname(artifacts);
  assert.equal(basename(runRoot), runId, "artifact plan run identity mismatch");
  assert.equal(
    normalized(home),
    normalized(resolve(runRoot, "home")),
    "HOME outside independently configured artifact plan",
  );
  assert.notEqual(normalized(home), normalized(repoRoot));
  for (const original of originalHomes) {
    // worker may inherit the runner's private HOME; OS userInfo still identifies the real home.
    if (
      normalized(original) !== normalized(process.env.ZCODE_E2E_HOME_DIR) ||
      normalized(original) === normalized(userInfo().homedir)
    ) {
      assert.notEqual(normalized(home), normalized(original), "real user HOME is forbidden");
    }
  }
  assert(
    !normalized(runRoot).startsWith(`${normalized(repoRoot)}\\`) &&
      !normalized(runRoot).startsWith(`${normalized(repoRoot)}/`),
  );
  await assertRecoveryPath(dirname(runRoot), home);
  await assertRecoveryPath(dirname(runRoot), artifacts);
  return runRoot;
}

const OWNER = "workflow-recovery-owner.json";
const RESET_CLAIM = "workflow-recovery-reset-claim.json";
const RESET_COMPLETE = "workflow-recovery-reset-complete.json";
const SEED_CLAIM = "workflow-recovery-seed-claim.json";

function recoveryOwner(home: string, runRoot: string) {
  return {
    home,
    runRoot: normalized(runRoot),
    runId: process.env.ZCODE_E2E_RUN_ID,
    artifacts: normalized(resolve(runRoot, "artifacts")),
  };
}

async function readRecoveryOwner(home: string, repoRoot: string) {
  const root = await validateWorkflowRecoveryHome(home, repoRoot);
  const expected = recoveryOwner(home, root);
  const path = await assertRecoveryPath(root, resolve(root, OWNER));
  const owner = JSON.parse(await readFile(path, "utf8")) as ReturnType<typeof recoveryOwner>;
  // 修复原因：CLI child 精确核验原始 HOME；落盘保留大小写，读取时才按平台规范化比较。
  assert.deepEqual(
    { ...owner, home: normalized(owner.home) },
    { ...expected, home: normalized(expected.home) },
    "recovery owner mismatch",
  );
  return { root, owner };
}

/** Launcher admission precedes tools that may create platform directories inside HOME. */
export async function admitWorkflowRecoveryHome(home: string, repoRoot: string): Promise<void> {
  const root = await validateWorkflowRecoveryHome(home, repoRoot);
  await assert.rejects(lstat(home), { code: "ENOENT" }, "P2 requires a new, unused HOME");
  await mkdir(root, { recursive: true });
  const path = await assertRecoveryPath(root, resolve(root, OWNER));
  await writeFile(path, JSON.stringify(recoveryOwner(home, root)), {
    encoding: "utf8",
    flag: "wx",
  });
}

/** Called before reset's first deletion; retries/reloads cannot acquire this claim again. */
export async function prepareWorkflowRecoveryReset(home: string, repoRoot: string): Promise<void> {
  // 修复原因：launcher 的平台准备可能先创建 HOME/AppData；新目录检查必须在 launcher
  // 认领时完成，worker 只接受该 owner，并在删除前以 wx 消费一次性 reset 权利。
  const { root, owner } = await readRecoveryOwner(home, repoRoot);
  const path = await assertRecoveryPath(root, resolve(root, RESET_CLAIM));
  await writeFile(path, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
}

export async function completeWorkflowRecoveryReset(home: string, repoRoot: string): Promise<void> {
  const { root, owner } = await readRecoveryOwner(home, repoRoot);
  const claim = await assertRecoveryPath(root, resolve(root, RESET_CLAIM));
  assert.deepEqual(JSON.parse(await readFile(claim, "utf8")), owner);
  assert((await lstat(home)).isDirectory(), "reset must create the admitted HOME");
  const path = await assertRecoveryPath(root, resolve(root, RESET_COMPLETE));
  await writeFile(path, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
}

export async function claimWorkflowRecoverySeed(home: string, repoRoot: string): Promise<string> {
  const { root, owner } = await readRecoveryOwner(home, repoRoot);
  const completed = await assertRecoveryPath(root, resolve(root, RESET_COMPLETE));
  assert.deepEqual(JSON.parse(await readFile(completed, "utf8")), owner);
  // 修复原因：manifest 在 DB 写入之后才落盘；必须先独占 seed，防止重复调用先改库再失败。
  const path = await assertRecoveryPath(root, resolve(root, SEED_CLAIM));
  await writeFile(path, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
  return root;
}

export async function seedWorkflowRecoveryHistory(options: {
  e2eHomeDir: string;
  repoRoot: string;
  desktopDir: string;
  cliEntryPoint: string;
  providerId: string;
  modelId: string;
}): Promise<void> {
  const runRoot = await claimWorkflowRecoverySeed(options.e2eHomeDir, options.repoRoot);
  const id = randomUUID().replaceAll("-", "");
  const identity = {
    sessionId: `sess_e2e_wf5_${id}`,
    controlSessionId: `sess_e2e_control_${id}`,
    runId: `dwfrun-e2e-${id}`,
    toolCallId: `call_e2e_${id}`,
    inputId: randomUUID(),
  };
  const workspacePath = await assertRecoveryPath(
    runRoot,
    resolve(options.e2eHomeDir, "ZCodeProject"),
  );
  await mkdir(workspacePath, { recursive: true });
  for (const sessionId of [identity.sessionId, identity.controlSessionId]) {
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint: options.cliEntryPoint,
      e2eHomeDir: options.e2eHomeDir,
      workspacePath,
      history: {
        sessionId,
        title: sessionId === identity.sessionId ? "E2E_WF5_RECOVERY" : "E2E_WF5_CONTROL",
        userText: "E2E_WF5_SYNTHETIC_HISTORY",
        assistantText: "E2E_WF5_HISTORY_ONLY_NO_EXECUTION",
        assistantInputTokens: 0,
        assistantOutputTokens: 0,
        modelId: options.modelId,
        runtimeProviderId: options.providerId,
        taskProviderId: "glm",
      },
    });
  }
  const cliRoot = resolve(options.repoRoot, "apps/zcode-cli");
  const seed = await runSeedChild({
    mode: "seed",
    home: options.e2eHomeDir,
    cliRoot,
    ...identity,
    providerId: options.providerId,
    modelId: options.modelId,
  });
  const manifest = {
    version: 1 as const,
    seedCount: 1 as const,
    runRoot,
    home: options.e2eHomeDir,
    ...identity,
    pendingSpec: normalized(resolve(options.desktopDir, RECOVERY_PENDING_SPEC)),
    invocationId: id,
    seed,
  };
  const baseline = await inspectWorkflowRecovery(manifest);
  // journal 的逻辑 stopped 用 cancelled + stopReason 信封存储，不能手猜数据库列。
  assert.equal(baseline.run.status, "cancelled");
  assert.equal(JSON.parse(baseline.run.failure_json ?? "{}").stopReason, "interrupted");
  assert.equal(baseline.nodes.length, 2);
  await writeFile(resolve(runRoot, MANIFEST), JSON.stringify({ ...manifest, baseline }, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
}

async function runSeedChild(input: {
  cliRoot: string;
  home: string;
  [key: string]: unknown;
}): Promise<RecoverySeedManifest["seed"]> {
  const require = createRequire(resolve(input.cliRoot, "packages/bootstrap/package.json"));
  const child = fork(
    resolve(input.cliRoot, "packages/bootstrap/tests/fixtures/workflow-recovery-desktop-seed.ts"),
    {
      cwd: input.cliRoot,
      execArgv: ["--import", pathToFileURL(require.resolve("tsx")).href],
      env: {
        ...process.env,
        HOME: input.home,
        USERPROFILE: input.home,
        ZCODE_DATA_BASE_DIR: input.home,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  // Drain stderr without persisting arbitrary dependency diagnostics or secrets.
  child.stderr?.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? done() : fail(new Error(`P2 seed exit ${code}`))));
  });
  void exited.catch(() => {});
  try {
    const barrier = new Promise<RecoverySeedManifest["seed"]>((done, fail) => {
      child.once("error", fail);
      child.on(
        "message",
        (message: { type?: string; result?: RecoverySeedManifest["seed"]; message?: string }) => {
          if (message.type === "listening") child.send(input);
          else if (message.type === "closed" && message.result) done(message.result);
          else if (message.type === "failure") fail(new Error(message.message));
        },
      );
      child.once("exit", () => fail(new Error("seed exited before close barrier")));
    });
    return await Promise.race([
      barrier.then(async (result) => {
        await exited;
        return result;
      }),
      new Promise<never>((_done, fail) => {
        timer = setTimeout(() => fail(new Error("P2 seed deadline")), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited.catch(() => {}),
        new Promise<never>((_done, fail) => {
          timer = setTimeout(() => fail(new Error("owned seed child failed to exit")), 5_000);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    child.removeAllListeners();
  }
}

export async function readRecoveryManifest(home: string): Promise<RecoverySeedManifest> {
  const runRoot = dirname(resolve(home));
  await assertRecoveryPath(runRoot, home);
  const manifest = JSON.parse(
    await readFile(resolve(runRoot, MANIFEST), "utf8"),
  ) as RecoverySeedManifest;
  assert.equal(manifest.home, home);
  assert.equal(manifest.runRoot, runRoot);
  assert.equal(manifest.seedCount, 1);
  assert.equal(manifest.version, 1);
  return manifest;
}

export interface RecoveryFacts {
  run: {
    id: string;
    status: string;
    failure_json: string | null;
    script_hash: string;
    script_text: string;
    spent_tokens: number;
  };
  nodes: Array<{
    site_id: string;
    ordinal: number;
    kind: string;
    status: string;
    input_hash: string;
    result_json: string | null;
  }>;
  counts: { runs: number; actors: number; events: number; sessions: number; childSessions: number };
}

/** The visible command diagnostic and persisted failure have distinct, strict contracts. */
export function assertWorkflowRecoveryRejection(
  manifest: { runId: string; baseline: Pick<RecoveryFacts, "nodes"> },
  visibleTexts: string[],
  failure: { code?: unknown; message?: unknown },
): void {
  const unknown = manifest.baseline.nodes.filter(
    (node) => node.kind === "world-run" && node.status === "running",
  );
  assert.equal(unknown.length, 1, "P2 baseline requires exactly one unknown world instance");
  const instance = unknown[0]!;
  const code = "fault.command.workflowRunResumeRejected.recovery_uncertain";
  const ackDetail = `Run ${manifest.runId}, instance ${instance.site_id}#${instance.ordinal}: the external outcome is unknown and requires verification. Recovery was refused to avoid repeating the effect.`;
  // 修复原因：命令 ACK 与持久 failure 分属不同正文合同，必须分别严格核验同一身份，不能互换。
  assert(
    visibleTexts.some((text) => text.includes(code) && text.includes(ackDetail)),
    "visible rejection must include the same run/instance and complete command safety detail",
  );
  assert.equal(failure.code, "RecoveryUncertain");
  assert.equal(
    failure.message,
    `Run ${manifest.runId}, instance ${instance.site_id}:${instance.ordinal} has an unknown external effect result; verify what happened before recovery.`,
    "journal failure must match the same run/instance and complete recovery detail",
  );
}

/** Online inspection never opens the migrator/store factory or changes journal state. */
export async function inspectWorkflowRecovery(
  manifest: Pick<
    RecoverySeedManifest,
    "runRoot" | "home" | "runId" | "sessionId" | "controlSessionId"
  >,
): Promise<RecoveryFacts> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readRecoveryFactsOnce(manifest);
    } catch (error) {
      // 并发只读切面遇锁时有界重试；其它读失败必须保留，绝不改为可写 opener。
      const busy =
        error instanceof Error &&
        "errcode" in error &&
        (error.errcode === 5 || error.errcode === 6);
      if (!busy || attempt >= 3) throw error;
      await delay(100);
    }
  }
}

async function readRecoveryFactsOnce(
  manifest: Pick<
    RecoverySeedManifest,
    "runRoot" | "home" | "runId" | "sessionId" | "controlSessionId"
  >,
): Promise<RecoveryFacts> {
  const path = await assertRecoveryPath(
    manifest.runRoot,
    resolve(manifest.home, ".zcode/cli/db/db.sqlite"),
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const run = db
      .prepare(
        "SELECT id,status,failure_json,script_hash,script_text,spent_tokens FROM dwf_run WHERE id=? AND parent_session_id=?",
      )
      .get(manifest.runId, manifest.sessionId) as RecoveryFacts["run"] | undefined;
    assert(run, "missing private recovery run");
    assert.equal(
      createHash("sha256").update(run.script_text, "utf8").digest("hex"),
      run.script_hash,
    );
    const nodes = db
      .prepare(
        "SELECT site_id,ordinal,kind,status,input_hash,result_json FROM dwf_node WHERE run_id=? ORDER BY site_id,ordinal",
      )
      .all(manifest.runId) as RecoveryFacts["nodes"];
    const count = (sql: string, ...params: string[]) =>
      Number(db.prepare(sql).get(...params)?.total);
    const counts = {
      runs: count(
        "SELECT count(*) AS total FROM dwf_run WHERE parent_session_id=?",
        manifest.sessionId,
      ),
      actors: count("SELECT count(*) AS total FROM dwf_actor WHERE run_id=?", manifest.runId),
      events: count("SELECT count(*) AS total FROM dwf_event WHERE run_id=?", manifest.runId),
      sessions: count(
        "SELECT count(*) AS total FROM session WHERE id IN (?,?)",
        manifest.sessionId,
        manifest.controlSessionId,
      ),
      childSessions: count(
        "SELECT count(*) AS total FROM session WHERE parent_id IN (?,?)",
        manifest.sessionId,
        manifest.controlSessionId,
      ),
    };
    db.exec("COMMIT");
    // 修复原因：SQLite 行是 null prototype，JSON baseline 是普通对象；只复制原型，保留全部字段和值。
    return { run: { ...run }, nodes: nodes.map((node) => ({ ...node })), counts };
  } finally {
    db.close();
  }
}
