import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillReflowLedgerFile,
  createSkillReflowQueueFile,
  createSkillReflowUploadService,
} from "../src/skill-reflow-upload/index.js";
import type {
  SkillReflowDedupLedger,
  SkillReflowScanRoot,
  SkillReflowTriggerScheduler,
  SkillReflowUploadQueue,
  SkillReflowUploadService,
} from "../src/skill-reflow-upload/index.js";
import {
  makeSkillReflowTestDirectory,
  removeSkillReflowTestDirectory,
  skillMarkdown,
  userScanRoot,
  writeSkillEntry,
} from "./skillReflowUploadFixtures.js";

/**
 * 服务编排单测（spec §6.1 触发与补传 / §6.3 增量判定 / §6.5 状态面）：
 * 验收场景 2（内容不变零入队）、5（变更入队）、8（触发幂等）与状态计数器判据。
 */

let directory: string;

beforeEach(async () => {
  directory = await makeSkillReflowTestDirectory();
});

afterEach(async () => {
  await removeSkillReflowTestDirectory(directory);
});

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface SchedulerProbe extends SkillReflowTriggerScheduler {
  dueAt?: number;
  fire?: () => void;
}

function countingRootProvider(skillsDirectory: string): {
  listRoots: () => Promise<readonly SkillReflowScanRoot[]>;
  calls: number;
} {
  return {
    calls: 0,
    async listRoots() {
      this.calls += 1;
      return [userScanRoot(skillsDirectory)];
    },
  };
}

function createService(options: {
  skillsDirectory?: string;
  rootProvider?: { listRoots: () => Promise<readonly SkillReflowScanRoot[]> };
  now: () => Date;
  scheduler?: SchedulerProbe;
  onTriggerSession?: (outcome: Awaited<ReturnType<SkillReflowUploadService["runDailyFirstLaunchTrigger"]>>) => void;
}): {
  service: SkillReflowUploadService;
  ledger: SkillReflowDedupLedger;
  queue: SkillReflowUploadQueue;
} {
  const stateDirectory = join(directory, "state");
  const ledger = createSkillReflowLedgerFile({ storageDirectory: stateDirectory, logger: quietLogger });
  const queue = createSkillReflowQueueFile({ storageDirectory: stateDirectory, logger: quietLogger });
  const rootProvider =
    options.rootProvider ?? countingRootProvider(options.skillsDirectory ?? directory);
  const scheduler: SchedulerProbe = options.scheduler ?? {
    schedule(dueAt, fire) {
      this.dueAt = dueAt;
      this.fire = fire;
    },
    cancel() {
      this.dueAt = undefined;
      this.fire = undefined;
    },
  };
  const service = createSkillReflowUploadService({
    rootProvider,
    ledger,
    queue,
    stateDirectory,
    scheduler,
    now: options.now,
    logger: quietLogger,
    onTriggerSession: options.onTriggerSession,
  });
  return { service, ledger, queue };
}

