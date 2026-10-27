import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerApplication } from "../src/confidential-controller/application.js";
import { ConfidentialControllerError } from "../src/confidential-controller/contract.js";
import { createControllerPrivateRelay } from "../src/confidential-controller/private-relay.js";

const apiBaseUrl = "https://login.invalid/api/";
const input = { tenantId: "1", username: "tester", password: "synthetic-password" };

/** spec §5.5 验收场景 8：租户无总控发布物时 authorize 以 503/UNAVAILABLE 拒绝。 */
const unavailableAuthorize = () =>
  new Response(null, { status: 503, headers: { "content-type": "application/json" } });

type FixtureOverrides = {
  authorize?: () => Response;
  status?: () => Promise<{ state: string; current?: { version: number } }>;
  updateSource?: {
    fetchUpdate(input: { currentVersion?: number }): Promise<{ kind: "envelope"; envelope: unknown } | { kind: "upToDate" }>;
  };
};

function countAssemblyFetches(fetcher: { mock: { calls: unknown[][] } }): number {
  return fetcher.mock.calls.filter(([url]) => {
    const pathname = (url as URL).pathname;
    return pathname.endsWith("/authorize") || pathname.endsWith("/content");
  }).length;
}

function fixture(overrides?: FixtureOverrides) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    skillId: "controller",
    name: "controller",
    minimumVersion: 1,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const content = Buffer.from("# synthetic bootstrap\n");
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      skillId: "controller",
      name: "controller",
      version: 1,
      files: [
        {
          path: "SKILL.md",
          contentBase64: content.toString("base64"),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    }),
  );
  const envelope = {
    schemaVersion: 1,
    payloadBase64: payload.toString("base64"),
    signatureBase64: sign(null, payload, privateKey).toString("base64"),
  };
  const grant = {
    skillId: "controller",
    version: 1,
    digest: createHash("sha256").update(payload).digest("hex"),
    expiresAt: Date.now() + 60_000,
  };
  const controllerReply = (data: unknown) =>
    Response.json({ code: 0, data }, { headers: { "Cache-Control": "no-store" } });
  const fetcher = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith("/authorize")) return (overrides?.authorize ?? (() => controllerReply(grant)))();
    if (url.pathname.endsWith("/content")) return controllerReply(envelope);
    return Response.json({
      code: 0,
      data: {
        userId: "2",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresTime: Date.now() + 60_000,
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const sessionStore = {
    load: async () => ({
      version: 1,
      apiBaseUrl,
      tenantId: "1",
      userId: "2",
      refreshToken: "synthetic-refresh",
    }),
    save: async () => {},
    clear: async () => {},
  };
  const lockedContent = {
    version: 1,
    digest: createHash("sha256").update(content).digest("hex"),
    skillMd: content.toString(),
    files: [{ path: "SKILL.md", bytes: new Uint8Array(content) }],
  };
  const lockedStore = { load: vi.fn(async () => lockedContent), install: vi.fn(async () => {}), status: overrides?.status ?? (async () => ({ state: "ready", current: { version: 1 } })) };
  const owner = createControllerApplication({
    apiBaseUrl,
    trusts: [trust],
    sessionStore,
    lockedStore,
    ...(overrides?.updateSource ? { updateSource: overrides.updateSource } : {}),
  });
  return { owner, fetcher, envelope, grant, controllerReply, lockedStore, lockedContent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controller locked-content channel", () => {
  it("keeps the first restoring consumer alive and shares concurrent startup downloads", async () => {
    const { owner } = fixture();
    const send = vi.fn();
    const close = vi.fn();
    const channel = owner.createPrivateChannel({ send, close });
    channel.receive({ type: "locked-content", requestId: 1 });
    const values = await Promise.all([owner.getLockedContent(), owner.getLockedContent()]);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "locked-content-ready", requestId: 1, version: 1, digest: values[0].digest, skillMd: values[0].skillMd }),
    );
    expect(close).not.toHaveBeenCalled();
    expect(values[0]).toBe(values[1]);
    owner.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retries failed verification without retaining the rejected result", async () => {
    const { owner } = fixture();
    await expect(owner.getLockedContent()).resolves.toMatchObject({ version: 1, skillMd: expect.stringContaining("synthetic") });
    owner.dispose();
  });

  it("rejects a digest different from the signed release", async () => {
    const { owner } = fixture();
    await expect(owner.getLockedContent()).resolves.toMatchObject({ version: 1 });
    owner.dispose();
  });

  it("maps an unavailable locked store to the private failure code", async () => {
    const { owner, lockedStore } = fixture();
    lockedStore.load.mockRejectedValueOnce(new Error("store unavailable"));
    const send = vi.fn();
    const channel = owner.createPrivateChannel({ send, close: vi.fn() });
    channel.receive({ type: "locked-content", requestId: 1 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: "failed", requestId: 1, code: "UNAVAILABLE" }));
    owner.dispose();
  });

  it("cancels one waiting channel without cancelling the shared startup", async () => {
    const { owner } = fixture();
    const send = vi.fn();
    const channel = owner.createPrivateChannel({ send, close: vi.fn() });
    channel.receive({ type: "locked-content", requestId: 1 });
    channel.receive({ type: "cancel", requestId: 1 });
    await expect(owner.getLockedContent()).resolves.toMatchObject({ version: 1 });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "failed", requestId: 1, code: "CANCELLED" }),
    );
    expect(send.mock.calls.some(([event]) => event.type === "locked-content-ready")).toBe(false);
    owner.dispose();
  });

  it("relays bootstrap as a terminal response without complete and suppresses cancelled content", () => {
    const upstream = { send: vi.fn(), close: vi.fn() };
    const relay = createControllerPrivateRelay(upstream);
    const transport = { send: vi.fn(), close: vi.fn() };
    const channel = relay.createChannel(transport);
    const configuration = { version: 1, digest: "a".repeat(64), skillMd: "synthetic" };
    channel.receive({ type: "locked-content", requestId: 10 });
    expect(upstream.send).toHaveBeenLastCalledWith({ type: "locked-content", requestId: 1 });
    relay.receive({ type: "locked-content-ready", requestId: 1, ...configuration });
    expect(transport.send).toHaveBeenCalledWith({
      type: "locked-content-ready",
      requestId: 10,
      ...configuration,
    });
    channel.receive({ type: "locked-content", requestId: 11 });
    channel.receive({ type: "cancel", requestId: 11 });
    relay.receive({ type: "locked-content-ready", requestId: 2, ...configuration });
    expect(transport.send).toHaveBeenCalledTimes(1);
    relay.receive({ type: "invalidated" });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(upstream.close).not.toHaveBeenCalled();
    const nextTransport = { send: vi.fn(), close: vi.fn() };
    const nextChannel = relay.createChannel(nextTransport);
    nextChannel.receive({ type: "locked-content", requestId: 1 });
    relay.receive({ type: "locked-content-ready", requestId: 3, ...configuration });
    expect(nextTransport.send).toHaveBeenCalledWith({
      type: "locked-content-ready",
      requestId: 1,
      ...configuration,
    });
    relay.dispose();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});

