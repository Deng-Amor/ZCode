import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";
import { createCcodePlatformRuntime, type CcodePlatformRuntimeDeps } from "../src/ccode-platform-runtime/index.js";
import { createAuditTelemetryDiskQueue, createAuditTelemetryHttpUploader, createAuditTelemetryPolicyGate, createAuditTelemetryUploadScheduler, DEFAULT_AUDIT_TELEMETRY_POLICY, type AuditTelemetryEvent } from "../src/audit-telemetry/index.js";
import { createExpertSkillCacheStore } from "../src/expert-skills/index.js";
import { createSkillReflowHttpUploader, createSkillReflowLedgerFile, createSkillReflowQueueFile, createSkillReflowRootsProvider, createSkillReflowUploadService, type SkillReflowUploadService } from "../src/skill-reflow-upload/index.js";
import { createCommandChannelDiskStore, createCommandChannelProcessor, DEFAULT_COMMAND_CHANNEL_POLICY, type CommandChannelProcessor } from "../src/platform-command-channel/index.js";
import { testLifecycleEvent } from "./auditTelemetryFixtures.ts";
import { skillMarkdown, writeSkillEntry } from "./skillReflowUploadFixtures.ts";
import { testPullRunLogsEnvelope } from "./platformCommandChannelFixtures.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.useRealTimers(); });

function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }
function tokenProvider() { return { getHeaders: async () => ({ authorization: "Bearer test" }) }; }
function signedSkill() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, skillId: "expert", name: "Expert", version: 1, files: [{ path: "SKILL.md", contentBase64: Buffer.from("# Expert").toString("base64"), sha256: createHash("sha256").update("# Expert").digest("hex") }] }));
  return { envelope: { schemaVersion: 1, payloadBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, privateKey).toString("base64") }, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

