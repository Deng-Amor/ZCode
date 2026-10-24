import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fixture from "./e2e/helpers/workflow-recovery-history-fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let privateRoot: string;
let runRoot: string;
let home: string;
const ownerName = "workflow-recovery-owner.json";

beforeEach(async () => {
  privateRoot = await mkdtemp(join(tmpdir(), "wf5-admission-test-"));
  const runId = `wf5-ui-${randomUUID().replaceAll("-", "")}`;
  runRoot = join(privateRoot, runId);
  home = join(runRoot, "home");
  vi.stubEnv("ZCODE_E2E_RUN_ID", runId);
  vi.stubEnv("ZCODE_E2E_HOME_DIR", home);
  vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", join(runRoot, "artifacts"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(privateRoot, { recursive: true, force: true });
});

async function admit() {
  await fixture.admitWorkflowRecoveryHome(home, repoRoot);
}
async function completeReset() {
  await fixture.prepareWorkflowRecoveryReset(home, repoRoot);
  await mkdir(home, { recursive: true });
  await fixture.completeWorkflowRecoveryReset(home, repoRoot);
}

describe("workflow recovery HOME admission", () => {
  it("admits before platform directories and consumes reset/seed only once", async () => {
    await admit();
    await mkdir(join(home, "AppData", "Roaming"), { recursive: true });
    await completeReset();
    const sentinel = join(home, "seed-sentinel");
    await writeFile(sentinel, "keep");
    await fixture.claimWorkflowRecoverySeed(home, repoRoot);
    await expect(fixture.prepareWorkflowRecoveryReset(home, repoRoot)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(fixture.claimWorkflowRecoverySeed(home, repoRoot)).rejects.toMatchObject({
      code: "EEXIST",
    });
    // 重复 seed 必须在任何数据库写入前拒绝，不能依赖末尾 manifest 的 wx。
    await expect(
      fixture.seedWorkflowRecoveryHistory({
        e2eHomeDir: home,
        repoRoot,
        desktopDir: "unused",
        cliEntryPoint: "unused",
        providerId: "unused",
        modelId: "unused",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it("preserves mixed-case HOME for the unchanged seed child contract", async () => {
    runRoot = join(privateRoot, "MiXeD", process.env.ZCODE_E2E_RUN_ID!);
    home = join(runRoot, "home");
    vi.stubEnv("ZCODE_E2E_HOME_DIR", home);
    vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", join(runRoot, "artifacts"));
    await admit();
    const owner = JSON.parse(await readFile(join(runRoot, ownerName), "utf8"));
    const childSource = await readFile(
      join(
        repoRoot,
        "apps/zcode-cli/packages/bootstrap/tests/fixtures/workflow-recovery-desktop-seed.ts",
      ),
      "utf8",
    );
    // 执行 child 的真实边界断言，不启动离线 seed，也不访问数据库。
    const childAssertion = childSource.match(/assert\.equal\(owner\.home, input\.home\);/u)?.[0];
    expect(childAssertion).toBeDefined();
    runInNewContext(childAssertion!, { assert, owner, input: { home } });
    const workerHome = process.platform === "win32" ? home.toLowerCase() : home;
    await fixture.prepareWorkflowRecoveryReset(workerHome, repoRoot);
    await mkdir(home, { recursive: true });
    await fixture.completeWorkflowRecoveryReset(workerHome, repoRoot);
    await fixture.claimWorkflowRecoverySeed(home, repoRoot);
  });

  it("rejects an old HOME without changing its sentinel", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sentinel"), "keep");
    await expect(admit()).rejects.toThrow("new, unused HOME");
    expect(await readFile(join(home, "sentinel"), "utf8")).toBe("keep");
    await expect(lstat(join(runRoot, ownerName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second launcher even while HOME is absent", async () => {
    await admit();
    await expect(admit()).rejects.toMatchObject({ code: "EEXIST" });
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects absent owner and incomplete reset before seed", async () => {
    await expect(fixture.prepareWorkflowRecoveryReset(home, repoRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await admit();
    await expect(fixture.completeWorkflowRecoveryReset(home, repoRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fixture.claimWorkflowRecoverySeed(home, repoRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.prepareWorkflowRecoveryReset(home, repoRoot);
    await expect(fixture.claimWorkflowRecoverySeed(home, repoRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["home", "runRoot", "runId", "artifacts"])(
    "rejects tampered owner %s before reset",
    async (key) => {
      await admit();
      const path = join(runRoot, ownerName);
      const owner = JSON.parse(await readFile(path, "utf8"));
      owner[key] = "tampered";
      await writeFile(path, JSON.stringify(owner));
      await expect(fixture.prepareWorkflowRecoveryReset(home, repoRoot)).rejects.toThrow();
      await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a changed artifact plan", async () => {
    await admit();
    vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", join(privateRoot, "other", "artifacts"));
    await expect(fixture.prepareWorkflowRecoveryReset(home, repoRoot)).rejects.toThrow();
  });

  it("rejects a HOME junction even after admission", async () => {
    await admit();
    const target = join(privateRoot, "junction-target");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "keep");
    await symlink(target, home, process.platform === "win32" ? "junction" : "dir");
    await expect(fixture.prepareWorkflowRecoveryReset(home, repoRoot)).rejects.toThrow(
      "symlink/junction",
    );
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("keep");
  });

  it("rejects the real user HOME and repository as fixture HOME", async () => {
    for (const invalid of [userInfo().homedir, repoRoot]) {
      vi.stubEnv("ZCODE_E2E_HOME_DIR", invalid);
      await expect(fixture.admitWorkflowRecoveryHome(invalid, repoRoot)).rejects.toThrow();
    }
  });

  it("roundtrips real SQLite facts as plain objects without hiding changed values", async () => {
    const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
    await mkdir(dirname(dbPath), { recursive: true });
    const scriptText = 'await world.run("SQLITE_ROUNDTRIP");';
    const scriptHash = createHash("sha256").update(scriptText).digest("hex");
    const manifest = {
      runRoot,
      home,
      runId: "run-roundtrip",
      sessionId: "session-main",
      controlSessionId: "session-control",
    };
    const expected = {
      run: {
        id: manifest.runId,
        status: "cancelled",
        failure_json: '{"stopReason":"interrupted"}',
        script_hash: scriptHash,
        script_text: scriptText,
        spent_tokens: 7,
      },
      nodes: [
        {
          site_id: "first",
          ordinal: 1,
          kind: "world-run",
          status: "completed",
          input_hash: "hash-one",
          result_json: '{"marker":"kept"}',
        },
        {
          site_id: "second",
          ordinal: 2,
          kind: "world-run",
          status: "running",
          input_hash: "hash-two",
          result_json: null,
        },
      ],
      counts: { runs: 1, actors: 1, events: 2, sessions: 2, childSessions: 1 },
    };
    const writable = new DatabaseSync(dbPath);
    try {
      writable.exec(`
        CREATE TABLE dwf_run (id TEXT, parent_session_id TEXT, status TEXT, failure_json TEXT, script_hash TEXT, script_text TEXT, spent_tokens INTEGER);
        CREATE TABLE dwf_node (run_id TEXT, site_id TEXT, ordinal INTEGER, kind TEXT, status TEXT, input_hash TEXT, result_json TEXT);
        CREATE TABLE dwf_actor (run_id TEXT);
        CREATE TABLE dwf_event (run_id TEXT);
        CREATE TABLE session (id TEXT, parent_id TEXT);
      `);
      writable
        .prepare("INSERT INTO dwf_run VALUES (?,?,?,?,?,?,?)")
        .run(
          manifest.runId,
          manifest.sessionId,
          expected.run.status,
          expected.run.failure_json,
          scriptHash,
          scriptText,
          7,
        );
      for (const node of expected.nodes) {
        writable
          .prepare("INSERT INTO dwf_node VALUES (?,?,?,?,?,?,?)")
          .run(
            manifest.runId,
            node.site_id,
            node.ordinal,
            node.kind,
            node.status,
            node.input_hash,
            node.result_json,
          );
      }
      writable.prepare("INSERT INTO dwf_actor VALUES (?)").run(manifest.runId);
      writable.prepare("INSERT INTO dwf_event VALUES (?), (?)").run(manifest.runId, manifest.runId);
      writable
        .prepare("INSERT INTO session VALUES (?,NULL),(?,NULL),(?,?)")
        .run(manifest.sessionId, manifest.controlSessionId, "child-session", manifest.sessionId);
    } finally {
      writable.close();
    }
    const facts = await fixture.inspectWorkflowRecovery(manifest);
    expect(Object.getPrototypeOf(facts.run)).toBe(Object.prototype);
    for (const node of facts.nodes) expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
    assert.deepEqual(facts, expected);
    const baselinePath = join(runRoot, "sqlite-baseline.json");
    await writeFile(baselinePath, JSON.stringify(facts));
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.deepEqual(await fixture.inspectWorkflowRecovery(manifest), baseline);
    // 只在离线测试准备阶段改值；真实 inspect 仍以 readOnly 打开，不放松任何字段比较。
    const changed = new DatabaseSync(dbPath);
    try {
      changed
        .prepare("UPDATE dwf_node SET result_json=? WHERE run_id=? AND site_id=?")
        .run('{"marker":"changed"}', manifest.runId, "first");
    } finally {
      changed.close();
    }
    const after = await fixture.inspectWorkflowRecovery(manifest);
    assert.throws(() => assert.deepEqual(after, baseline));
    assert.equal(after.nodes[0]?.result_json, '{"marker":"changed"}');
  });

  it("validates distinct visible ACK and journal templates for the same unknown instance", () => {
    const input = rejectionFixture();
    fixture.assertWorkflowRecoveryRejection(input.manifest, [input.visible], input.failure);
  });

  it.each([
    "wrong-run",
    "wrong-instance",
    "missing-unknown",
    "missing-verification",
    "missing-refusal",
    "code-only",
    "split-text",
    "journal-as-ack",
    "ack-as-journal",
    "wrong-journal-code",
    "wrong-journal-run",
    "wrong-journal-instance",
    "duplicate-unknown",
    "no-unknown",
  ])("rejects invalid recovery detail: %s", (kind) => {
    const input = rejectionFixture();
    let texts = [input.visible];
    if (kind === "wrong-run") texts = [input.visible.replace("run-expected", "run-other")];
    if (kind === "wrong-instance")
      texts = [input.visible.replace("world-read#2#1", "world-read#3#1")];
    if (kind === "missing-unknown") texts = [input.visible.replace("unknown", "known")];
    if (kind === "missing-verification")
      texts = [input.visible.replace("requires verification", "needs no verification")];
    if (kind === "missing-refusal")
      texts = [input.visible.replace("Recovery was refused to avoid repeating the effect.", "")];
    if (kind === "code-only") texts = [input.code];
    if (kind === "split-text") texts = [input.code, input.ack];
    if (kind === "journal-as-ack") texts = [input.code + input.failure.message];
    if (kind === "ack-as-journal") input.failure.message = input.ack;
    if (kind === "wrong-journal-code") input.failure.code = "OtherError";
    if (kind === "wrong-journal-run")
      input.failure.message = input.failure.message.replace("run-expected", "run-other");
    if (kind === "wrong-journal-instance")
      input.failure.message = input.failure.message.replace("world-read#2:1", "world-read#3:1");
    if (kind === "duplicate-unknown")
      input.manifest.baseline.nodes.push({ ...input.manifest.baseline.nodes[0]! });
    if (kind === "no-unknown") input.manifest.baseline.nodes = [];
    expect(() =>
      fixture.assertWorkflowRecoveryRejection(input.manifest, texts, input.failure),
    ).toThrow(assert.AssertionError);
  });

  it("wires launcher admission before reporter preparation and reset completion before seed", async () => {
    const config = await readFile(join(repoRoot, "packages/desktop/wdio.conf.ts"), "utf8");
    const prepare = config.slice(
      config.indexOf("async onPrepare()"),
      config.indexOf("async beforeSession("),
    );
    expect(prepare.indexOf("await admitWorkflowRecoveryHome(")).toBeGreaterThan(-1);
    expect(prepare.indexOf("await admitWorkflowRecoveryHome(")).toBeLessThan(
      prepare.indexOf("e2eReporter.prepare("),
    );
    const reset = config.slice(
      config.indexOf("async function resetE2EHome("),
      config.indexOf("async function removeE2EHomeWithRetry("),
    );
    expect(reset.indexOf("await completeWorkflowRecoveryReset(")).toBeGreaterThan(
      reset.indexOf("await removeE2EHomeWithRetry("),
    );
    expect(reset.indexOf("await completeWorkflowRecoveryReset(")).toBeLessThan(
      reset.indexOf("await seedWorkflowRecoveryHistory("),
    );
  });
});

function rejectionFixture() {
  const code = "fault.command.workflowRunResumeRejected.recovery_uncertain";
  const ack =
    "Run run-expected, instance world-read#2#1: the external outcome is unknown and requires verification. Recovery was refused to avoid repeating the effect.";
  return {
    code,
    ack,
    visible: `${code} ${ack}`,
    manifest: {
      runId: "run-expected",
      baseline: {
        nodes: [
          {
            site_id: "world-read#2",
            ordinal: 1,
            kind: "world-run",
            status: "running",
            input_hash: "unchanged",
            result_json: null,
          },
        ] as fixture.RecoveryFacts["nodes"],
      },
    },
    failure: {
      code: "RecoveryUncertain",
      message:
        "Run run-expected, instance world-read#2:1 has an unknown external effect result; verify what happened before recovery.",
    },
  };
}
