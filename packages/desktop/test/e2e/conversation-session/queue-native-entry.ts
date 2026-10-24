import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
} from "../helpers/desktop-app.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";

const TIMEOUT = 45_000;

// 仅 C02/PV4-25Q 使用：旧准备函数只识别职业引导/API key，无法越过新的原生聊天入口。
// 按 P2 已验的真实按钮路径进入；不修改共享登录 helper、凭据或 CTRL 状态。
export async function enterQueueWorkspace(
  evidence: Record<string, unknown>,
  phase: "initialStartup" | "coldStartup",
) {
  const observation = { entry: "waiting", clicked: false, workspaceReady: false };
  evidence[phase] = observation;
  try {
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
        timeoutMsg: `${phase}: native chat entry or workspace did not become available`,
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
  } finally {
    await saveEvidence(evidence);
  }
}

export async function restartQueueWorkspace(evidence: Record<string, unknown>) {
  const before = await processIdentity();
  const restart = { before, oldProcessTreeExited: false };
  evidence.restart = restart;
  try {
    assert(before.home, "queue restart requires the private E2E HOME");
    assert.equal(before.home, process.env.ZCODE_E2E_HOME_DIR);
    // 旧高层 restart helper 会先等工作区而卡在原生入口；低层 helper 保留同 profile，
    // 内部先 flushStorageData，再等待完整旧进程树退出；之后才能走新进程的真实入口。
    const userData = await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: () => {
        restart.oldProcessTreeExited = true;
      },
    });
    assert(restart.oldProcessTreeExited, "old process tree exit barrier did not run");
    await enterQueueWorkspace(evidence, "coldStartup");
    const after = await processIdentity();
    evidence.processAfter = after;
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.home, before.home);
    assert.equal(after.userData, before.userData);
    assert.equal(userData, before.userData);
  } finally {
    await saveEvidence(evidence);
  }
}

async function processIdentity() {
  return await browser.electron.execute((electron) => ({
    pid: process.pid,
    home: process.env.ZCODE_E2E_HOME_DIR ?? "",
    userData: electron.app.getPath("userData"),
  }));
}

async function saveEvidence(evidence: Record<string, unknown>) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  assert(artifactDir, "queue native entry requires a run-specific artifact directory");
  await writeFile(
    resolve(artifactDir, "queue-native-entry.json"),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
}