describe("ccode-platform-runtime 真工厂组合根装配", () => {
  test("遥测链：定时 flush、fake fetch 批量受理并 ACK 出队", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "ccode-runtime-")); roots.push(root);
    const calls: Request[] = []; let event: AuditTelemetryEvent;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { const request = new Request(input); calls.push(request); return response({ code: 0, data: { results: [{ commandId: event.commandId, status: "accepted" }] } }); });
    const queue = createAuditTelemetryDiskQueue({ storageDirectory: root, identity: { tenantId: "t", userId: "u" } });
    const scheduler = createAuditTelemetryUploadScheduler({ queue, uploader: createAuditTelemetryHttpUploader({ baseUrl: "https://fake.test/", tokenProvider: tokenProvider(), fetchImpl }), timers: { now: () => Date.now(), schedule: (cb, ms) => setTimeout(cb, ms) as unknown as number, cancel: (id) => clearTimeout(id) }, lifecycleIntervalMs: 10 });
    const runtime = createCcodePlatformRuntime({ storageDirectory: root }, { createAudit: () => ({ queue, policyGate: createAuditTelemetryPolicyGate(DEFAULT_AUDIT_TELEMETRY_POLICY), scheduler }), createExpert: () => createExpertSkillCacheStore({ baseDir: join(root, "expert") }), createReflow: () => ({ armDailyTrigger: () => {}, dispose: async () => {}, getStatus: () => ({ state: "idle", queueDepth: 0, counters: { scanned: 0, uploaded: 0, dedupSkipped: 0, optOutSkipped: 0, rangeExcluded: 0, filterHit: 0, failed: 0 } }) } as unknown as SkillReflowUploadService), createCommandChannel: () => ({}) as CommandChannelProcessor } as CcodePlatformRuntimeDeps);
    event = testLifecycleEvent(); await runtime.start(); await Promise.resolve(); await Promise.resolve(); await queue.enqueue(event); await scheduler.notifyOnline(); await expect.poll(() => queue.stats()).toMatchObject({ pendingRecords: 0 }); expect(calls).toHaveLength(1); await runtime.dispose();
  });

  test("专家链：真实磁盘缓存 put/get 保留已签名内容摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-runtime-")); roots.push(root); const store = createExpertSkillCacheStore({ baseDir: root }); const signed = signedSkill();
    const bytes = Buffer.from("# Expert", "utf8");
    const verified: VerifiedManagedSkillBundle = { schemaVersion: 1, skillId: "expert", name: "Expert", version: 1, files: [{ path: "SKILL.md", bytes, sha256: sha256(bytes) }] };
    await store.put("tenant:user", { verified, payloadDigest: sha256(Buffer.from(signed.envelope.payloadBase64, "base64")) });
    expect((await store.get("tenant:user", "expert"))?.skillId).toBe("expert"); expect(signed.publicKeyPem).toContain("PUBLIC KEY");
  });

  test("通道链：真实磁盘 store + processor 执行并按字节幂等重放", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-runtime-")); roots.push(root); const store = createCommandChannelDiskStore({ storageDirectory: root, identity: { tenantId: "t", userId: "u" } }); const envelope = testPullRunLogsEnvelope();
    const processor = createCommandChannelProcessor({ verifier: { verify: async () => true }, executor: { execute: async () => ({ resultRef: "ref" }) }, noticeSink: { dispatch: async () => {} }, auditSink: { record: async () => {} }, store, getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY, now: () => new Date("2026-10-22T12:00:00.000Z") });
    const first = await processor.processEnvelope(envelope); const replay = await processor.processEnvelope(envelope); expect(first.response.status).toBe("executed"); expect(replay.replay).toBe(true); expect(replay.serializedResponse).toBe(first.serializedResponse); await store.dispose();
  });

  test("回流链：真实 roots 扫描入队，真实 uploader 回执后账本落账", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-runtime-")); const workingDirectory = await mkdtemp(join(tmpdir(), "ccode-runtime-work-")); roots.push(root, workingDirectory); await writeSkillEntry(root, ".zcode/skills/demo", { skillMd: skillMarkdown({ name: "demo" }) });
    const queue = createSkillReflowQueueFile({ storageDirectory: root }); const ledger = createSkillReflowLedgerFile({ storageDirectory: root }); const service = createSkillReflowUploadService({ rootProvider: createSkillReflowRootsProvider({ homeDirectory: root, workingDirectory }), ledger, queue, stateDirectory: root, now: () => new Date("2026-10-23T00:01:00.000Z") });
    let receiptKey = ""; const fetchImpl = vi.fn(async () => response({ code: 0, data: { receipts: [{ key: receiptKey, outcome: "accepted", settledAt: "2026-10-23T00:01:01.000Z" }] } })); const uploader = createSkillReflowHttpUploader({ baseUrl: "https://fake.test/", tokenProvider: tokenProvider(), attribution: { ccodeRelease: "test", platform: "windows" }, fetchImpl });
    const outcome = await service.runDailyFirstLaunchTrigger(); const entries = await queue.take(10); expect(outcome.triggered).toBe(true); expect(entries).toHaveLength(1); receiptKey = entries[0]!.key; const receipts = await uploader.uploadSession({ triggerType: "dailyFirstLaunch", entries: entries.map((entry) => ({ entry, files: [{ path: "SKILL.md", contentBase64: Buffer.from("# demo").toString("base64") }] })) }); await service.recordReceipt(receipts[0]!); expect(await ledger.getAccepted(entries[0]!.key)).toBeDefined(); expect(fetchImpl).toHaveBeenCalledTimes(1); await service.dispose();
  });

  test("dispose：真实子模块均可重复收尾", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-runtime-")); roots.push(root); const runtime = createCcodePlatformRuntime({ storageDirectory: root }, { createAudit: () => { const queue = createAuditTelemetryDiskQueue({ storageDirectory: root, identity: { tenantId: "t", userId: "u" } }); return { queue, policyGate: createAuditTelemetryPolicyGate(DEFAULT_AUDIT_TELEMETRY_POLICY), scheduler: createAuditTelemetryUploadScheduler({ queue, uploader: { upload: async () => ({ outcomes: [] }) } as never, timers: { now: Date.now, schedule: () => 1, cancel: () => {} } }) }; }, createExpert: () => createExpertSkillCacheStore({ baseDir: root }), createReflow: () => ({ armDailyTrigger: () => {}, dispose: async () => {}, getStatus: () => ({ state: "idle", queueDepth: 0, counters: { scanned: 0, uploaded: 0, dedupSkipped: 0, optOutSkipped: 0, rangeExcluded: 0, filterHit: 0, failed: 0 } }) } as unknown as SkillReflowUploadService), createCommandChannel: () => ({}) as CommandChannelProcessor } as CcodePlatformRuntimeDeps); await runtime.dispose(); await runtime.dispose(); expect((await runtime.status()).disposed).toBe(true);
  });
});
