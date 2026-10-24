import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditTelemetryValidationError,
  auditTelemetryQueueFileName,
  createAuditTelemetryDiskQueue,
  serializeAuditTelemetryEvent,
} from "../src/audit-telemetry/index.js";
import type {
  AuditTelemetryEvent,
  AuditTelemetryQueue,
} from "../src/audit-telemetry/index.js";
import {
  makeAuditTelemetryTestDirectory,
  removeAuditTelemetryTestDirectory,
  testCapabilityEvent,
  testLifecycleEvent,
  testRuntimeErrorEvent,
} from "./auditTelemetryFixtures.js";

/** 队列骨架单测（spec §5.2 / 验收 AT-2、AT-8 的客户端侧判据）。 */

const IDENTITY = { tenantId: "tenant-1", userId: "user-1" };

let directory: string;

beforeEach(async () => {
  directory = await makeAuditTelemetryTestDirectory();
});

afterEach(async () => {
  await removeAuditTelemetryTestDirectory(directory);
});

function openQueue(
  options?: Partial<Parameters<typeof createAuditTelemetryDiskQueue>[0]> & {
    identity?: typeof IDENTITY;
    directory?: string;
  },
): AuditTelemetryQueue {
  return createAuditTelemetryDiskQueue({
    storageDirectory: options?.directory ?? directory,
    identity: options?.identity ?? IDENTITY,
    limits: options?.limits,
    mintOverflowEvent: options?.mintOverflowEvent,
  });
}

function queueFilePath(): string {
  return join(directory, auditTelemetryQueueFileName(IDENTITY));
}

function isOverflowRecord(record: { serializedEvent: string }): boolean {
  const parsed = JSON.parse(record.serializedEvent) as {
    type?: string;
    payload?: { errorCode?: string };
  };
  return (
    parsed.type === "runtime.error" &&
    parsed.payload?.errorCode === "AUDIT_QUEUE_OVERFLOW"
  );
}

