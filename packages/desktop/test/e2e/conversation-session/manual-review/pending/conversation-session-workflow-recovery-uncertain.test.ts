import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_SESSION_PANE,
  TID_WORKSPACE_PATH,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  probeWorkspaceAppState,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  openGeneralSettings,
  selectDynamicWorkflowMode,
} from "../../../helpers/dynamic-workflow-gray.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../../../helpers/e2e-electron-reload.js";
import { prepareV4ConversationE2E, selectV4TaskById } from "../../../helpers/v4-conversation.js";
import {
  assertRecoveryPath,
  assertWorkflowRecoveryRejection,
  assertWorkflowRecoveryProfile,
  inspectWorkflowRecovery,
  readRecoveryManifest,
  type RecoveryFacts,
  type RecoverySeedManifest,
} from "../../../helpers/workflow-recovery-history-fixture.js";

interface LifecycleRow {
  event: string;
  subscriptionId?: string;
  topic?: string;
  sessionId?: string;
  line: string;
}
interface RejectionObserver {
  texts: string[];
  observer: MutationObserver;
}
type ObservationWindow = Window & { __wf5RejectionObservation?: RejectionObserver };
const TIMEOUT = 45_000;

describe("E2E1-P2: synthetic history through real Desktop recovery rejection", () => {
  it("rejects hot, unsubscribes/re-subscribes, then cold-reads the same journal", async function () {
    this.timeout(240_000);
    const home = process.env.ZCODE_E2E_HOME_DIR;
    assert(home, "missing explicit private HOME");
    const manifest = await readRecoveryManifest(home);
    const evidence: Record<string, unknown> = {
      kind: "synthetic-history",
      seedCount: manifest.seedCount,
      invocationId: manifest.invocationId,
    };
    try {
      await enterHistoryWorkspace("initialStartup", evidence);
      await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
      // 产品设置只控制展示入口；不会构造授权或改变 Resume 的真实命令链。
      await openGeneralSettings();
      await selectDynamicWorkflowMode("alwaysOn");
      await $('[data-testid="settings-back-button"]').click();
      await selectV4TaskById(manifest.sessionId);
      const processBefore = await processIdentity();
      await assertWorkflowRecoveryProfile(processBefore.userData);
      assert.equal(resolve(processBefore.home), resolve(home));
      const logRoot = await assertRecoveryPath(manifest.runRoot, processBefore.logRoot);
      const firstSubscription = await waitForSubscription(logRoot, manifest.sessionId);
      evidence.firstSubscription = firstSubscription;
      evidence.processBefore = processBefore;
      await openRun(manifest, "stopped");
      const before = await inspectWorkflowRecovery(manifest);
      assert.deepEqual(before, manifest.baseline);
      assert.equal(before.counts.runs, 1);
      assert.equal(before.counts.actors, 0);
      assert.equal(before.counts.childSessions, 0);
      assert.equal(before.nodes[0]?.status, "completed");
      assert.equal(before.nodes[1]?.status, "running");
      assert.equal(before.nodes[1]?.result_json, null);
      assert.equal(
        JSON.parse(before.nodes[0]?.result_json ?? "null").marker,
        "E2E_WF5_COMPLETED_RESULT",
      );
      await assertNoProviderRequests(manifest);

      // 只读 DOM observer 捕捉被权威终态更新迅速清除的可见拒绝，不延长产品提示生命周期。
      await browser.execute(() => {
        const target = window as ObservationWindow;
        const texts: string[] = [];
        const capture = () => {
          for (const node of document.querySelectorAll<HTMLElement>(
            '[data-testid="workflow-run-rejection"]',
          )) {
            if (node.getClientRects().length && node.textContent?.trim())
              texts.push(node.textContent.trim());
          }
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        target.__wf5RejectionObservation = { texts, observer };
      });
      const resume = $('[data-testid="workflow-run-resume"]');
      await resume.waitForClickable({ timeout: TIMEOUT });
      await resume.click();
      let rejection: string[] = [];
      await browser.waitUntil(
        async () => {
          rejection = await browser.execute(
            () => (window as ObservationWindow).__wf5RejectionObservation?.texts ?? [],
          );
          return rejection.some((text) =>
            text.includes("fault.command.workflowRunResumeRejected.recovery_uncertain"),
          );
        },
        {
          timeout: TIMEOUT,
          timeoutMsg: "real Resume rejection was not visible; no synthetic ACK fallback",
        },
      );
      evidence.hotRejection = rejection;
      const hot = await waitForRejectedFacts(manifest);
      assertConserved(manifest, hot);
      const failure = JSON.parse(hot.run.failure_json ?? "{}");
      assertWorkflowRecoveryRejection(manifest, rejection, failure);
      await assertErroredPane(manifest, failure.message);
      await browser.saveScreenshot(resolve(manifest.runRoot, "hot-rejection.png"));
      evidence.hot = hot;

      // 独立记录三层证据：冷读成功不能抵消重订阅失败。
      const resubscribeStart = await lifecycleRows(logRoot, manifest.sessionId);
      let resubscribeError: unknown;
      try {
        await closeRunPaneTabs();
        await selectV4TaskById(manifest.controlSessionId);
        let released: LifecycleRow[] = [];
        await browser.waitUntil(
          async () => {
            released = (await lifecycleRows(logRoot, manifest.sessionId)).filter(
              (row) => !resubscribeStart.some((old) => old.line === row.line),
            );
            return (
              released.some((row) => row.event === "v4.session_data.keep_warm_expired") &&
              released.some(
                (row) =>
                  row.event === "v4.conversation.unsubscribe.completed" &&
                  row.subscriptionId === firstSubscription.subscriptionId,
              )
            );
          },
          { timeout: TIMEOUT, timeoutMsg: "parent lease was not really released/unsubscribed" },
        );
        evidence.unsubscription = released;
        await selectV4TaskById(manifest.sessionId);
        const nextSubscription = await waitForSubscription(
          logRoot,
          manifest.sessionId,
          firstSubscription.subscriptionId,
        );
        evidence.nextSubscription = nextSubscription;
        assert.equal((await processIdentity()).pid, processBefore.pid);
        await openRun(manifest, "errored");
        await assertErroredPane(manifest, failure.message);
        assertConserved(manifest, await inspectWorkflowRecovery(manifest));
        await browser.saveScreenshot(resolve(manifest.runRoot, "resubscribed.png"));
      } catch (error) {
        resubscribeError = error;
        evidence.resubscribeFailure = error instanceof Error ? error.message : String(error);
      }

      let exited = false;
      const userDataAfter = await reloadElectronSessionPreservingBrowserProfile(browser, {
        afterElectronProcessExit: async () => {
          exited = true;
          assertConserved(manifest, await inspectWorkflowRecovery(manifest));
          assert.deepEqual(await readRecoveryManifest(home), manifest);
        },
      });
      assert(exited, "old process tree exit barrier did not run");
      await enterHistoryWorkspace("coldStartup", evidence);
      const processAfter = await processIdentity();
      assert.notEqual(processAfter.pid, processBefore.pid);
      assert.equal(processAfter.home, processBefore.home);
      assert.equal(processAfter.userData, processBefore.userData);
      assert.equal(userDataAfter, processBefore.userData);
      assert.deepEqual(await readRecoveryManifest(home), manifest);
      await selectV4TaskById(manifest.sessionId);
      await openRun(manifest, "errored");
      await assertErroredPane(manifest, failure.message);
      const cold = await inspectWorkflowRecovery(manifest);
      assertConserved(manifest, cold);
      evidence.cold = { processAfter, oldProcessTreeExited: exited, facts: cold, seedCount: 1 };
      await browser.saveScreenshot(resolve(manifest.runRoot, "cold.png"));
      await assertNoProviderRequests(manifest);
      if (resubscribeError) throw resubscribeError;
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await browser
        .execute(() => {
          const target = window as ObservationWindow;
          target.__wf5RejectionObservation?.observer.disconnect();
          delete target.__wf5RejectionObservation;
        })
        .catch(() => {});
      await writeFile(
        resolve(manifest.runRoot, "workflow-recovery-evidence.json"),
        JSON.stringify(evidence, null, 2),
        "utf8",
      );
      // Electron/Host/CLI/provider replay are owned and finalized by WDIO, including failed specs.
      // Do not clearAppData: the restart assertion must retain the exact original journal.
    }
  });
});

/** 普通历史/未知效果拒绝仅走产品原生入口；每个新进程都重新观察，不写登录 latch/凭据。 */
async function enterHistoryWorkspace(phase: string, evidence: Record<string, unknown>) {
  const observation = { entry: "waiting", clicked: false, workspaceReady: false };
  evidence[phase] = observation;
  const startup = $('section[aria-labelledby="ccode-startup-login-title"]');
  await browser.waitUntil(
    async () => {
      if (await startup.isDisplayed()) {
        observation.entry = "native-startup";
        return true;
      }
      const state = await browser.execute(probeWorkspaceAppState, {
        workspacePathTestId: TID_WORKSPACE_PATH,
        workspaceItemTestId: "virtual-project-row",
        sessionPanePrefix: TID_V4_SESSION_PANE,
        composerWorkspaceTriggerTestId: TID_COMPOSER_WORKSPACE_TRIGGER,
        expectedPath: DEFAULT_WORKSPACE,
      });
      if (state !== "ready" && state !== "onboarding") return false;
      observation.entry = state === "ready" ? "workspace-already-ready" : "native-onboarding";
      return true;
    },
    {
      timeout: TIMEOUT,
      timeoutMsg: `${phase}: neither native startup nor workspace became available; authentication gates remain intact`,
    },
  );
  if (observation.entry === "native-startup") {
    const skip = startup.$(
      './button[normalize-space(.)="暂不登录，继续聊天" or normalize-space(.)="Continue chatting without signing in"]',
    );
    await skip.waitForClickable({ timeout: TIMEOUT });
    await skip.click();
    observation.clicked = true;
    observation.entry = "native-continue-without-signing-in";
    await startup.waitForDisplayed({ reverse: true, timeout: TIMEOUT });
  }
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, TIMEOUT);
  observation.workspaceReady = true;
}

