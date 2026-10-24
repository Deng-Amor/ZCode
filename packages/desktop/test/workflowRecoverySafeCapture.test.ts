import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createE2EReporter } from "./e2e/reporting/e2e-reporting.js";
import { describe, expect, it } from "vitest";
import { writeE2EJsonFileAtomically } from "./e2e/helpers/e2e-atomic-json-file.js";
import { runMeasuredE2ELifecyclePhase } from "./e2e/helpers/e2e-lifecycle-measurement.js";
import type { E2ELifecycleEvent } from "./e2e/reporting/e2e-reporting-types.js";
import {
  createWorkflowRecoverySafeCapture,
  createWorkflowRecoveryProof,
  createWorkflowRecoverySafeError,
  resolveWorkflowRecoverySafeCapture,
} from "./e2e/helpers/workflow-recovery-safe-capture.js";

const sentinel = `SYNTHETIC_WF4_PRIVATE_SENTINEL_${randomUUID()}`;
const target =
  "test/e2e/conversation-session/manual-review/pending/conversation-session-workflow-recovery-exhausted.test.ts";
const desktopDir = resolve("packages/desktop");
const admission = {
  desktopDir,
  specs: [target],
  optIn: "1",
  mode: "replay",
  toolsearchProxy: false,
  codingPlanProxy: false,
};

