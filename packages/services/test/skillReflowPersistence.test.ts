import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillReflowLedgerFile,
  createSkillReflowQueueFile,
  SKILL_REFLOW_LEDGER_FILE_NAME,
  SKILL_REFLOW_QUEUE_FILE_NAME,
} from "../src/skill-reflow-upload/index.js";
import type { SkillReflowEntry } from "../src/skill-reflow-upload/index.js";
import {
  makeSkillReflowTestDirectory,
  removeSkillReflowTestDirectory,
} from "./skillReflowUploadFixtures.js";

/**
 * 去重账本与上传队列持久化单测（spec §6.3 增量判定 / §6.4 失败重试与不阻塞）：
 * 验收场景 2（内容不变零请求）、3（队列恢复无重复条目）、5（变更入队）的本地层判据。
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

function queueEntry(overrides: Partial<SkillReflowEntry> = {}): SkillReflowEntry {
  return {
    key: "user/root/alpha",
    relativePath: "alpha",
    name: "alpha",
    sourceType: "user",
    contentDigest: "6a".repeat(32),
    lastModified: "2026-10-22T08:00:00.000Z",
    queuedAt: "2026-10-22T08:00:01.000Z",
    attempts: 0,
    rootId: "root",
    directoryPath: "/skills/alpha",
    ...overrides,
  };
}

function openQueue(storageDirectory = directory) {
  return createSkillReflowQueueFile({ storageDirectory, logger: quietLogger });
}

function openLedger(storageDirectory = directory) {
  return createSkillReflowLedgerFile({ storageDirectory, logger: quietLogger });
}

describe("skill reflow dedup ledger", () => {
  it("roundtrips accepted digests and persists them across reopen", async () => {
    const ledger = openLedger();
    await ledger.recordAccepted("user/root/alpha", "6a".repeat(32), "2026-10-22T08:01:00Z");
    await ledger.recordAccepted("project/root/beta", "6b".repeat(32), "2026-10-22T08:02:00Z");
    await ledger.dispose();
    const reopened = openLedger();
    expect(await reopened.getAccepted("user/root/alpha")).toEqual({
      contentDigest: "6a".repeat(32),
      uploadedAt: "2026-10-22T08:01:00Z",
    });
    expect(await reopened.getAccepted("project/root/beta")).toEqual({
      contentDigest: "6b".repeat(32),
      uploadedAt: "2026-10-22T08:02:00Z",
    });
    expect(await reopened.getAccepted("user/root/missing")).toBeUndefined();
    await reopened.dispose();
  });

  it("updates the accepted digest when content changes (变更即新基准)", async () => {
    const ledger = openLedger();
    await ledger.recordAccepted("user/root/alpha", "6a".repeat(32), "2026-10-22T08:01:00Z");
    await ledger.recordAccepted("user/root/alpha", "6c".repeat(32), "2026-10-23T08:01:00Z");
    expect(await ledger.getAccepted("user/root/alpha")).toEqual({
      contentDigest: "6c".repeat(32),
      uploadedAt: "2026-10-23T08:01:00Z",
    });
    await ledger.dispose();
  });

  it("prunes only absent keys and returns the pruned count (spec §6.3 本地过期清理)", async () => {
    const ledger = openLedger();
    await ledger.recordAccepted("user/root/alpha", "6a".repeat(32), "2026-10-22T08:01:00Z");
    await ledger.recordAccepted("user/root/deleted", "6b".repeat(32), "2026-10-22T08:02:00Z");
    expect(await ledger.pruneAbsent(["user/root/alpha"])).toBe(1);
    expect(await ledger.getAccepted("user/root/deleted")).toBeUndefined();
    expect(await ledger.getAccepted("user/root/alpha")).toBeDefined();
    // 幂等：再次清理为 0；持久化后重开仍是清理后的状态。
    expect(await ledger.pruneAbsent(["user/root/alpha"])).toBe(0);
    await ledger.dispose();
    const reopened = openLedger();
    expect(await reopened.getAccepted("user/root/deleted")).toBeUndefined();
    await reopened.dispose();
  });
});

describe("skill reflow upload queue", () => {
  it("recovers identical entries across restart (场景 3 无重复条目)", async () => {
    const queue = openQueue();
    await queue.enqueue(queueEntry({ key: "user/root/alpha", relativePath: "alpha" }));
    await queue.enqueue(
      queueEntry({
        key: "project/root/beta",
        relativePath: "beta",
        sourceType: "workspace",
        contentDigest: "6b".repeat(32),
      }),
    );
    await queue.fail("user/root/alpha", "NETWORK_UNAVAILABLE", "2026-10-22T08:05:00Z");
    const before = await queue.take(10);
    await queue.dispose();

    const reopened = openQueue();
    const after = await reopened.take(10);
    expect(after).toEqual(before);
    expect(after.find((item) => item.key === "user/root/alpha")).toMatchObject({
      attempts: 1,
      lastError: { code: "NETWORK_UNAVAILABLE", at: "2026-10-22T08:05:00Z" },
    });
    await reopened.dispose();
  });

  it("keeps at most one entry per key and digest (同 key 同 digest 幂等)", async () => {
    const queue = openQueue();
    const entry = queueEntry();
    await queue.enqueue(entry);
    await queue.enqueue({ ...entry, queuedAt: "2026-10-22T09:00:00.000Z" });
    const items = await queue.take(10);
    expect(items).toHaveLength(1);
    // 幂等命中保留首入队时刻（不刷新 queuedAt）。
    expect(items[0]!.queuedAt).toBe(entry.queuedAt);
    await queue.dispose();
  });

  it("replaces the entry and resets retry state when the digest changes (场景 5 全量重传)", async () => {
    const queue = openQueue();
    await queue.enqueue(queueEntry());
    await queue.fail("user/root/alpha", "RATE_LIMITED", "2026-10-22T08:05:00Z");
    await queue.enqueue(
      queueEntry({
        contentDigest: "6d".repeat(32),
        queuedAt: "2026-10-23T08:00:00.000Z",
      }),
    );
    const items = await queue.take(10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      contentDigest: "6d".repeat(32),
      attempts: 0,
      queuedAt: "2026-10-23T08:00:00.000Z",
    });
    expect(items[0]!.lastError).toBeUndefined();
    await queue.dispose();
  });

  it("keeps FIFO order in take(limit) without dequeuing", async () => {
    const queue = openQueue();
    await queue.enqueue(queueEntry({ key: "user/root/a", relativePath: "a", queuedAt: "T1" }));
    await queue.enqueue(queueEntry({ key: "user/root/b", relativePath: "b", queuedAt: "T2" }));
    await queue.enqueue(queueEntry({ key: "user/root/c", relativePath: "c", queuedAt: "T3" }));
    expect((await queue.take(2)).map((item) => item.key)).toEqual([
      "user/root/a",
      "user/root/b",
    ]);
    expect((await queue.take(10)).map((item) => item.key)).toEqual([
      "user/root/a",
      "user/root/b",
      "user/root/c",
    ]);
    await queue.dispose();
  });

  it("settles by key and ignores unknown keys", async () => {
    const queue = openQueue();
    await queue.enqueue(queueEntry({ key: "user/root/a", relativePath: "a" }));
    await queue.enqueue(queueEntry({ key: "user/root/b", relativePath: "b" }));
    expect(await queue.settle(["user/root/a", "user/root/ghost"])).toBe(1);
    expect((await queue.take(10)).map((item) => item.key)).toEqual(["user/root/b"]);
    // 已出队 key 再 settle 为 0（幂等）。
    expect(await queue.settle(["user/root/a"])).toBe(0);
    await queue.dispose();
  });

  it("fails by key with fixed error codes and ignores unknown keys", async () => {
    const queue = openQueue();
    await queue.enqueue(queueEntry());
    await queue.fail("user/root/ghost", "IO_FAILED", "T1");
    await queue.fail("user/root/alpha", "NEED_LOGIN", "T2");
    const [item] = await queue.take(10);
    expect(item).toMatchObject({
      attempts: 1,
      lastError: { code: "NEED_LOGIN", at: "T2" },
    });
    await queue.dispose();
  });

  it("resets a corrupted queue file to empty instead of failing the session", async () => {
    await writeFile(
      join(directory, SKILL_REFLOW_QUEUE_FILE_NAME),
      "{not-json",
      "utf8",
    );
    const queue = openQueue();
    expect(await queue.take(10)).toEqual([]);
    await queue.enqueue(queueEntry());
    expect((await queue.take(10)).length).toBe(1);
    await queue.dispose();
  });

  it("resets a corrupted ledger file to empty (全量重传由中台幂等兜底)", async () => {
    await writeFile(
      join(directory, SKILL_REFLOW_LEDGER_FILE_NAME),
      "{not-json",
      "utf8",
    );
    const ledger = openLedger();
    expect(await ledger.getAccepted("user/root/alpha")).toBeUndefined();
    await ledger.recordAccepted("user/root/alpha", "6a".repeat(32), "T");
    expect(await ledger.getAccepted("user/root/alpha")).toBeDefined();
    await ledger.dispose();
  });
});