async function processIdentity() {
  return await browser.electron.execute((electron) => ({
    pid: process.pid,
    userData: electron.app.getPath("userData"),
    home: process.env.ZCODE_E2E_HOME_DIR ?? "",
    logRoot: process.env.ZCODE_E2E_RUNTIME_LOG_DIR ?? "",
  }));
}

function digest(manifest: RecoverySeedManifest) {
  return `[data-workflow-run-digest="true"][data-workflow-run-id="${manifest.runId}"]`;
}

async function openRun(manifest: RecoverySeedManifest, status: string) {
  const card = $(digest(manifest));
  await card.waitForDisplayed({ timeout: TIMEOUT });
  await browser.waitUntil(
    async () => (await card.getAttribute("data-workflow-run-status")) === status,
    { timeout: TIMEOUT, timeoutMsg: `workflow card did not become ${status}` },
  );
  await card.$('[data-testid="workflow-card-open-details"]').click();
  await $('[data-testid="workflow-run-status-row"]').waitForDisplayed({ timeout: TIMEOUT });
}

async function assertErroredPane(manifest: RecoverySeedManifest, message: string) {
  // 修复原因：同 run-id 的工具摘要没有 status；只核验活动侧板的真实运行根。
  const pane = $(
    `[data-side-pane-content-slot] [role="tabpanel"][data-state="active"] [data-workflow-run-id="${manifest.runId}"][data-workflow-run-status]:has([data-testid="workflow-run-status-row"])`,
  );
  await pane.waitForDisplayed({ timeout: TIMEOUT });
  await browser.waitUntil(
    async () => (await pane.getAttribute("data-workflow-run-status")) === "errored",
    { timeout: TIMEOUT },
  );
  assert.equal(await pane.$('[data-testid="workflow-run-resume"]').isExisting(), false);
  assert.equal(await pane.$('[data-testid="workflow-run-stop-reason"]').isExisting(), false);
  assert((await pane.$('[data-testid="workflow-run-error"]').getText()).includes(message));
}

