import { describe, expect, test } from "vitest";
import {
  createCcodePlatformRuntime,
  type CcodePlatformRuntime,
  type CcodePlatformRuntimeConfig,
  type CcodePlatformRuntimeDeps,
} from "../src/ccode-platform-runtime/index.js";
import type {
  AuditTelemetryPolicyGate,
  AuditTelemetryQueue,
  AuditTelemetryUploadScheduler,
} from "../src/audit-telemetry/index.js";
import type { ExpertSkillCacheStore } from "../src/expert-skills/index.js";
import type {
  SkillReflowStatus,
  SkillReflowUploadService,
} from "../src/skill-reflow-upload/index.js";
import type { CommandChannelProcessor } from "../src/platform-command-channel/index.js";

/**
 * 组合根生命周期测试（2026-10-23 总控补写——C9R2 卡交付了工厂与契约但缺生命周期用例）。
 * 全部依赖用可记录调用的 stub（`as unknown as` 只出现在测试桩转换处）；
 * 完整装配冒烟（真工厂+fake fetch 串联四模块）列下一批集成卡。
 */

interface Calls {
  schedulerStart: number;
  schedulerDispose: number;
  queueDispose: number;
  reflowArm: number;
  reflowDispose: number;
  startTransport: number;
  stopTransport: number;
}

function createStubs(calls: Calls): CcodePlatformRuntimeDeps {
  const scheduler = {
    start: () => {
      calls.schedulerStart += 1;
    },
    dispose: async () => {
      calls.schedulerDispose += 1;
    },
  } as unknown as AuditTelemetryUploadScheduler;
  const queue = {
    stats: async () => ({ pendingRecords: 0, pendingBytes: 0, droppedOldestTotal: 0, commandIdConflicts: 0, recoveredCorruptLines: 0 }),
    dispose: async () => {
      calls.queueDispose += 1;
    },
  } as unknown as AuditTelemetryQueue;
  const policyGate = {} as AuditTelemetryPolicyGate;
  const reflowStatus: SkillReflowStatus = {
    state: "done",
    queueDepth: 0,
    counters: { scanned: 0, uploaded: 0, dedupSkipped: 0, optOutSkipped: 0, rangeExcluded: 0, filterHit: 0, failed: 0 },
  };
  const reflow = {
    armDailyTrigger: () => {
      calls.reflowArm += 1;
    },
    getStatus: () => reflowStatus,
    dispose: async () => {
      calls.reflowDispose += 1;
    },
  } as unknown as SkillReflowUploadService;
  return {
    createAudit: () => ({ queue, policyGate, scheduler }),
    createExpert: () => ({}) as ExpertSkillCacheStore,
    createReflow: () => reflow,
    createCommandChannel: () => ({}) as CommandChannelProcessor,
    startTransport: () => {
      calls.startTransport += 1;
    },
    stopTransport: () => {
      calls.stopTransport += 1;
    },
  };
}

function createRuntime(calls: Calls): CcodePlatformRuntime {
  const config: CcodePlatformRuntimeConfig = { storageDirectory: "unused" };
  return createCcodePlatformRuntime(config, createStubs(calls));
}

describe("ccode-platform-runtime lifecycle", () => {
  test("start is idempotent and arms reflow + transport once", async () => {
    const calls: Calls = { schedulerStart: 0, schedulerDispose: 0, queueDispose: 0, reflowArm: 0, reflowDispose: 0, startTransport: 0, stopTransport: 0 };
    const runtime = createRuntime(calls);
    await runtime.start();
    await runtime.start();
    expect(calls.schedulerStart).toBe(1);
    expect(calls.reflowArm).toBe(1);
    expect(calls.startTransport).toBe(1);
    expect((await runtime.status()).started).toBe(true);
  });

  test("stop allows restart and pairs transport hooks", async () => {
    const calls: Calls = { schedulerStart: 0, schedulerDispose: 0, queueDispose: 0, reflowArm: 0, reflowDispose: 0, startTransport: 0, stopTransport: 0 };
    const runtime = createRuntime(calls);
    await runtime.start();
    await runtime.stop();
    expect(calls.stopTransport).toBe(1);
    expect((await runtime.status()).started).toBe(false);
    await runtime.start();
    expect(calls.startTransport).toBe(2);
    expect((await runtime.status()).started).toBe(true);
  });

  test("dispose awaits module disposal exactly once and seals the runtime", async () => {
    const calls: Calls = { schedulerStart: 0, schedulerDispose: 0, queueDispose: 0, reflowArm: 0, reflowDispose: 0, startTransport: 0, stopTransport: 0 };
    const runtime = createRuntime(calls);
    await runtime.start();
    await runtime.dispose();
    await runtime.dispose();
    expect(calls.schedulerDispose).toBe(1);
    expect(calls.queueDispose).toBe(1);
    expect(calls.reflowDispose).toBe(1);
    expect(calls.stopTransport).toBe(1);
    const status = await runtime.status();
    expect(status.disposed).toBe(true);
    await runtime.start();
    expect(calls.schedulerStart).toBe(1);
  });

  test("status aggregates reflow status and audit queue stats", async () => {
    const calls: Calls = { schedulerStart: 0, schedulerDispose: 0, queueDispose: 0, reflowArm: 0, reflowDispose: 0, startTransport: 0, stopTransport: 0 };
    const runtime = createRuntime(calls);
    const status = await runtime.status();
    expect(status.skillReflow.state).toBe("done");
    expect(status.auditQueue.pendingRecords).toBe(0);
    expect(status.commandChannelPolicy.visibility).toBe("silent");
  });
});
