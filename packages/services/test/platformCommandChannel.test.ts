import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import {
  commandChannelStoreFileName,
  createCommandChannelDiskStore,
  createCommandChannelProcessor,
  DEFAULT_COMMAND_CHANNEL_POLICY,
  type CommandChannelAuditEvent,
  type CommandChannelCommandEnvelope,
  type CommandChannelNoticeEnvelope,
  type CommandChannelPolicy,
  type CommandChannelProcessor,
} from "../src/platform-command-channel/index.js";
import {
  FIXED_EXPIRES_AT,
  FIXED_NOW,
  makeCommandChannelTestDirectory,
  nextTestUuid,
  removeCommandChannelTestDirectory,
  testPullChatLogsEnvelope,
  testPullRunLogsEnvelope,
  testPullSkillUsageStatsEnvelope,
  testSkillUpdateNoticeEnvelope,
} from "./platformCommandChannelFixtures.js";

/**
 * 处理核心与磁盘幂等存储单测：验收场景 S11 客户端侧前半四组判据
 * （a 签名无效拒绝且不执行 / b 同 commandId 幂等 / c 策略关闭 POLICY_DISABLED /
 * d 未知类型 UNKNOWN_TYPE），外加过期、scope 越界、MALFORMED、通告分发路由、
 * 审计钩子断言与存储持久化恢复。
 */

const CHAT_ENABLED_POLICY: CommandChannelPolicy = {
  ...DEFAULT_COMMAND_CHANNEL_POLICY,
  commands: {
    ...DEFAULT_COMMAND_CHANNEL_POLICY.commands,
    "command.pull_chat_logs": { enabled: true },
  },
};

/** 静默 logger：阻断 audit 降级路径的 console 噪声，同时可断言 warn 被调用。 */
function createSilentLogger(): ServiceLogger & { warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  return {
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (_traceId, ...args) => {
      warnings.push(args);
    },
    warnings,
  };
}

interface Harness {
  processor: CommandChannelProcessor;
  executedCommands: CommandChannelCommandEnvelope[];
  dispatchedNotices: CommandChannelNoticeEnvelope[];
  auditEvents: CommandChannelAuditEvent[];
  verifierInputs: unknown[];
  frozenStore: Map<string, string>;
  logger: ReturnType<typeof createSilentLogger>;
}

function createHarness(options?: {
  signatureValid?: boolean;
  policy?: CommandChannelPolicy;
  resultRef?: string;
}): Harness {
  const executedCommands: CommandChannelCommandEnvelope[] = [];
  const dispatchedNotices: CommandChannelNoticeEnvelope[] = [];
  const auditEvents: CommandChannelAuditEvent[] = [];
  const verifierInputs: unknown[] = [];
  const frozenStore = new Map<string, string>();
  const logger = createSilentLogger();
  const processor = createCommandChannelProcessor({
    verifier: {
      verify: (envelope) => {
        verifierInputs.push(envelope);
        return Promise.resolve(options?.signatureValid ?? true);
      },
    },
    executor: {
      execute: (command) => {
        executedCommands.push(command);
        return Promise.resolve({ resultRef: options?.resultRef ?? "result-ref-1" });
      },
    },
    noticeSink: {
      dispatch: (notice) => {
        dispatchedNotices.push(notice);
        return Promise.resolve();
      },
    },
    auditSink: {
      record: (event) => {
        auditEvents.push(event);
        return Promise.resolve();
      },
    },
    store: {
      get: (commandId) => Promise.resolve(frozenStore.get(commandId)),
      freeze: (commandId, serializedResponse) => {
        if (frozenStore.has(commandId)) return Promise.resolve(false);
        frozenStore.set(commandId, serializedResponse);
        return Promise.resolve(true);
      },
      dispose: () => Promise.resolve(),
    },
    getPolicy: () => options?.policy ?? DEFAULT_COMMAND_CHANNEL_POLICY,
    now: () => FIXED_NOW,
    logger,
  });
  return {
    processor,
    executedCommands,
    dispatchedNotices,
    auditEvents,
    verifierInputs,
    frozenStore,
    logger,
  };
}

const IDENTITY = { tenantId: "tenant-1", userId: "user-1" };

let directory: string;

beforeEach(async () => {
  directory = await makeCommandChannelTestDirectory();
});