describe("skill reflow upload service daily trigger", () => {
  it("scans once per local day: same-day restarts do not rescan (场景 8)", async () => {
    await writeSkillEntry(directory, "alpha", { skillMd: skillMarkdown({ name: "alpha" }) });
    const fixed = { date: new Date(2026, 9, 22, 8, 0, 0) };
    const rootProvider = countingRootProvider(directory);
    const { service } = createService({
      rootProvider,
      now: () => fixed.date,
    });
    const first = await service.runDailyFirstLaunchTrigger();
    expect(first).toMatchObject({ triggered: true, reason: "newDay" });
    expect(first.session).toMatchObject({ scanned: 1, queued: 1 });
    expect(rootProvider.calls).toBe(1);

    // 同日第二次（含 23:59 重启）：不重新扫描、不重复判定。
    fixed.date = new Date(2026, 9, 22, 23, 59, 0);
    const sameDay = await service.runDailyFirstLaunchTrigger();
    expect(sameDay).toMatchObject({ triggered: false, reason: "alreadyTriggeredToday" });
    expect(rootProvider.calls).toBe(1);

    const status = service.getStatus();
    expect(status.state).toBe("queued");
    expect(status.queueDepth).toBe(1);
    expect(status.counters).toMatchObject({ scanned: 1, uploaded: 0, dedupSkipped: 0 });
    await service.dispose();
  });

  it("skips unchanged content on the next day and counts dedupSkipped (场景 2)", async () => {
    const skillsDirectory = join(directory, "skills");
    await writeSkillEntry(skillsDirectory, "alpha", {
      skillMd: skillMarkdown({ name: "alpha" }),
    });
    const fixed = { date: new Date(2026, 9, 22, 8, 0, 0) };
    const rootProvider = countingRootProvider(skillsDirectory);
    const { service } = createService({ rootProvider, now: () => fixed.date });
    const day1 = await service.runDailyFirstLaunchTrigger();
    expect(day1.session).toMatchObject({ scanned: 1, queued: 1, dedupSkipped: 0 });
    // 中台回执 accepted：账本回写 digest（次日增量依据），条目出队。
    await service.recordReceipt({
      key: "user/user-root/alpha",
      outcome: "accepted",
      settledAt: "2026-10-22T08:01:00Z",
    });
    const afterReceipt = service.getStatus();
    expect(afterReceipt.queueDepth).toBe(0);
    expect(afterReceipt.counters.uploaded).toBe(1);

    fixed.date = new Date(2026, 9, 23, 9, 0, 0);
    const day2 = await service.runDailyFirstLaunchTrigger();
    expect(day2.session).toMatchObject({ scanned: 1, queued: 0, dedupSkipped: 1 });
    expect(rootProvider.calls).toBe(2);
    const finalStatus = service.getStatus();
    expect(finalStatus.state).toBe("done");
    expect(finalStatus.counters.dedupSkipped).toBe(1);
    expect(finalStatus.lastTriggerDate).toBe("2026-10-23");
    expect(finalStatus.lastSuccessAt).toBeTruthy();
    await service.dispose();
  });

  it("re-enqueues changed content and treats filterHit receipts as terminal without ledger writeback", async () => {
    const skillsDirectory = join(directory, "skills");
    const entryDirectory = await writeSkillEntry(skillsDirectory, "alpha", {
      skillMd: skillMarkdown({ name: "alpha" }),
    });
    const fixed = { date: new Date(2026, 9, 22, 8, 0, 0) };
    const rootProvider = countingRootProvider(skillsDirectory);
    const { service, ledger } = createService({ rootProvider, now: () => fixed.date });
    await service.runDailyFirstLaunchTrigger();
    await service.recordReceipt({
      key: "user/user-root/alpha",
      outcome: "accepted",
      settledAt: "2026-10-22T08:01:00Z",
    });
    const acceptedAfterDay1 = await ledger.getAccepted("user/user-root/alpha");
    expect(acceptedAfterDay1?.contentDigest).toBeTruthy();

    // 修改内容：次日变更入队（场景 5，全量重传语义）。
    await writeFile(join(entryDirectory, "SKILL.md"), skillMarkdown({ name: "alpha-v2" }), "utf8");
    fixed.date = new Date(2026, 9, 23, 8, 0, 0);
    const day2 = await service.runDailyFirstLaunchTrigger();
    expect(day2.session).toMatchObject({ scanned: 1, queued: 1, dedupSkipped: 0 });

    // 过滤命中为终态：出队、计数，但账本不回写该 digest（spec §6.4 不重试）。
    await service.recordReceipt({
      key: "user/user-root/alpha",
      outcome: "filterHit",
      filterCategory: "credential",
      settledAt: "2026-10-23T08:01:00Z",
    });
    const status = service.getStatus();
    expect(status.queueDepth).toBe(0);
    expect(status.counters.filterHit).toBe(1);
    expect(await ledger.getAccepted("user/user-root/alpha")).toEqual(acceptedAfterDay1);
    await service.dispose();
  });

  it("internalizes scan failures into retryableFailed status without throwing (spec §6.4 绝不阻塞)", async () => {
    const failingProvider = {
      calls: 0,
      async listRoots(): Promise<readonly SkillReflowScanRoot[]> {
        this.calls += 1;
        throw new Error("roots unavailable");
      },
    };
    const fixed = { date: new Date(2026, 9, 22, 8, 0, 0) };
    const { service } = createService({
      rootProvider: failingProvider,
      now: () => fixed.date,
    });
    const outcome = await service.runDailyFirstLaunchTrigger();
    expect(outcome.triggered).toBe(true);
    expect(outcome.reason).toBe("scanFailed");
    expect(outcome.error?.code).toBe("SCAN_FAILED");
    const status = service.getStatus();
    expect(status.state).toBe("retryableFailed");
    expect(status.counters.failed).toBe(1);
    expect(status.lastError?.code).toBe("SCAN_FAILED");
    // 失败当日已占用日界标记：同日重启不再重复判定（崩溃恢复零重复会话）。
    const sameDay = await service.runDailyFirstLaunchTrigger();
    expect(sameDay.reason).toBe("alreadyTriggeredToday");
    expect(failingProvider.calls).toBe(1);
    await service.dispose();
  });

  it("arms the daily trigger through the injected scheduler at next local midnight", async () => {
    const fixed = { date: new Date(2026, 9, 22, 23, 0, 0) };
    const scheduler: SchedulerProbe = {
      dueAt: undefined,
      fire: undefined,
      schedule(dueAt, fire) {
        this.dueAt = dueAt;
        this.fire = fire;
      },
      cancel() {
        this.dueAt = undefined;
        this.fire = undefined;
      },
    };
    const { service } = createService({ now: () => fixed.date, scheduler });
    service.armDailyTrigger();
    // 注入时钟 23:00 → 排程到次日零点（本地时区自然日界）。
    expect(scheduler.dueAt).toBe(new Date(2026, 9, 23, 0, 0, 0).getTime());
    expect(typeof scheduler.fire).toBe("function");
    scheduler.cancel();
    expect(scheduler.dueAt).toBeUndefined();
    await service.dispose();
  });

  it("exposes mark* state transitions for the uploader card (needLogin/sending/retryableFailed/done)", async () => {
    const fixed = { date: new Date(2026, 9, 22, 8, 0, 0) };
    const { service } = createService({ now: () => fixed.date });
    expect(service.getStatus().state).toBe("idle");
    service.markNeedLogin();
    expect(service.getStatus().state).toBe("needLogin");
    service.markSending();
    expect(service.getStatus().state).toBe("sending");
    service.markRetryableFailed("RATE_LIMITED");
    const failed = service.getStatus();
    expect(failed.state).toBe("retryableFailed");
    expect(failed.lastError?.code).toBe("RATE_LIMITED");
    expect(failed.lastError?.at).toBe(fixed.date.toISOString());
    service.markDone();
    expect(service.getStatus().state).toBe("done");
    await service.dispose();
  });

  it("notifies after a successful trigger session", async () => {
    await writeSkillEntry(directory, "alpha", { skillMd: skillMarkdown({ name: "alpha" }) });
    let observed: Awaited<ReturnType<SkillReflowUploadService["runDailyFirstLaunchTrigger"]>> | undefined;
    const { service } = createService({
      now: () => new Date(2026, 9, 22, 8),
      onTriggerSession: (outcome) => { observed = outcome; },
    });

    const outcome = await service.runDailyFirstLaunchTrigger();

    expect(observed).toEqual(outcome);
    expect(observed).toMatchObject({ triggered: true, reason: "newDay" });
    await service.dispose();
  });

  it("does not let an observing callback error affect the trigger result or status", async () => {
    await writeSkillEntry(directory, "alpha", { skillMd: skillMarkdown({ name: "alpha" }) });
    const { service } = createService({
      now: () => new Date(2026, 9, 22, 8),
      onTriggerSession: () => { throw new Error("observer failed"); },
    });

    const outcome = await service.runDailyFirstLaunchTrigger();

    expect(outcome).toMatchObject({ triggered: true, reason: "newDay" });
    expect(service.getStatus().state).toBe("queued");
    await service.dispose();
  });
});