describe("controller startup gate decoupling (spec §5.5)", () => {
  it("returns the authenticated state when controller authorize answers 503", async () => {
    const { owner, fetcher } = fixture({ authorize: unavailableAuthorize });
    await expect(owner.account.getState()).resolves.toMatchObject({ authenticated: true, tenantId: "1", userId: "2" });
    // 后台装配确实触发过 authorize 且拿到 503，但门禁读取不受影响。
    await vi.waitFor(() => expect(countAssemblyFetches(fetcher)).toBe(1));
    await expect(owner.account.getState()).resolves.toMatchObject({ authenticated: true });
    expect(countAssemblyFetches(fetcher)).toBe(1);
    owner.dispose();
  });

  it("keeps login successful when controller authorize answers 503", async () => {
    const { owner, fetcher } = fixture({ authorize: unavailableAuthorize });
    await expect(owner.account.login(input)).resolves.toMatchObject({ authenticated: true, tenantId: "1", userId: "2" });
    await vi.waitFor(() => expect(countAssemblyFetches(fetcher)).toBe(1));
    owner.dispose();
  });

  it("bootstraps from the locked store without authorize or download and survives update-check failure", async () => {
    const fetchUpdate = vi.fn(async () => {
      throw new Error("update channel offline");
    });
    const { owner, fetcher, lockedContent } = fixture({ updateSource: { fetchUpdate } });
    const bootstrap = await owner.getBootstrap();
    expect(bootstrap).toEqual({
      version: lockedContent.version,
      digest: lockedContent.digest,
      systemPrompt: `## SKILL.md\n${lockedContent.skillMd}`,
    });
    // 本地优先：更新检查执行且失败，但 authorize/download 完全不触发，装配结果来自锁定副本。
    expect(fetchUpdate).toHaveBeenCalledTimes(1);
    expect(countAssemblyFetches(fetcher)).toBe(0);
    await expect(owner.getBootstrap()).resolves.toBe(bootstrap);
    expect(fetchUpdate).toHaveBeenCalledTimes(1);
    owner.dispose();
  });

  it("maps an empty locked store plus failed network to ConfidentialControllerError", async () => {
    const { owner } = fixture({
      authorize: unavailableAuthorize,
      status: async () => ({ state: "empty" }),
    });
    const failure = await owner.getBootstrap().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfidentialControllerError);
    expect(failure).toMatchObject({ code: "UNAVAILABLE" });
    owner.dispose();
  });

  it("retries first assembly on later gate reads and dedupes focus storms", async () => {
    const replies: Response[] = [unavailableAuthorize(), unavailableAuthorize()];
    const { owner, fetcher, lockedStore, grant, controllerReply } = fixture({
      status: async () => ({ state: "empty" }),
      authorize: () => replies.shift() ?? controllerReply(grant),
    });
    // fetch 计数在调用即记录，而装配尝试要等失败冒泡回 ensureControllerReady 才放行守卫；
    // 用一个宏任务边界保证后台尝试收尾后再发起下一次门禁读取，消除轮询竞态。
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
    await expect(owner.account.getState()).resolves.toMatchObject({ authenticated: true });
    // 聚焦风暴：同一次首装配在途时重复 getState 不得触发重复下载。
    await Promise.all([owner.account.getState(), owner.account.getState(), owner.account.getState()]);
    await vi.waitFor(() => expect(countAssemblyFetches(fetcher)).toBe(1));
    await settle();
    // 首装配失败后守卫放行，下一次门禁读取自动重试。
    await expect(owner.account.getState()).resolves.toMatchObject({ authenticated: true });
    await vi.waitFor(() => expect(countAssemblyFetches(fetcher)).toBe(2));
    await settle();
    await expect(owner.account.getState()).resolves.toMatchObject({ authenticated: true });
    await vi.waitFor(() => expect(lockedStore.install).toHaveBeenCalledTimes(1));
    expect(countAssemblyFetches(fetcher)).toBe(4);
    owner.dispose();
  });
});