describe("audit telemetry disk queue", () => {
  it("keeps FIFO order and filters take by channel", async () => {
    const queue = openQueue();
    const first = testLifecycleEvent();
    const second = testRuntimeErrorEvent({ channel: "diagnostic" });
    const third = testLifecycleEvent({ lifecycleStatus: "started" });
    await queue.enqueue(first);
    await queue.enqueue(second);
    await queue.enqueue(third);
    const all = await queue.take(10);
    expect(all.map((record) => record.commandId)).toEqual([
      first.commandId,
      second.commandId,
      third.commandId,
    ]);
    expect((await queue.take(2)).map((record) => record.commandId)).toEqual([
      first.commandId,
      second.commandId,
    ]);
    const lifecycleOnly = await queue.take(10, "lifecycle");
    expect(lifecycleOnly.map((record) => record.commandId)).toEqual([
      first.commandId,
      third.commandId,
    ]);
    expect((await queue.stats()).pendingRecords).toBe(3);
  });

  it("isolates queue files per login identity (tenantId+userId)", async () => {
    const queueA = openQueue();
    const queueB = openQueue({
      identity: { tenantId: "tenant-2", userId: "user-1" },
    });
    await queueA.enqueue(testLifecycleEvent());
    expect((await queueB.take(10)).length).toBe(0);
    expect((await queueA.take(10)).length).toBe(1);
    expect(auditTelemetryQueueFileName(IDENTITY)).not.toBe(
      auditTelemetryQueueFileName({ tenantId: "tenant-2", userId: "user-1" }),
    );
    // 同租户不同用户同样隔离；同身份重新打开则命中同一文件。
    expect(auditTelemetryQueueFileName(IDENTITY)).not.toBe(
      auditTelemetryQueueFileName({ tenantId: "tenant-1", userId: "user-2" }),
    );
    expect(auditTelemetryQueueFileName(IDENTITY)).toBe(
      auditTelemetryQueueFileName(IDENTITY),
    );
  });

  it("recovers identical frozen bytes across process restart (AT-8 判据)", async () => {
    const queue = openQueue();
    const events = [
      testLifecycleEvent(),
      testRuntimeErrorEvent(),
      testCapabilityEvent(),
    ];
    for (const event of events) await queue.enqueue(event);
    const before = await queue.take(10);
    const statsBefore = await queue.stats();
    await queue.dispose();
    const reopened = openQueue();
    const after = await reopened.take(10);
    expect(after.map((record) => record.serializedEvent)).toEqual(
      before.map((record) => record.serializedEvent),
    );
    const statsAfter = await reopened.stats();
    expect(statsAfter.pendingRecords).toBe(statsBefore.pendingRecords);
    expect(statsAfter.pendingBytes).toBe(statsBefore.pendingBytes);
    // 冻结字节与直接序列化结果一致：重放同一 commandId 发送同一字节序列。
    for (let index = 0; index < events.length; index += 1) {
      expect(after[index]!.serializedEvent).toBe(
        serializeAuditTelemetryEvent(events[index]!),
      );
    }
  });

  it("treats same commandId + same bytes as an idempotent replay and refuses divergent content", async () => {
    const queue = openQueue();
    const event = testLifecycleEvent();
    expect((await queue.enqueue(event)).status).toBe("enqueued");
    const replay = await queue.enqueue(event);
    expect(replay.status).toBe("duplicate-replay");
    expect((await queue.stats()).pendingRecords).toBe(1);
    const divergent = {
      ...event,
      payload: { ...event.payload, lifecycleStatus: "failed" as const },
    };
    const conflict = await queue.enqueue(divergent);
    expect(conflict.status).toBe("command-id-conflict");
    expect((await queue.stats()).commandIdConflicts).toBe(1);
    const records = await queue.take(5);
    expect(records).toHaveLength(1);
    // 已冻结字节未被改写：仍是首次入队的 completed。
    expect(
      (
        JSON.parse(records[0]!.serializedEvent) as {
          payload: { lifecycleStatus: string };
        }
      ).payload.lifecycleStatus,
    ).toBe("completed");
  });

  it("evicts the oldest records beyond the count limit and counts droppedOldest", async () => {
    const queue = openQueue({ limits: { maxRecords: 2 } });
    const first = testLifecycleEvent();
    const second = testLifecycleEvent();
    const third = testRuntimeErrorEvent();
    await queue.enqueue(first);
    await queue.enqueue(second);
    const result = await queue.enqueue(third);
    expect(result.droppedOldest).toBe(1);
    expect(result.droppedOldestTotal).toBe(1);
    const stats = await queue.stats();
    expect(stats.pendingRecords).toBe(2);
    expect(stats.droppedOldestTotal).toBe(1);
    expect((await queue.take(10)).map((record) => record.commandId)).toEqual([
      second.commandId,
      third.commandId,
    ]);
  });

  it("evicts beyond the byte limit", async () => {
    const bigger = testRuntimeErrorEvent({ sanitizedSummary: "b".repeat(120) });
    const smaller = testRuntimeErrorEvent({ sanitizedSummary: "s".repeat(80) });
    const biggerBytes = Buffer.byteLength(
      serializeAuditTelemetryEvent(bigger),
      "utf8",
    );
    const queue = openQueue({ limits: { maxBytes: biggerBytes + 8 } });
    await queue.enqueue(bigger);
    const result = await queue.enqueue(smaller);
    expect(result.status).toBe("enqueued");
    expect(result.droppedOldest).toBe(1);
    const remaining = await queue.take(10);
    expect(remaining.map((record) => record.commandId)).toEqual([
      smaller.commandId,
    ]);
  });

  it("rejects a single oversized event without touching the queue", async () => {
    const queue = openQueue({ limits: { maxBytes: 64 } });
    const result = await queue.enqueue(testRuntimeErrorEvent());
    expect(result.status).toBe("rejected-oversized");
    expect((await queue.stats()).pendingRecords).toBe(0);
  });

  it("reports eviction via at most one unacked low-frequency overflow counter event", async () => {
    const mintTotals: number[] = [];
    let minted = 0;
    // 补报事件 commandId 用合法 UUID（schema 强制），按铸造序号确定性生成。
    const overflowFor = (n: number): AuditTelemetryEvent =>
      testRuntimeErrorEvent({
        commandId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
        channel: "diagnostic",
        errorCode: "AUDIT_QUEUE_OVERFLOW",
        sanitizedSummary: `droppedOldest=${n}`,
      });
    const queue = createAuditTelemetryDiskQueue({
      storageDirectory: directory,
      identity: IDENTITY,
      limits: { maxRecords: 3 },
      mintOverflowEvent: (total) => {
        minted += 1;
        mintTotals.push(total);
        return overflowFor(minted);
      },
    });
    const e1 = testLifecycleEvent();
    const e2 = testLifecycleEvent();
    const e3 = testLifecycleEvent();
    const e4 = testRuntimeErrorEvent();
    const e5 = testLifecycleEvent();
    const e6 = testLifecycleEvent();
    await queue.enqueue(e1);
    await queue.enqueue(e2);
    await queue.enqueue(e3);
    // e4 入队触发淘汰 e1（total=1）→ 补报事件入队又触发淘汰 e2（total=2）。
    const fourth = await queue.enqueue(e4);
    expect(fourth.droppedOldest).toBe(2);
    expect(mintTotals).toEqual([1]);
    expect((await queue.stats()).droppedOldestTotal).toBe(2);
    // 队内同时只有一条补报计数事件（低频约束）。
    const pending = await queue.take(10);
    expect(pending.filter(isOverflowRecord)).toHaveLength(1);
    const overflowCommandId = pending.find(isOverflowRecord)!.commandId;
    // ACK 后下一次淘汰才允许再补报，且携带累计计数。
    await queue.ack([overflowCommandId]);
    await queue.enqueue(e5);
    expect(mintTotals).toEqual([1]);
    await queue.enqueue(e6);
    expect(mintTotals).toEqual([1, 3]);
    const finalRecords = await queue.take(10);
    expect(finalRecords.filter(isOverflowRecord)).toHaveLength(1);
    const finalStats = await queue.stats();
    expect(finalStats.droppedOldestTotal).toBe(4);
    expect(finalStats.pendingRecords).toBe(3);
  });

  it("acks acknowledged command ids only and removes them from disk", async () => {
    const queue = openQueue();
    const first = testLifecycleEvent();
    const second = testRuntimeErrorEvent();
    await queue.enqueue(first);
    await queue.enqueue(second);
    expect(
      await queue.ack([
        "00000000-0000-4000-8000-00000000dead",
        first.commandId,
      ]),
    ).toBe(1);
    const remaining = await queue.take(10);
    expect(remaining.map((record) => record.commandId)).toEqual([
      second.commandId,
    ]);
    // 重启后确认已 ACK 记录不再恢复（文件已重写）。
    await queue.dispose();
    const reopened = openQueue();
    expect((await reopened.take(10)).map((record) => record.commandId)).toEqual(
      [second.commandId],
    );
    expect((await reopened.stats()).recoveredCorruptLines).toBe(0);
  });

  it("persists nothing when the event fails strict validation", async () => {
    const queue = openQueue();
    const invalid = {
      ...testRuntimeErrorEvent(),
      payload: {
        ...testRuntimeErrorEvent().payload,
        sanitizedSummary: "x".repeat(513),
      },
    };
    await expect(queue.enqueue(invalid)).rejects.toThrow(
      AuditTelemetryValidationError,
    );
    expect((await queue.stats()).pendingRecords).toBe(0);
  });

  it("drops a torn tail line on recovery, keeps valid frozen bytes, and rewrites the file", async () => {
    const queue = openQueue();
    const first = testLifecycleEvent();
    const second = testRuntimeErrorEvent();
    await queue.enqueue(first);
    await queue.enqueue(second);
    const before = await queue.take(10);
    await queue.dispose();
    // 模拟写中断：追加一段无换行结尾的残行。
    await appendFile(queueFilePath(), '{"schemaVersion":1,"commandId":"tor');
    const reopened = openQueue();
    const stats = await reopened.stats();
    expect(stats.recoveredCorruptLines).toBe(1);
    expect(stats.pendingRecords).toBe(2);
    const after = await reopened.take(10);
    expect(after.map((record) => record.serializedEvent)).toEqual(
      before.map((record) => record.serializedEvent),
    );
    // 文件已被原子重写为合法行 + 换行结尾，后续 append 不会拼进残行。
    const content = await readFile(queueFilePath(), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content).not.toContain('"tor');
    // 重写文件后继续入队可正常恢复读取。
    const third = testCapabilityEvent();
    await reopened.enqueue(third);
    await reopened.dispose();
    const secondReopen = openQueue();
    expect(
      (await secondReopen.take(10)).map((record) => record.commandId),
    ).toEqual([first.commandId, second.commandId, third.commandId]);
  });

  it("recovers when an unparseable line sits in the middle of the file", async () => {
    const queue = openQueue();
    const first = testLifecycleEvent();
    await queue.enqueue(first);
    await queue.dispose();
    await writeFile(queueFilePath(), "not-json\n", {
      encoding: "utf8",
      flag: "a",
    });
    const second = testRuntimeErrorEvent();
    const reopened = openQueue();
    await reopened.enqueue(second);
    const stats = await reopened.stats();
    expect(stats.recoveredCorruptLines).toBe(1);
    expect(stats.pendingRecords).toBe(2);
  });

  it("rejects invalid queue limits at construction", () => {
    expect(() =>
      createAuditTelemetryDiskQueue({
        storageDirectory: directory,
        identity: IDENTITY,
        limits: { maxRecords: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createAuditTelemetryDiskQueue({
        storageDirectory: directory,
        identity: IDENTITY,
        limits: { maxBytes: 0 },
      }),
    ).toThrow(RangeError);
  });

  it("removes the queue file only through explicit external deletion, not dispose", async () => {
    const queue = openQueue();
    await queue.enqueue(testLifecycleEvent());
    await queue.dispose();
    // dispose 不删除队列文件（跨重启保留是队列义务）；删除由注销清理流程所有者决定。
    const stats = await openQueue().stats();
    expect(stats.pendingRecords).toBe(1);
    await rm(queueFilePath(), { force: true });
  });
});