describe("WF4 measurement owner", () => {
  async function withMeasurement(
    enabled: boolean,
    check: (fixture: {
      dir: string;
      lifecyclePath: string;
      capture: ReturnType<typeof createWorkflowRecoverySafeCapture>;
      events: E2ELifecycleEvent[];
      recorderErrors: unknown[];
      sandbox: vm.Context;
    }) => Promise<void>,
  ) {
    const dir = await mkdtemp(resolve(tmpdir(), "wf4-measurement-"));
    const envKeys = ["ZCODE_E2E_ARTIFACT_DIR", "ZCODE_E2E_RUN_ID", "ZCODE_E2E_COVERAGE"];
    const saved = envKeys.map((key) => process.env[key]);
    process.env.ZCODE_E2E_ARTIFACT_DIR = dir;
    process.env.ZCODE_E2E_RUN_ID = "wf4-measurement";
    process.env.ZCODE_E2E_COVERAGE = "0";
    try {
      const reporter = createE2EReporter({
        repoRoot: dir,
        desktopDir: dir,
        requestedSpecs: [target],
        containerE2E: false,
      });
      const source = await readFile(resolve(desktopDir, "wdio.conf.ts"), "utf8");
      const tree = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
      let measurement = "";
      let afterSession = "";
      const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "measureE2ELifecyclePhase")
          measurement = node.getText(tree);
        if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "afterSession")
          afterSession = node.getText(tree);
        ts.forEachChild(node, visit);
      };
      visit(tree);
      const capture = createWorkflowRecoverySafeCapture();
      const events: E2ELifecycleEvent[] = [];
      const recorderErrors: unknown[] = [];
      const sandbox = vm.createContext({
        runMeasuredE2ELifecyclePhase,
        wf4SafeCaptureEnabled: enabled,
        wf4SafeCapture: capture,
        createWorkflowRecoverySafeError,
        e2eReporter: {
          recordLifecycleEvent(event: E2ELifecycleEvent) {
            events.push(event);
            try {
              reporter.recordLifecycleEvent(event);
            } catch (error) {
              recorderErrors.push(error);
              throw error;
            }
          },
        },
        // 仅替换外部进程清理；measurement、recorder、粘性状态与证明仍执行真实实现。
        stopUpstreamE2EHttp: async () => {},
        cleanupE2EElectronProcesses: async () => {},
        stopRequestSecurityFixture: async () => {},
        stopModelContextBudgetConfigE2EMock: async () => {},
        stopDynamicWorkflowConfigE2EMock: async () => {},
        stopOAuthCompletionRaceFixture: null,
        stopWebRemoteControlAuthGateFixture: null,
        stopAccessToken401Fixture: null,
        currentE2EWorkerSessionSpecs: [target],
        currentE2EChromiumUserDataDir: null,
        currentE2EElectronAppPid: null,
        currentE2EBeforeSessionError: null,
        e2eFailureArtifacts: null,
        process: { exitCode: undefined },
      });
      vm.runInContext(
        ts.transpileModule(
          `${measurement}\nglobalThis.measure = measureE2ELifecyclePhase;\nglobalThis.afterSession = ${afterSession.replace(/^async afterSession/, "async function")}`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        sandbox,
      );
      await check({
        dir,
        lifecyclePath: resolve(dir, "lifecycle-events.ndjson"),
        capture,
        events,
        recorderErrors,
        sandbox,
      });
    } finally {
      envKeys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("preserves a successful value and passed lifecycle without failing capture", async () => {
    await withMeasurement(true, async ({ sandbox, capture, events, lifecyclePath }) => {
      const value = { result: "synthetic" };
      let calls = 0;
      await expect(
        sandbox.measure("after", {}, () => {
          calls++;
          return value;
        }),
      ).resolves.toBe(value);
      expect(calls).toBe(1);
      expect(events[0].status).toBe("passed");
      expect(JSON.parse(await readFile(lifecyclePath, "utf8")).status).toBe("passed");
      expect(() => capture.assertHealthy()).not.toThrow();
    });
  });

  it("sanitizes callback rejection before actual lifecycle persistence", async () => {
    await withMeasurement(true, async ({ sandbox, capture, lifecyclePath }) => {
      const original = Object.assign(new Error(sentinel, { cause: sentinel }), {
        privateData: sentinel,
      });
      const error = await sandbox
        .measure("after", {}, async () => {
          throw original;
        })
        .catch((value: unknown) => value);
      expect(error).not.toBe(original);
      expect(error.message).toBe("WF4_SAFE_CAPTURE_FAILED");
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("privateData");
      const raw = await readFile(lifecyclePath, "utf8");
      expect(raw).not.toContain(sentinel);
      expect(JSON.parse(raw)).toMatchObject({ status: "failed", error: "WF4_SAFE_CAPTURE_FAILED" });
      expect(() => capture.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
    });
  });

  it("owns actual recorder IO rejection and keeps failure after recording recovers", async () => {
    await withMeasurement(true, async ({ sandbox, capture, lifecyclePath, recorderErrors }) => {
      await mkdir(lifecyclePath);
      await expect(sandbox.measure("after", {}, async () => "done")).rejects.toThrow(
        "WF4_SAFE_CAPTURE_FAILED",
      );
      expect(recorderErrors).toHaveLength(1);
      expect(() => capture.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
      await rmdir(lifecyclePath);
      await expect(sandbox.measure("complete", {}, async () => "recovered")).resolves.toBe(
        "recovered",
      );
      expect(JSON.parse(await readFile(lifecyclePath, "utf8")).status).toBe("passed");
      expect(() => capture.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
    });
  });

  it("keeps callback data fixed before a second recorder failure", async () => {
    await withMeasurement(
      true,
      async ({ sandbox, capture, lifecyclePath, events, recorderErrors }) => {
        await mkdir(lifecyclePath);
        await expect(
          sandbox.measure("after", {}, async () => {
            throw new Error(sentinel);
          }),
        ).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
        expect(events[0]).toMatchObject({ status: "failed", error: "WF4_SAFE_CAPTURE_FAILED" });
        expect(JSON.stringify(events)).not.toContain(sentinel);
        expect(recorderErrors).toHaveLength(1);
        expect(() => capture.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
      },
    );
  });

  it.each([new Error("synthetic original"), ""])(
    "preserves off-mode callback identity: %s",
    async (original) => {
      await withMeasurement(false, async ({ sandbox, capture, lifecyclePath }) => {
        await expect(
          sandbox.measure("after", {}, async () => {
            throw original;
          }),
        ).rejects.toBe(original);
        expect(JSON.parse(await readFile(lifecyclePath, "utf8"))).toMatchObject({
          status: "failed",
          error: original instanceof Error ? original.message : original,
        });
        expect(() => capture.assertHealthy()).not.toThrow();
      });
    },
  );

  it("preserves the actual off-mode recorder rejection object", async () => {
    await withMeasurement(false, async ({ sandbox, capture, lifecyclePath, recorderErrors }) => {
      await mkdir(lifecyclePath);
      const error = await sandbox
        .measure("after", {}, async () => {})
        .catch((value: unknown) => value);
      expect(recorderErrors).toHaveLength(1);
      expect(error).toBe(recorderErrors[0]);
      expect(() => capture.assertHealthy()).not.toThrow();
    });
  });

  it.each([false, true])(
    "publishes actual afterSession proof after transient fault=%s",
    async (fault) => {
      await withMeasurement(true, async ({ sandbox, dir, lifecyclePath, events }) => {
        const binding = { artifactDir: dir, runId: "measurement-proof", ownerId: randomUUID() };
        const launcher = createWorkflowRecoveryProof(binding);
        await launcher.initialize();
        sandbox.wf4Proof = createWorkflowRecoveryProof(binding);
        await sandbox.wf4Proof.claim();
        if (fault) await mkdir(lifecyclePath);
        await sandbox.measure("after", {}, async () => {}).catch(() => {});
        if (fault) await rmdir(lifecyclePath);
        if (fault) await expect(sandbox.afterSession()).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
        else await sandbox.afterSession();
        expect(events.map((event) => event.phase)).toEqual(["after", "after-session"]);
        expect(
          JSON.parse((await readFile(lifecyclePath, "utf8")).trim().split("\n").at(-1)!),
        ).toMatchObject({ phase: "after-session", status: "passed" });
        expect(
          JSON.parse(await readFile(resolve(dir, "wf4-safe-capture-owner/state.json"), "utf8")),
        ).toMatchObject({
          state: fault ? "failed" : "healthy",
          code: fault ? "WF4_FAILED" : "WF4_HEALTHY",
        });
        if (fault)
          await expect(launcher.assertHealthy()).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
        else await expect(launcher.assertHealthy()).resolves.toBeUndefined();
      });
    },
  );
});

function artifact(fixtureId?: string, status = "pending") {
  return {
    version: 1,
    proxy: { secret: sentinel },
    records: [
      {
        id: "7bcb05f4-bc34-434a-a363-d8a75699bc1e",
        status,
        startedAt: "2026-10-21T00:00:00.000Z",
        completedAt: sentinel,
        statusCode: 503,
        replay: { fixtureId },
        requestJson: { system: sentinel, messages: [{ role: "user", content: sentinel }] },
        requestHeaders: { unknown: sentinel },
        url: `https://example.invalid/?${sentinel}`,
        requestTextPreview: sentinel,
        responseTextPreview: sentinel,
        responseChunkTimeline: [{ text: sentinel }],
        error: new Error(sentinel),
      },
    ],
  };
}

describe("WF4 safe capture", () => {
  it.each([
    "healthy",
    "late-failure",
    "missing",
    "pending",
    "corrupt",
    "wrong-run",
    "wrong-owner",
    "io-failure",
    "linked",
  ])("requires a matching final proof despite zero worker exit: %s", async (scenario) => {
    const dir = await mkdtemp(resolve(tmpdir(), "wf4-proof-"));
    const binding = {
      artifactDir: resolve(dir, "artifact"),
      runId: "synthetic-run",
      ownerId: randomUUID(),
    };
    let proof = createWorkflowRecoveryProof(binding);
    try {
      if (scenario !== "missing") await proof.initialize();
      if (!["missing", "pending", "corrupt"].includes(scenario)) {
        const worker = createWorkflowRecoveryProof(
          binding,
          scenario === "io-failure"
            ? async () => {
                throw new Error(sentinel);
              }
            : undefined,
        );
        await worker.claim();
        if (scenario === "late-failure") {
          const source = await readFile(resolve(desktopDir, "wdio.conf.ts"), "utf8");
          const tree = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
          let method = "";
          const visit = (node: ts.Node) => {
            if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "afterSession")
              method = node.getText(tree);
            ts.forEachChild(node, visit);
          };
          visit(tree);
          let cleaned = false;
          const sandbox = vm.createContext({
            wf4SafeCaptureEnabled: true,
            wf4SafeCapture: createWorkflowRecoverySafeCapture(async () => {}),
            wf4Proof: worker,
            stopUpstreamE2EHttp: async () => {
              throw new Error(sentinel);
            },
            createWorkflowRecoverySafeError: () => new Error("WF4_SAFE_CAPTURE_FAILED"),
            currentE2EWorkerSessionSpecs: [target],
            process: { exitCode: undefined },
            measureE2ELifecyclePhase: async () => {
              cleaned = true;
            },
          });
          vm.runInContext(
            ts.transpileModule(
              `globalThis.run = ${method.replace(/^async afterSession/, "async function")}`,
              { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
            ).outputText,
            sandbox,
          );
          await expect(sandbox.run()).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
          expect(cleaned).toBe(true);
          expect(sandbox.process.exitCode).toBe(1);
        } else
          await worker.finish(true).catch((error: Error) => {
            expect(scenario).toBe("io-failure");
            expect(error.message).toBe("WF4_SAFE_CAPTURE_FAILED");
          });
      }
      const statePath = resolve(binding.artifactDir, "wf4-safe-capture-owner/state.json");
      if (scenario === "corrupt") await writeFile(statePath, sentinel);
      if (scenario === "linked") await link(statePath, resolve(dir, "state-hardlink.json"));
      if (scenario === "wrong-run")
        proof = createWorkflowRecoveryProof({ ...binding, runId: "other-run" });
      if (scenario === "wrong-owner")
        proof = createWorkflowRecoveryProof({ ...binding, ownerId: randomUUID() });
      if (scenario === "late-failure") {
        // 通过公开 ESM 入口定位依赖上下文，兼容 hoist 与包内链接两种布局。
        const { stdout: localRunnerEntry } = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "process.stdout.write(import.meta.resolve('@wdio/local-runner'))",
          ],
          { timeout: 10000, cwd: desktopDir },
        );
        const child = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      const {executeHooksWithArgs} = await import('@wdio/utils');
      const {gracefulExit} = await import('exit-hook');
      await executeHooksWithArgs('afterSession', [async () => {
        process.exitCode = 1; throw new Error('WF4_SAFE_CAPTURE_FAILED');
      }], []);
      console.log('HOOK_RESOLVED_WITH_EXIT_CODE_' + process.exitCode);
      gracefulExit(0);
    `,
          ],
          { timeout: 10000, cwd: dirname(fileURLToPath(localRunnerEntry.trim())) },
        );
        expect(child.stdout).toContain("HOOK_RESOLVED_WITH_EXIT_CODE_1");
      }
      // execFile 已成功返回，证明实际 gracefulExit(0) 覆盖了 hook 设置的退出码。
      const source = await readFile(resolve(desktopDir, "wdio.conf.ts"), "utf8");
      const tree = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
      let method = "";
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "onComplete")
          method = node.getText(tree);
        ts.forEachChild(node, visit);
      };
      visit(tree);
      const exits: number[] = [];
      const sandbox = vm.createContext({
        wf4SafeCaptureEnabled: true,
        wf4SafeCapture: createWorkflowRecoverySafeCapture(async () => {}),
        wf4Proof: proof,
        createWorkflowRecoverySafeError: () => new Error("WF4_SAFE_CAPTURE_FAILED"),
        e2eRunnerFinalizationGuard: { disarm() {} },
        configuredE2ESpecs: [target],
        measureE2ELifecyclePhase: async () => {},
        e2eReporter: {
          writeSummary(code: number) {
            exits.push(code);
          },
        },
        armE2ERunnerExitWatchdog(code: number) {
          exits.push(code);
        },
        process: { env: {} },
      });
      vm.runInContext(
        ts.transpileModule(
          `globalThis.run = ${method.replace(/^async onComplete/, "async function")}`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        sandbox,
      );
      const error = await sandbox.run(0).catch((value: Error) => value);
      expect(exits).toEqual(scenario === "healthy" ? [0, 0] : [1, 1]);
      if (scenario !== "healthy") expect(error.message).toBe("WF4_SAFE_CAPTURE_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects reused proof roots, second owners and terminal rewrites", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wf4-owner-"));
    const binding = { artifactDir: dir, runId: "synthetic-run", ownerId: randomUUID() };
    try {
      const launcher = createWorkflowRecoveryProof(binding);
      await launcher.initialize();
      await expect(createWorkflowRecoveryProof(binding).initialize()).rejects.toThrow(
        "WF4_SAFE_CAPTURE_FAILED",
      );
      const worker = createWorkflowRecoveryProof(binding);
      await worker.claim();
      await expect(createWorkflowRecoveryProof(binding).claim()).rejects.toThrow(
        "WF4_SAFE_CAPTURE_FAILED",
      );
      await worker.finish(false);
      await expect(worker.finish(true)).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
      await expect(launcher.assertHealthy()).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("actual afterTest projects sentinel before the custom reporter consumer writes results and summary", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wf4-reporter-"));
    const savedArtifact = process.env.ZCODE_E2E_ARTIFACT_DIR;
    const savedRunId = process.env.ZCODE_E2E_RUN_ID;
    process.env.ZCODE_E2E_ARTIFACT_DIR = dir;
    process.env.ZCODE_E2E_RUN_ID = "wf4-synthetic";
    try {
      const reporter = createE2EReporter({
        repoRoot: dir,
        desktopDir: dir,
        requestedSpecs: [target],
        containerE2E: false,
      });
      const source = await readFile(resolve(desktopDir, "wdio.conf.ts"), "utf8");
      const tree = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
      let method = "";
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "afterTest")
          method = node.getText(tree);
        ts.forEachChild(node, visit);
      };
      visit(tree);
      const sandbox = vm.createContext({
        wf4SafeCaptureEnabled: true,
        wf4SafeCapture: createWorkflowRecoverySafeCapture(async () => {}),
        wf4ResolvedSpecs: [target],
        e2eReporter: reporter,
        createWorkflowRecoverySafeError: () => new Error("WF4_SAFE_CAPTURE_FAILED"),
        process: { exitCode: undefined },
      });
      vm.runInContext(
        ts.transpileModule(
          `globalThis.run = ${method.replace(/^async afterTest/, "async function")}`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        sandbox,
      );
      await sandbox.run(
        { title: sentinel, fullTitle: sentinel, file: sentinel },
        {},
        {
          passed: false,
          duration: 1,
          error: new Error(sentinel, { cause: { row: sentinel, dom: sentinel } }),
        },
      );
      reporter.recordLifecycleEvent({
        phase: "complete",
        specs: [target],
        startedAt: "2026-10-21T00:00:00.000Z",
        completedAt: "2026-10-21T00:00:00.001Z",
        durationMs: 1,
        status: "failed",
        error: "WF4_SAFE_CAPTURE_FAILED",
      });
      reporter.writeSummary(1);
      const paths = await readdir(dir, { recursive: true, withFileTypes: true });
      const files = paths.filter((entry) => entry.isFile());
      expect(files.some((entry) => entry.name === "summary.json")).toBe(true);
      for (const entry of files) {
        const value = await readFile(resolve(entry.parentPath, entry.name), "utf8");
        expect(value.includes(sentinel)).toBe(false);
      }
    } finally {
      if (savedArtifact === undefined) delete process.env.ZCODE_E2E_ARTIFACT_DIR;
      else process.env.ZCODE_E2E_ARTIFACT_DIR = savedArtifact;
      if (savedRunId === undefined) delete process.env.ZCODE_E2E_RUN_ID;
      else process.env.ZCODE_E2E_RUN_ID = savedRunId;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["write", "rename", "remove"])(
    "sanitizes atomic %s failure before returning and keeps sticky failure",
    async (stage) => {
      const writes: string[] = [];
      const owner = createWorkflowRecoverySafeCapture((path, value) =>
        writeE2EJsonFileAtomically(path, value, {
          mkdir() {},
          async wait() {},
          write(_path, text) {
            writes.push(text);
            if (stage === "write") throw new Error(sentinel);
          },
          rename() {
            throw new Error(sentinel);
          },
          remove() {
            if (stage === "remove") throw new Error(sentinel);
          },
        }),
      );
      await expect(owner.artifactWriter("synthetic.json", artifact())).rejects.toThrow(
        "WF4_SAFE_CAPTURE_FAILED",
      );
      expect(writes.every((text) => !text.includes(sentinel))).toBe(true);
      expect(() => owner.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
    },
  );
  it("actual WDIO finalization writes failure summary and watchdog after late shutdown failure", async () => {
    const source = await readFile(resolve(desktopDir, "wdio.conf.ts"), "utf8");
    const tree = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
    let method = "";
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "onComplete")
        method = node.getText(tree);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(method.length > 0).toBe(true);
    const exits: number[] = [];
    const sandbox = vm.createContext({
      wf4SafeCaptureEnabled: true,
      wf4SafeCapture: createWorkflowRecoverySafeCapture(async () => {}),
      createWorkflowRecoverySafeError: () => new Error("WF4_SAFE_CAPTURE_FAILED"),
      e2eRunnerFinalizationGuard: { disarm() {} },
      configuredE2ESpecs: [target],
      measureE2ELifecyclePhase: async (
        _phase: string,
        _context: unknown,
        run: () => Promise<void>,
      ) => run(),
      stopUpstreamE2EHttp: async () => {
        throw new Error(sentinel);
      },
      cleanupE2EElectronProcesses: async () => {},
      cleanupE2EDirectory: async () => {},
      E2E_HOME_DIR: "synthetic-home",
      E2E_RUN_CACHE_DIR: "synthetic-cache",
      e2eReporter: {
        writeSummary(code: number) {
          exits.push(code);
        },
      },
      armE2ERunnerExitWatchdog(code: number) {
        exits.push(code);
      },
      process: { env: {}, exitCode: undefined },
      console,
    });
    vm.runInContext(
      ts.transpileModule(
        `globalThis.run = ${method.replace(/^async onComplete/, "async function")}`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      sandbox,
    );
    const error = await sandbox.run(0).catch((value: Error) => value);
    expect(exits).toEqual([1, 1]);
    expect(error.message).toBe("WF4_SAFE_CAPTURE_FAILED");
    expect(sandbox.process.exitCode).toBe(1);
  });
  it("admits only the exact opted-in single spec", () => {
    expect(resolveWorkflowRecoverySafeCapture(admission)).toBe("enabled");
    expect(
      resolveWorkflowRecoverySafeCapture({
        ...admission,
        specs: [pathToFileURL(resolve(desktopDir, target)).href],
      }),
    ).toBe("enabled");
    expect(
      resolveWorkflowRecoverySafeCapture({ ...admission, specs: [target.replaceAll("/", "\\")] }),
    ).toBe("enabled");
    expect(
      resolveWorkflowRecoverySafeCapture({
        ...admission,
        specs: ["other.test.ts"],
        optIn: undefined,
      }),
    ).toBe("off");
    for (const changed of [
      { optIn: undefined },
      { optIn: "0" },
      { specs: [target, "other.test.ts"] },
      { specs: ["elsewhere/" + target] },
      { mode: "capture" },
      { toolsearchProxy: true },
      { codingPlanProxy: true },
      { specs: ["**/*.test.ts"] },
    ])
      expect(() => resolveWorkflowRecoverySafeCapture({ ...admission, ...changed })).toThrow(
        "WF4_SAFE_CAPTURE_ADMISSION_FAILED",
      );
  });

  it("projects pending and matched records before every atomic tmp write", async () => {
    const writes: string[] = [];
    const owner = createWorkflowRecoverySafeCapture(async (path, value) => {
      await writeE2EJsonFileAtomically(path, value, {
        mkdir() {},
        remove() {},
        rename() {},
        async wait() {},
        write(_path, content) {
          writes.push(content);
        },
      });
    });
    await owner.artifactWriter("synthetic.json", { records: [] });
    await owner.artifactWriter("synthetic.json", artifact());
    await owner.artifactWriter("synthetic.json", artifact("actor-a-fault", "complete"));
    await owner.artifactWriter("synthetic.json", artifact(sentinel, "complete"));
    expect(writes.every((value) => !value.includes(sentinel))).toBe(true);
    expect(JSON.parse(writes[1]!)).toEqual({
      schemaVersion: 1,
      records: [
        {
          ordinal: 1,
          id: "7bcb05f4-bc34-434a-a363-d8a75699bc1e",
          fixtureId: "unclassified",
          actor: "unknown",
          state: "pending",
          httpStatus: 503,
          startedAt: "2026-10-21T00:00:00.000Z",
        },
      ],
    });
    expect(JSON.parse(writes[2]!).records[0]).toMatchObject({
      fixtureId: "actor-a-fault",
      actor: "A",
      state: "complete",
    });
    expect(JSON.parse(writes[3]!).records[0]).toMatchObject({
      fixtureId: "unclassified",
      actor: "unknown",
      state: "unmatched",
    });
    owner.assertHealthy();
  });

  it("keeps failed state after a later successful write and discards original error fields", async () => {
    let fail = true;
    const owner = createWorkflowRecoverySafeCapture(async () => {
      if (fail) throw new Error(sentinel, { cause: { value: sentinel } });
    });
    const error = await owner
      .artifactWriter("synthetic.json", artifact())
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("WF4_SAFE_CAPTURE_FAILED");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack?.includes(sentinel)).toBe(false);
    fail = false;
    await owner.artifactWriter("synthetic.json", artifact());
    expect(() => owner.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
  });

  it("rejects invalid required structure and handles external failure without reset", async () => {
    const output: unknown[] = [];
    const owner = createWorkflowRecoverySafeCapture(async (_path, value) => {
      output.push(value);
    });
    await expect(
      owner.artifactWriter("synthetic.json", { records: [{ id: sentinel }] }),
    ).rejects.toThrow("WF4_SAFE_CAPTURE_FAILED");
    expect(output).toEqual([]);
    expect(() => owner.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
    const other = createWorkflowRecoverySafeCapture(async () => {});
    other.markFailed();
    expect(() => other.assertHealthy()).toThrow("WF4_SAFE_CAPTURE_FAILED");
  });
});