afterEach(async () => {
  await removeCommandChannelTestDirectory(directory);
});

describe("S11-a signature failure rejects without execution", () => {
  it("rejects pull_run_logs with INVALID_SIGNATURE, never executes, and audits the rejection", async () => {
    const harness = createHarness({ signatureValid: false });
    const result = await harness.processor.processEnvelope(
      testPullRunLogsEnvelope({ commandId: "123e4567-e89b-42d3-a456-426614174001" }),
    );
    expect(result.response).toEqual({
      status: "rejected",
      commandId: "123e4567-e89b-42d3-a456-426614174001",
      reason: "INVALID_SIGNATURE",
    });
    expect(result.replay).toBe(false);
    // 不执行：执行体零调用，也无任何数据引用产生（数据本体经执行体回传）。
    expect(harness.executedCommands).toHaveLength(0);
    expect(harness.frozenStore.size).toBe(0);
    // 拒绝事件（固定原因码）经本地审计钩子可回读。
    expect(harness.auditEvents).toEqual([
      {
        kind: "command.rejected",
        commandId: "123e4567-e89b-42d3-a456-426614174001",
        type: "command.pull_run_logs",
        reason: "INVALID_SIGNATURE",
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });
});

describe("S11-b same commandId replays the frozen result", () => {
  it("returns the identical serialized bytes on the second send and executes once", async () => {
    const commandId = "123e4567-e89b-42d3-a456-426614174002";
    const harness = createHarness({ resultRef: "upload-batch-42" });
    const envelope = testPullRunLogsEnvelope({ commandId });
    const first = await harness.processor.processEnvelope(envelope);
    expect(first.response).toEqual({
      status: "executed",
      commandId,
      resultRef: "upload-batch-42",
    });
    expect(first.replay).toBe(false);
    expect(first.serializedResponse).toBe(
      `{"status":"executed","commandId":"${commandId}","resultRef":"upload-batch-42"}`,
    );
    const second = await harness.processor.processEnvelope(envelope);
    // 第二次返回首次结果：字节一致（===），且未重新执行（数据仅回传一份的客户端侧义务）。
    expect(second.serializedResponse).toBe(first.serializedResponse);
    expect(second.response).toEqual(first.response);
    expect(second.replay).toBe(true);
    expect(harness.executedCommands).toHaveLength(1);
    expect(harness.frozenStore.get(commandId)).toBe(first.serializedResponse);
    // executed 审计只记首次；重放不产生第二条 executed 事件。
    expect(
      harness.auditEvents.filter((event) => event.kind === "command.executed"),
    ).toHaveLength(1);
  });

  it("expires before idempotency: an expired replay answers EXPIRED, not the frozen result", async () => {
    const commandId = "123e4567-e89b-42d3-a456-426614174003";
    const frozenStore = new Map<string, string>();
    const buildProcessor = (now: () => Date): CommandChannelProcessor =>
      createCommandChannelProcessor({
        verifier: { verify: () => Promise.resolve(true) },
        executor: {
          execute: () => Promise.resolve({ resultRef: "ref-old" }),
        },
        noticeSink: { dispatch: () => Promise.resolve() },
        auditSink: { record: () => Promise.resolve() },
        store: {
          get: (id) => Promise.resolve(frozenStore.get(id)),
          freeze: (id, bytes) => {
            frozenStore.set(id, bytes);
            return Promise.resolve(true);
          },
          dispose: () => Promise.resolve(),
        },
        getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY,
        now,
        logger: createSilentLogger(),
      });
    const envelope = testPullRunLogsEnvelope({ commandId });
    await buildProcessor(() => FIXED_NOW).processEnvelope(envelope);
    // 任务卡管线：过期判定先于幂等命中——过期重放回 EXPIRED 而非原结果。
    const replayAfterExpiry = await buildProcessor(
      () => new Date("2026-10-22T12:10:00.000Z"),
    ).processEnvelope(envelope);
    expect(replayAfterExpiry.response).toMatchObject({
      status: "rejected",
      commandId,
      reason: "EXPIRED",
    });
    expect(replayAfterExpiry.replay).toBe(false);
  });
});

describe("S11-c policy disabled answers POLICY_DISABLED", () => {
  it("rejects pull_chat_logs when the tenant disables that command type (default policy)", async () => {
    const harness = createHarness();
    const result = await harness.processor.processEnvelope(
      testPullChatLogsEnvelope({
        commandId: "123e4567-e89b-42d3-a456-426614174004",
        sessionId: "session-1",
      }),
    );
    expect(result.response).toEqual({
      status: "rejected",
      commandId: "123e4567-e89b-42d3-a456-426614174004",
      reason: "POLICY_DISABLED",
    });
    expect(harness.executedCommands).toHaveLength(0);
    expect(
      harness.auditEvents.find((event) => event.kind === "command.rejected"),
    ).toMatchObject({ reason: "POLICY_DISABLED" });
  });

  it("rejects every command type when the whole channel is disabled", async () => {
    const policy: CommandChannelPolicy = {
      ...DEFAULT_COMMAND_CHANNEL_POLICY,
      channelEnabled: false,
    };
    for (const envelope of [
      testPullRunLogsEnvelope(),
      testPullSkillUsageStatsEnvelope(),
      testPullChatLogsEnvelope({ sessionId: "session-1" }),
    ]) {
      const harness = createHarness({ policy });
      const result = await harness.processor.processEnvelope(envelope);
      expect(result.response).toMatchObject({
        status: "rejected",
        reason: "POLICY_DISABLED",
      });
      expect(harness.executedCommands).toHaveLength(0);
    }
  });
});

describe("S11-d unknown envelope type answers UNKNOWN_TYPE without execution", () => {
  it("rejects a forged command.exec type and audits it", async () => {
    const harness = createHarness();
    const result = await harness.processor.processEnvelope({
      envelopeVersion: 1,
      type: "command.exec",
      commandId: "123e4567-e89b-42d3-a456-426614174005",
      params: { argv: ["rm", "-rf", "/"] },
      issuedAt: "2026-10-22T11:59:00.000Z",
      expiresAt: FIXED_EXPIRES_AT,
      signature: "valid-signature-on-forged-type",
    });
    expect(result.response).toEqual({
      status: "rejected",
      commandId: "123e4567-e89b-42d3-a456-426614174005",
      reason: "UNKNOWN_TYPE",
    });
    expect(harness.executedCommands).toHaveLength(0);
    expect(harness.auditEvents).toEqual([
      {
        kind: "envelope.rejected",
        type: "command.exec",
        commandId: "123e4567-e89b-42d3-a456-426614174005",
        reason: "UNKNOWN_TYPE",
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });

  it("checks the signature before the whitelist: forged type with bad signature answers INVALID_SIGNATURE", async () => {
    const harness = createHarness({ signatureValid: false });
    const result = await harness.processor.processEnvelope({
      envelopeVersion: 1,
      type: "command.exec",
      commandId: "123e4567-e89b-42d3-a456-426614174006",
      params: {},
      issuedAt: "2026-10-22T11:59:00.000Z",
      expiresAt: FIXED_EXPIRES_AT,
      signature: "bad-signature",
    });
    expect(result.response).toMatchObject({ reason: "INVALID_SIGNATURE" });
  });
});

describe("guardrail order and scope validation", () => {
  it("rejects expired commands with EXPIRED", async () => {
    const harness = createHarness();
    const result = await harness.processor.processEnvelope(
      testPullRunLogsEnvelope({
        expiresAt: "2026-10-22T12:00:00.000Z",
      }),
    );
    expect(result.response).toMatchObject({ reason: "EXPIRED" });
    expect(harness.executedCommands).toHaveLength(0);
  });

  it("rejects oversized time windows with SCOPE_INVALID (default 7d cap)", async () => {
    const harness = createHarness();
    const result = await harness.processor.processEnvelope(
      testPullRunLogsEnvelope({
        timeRange: {
          from: "2026-10-01T12:00:00.000Z",
          to: "2026-10-22T12:00:00.000Z",
        },
      }),
    );
    expect(result.response).toMatchObject({ reason: "SCOPE_INVALID" });
    expect(harness.executedCommands).toHaveLength(0);
  });

  it("rejects inverted and empty time ranges, unbounded chat scopes, and malformed sessionIds", async () => {
    const harness = createHarness({ policy: CHAT_ENABLED_POLICY });
    const cases = [
      testPullRunLogsEnvelope({
        timeRange: {
          from: "2026-10-22T12:00:00.000Z",
          to: "2026-10-22T11:00:00.000Z",
        },
      }),
      // 空限定 scope：chat logs 必须至少带 sessionId 或 timeRange 之一（M7-R6 范围限定）。
      testPullChatLogsEnvelope(),
      // sessionId 超长与含控制字符都属 scope 语义（SCOPE_INVALID 而非 MALFORMED）。
      testPullChatLogsEnvelope({ sessionId: "s".repeat(257) }),
      testPullChatLogsEnvelope({ sessionId: "session\u0007-1" }),
    ];
    for (const envelope of cases) {
      const result = await harness.processor.processEnvelope(envelope);
      expect(result.response).toMatchObject({ reason: "SCOPE_INVALID" });
    }
    expect(harness.executedCommands).toHaveLength(0);
  });

  it("executes sessionId-scoped chat pulls when the policy enables them", async () => {
    const harness = createHarness({ policy: CHAT_ENABLED_POLICY });
    const result = await harness.processor.processEnvelope(
      testPullChatLogsEnvelope({ sessionId: "session-1" }),
    );
    expect(result.response).toMatchObject({ status: "executed" });
    expect(harness.executedCommands).toHaveLength(1);
  });

  it("answers MALFORMED for unknown fields and structural violations without verifying", async () => {
    const harness = createHarness();
    const malformed = {
      ...testPullRunLogsEnvelope(),
      tenantId: "tenant-must-not-ride-along",
    };
    const result = await harness.processor.processEnvelope(malformed);
    expect(result.response).toEqual({
      status: "rejected",
      reason: "MALFORMED",
    });
    // schema 失败在验签之前：验签端口零调用。
    expect(harness.verifierInputs).toHaveLength(0);
    expect(harness.executedCommands).toHaveLength(0);
    expect(harness.auditEvents).toEqual([
      {
        kind: "envelope.rejected",
        reason: "MALFORMED",
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });
});

describe("notice routing", () => {
  it("dispatches notices through the sink without entering command processing", async () => {
    const harness = createHarness();
    const noticeId = "123e4567-e89b-42d3-a456-426614174007";
    const result = await harness.processor.processEnvelope(
      testSkillUpdateNoticeEnvelope({ noticeId, version: 3, seq: 7 }),
    );
    expect(result.response).toEqual({
      status: "dispatched",
      noticeId,
    });
    expect(result.serializedResponse).toBe(
      `{"status":"dispatched","noticeId":"${noticeId}"}`,
    );
    // 通告不进命令处理：执行体零调用、幂等存储零冻结。
    expect(harness.executedCommands).toHaveLength(0);
    expect(harness.frozenStore.size).toBe(0);
    expect(harness.dispatchedNotices).toHaveLength(1);
    expect(harness.dispatchedNotices[0]).toMatchObject({
      type: "skill.update.notice",
      noticeId,
      params: { version: 3, seq: 7 },
    });
    expect(harness.auditEvents).toEqual([
      {
        kind: "notice.dispatched",
        noticeId,
        type: "skill.update.notice",
        issuedAt: "2026-10-22T11:59:00.000Z",
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });

  it("rejects notices with invalid signatures without dispatching", async () => {
    const harness = createHarness({ signatureValid: false });
    const noticeId = "123e4567-e89b-42d3-a456-426614174008";
    const result = await harness.processor.processEnvelope(
      testSkillUpdateNoticeEnvelope({ noticeId }),
    );
    expect(result.response).toEqual({
      status: "rejected",
      noticeId,
      reason: "INVALID_SIGNATURE",
    });
    expect(harness.dispatchedNotices).toHaveLength(0);
    expect(harness.auditEvents).toEqual([
      {
        kind: "notice.rejected",
        noticeId,
        type: "skill.update.notice",
        reason: "INVALID_SIGNATURE",
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });
});

describe("audit hook robustness", () => {
  it("keeps processing when the audit sink throws (degrades to warn log)", async () => {
    const logger = createSilentLogger();
    const frozenStore = new Map<string, string>();
    const processor = createCommandChannelProcessor({
      verifier: { verify: () => Promise.resolve(true) },
      executor: { execute: () => Promise.resolve({ resultRef: "ref-x" }) },
      noticeSink: { dispatch: () => Promise.resolve() },
      auditSink: {
        record: () => Promise.reject(new Error("audit sink down")),
      },
      store: {
        get: (id) => Promise.resolve(frozenStore.get(id)),
        freeze: (id, bytes) => {
          frozenStore.set(id, bytes);
          return Promise.resolve(true);
        },
        dispose: () => Promise.resolve(),
      },
      getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY,
      now: () => FIXED_NOW,
      logger,
    });
    const result = await processor.processEnvelope(testPullRunLogsEnvelope());
    expect(result.response).toMatchObject({ status: "executed" });
    expect(logger.warnings).toHaveLength(1);
  });

  it("propagates executor failures without freezing an executed result", async () => {
    const frozenStore = new Map<string, string>();
    const processor = createCommandChannelProcessor({
      verifier: { verify: () => Promise.resolve(true) },
      executor: {
        // v1 阶段执行体未接线属预期：非终态向调用方传播，不冻结、不回 executed。
        execute: () => {
          throw new Error("executor not wired yet");
        },
      },
      noticeSink: { dispatch: () => Promise.resolve() },
      auditSink: { record: () => Promise.resolve() },
      store: {
        get: (id) => Promise.resolve(frozenStore.get(id)),
        freeze: (id, bytes) => {
          frozenStore.set(id, bytes);
          return Promise.resolve(true);
        },
        dispose: () => Promise.resolve(),
      },
      getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY,
      now: () => FIXED_NOW,
      logger: createSilentLogger(),
    });
    await expect(
      processor.processEnvelope(testPullRunLogsEnvelope()),
    ).rejects.toThrow("executor not wired yet");
    expect(frozenStore.size).toBe(0);
  });
});

describe("disk idempotent store", () => {
  it("freezes once, refuses rewrites, and survives reopen with identical bytes", async () => {
    const store = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    const commandId = nextTestUuid(3);
    const bytes = '{"status":"executed","commandId":"x","resultRef":"r"}';
    expect(await store.freeze(commandId, bytes)).toBe(true);
    // 同 commandId 第二次冻结：拒绝且不改写原字节。
    expect(await store.freeze(commandId, '{"status":"executed","other":1}')).toBe(
      false,
    );
    expect(await store.get(commandId)).toBe(bytes);
    await store.dispose();

    const reopened = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    // 重启恢复：同一 commandId 读回同一字节（S11-b 幂等的持久化基础）。
    expect(await reopened.get(commandId)).toBe(bytes);
    await reopened.dispose();
  });

  it("isolates identities into separate store files", async () => {
    const storeA = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    const commandId = nextTestUuid(3);
    await storeA.freeze(commandId, '{"status":"executed"}');
    await storeA.dispose();
    const storeB = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: { tenantId: "tenant-2", userId: "user-2" },
      logger: createSilentLogger(),
    });
    // 另一租户/用户读不到该 commandId（多租户隔离的本地面）。
    expect(await storeB.get(commandId)).toBeUndefined();
    await storeB.dispose();
  });

  it("recovers from corrupt and torn lines by dropping them and keeping valid records", async () => {
    const store = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    const validId = nextTestUuid(4);
    const validBytes = '{"status":"executed","resultRef":"r1"}';
    await store.freeze(validId, validBytes);
    await store.dispose();

    const filePath = join(
      directory,
      commandChannelStoreFileName(IDENTITY),
    );
    const original = await readFile(filePath, "utf8");
    // 手工注入损坏行、重复幂等键行与撕裂尾行（写入中断形态）。
    await writeFile(
      filePath,
      `${original}{not json}\n${JSON.stringify({ commandId: validId, serializedResponse: '{"status":"executed","resultRef":"tampered"}' })}\n{"commandId":"torn`,
      "utf8",
    );
    const recovered = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    // 损坏行被丢弃计数（error 日志）、重复幂等键取首条（不改写已冻结名义）、撕裂尾行不复活。
    expect(await recovered.get(validId)).toBe(validBytes);
    // 恢复后继续追加新记录，后续读写不受残行影响。
    const freshId = nextTestUuid(5);
    expect(await recovered.freeze(freshId, validBytes)).toBe(true);
    expect(await recovered.get(freshId)).toBe(validBytes);
    await recovered.dispose();
    const reopened = createCommandChannelDiskStore({
      storageDirectory: directory,
      identity: IDENTITY,
      logger: createSilentLogger(),
    });
    expect(await reopened.get(freshId)).toBe(validBytes);
    await reopened.dispose();
  });
});
