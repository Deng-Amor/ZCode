import { describe, expect, it, vi } from "vitest";
import { createDesktopCcodePlatformRuntimeWiring } from "../src/main/ccode-platform-runtime-wiring/index.js";

function setup() {
  let authenticated = false;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const runtime = { start: vi.fn(async () => calls.push("runtime.start")), stop: vi.fn(async () => calls.push("runtime.stop")), dispose: vi.fn(async () => calls.push("runtime.dispose")), processCommand: vi.fn(async () => ({})) };
  const transport = { start: vi.fn(async () => calls.push("transport.start")), stop: vi.fn(async () => calls.push("transport.stop")) };
  const account = {
    getState: vi.fn(async () => ({ authenticated })),
    onStateChanged: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    getAuthHeaders: vi.fn(async () => ({ authorization: "Bearer token", "tenant-id": "tenant" })),
  };
  const wiring = createDesktopCcodePlatformRuntimeWiring({ account, storageDirectory: "storage", apiBaseUrl: "https://example.test/", commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work", createRuntime: () => runtime as never, createTransport: () => transport });
  return { account, calls, runtime, transport, wiring, login: async () => { authenticated = true; listeners.forEach((listener) => listener()); await Promise.resolve(); }, logout: async () => { authenticated = false; listeners.forEach((listener) => listener()); await Promise.resolve(); }, notify: () => { listeners.forEach((listener) => listener()); } };
}

describe("desktop CCode platform runtime wiring", () => {
  it("starts and stops once per account transition and disposes idempotently", async () => {
    const s = setup();
    await s.login(); await new Promise((resolve) => setTimeout(resolve, 0)); await s.login();
    await s.logout(); await new Promise((resolve) => setTimeout(resolve, 0)); await s.login(); await new Promise((resolve) => setTimeout(resolve, 0));
    await s.wiring.dispose(); await s.wiring.dispose();
    expect(s.runtime.start).toHaveBeenCalledTimes(2);
    expect(s.runtime.stop).toHaveBeenCalledTimes(2);
    expect(s.runtime.dispose).toHaveBeenCalledTimes(1);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    shouldThrow = true;
    s.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wiring).toBeDefined();
    await wiring.dispose();
    expect(warn).toHaveBeenCalled();
    expect(builder.build).toHaveBeenCalledTimes(2);
  });
});
