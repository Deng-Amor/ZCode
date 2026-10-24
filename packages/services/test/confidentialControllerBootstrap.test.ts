import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerApplication } from "../src/confidential-controller/application.js";
import { createControllerPrivateRelay } from "../src/confidential-controller/private-relay.js";

const apiBaseUrl = "https://login.invalid/api/";
const input = { tenantId: "1", username: "tester", password: "synthetic-password" };

function fixture() {
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
    if (url.pathname.endsWith("/authorize")) return controllerReply(grant);
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
  const lockedStore = { load: vi.fn(async () => lockedContent), install: async () => {}, status: async () => ({ state: "ready", current: { version: 1 } }) };
  const owner = createControllerApplication({ apiBaseUrl, trusts: [trust], sessionStore, lockedStore });
  return { owner, fetcher, envelope, grant, controllerReply, lockedStore };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controller locked-content channel", () => {
  it("keeps the first restoring consumer alive and shares concurrent startup downloads", async () => {
    const { owner, fetcher } = fixture();
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
    const { owner, envelope } = fixture();
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
