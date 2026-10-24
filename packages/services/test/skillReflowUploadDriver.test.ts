import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  SkillReflowHttpUploadError,
  createSkillReflowUploadDriver,
  createSkillReflowQueueFile,
  type SkillReflowEntry,
  type SkillReflowSessionReceipt,
} from "../src/skill-reflow-upload/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skill-reflow-driver-"));
  const storage = join(root, "storage");
  await mkdir(storage, { recursive: true });
  const entryDirectory = join(root, "skill");
  await mkdir(entryDirectory, { recursive: true });
  await writeFile(join(entryDirectory, "SKILL.md"), "---\nname: test\n---\nbody\n");
  const entry: SkillReflowEntry = {
    key: "user/root/skill",
    relativePath: "skill",
    name: "test",
    sourceType: "user",
    contentDigest: "digest",
    lastModified: new Date(0).toISOString(),
    queuedAt: new Date(0).toISOString(),
    attempts: 0,
    rootId: "root",
    directoryPath: entryDirectory,
  };
  return { root, storage, entry };
}

function serviceFake(queue: { settle(keys: readonly string[]): Promise<number> }) {
  return {
    recordReceipt: vi.fn(async (receipt: SkillReflowSessionReceipt) => { await queue.settle([receipt.key]); }),
    markSending: vi.fn(),
    markNeedLogin: vi.fn(),
    markRetryableFailed: vi.fn(),
    markDone: vi.fn(),
  };
}

describe("skill reflow upload driver", () => {
  test("uploads a batch, consumes receipts, and marks done", async () => {
    const f = await fixture();
    const queue = createSkillReflowQueueFile({ storageDirectory: f.storage });
    await queue.enqueue(f.entry);
    const service = serviceFake(queue);
    const uploadSession = vi.fn(async ({ entries }: { entries: unknown[] }) =>
      entries.map((item: any) => ({ key: item.entry.key, outcome: "accepted", settledAt: new Date(0).toISOString() })),
    );
    const summary = await createSkillReflowUploadDriver({ service, queue, uploader: { uploadSession } }).run("dailyFirstLaunch");
    expect(uploadSession).toHaveBeenCalledTimes(1);
    expect(service.recordReceipt).toHaveBeenCalledTimes(1);
    expect(await queue.take(10)).toHaveLength(0);
    expect(service.markDone).toHaveBeenCalled();
    expect(summary.entriesUploaded).toBe(1);
    await queue.dispose(); await rm(f.root, { recursive: true, force: true });
  });

  test("uploads in configured batches", async () => {
    const f = await fixture(); const queue = createSkillReflowQueueFile({ storageDirectory: f.storage });
    await queue.enqueue(f.entry); await queue.enqueue({ ...f.entry, key: "user/root/skill-2", relativePath: "skill-2" }); await queue.enqueue({ ...f.entry, key: "user/root/skill-3", relativePath: "skill-3" });
    const service = serviceFake(queue); const uploadSession = vi.fn(async ({ entries }: any) => entries.map((x: any) => ({ key: x.entry.key, outcome: "accepted", settledAt: new Date(0).toISOString() })));
    const summary = await createSkillReflowUploadDriver({ service, queue, uploader: { uploadSession }, batchSize: 2 }).run("startupRetry");
    expect(uploadSession).toHaveBeenCalledTimes(2); expect(summary.sessions).toBe(2);
    await queue.dispose(); await rm(f.root, { recursive: true, force: true });
  });

  test.each([
    ["needLogin", "NEED_LOGIN", "markNeedLogin"],
    ["retryableFailed", "NETWORK_UNAVAILABLE", "markRetryableFailed"],
  ] as const)("stops on %s and retains queue", async (stopped, code, method) => {
    const f = await fixture(); const queue = createSkillReflowQueueFile({ storageDirectory: f.storage }); await queue.enqueue(f.entry); const service = serviceFake(queue);
    const uploader = { uploadSession: vi.fn(async () => { throw new SkillReflowHttpUploadError({ code, at: new Date(0).toISOString() }); }) };
    const summary = await createSkillReflowUploadDriver({ service, queue, uploader }).run("onlineHeartbeat");
    expect(summary.stopped).toBe(stopped); expect(await queue.take(10)).toHaveLength(1); expect(service[method]).toHaveBeenCalled();
    await queue.dispose(); await rm(f.root, { recursive: true, force: true });
  });

  test("fails a missing entry and continues with the rest", async () => {
    const f = await fixture(); const queue = createSkillReflowQueueFile({ storageDirectory: f.storage }); await queue.enqueue({ ...f.entry, key: "missing", directoryPath: join(f.root, "gone") }); await queue.enqueue(f.entry); const service = serviceFake(queue); const uploadSession = vi.fn(async ({ entries }: any) => entries.map((x: any) => ({ key: x.entry.key, outcome: "accepted", settledAt: new Date(0).toISOString() })));
    const summary = await createSkillReflowUploadDriver({ service, queue, uploader: { uploadSession } }).run("dailyFirstLaunch");
    expect(uploadSession).toHaveBeenCalledTimes(1); expect(summary.entriesUploaded).toBe(1); expect(await queue.take(10)).toHaveLength(1);
    await queue.dispose(); await rm(f.root, { recursive: true, force: true });
  });

  test("filterHit settles without recording to ledger through service contract", async () => {
    const f = await fixture(); const queue = createSkillReflowQueueFile({ storageDirectory: f.storage }); await queue.enqueue(f.entry); const service = serviceFake(queue); const uploadSession = vi.fn(async () => [{ key: f.entry.key, outcome: "filterHit", settledAt: new Date(0).toISOString() }]);
    const summary = await createSkillReflowUploadDriver({ service, queue, uploader: { uploadSession } }).run("dailyFirstLaunch");
    expect(service.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "filterHit" })); expect(summary.entriesUploaded).toBe(1);
    await queue.dispose(); await rm(f.root, { recursive: true, force: true });
  });
});
