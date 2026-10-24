import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createPartId, createSessionId, parseCompletedToolPartMetadata } from "@zcode/contracts";
import {
  collectSites,
  compileWorkflowScript,
  createWorkflowProgram,
  type RunEvent,
} from "@zcode/dynamic-workflow";

// Synthetic history only: this process never constructs an engine, provider or controller.
const SCRIPT = 'await world.run("E2E_WF5_EFFECT_ONE");\nawait world.run("E2E_WF5_EFFECT_TWO");';

interface SeedInput {
  mode: "seed";
  home: string;
  cliRoot: string;
  sessionId: string;
  controlSessionId: string;
  toolCallId: string;
  inputId: string;
  runId: string;
  providerId: string;
  modelId: string;
}

async function seed(input: SeedInput) {
  assert.equal(input.mode, "seed");
  assert(isAbsolute(input.home));
  assert.equal(basename(input.home), "home");
  const runRoot = dirname(input.home);
  assert(/^wf5-ui-[0-9a-f]{32}$/i.test(basename(runRoot)));
  assert.equal(basename(runRoot), process.env.ZCODE_E2E_RUN_ID);
  const owner = JSON.parse(
    await readFile(resolve(runRoot, "workflow-recovery-owner.json"), "utf8"),
  );
  assert.equal(owner.home, input.home);
  assert.equal(owner.runId, process.env.ZCODE_E2E_RUN_ID);
  assert.equal(await realpath(input.home), resolve(input.home));
  const imports = await Promise.all(
    ["@zcode/adapters/storage", "@zcode/contracts", "@zcode/dynamic-workflow"].map(async (name) => {
      const path = await realpath(fileURLToPath(import.meta.resolve(name)));
      const child = relative(await realpath(input.cliRoot), path);
      assert(
        child && !child.startsWith("..") && !isAbsolute(child),
        "foreign CLI package resolution",
      );
      return {
        name,
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    }),
  );
  const compiled = compileWorkflowScript(SCRIPT);
  assert(compiled.ok, JSON.stringify(compiled.diagnostics));
  const sites = collectSites(createWorkflowProgram(SCRIPT)).worldReads.filter(
    (site) => site.op === "run",
  );
  assert.equal(sites.length, 2);
  const scriptHash = createHash("sha256").update(SCRIPT, "utf8").digest("hex");
  const store = await createSqliteSessionStore({
    dbPath: resolve(input.home, ".zcode/cli/db/db.sqlite"),
  });
  try {
    assert(
      input.sessionId.startsWith("sess_e2e_") && input.controlSessionId.startsWith("sess_e2e_"),
    );
    const parentSessionId = createSessionId(input.sessionId.slice("sess_".length));
    const messages = await store.messages({ sessionID: parentSessionId });
    const user = messages.find((message) => message.info.role === "user");
    const assistant = messages.find((message) => message.info.role === "assistant");
    assert(user && assistant && assistant.info.role === "assistant");
    assert.equal(assistant.info.parentID, user.info.id);
    await store.saveMessage({
      ...user.info,
      anchor: { ...user.info.anchor, sourceCommandId: input.inputId },
    });
    const metadata = parseCompletedToolPartMetadata({
      schemaVersion: 1,
      display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
    });
    assert(metadata);
    const now = Date.now() - 20_000;
    await store.savePart({
      id: createPartId(input.toolCallId),
      messageID: assistant.info.id,
      sessionID: parentSessionId,
      type: "tool",
      tool: "CreateWorkflow",
      callID: input.toolCallId,
      state: {
        status: "completed",
        input: { script: SCRIPT, name: "E2E_WF5_SYNTHETIC_HISTORY" },
        output: "E2E_WF5_SYNTHETIC_HISTORY: never executed; recovery rejection fixture.",
        title: "CreateWorkflow",
        metadata,
        time: { start: now, end: now + 1 },
      },
    });
    assert(store.saveSessionEntry);
    for (const sessionID of [
      parentSessionId,
      createSessionId(input.controlSessionId.slice("sess_".length)),
    ]) {
      await store.saveSessionEntry({
        id: `model_${sessionID}`,
        sessionID,
        type: "runtime/model_selection",
        touchSession: false,
        time: { created: now, updated: now },
        data: { providerId: input.providerId, modelId: input.modelId },
      });
    }
    const journal = store.workflowJournalStore();
    journal.createRun({
      runId: input.runId,
      parentSessionId: input.sessionId,
      cwd: resolve(input.home, "ZCodeProject"),
      name: "E2E_WF5_SYNTHETIC_HISTORY",
      toolCallId: input.toolCallId,
      scriptText: SCRIPT,
      scriptHash,
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "interrupted",
    });
    const events: RunEvent[] = [
      { type: "run-started", runId: input.runId, caps: { maxConcurrency: 1 } },
      {
        type: "run-launched",
        inputId: input.inputId,
        toolCallId: input.toolCallId,
        parentSessionId: input.sessionId,
      },
    ];
    for (const [index, site] of sites.entries()) {
      journal.putNode({
        runId: input.runId,
        siteId: site.id,
        ordinal: 1,
        kind: "world-run",
        inputHash: `synthetic-rejection-only-${index + 1}`,
        status: index === 0 ? "completed" : "running",
        ...(index === 0 ? { result: { marker: "E2E_WF5_COMPLETED_RESULT" } } : {}),
      });
      const instance = { siteId: site.id, ordinal: 1 };
      events.push({ type: "node-queued", instance, kind: "world-run" });
      events.push({ type: "node-dispatched", instance, kind: "world-run" });
      if (index === 0) events.push({ type: "node-settled", instance, outcome: "ok" });
    }
    events.push({ type: "run-settled", status: "stopped", stopReason: "interrupted" });
    for (const event of events) journal.appendEvent(input.runId, event);
    const run = journal.getRun(input.runId);
    assert.equal(run?.scriptText, SCRIPT);
    assert.equal(createHash("sha256").update(run.scriptText, "utf8").digest("hex"), scriptHash);
    return { scriptHash, sites: sites.map((site) => site.id), imports, eventCount: events.length };
  } finally {
    await store.close();
  }
}

process.once("message", (input: SeedInput) => {
  void seed(input).then(
    (result) => process.send?.({ type: "closed", result }, () => process.disconnect()),
    (error: unknown) => {
      process.exitCode = 1;
      process.send?.(
        { type: "failure", message: error instanceof Error ? error.message : String(error) },
        () => process.disconnect(),
      );
    },
  );
});
process.send?.({ type: "listening" });