async function closeRunPaneTabs() {
  // 本 case 只打开工作流侧板；关闭实际 tab 的用户按钮，释放其订阅 lease。
  for (const tab of await $$("[data-side-pane-tab-id]")) {
    await tab.click();
    await tab.$("button").click();
  }
}

async function waitForRejectedFacts(manifest: RecoverySeedManifest): Promise<RecoveryFacts> {
  let latest: RecoveryFacts | undefined;
  await browser.waitUntil(
    async () => {
      latest = await inspectWorkflowRecovery(manifest);
      return (
        latest.run.status === "failed" &&
        JSON.parse(latest.run.failure_json ?? "{}").code === "RecoveryUncertain"
      );
    },
    { timeout: TIMEOUT, timeoutMsg: "journal did not persist RecoveryUncertain" },
  );
  assert(latest);
  return latest;
}

function assertConserved(manifest: RecoverySeedManifest, facts: RecoveryFacts) {
  assert.equal(facts.run.status, "failed"); // physical encoding of logical errored
  assert.equal(JSON.parse(facts.run.failure_json ?? "{}").code, "RecoveryUncertain");
  assert.deepEqual(facts.nodes, manifest.baseline.nodes);
  assert.deepEqual(facts.counts, manifest.baseline.counts);
  assert.equal(facts.run.script_hash, manifest.seed.scriptHash);
  assert.equal(facts.run.spent_tokens, 0);
}

