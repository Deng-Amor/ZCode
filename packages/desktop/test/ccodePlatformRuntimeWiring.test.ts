import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonString } from "@zcode/services/platform-command-channel";
import { createDesktopCcodePlatformRuntimeWiring } from "../src/main/ccode-platform-runtime-wiring/index.js";
import { testPullRunLogsEnvelope } from "../../services/test/platformCommandChannelFixtures.js";

function setup() {
  let authenticated = false;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const runtime = { start: vi.fn(async () => calls.push("runtime.start")), stop: vi.fn(async () => calls.push("runtime.stop")), dispose: vi.fn(async () => calls.push("runtime.dispose")), processCommand: vi.fn(async () => ({})) };
  const transport = { start: vi.fn(async () => calls.push("transport.start")), stop: vi.fn(async () => calls.push("transport.stop")) };
  const account = {
    getState: vi.fn(async () => ({ authenticated, tenantId: "7", userId: "9" })),
    onStateChanged: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    getAuthHeaders: vi.fn(async () => ({ authorization: "Bearer token", "tenant-id": "tenant" })),
  };
  const wiring = createDesktopCcodePlatformRuntimeWiring({ account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work", createRuntime: () => runtime as never, createTransport: () => transport });
  return { account, calls, runtime, transport, wiring, login: async () => { authenticated = true; listeners.forEach((listener) => listener()); await Promise.resolve(); }, logout: async () => { authenticated = false; listeners.forEach((listener) => listener()); await Promise.resolve(); }, notify: () => { listeners.forEach((listener) => listener()); } };
}

describe("desktop CCode platform runtime wiring", () => {
  it("queues ordinary task terminal with verified skill and statistical instance attribution", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-audit-"));
    let audit: ReturnType<Parameters<Parameters<typeof createDesktopCcodePlatformRuntimeWiring>[0]["createRuntime"]>[0]["createAudit"]> | undefined;
    try {
      const s = setup();
      s.account.getState.mockImplementation(async () => ({ authenticated: true, tenantId: "7", userId: "9" }));
      let controllerVersion = 1;
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account: s.account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/",
        ccodeRelease: "0.0.9", instanceId: "00000000-0000-4000-8000-000000000001",
        getControllerAttribution: async () => ({ version: controllerVersion, digest: controllerVersion === 1 ? "a".repeat(64) : "b".repeat(64) }),
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        createRuntime: (deps) => { audit = deps.createAudit({ storageDirectory: storageRoot }, deps); return s.runtime as never; },
        createTransport: () => s.transport,
      });
      await vi.waitFor(() => expect(s.runtime.start).toHaveBeenCalled());
      await wiring.reportTaskStarted("task-1", "turn-1");
      controllerVersion = 2;
      await wiring.reportTaskTerminal("task-1", "turn-1", "success");
      const records = await audit!.queue.take(10, "lifecycle");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!.serializedEvent)).toMatchObject({
        type: "task.lifecycle", payload: { lifecycleStatus: "completed", subjectRef: { id: "task-1" } },
        attribution: { ccodeRelease: "0.0.9", skillVersion: "1", skillDigest: "a".repeat(64), instanceId: "00000000-0000-4000-8000-000000000001" },
      });
      await wiring.reportTaskTerminal("task-2", "missing-start", "success");
      expect(await audit!.queue.take(10, "lifecycle")).toHaveLength(1);
      let releaseState!: (state: { authenticated: boolean; tenantId: string; userId: string }) => void;
      s.account.getState.mockImplementationOnce(() => new Promise((resolve) => { releaseState = resolve; }));
      const started = wiring.reportTaskStarted("task-fast", "turn-fast");
      const finished = wiring.reportTaskTerminal("task-fast", "turn-fast", "success");
      releaseState({ authenticated: true, tenantId: "7", userId: "9" });
      await Promise.all([started, finished]);
      expect(await audit!.queue.take(10, "lifecycle")).toHaveLength(2);
      await wiring.dispose();
      await audit!.queue.dispose();
    } finally { await rm(storageRoot, { recursive: true, force: true }); }
  });

  it("isolates pending audit queues across account changes", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-audit-identity-"));
    let userId = "9";
    const listeners = new Set<() => void>();
    const created: Array<{ userId: string; audit: ReturnType<Parameters<NonNullable<DesktopCcodePlatformRuntimeWiringOptions["createRuntime"]>>[0]["createAudit"]> }> = [];
    const uploads: Array<{ userId: string; url: string }> = [];
    const account = {
      getState: async () => ({ authenticated: true, tenantId: "7", userId }),
      onStateChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getAuthHeaders: async () => ({ authorization: `Bearer ${userId}`, "tenant-id": "7" }),
    };
    const wiring = createDesktopCcodePlatformRuntimeWiring({
      account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/", ccodeRelease: "0.0.9",
      instanceId: "00000000-0000-4000-8000-000000000001",
      getControllerAttribution: async () => ({ version: 1, digest: "a".repeat(64) }),
      commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
      fetchImpl: async (input, init) => {
        uploads.push({ userId: new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "", url: String(input) });
        const request = JSON.parse(String(init?.body)) as { items: Array<{ commandId: string }> };
        return new Response(JSON.stringify({ code: 0, data: { results: request.items.map((item) => ({ commandId: item.commandId, status: "accepted" })) } }), { status: 200, headers: { "content-type": "application/json" } });
      },
      createRuntime: (deps) => {
        const audit = deps.createAudit({ storageDirectory: storageRoot }, deps);
        created.push({ userId, audit });
        return { auditTelemetry: audit, start: async () => undefined, stop: async () => undefined, dispose: () => audit.scheduler.dispose(), processCommand: async () => ({}) } as never;
      },
      createTransport: () => ({ start: async () => undefined, stop: async () => undefined }),
    });
    try {
      await vi.waitFor(() => expect(created).toHaveLength(1));
      await wiring.reportTaskStarted("task-a", "turn-a");
      await wiring.reportTaskTerminal("task-a", "turn-a", "success");
      expect((await created[0]!.audit.queue.stats()).pendingRecords).toBe(1);
      userId = "10"; listeners.forEach((listener) => listener());
      await vi.waitFor(() => expect(created).toHaveLength(2));
      expect(uploads.some((item) => item.url.includes("ccode-audit-telemetry") && item.userId === "10")).toBe(false);
      expect((await created[1]!.audit.queue.stats()).pendingRecords).toBe(0);
      await wiring.reportTaskStarted("task-b", "turn-b");
      await wiring.reportTaskTerminal("task-b", "turn-b", "success");
      expect((await created[1]!.audit.queue.stats()).pendingRecords).toBe(1);
      userId = "9"; listeners.forEach((listener) => listener());
      await vi.waitFor(() => expect(created).toHaveLength(3));
      expect((await created[2]!.audit.queue.stats()).pendingRecords).toBe(1);
      created[2]!.audit.scheduler.start();
      await created[2]!.audit.scheduler.notifyAuthenticated();
      expect(uploads.filter((item) => item.url.includes("ccode-audit-telemetry")).map((item) => item.userId)).toEqual(["9"]);
    } finally { await wiring.dispose(); await rm(storageRoot, { recursive: true, force: true }); }
  });

  it("starts and stops once per account transition and disposes idempotently", async () => {
    const s = setup();
    await s.login(); await new Promise((resolve) => setTimeout(resolve, 0)); await s.login();
    await s.logout(); await new Promise((resolve) => setTimeout(resolve, 0)); await s.login(); await new Promise((resolve) => setTimeout(resolve, 0));
    await s.wiring.dispose(); await s.wiring.dispose();
    expect(s.runtime.start).toHaveBeenCalledTimes(2);
    expect(s.runtime.dispose).toHaveBeenCalledTimes(2);
  });

  it("injects auth headers into transport fetch and contains lifecycle errors", async () => {
    const s = setup(); const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token"); expect(new Headers(init?.headers).get("tenant-id")).toBe("tenant"); return new Response(JSON.stringify({}), { status: 200 }); });
    const warn = vi.fn();
    const wiring = createDesktopCcodePlatformRuntimeWiring({ account: s.account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work", fetchImpl, warn, createRuntime: () => { throw new Error("start failed"); } });
    await s.login(); await new Promise((resolve) => setTimeout(resolve, 0));
    await wiring.fetch("https://example.test/", { headers: {} });
    await expect(wiring.dispose()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("builds the reflow service through the authenticated runtime factory with release attribution configured", async () => {
    // 真实 reflow service 会把当日触发标记持久化到 storageDirectory；固定路径会让
    // 同日第二次运行因 alreadyTriggeredToday 变红，并在仓库落下垃圾目录——必须用一次性临时目录。
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-reflow-"));
    try {
      const s = setup();
      let capturedDeps: { createReflow(): { runDailyFirstLaunchTrigger(): Promise<{ triggered: boolean }> } } | undefined;
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account: s.account,
        storageDirectory: join(storageRoot, "state"),
        apiBaseUrl: "https://example.test/",
        ccodeRelease: "test-release",
        commandSignerPublicKeyPem: "key",
        homeDirectory: "home",
        workingDirectory: "work",
        createRuntime: (deps) => { capturedDeps = deps as typeof capturedDeps; return s.runtime as never; },
        createTransport: () => s.transport,
      });

      await s.login();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(capturedDeps?.createReflow).toBeTypeOf("function");
      await expect(capturedDeps?.createReflow().runDailyFirstLaunchTrigger()).resolves.toMatchObject({ triggered: true });
      await wiring.dispose();
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("runs the diagnostic daily digest after an authenticated runtime starts", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-diagnostic-daily-"));
    try {
      const s = setup();
      let capturedDeps: Parameters<NonNullable<DesktopCcodePlatformRuntimeWiringOptions["createRuntime"]>>[0] | undefined;
      const builder = { build: vi.fn(async () => ({ path: "archive.zip", fileName: "archive.zip", sizeBytes: 12, digestHex: "a".repeat(64) })) };
      const runtime = { ...s.runtime, start: vi.fn(async () => { capturedDeps?.createAudit({ storageDirectory: storageRoot }, capturedDeps); }) };
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account: s.account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/",
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        diagnosticArchiveBuilder: builder,
        createRuntime: (deps) => { capturedDeps = deps; return runtime as never; },
        createTransport: () => s.transport,
      });
      await s.login();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(builder.build).toHaveBeenCalledTimes(1);
      await wiring.dispose();
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("reports an external diagnostic error after the authenticated build creates the trigger", async () => {
    const s = setup();
    const builder = { build: vi.fn(async () => ({ path: "archive.zip", fileName: "archive.zip", sizeBytes: 12, digestHex: "c".repeat(64) })) };
    const capturedDeps: { createAudit(options: { storageDirectory: string }, deps: unknown): unknown } = { createAudit: () => undefined };
    const wiring = createDesktopCcodePlatformRuntimeWiring({
      account: s.account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
      diagnosticArchiveBuilder: builder,
      createRuntime: (deps) => { capturedDeps.createAudit = deps.createAudit as typeof capturedDeps.createAudit; return { ...s.runtime, start: vi.fn(async () => { capturedDeps.createAudit({ storageDirectory: "storage" }, deps); }) } as never; },
      createTransport: () => s.transport,
    });
    await s.login();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(builder.build).toHaveBeenCalledTimes(1);
    wiring.reportDiagnosticErrorTrigger("crash_recovery");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(builder.build).toHaveBeenCalledTimes(2);
    await wiring.dispose();
  });

  it("keeps diagnostic error reporting a no-op before build and without a builder", async () => {
    const s = setup();
    const wiring = createDesktopCcodePlatformRuntimeWiring({ account: s.account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work", createTransport: () => s.transport });
    expect(() => wiring.reportDiagnosticErrorTrigger("task_failed")).not.toThrow();
    await wiring.dispose();
    expect(() => wiring.reportDiagnosticErrorTrigger("controller_bootstrap_failed")).not.toThrow();
  });

  it("triggers controller bootstrap diagnostics when a later sync fails", async () => {
    const s = setup();
    let shouldThrow = false;
    s.account.getState.mockImplementation(async () => {
      if (shouldThrow) throw new Error("prefetch failed");
      return { authenticated: true, tenantId: "tenant", userId: "user" };
    });
    const builder = { build: vi.fn(async () => ({ path: "archive.zip", fileName: "archive.zip", sizeBytes: 12, digestHex: "b".repeat(64) })) };
    const warn = vi.fn();
    let capturedDeps: Parameters<NonNullable<DesktopCcodePlatformRuntimeWiringOptions["createRuntime"]>>[0] | undefined;
    const runtime = { ...s.runtime, start: vi.fn(async () => { capturedDeps?.createAudit({ storageDirectory: "storage" }, capturedDeps); }) };
    const wiring = createDesktopCcodePlatformRuntimeWiring({ account: s.account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work", diagnosticArchiveBuilder: builder, warn, createRuntime: (deps) => { capturedDeps = deps; return runtime as never; }, createTransport: () => s.transport });
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalledTimes(1));
    shouldThrow = true;
    s.notify();
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalledTimes(2));
    expect(wiring).toBeDefined();
    await wiring.dispose();
    expect(warn).toHaveBeenCalled();
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("wires the JCS signature contract: aligned signature passes, 0.0.9 self-referential form rejected", async () => {
    // 2026-10-25 与中台对齐：验签输入=移除 signature 后的 JCS 规范化字节。
    // 回归锚点：0.0.9 的「含 signature JSON.stringify」形态必须 INVALID_SIGNATURE。
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-signature-"));
    try {
      const pair = generateKeyPairSync("ed25519");
      const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const s = setup();
      s.account.getState.mockImplementation(async () => ({ authenticated: true, tenantId: "7", userId: "9" }));
      let capturedDeps: Parameters<NonNullable<DesktopCcodePlatformRuntimeWiringOptions["createRuntime"]>>[0] | undefined;
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account: s.account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/",
        commandSignerPublicKeyPem: publicKeyPem, homeDirectory: "home", workingDirectory: "work",
        createRuntime: (deps) => { capturedDeps = deps; return s.runtime as never; },
        createTransport: () => s.transport,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const processor = capturedDeps!.createCommandChannel() as { processEnvelope(envelope: unknown): Promise<{ response: { status: string; reason?: string } }> };

      const aligned = { ...testPullRunLogsEnvelope() } as Record<string, unknown>;
      aligned.signature = "placeholder";
      const { signature: _omit, ...rest } = aligned;
      void _omit;
      aligned.signature = ed25519Sign(null, Buffer.from(canonicalJsonString(rest), "utf8"), privateKeyPem).toString("base64");
      const alignedResult = await processor.processEnvelope(aligned);
      expect(alignedResult.response.reason).not.toBe("INVALID_SIGNATURE");
      // 夹具时间是 2026-10-22（已过期），验签通过后应走 EXPIRED 拒绝——即证明签名被接受。
      expect(alignedResult.response.reason).toBe("EXPIRED");

      const selfReferential = { ...testPullRunLogsEnvelope(), signature: "placeholder" } as Record<string, unknown>;
      selfReferential.signature = ed25519Sign(null, Buffer.from(JSON.stringify(selfReferential), "utf8"), privateKeyPem).toString("base64");
      const legacyResult = await processor.processEnvelope(selfReferential);
      expect(legacyResult.response.reason).toBe("INVALID_SIGNATURE");
      await wiring.dispose();
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("uploads receipts and persists the poll cursor across rebuilds", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-receipts-"));
    try {
      const pollUrls: string[] = [];
      const receiptPosts: { url: string; body: unknown }[] = [];
      let pollCount = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/poll")) {
          pollUrls.push(url);
          pollCount += 1;
          // 首轮回传一个信封（触发回执），后续空轮（维持游标）；10ms 延迟避免热循环。
          await new Promise((resolve) => setTimeout(resolve, 10));
          const payload = pollCount === 1
            ? { envelopes: [{ envelopeVersion: 1 }], nextCursor: "cursor-1" }
            : { envelopes: [], nextCursor: "cursor-1" };
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
        }
        receiptPosts.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      });
      const account = {
        getState: vi.fn(async () => ({ authenticated: true, tenantId: "7", userId: "9" })),
        onStateChanged: () => () => undefined,
        getAuthHeaders: vi.fn(async () => ({ authorization: "Bearer t", "tenant-id": "7" })),
      };
      let runtimeDeps: { startTransport(): Promise<void>; stopTransport(): Promise<void> } | undefined;
      const runtime = {
        start: vi.fn(async () => { await runtimeDeps?.startTransport(); }),
        stop: vi.fn(async () => { await runtimeDeps?.stopTransport(); }),
        dispose: vi.fn(async () => undefined),
        processCommand: vi.fn(async () => ({
          response: { status: "executed", commandId: "cmd-1", resultRef: "ref-1" },
          serializedResponse: '{"status":"executed","commandId":"cmd-1","resultRef":"ref-1"}',
          replay: false,
        })),
      };
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/admin-api/",
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        minEmptyPollIntervalMs: 10,
        createRuntime: (deps) => { runtimeDeps = deps as typeof runtimeDeps; return runtime as never; },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await wiring.dispose();
      // 回执上行：POST receipts，体含固定键序响应对象。
      expect(receiptPosts.length).toBeGreaterThanOrEqual(1);
      expect(receiptPosts[0]!.url).toBe("https://example.test/admin-api/system/ccode-commands/receipts");
      expect(receiptPosts[0]!.body).toEqual({
        schemaVersion: 1,
        receipts: [{ status: "executed", commandId: "cmd-1", resultRef: "ref-1" }],
      });
      // 游标持久化：落盘后跨 wiring 重建作为初始 cursor 回传。
      await expect(readFile(join(storageRoot, "command-channel", "cursor.txt"), "utf8")).resolves.toBe("cursor-1");
      const secondPollUrls: string[] = [];
      const fetch2 = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/poll")) {
          secondPollUrls.push(url);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new Response(JSON.stringify({ envelopes: [], nextCursor: "cursor-1" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      });
      let deps2: { startTransport(): Promise<void>; stopTransport(): Promise<void> } | undefined;
      const wiring2 = createDesktopCcodePlatformRuntimeWiring({
        account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/admin-api/",
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        fetchImpl: fetch2 as unknown as typeof fetch,
        minEmptyPollIntervalMs: 10,
        createRuntime: (deps) => { deps2 = deps as typeof deps2; return { ...runtime, start: vi.fn(async () => { await deps2?.startTransport(); }), stop: vi.fn(async () => { await deps2?.stopTransport(); }) } as never; },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await wiring2.dispose();
      expect(secondPollUrls.length).toBeGreaterThanOrEqual(1);
      expect(secondPollUrls[0]!).toContain("cursor=cursor-1");
      expect(pollUrls[0]!).not.toContain("cursor=");
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