async function lifecycleRows(root: string, sessionId: string): Promise<LifecycleRow[]> {
  const rows: LifecycleRow[] = [];
  for (const file of (await readdir(root)).filter((name) => name.endsWith(".log")).sort()) {
    const path = await assertRecoveryPath(root, resolve(root, file));
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.includes(sessionId) || !line.includes('"event":"v4.')) continue;
      const start = line.indexOf("{");
      if (start < 0) continue;
      const item = JSON.parse(line.slice(start)) as Omit<LifecycleRow, "line">;
      if (
        [
          "v4.session_data.keep_warm_expired",
          "v4.conversation.unsubscribe.completed",
          "v4.conversation.subscribe.acknowledged",
          "v4.conversation.subscribe.activated",
        ].includes(item.event)
      )
        rows.push({ ...item, line });
    }
  }
  return rows;
}

async function waitForSubscription(
  root: string,
  sessionId: string,
  previous?: string,
): Promise<LifecycleRow> {
  let selected: LifecycleRow | undefined;
  await browser.waitUntil(
    async () => {
      const rows = await lifecycleRows(root, sessionId);
      selected = rows.findLast(
        (row) =>
          row.event === "v4.conversation.subscribe.acknowledged" &&
          Boolean(row.subscriptionId) &&
          row.subscriptionId !== previous &&
          rows.some(
            (active) =>
              active.event === "v4.conversation.subscribe.activated" &&
              active.subscriptionId === row.subscriptionId,
          ),
      );
      return Boolean(selected);
    },
    { timeout: TIMEOUT, timeoutMsg: "missing acknowledged AND activated new subscription" },
  );
  assert(selected);
  return selected;
}

async function assertNoProviderRequests(manifest: RecoverySeedManifest) {
  const path = process.env.E2E_PROVIDER_CAPTURE_PATH;
  assert(path, "zero requests cannot be proven without a capture source");
  await assertRecoveryPath(manifest.runRoot, path);
  const capture = JSON.parse(await readFile(path, "utf8")) as {
    records: Array<{ method: string; path: string }>;
  };
  assert(Array.isArray(capture.records));
  assert.equal(
    capture.records.filter(
      (row) =>
        row.method === "POST" && /\/(chat\/completions|messages|responses)(?:\?|$)/.test(row.path),
    ).length,
    0,
  );
}
