import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createControllerApplication } from "../src/confidential-controller/application.js";

function fixture(options: { grantVersion?: number; currentVersion?: number } = {}) {
  const grantVersion = options.grantVersion ?? 1;
  const currentVersion = options.currentVersion ?? 1;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    skillId: "controller",
    name: "controller",
    minimumVersion: 1,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const content = Buffer.from("# locked\n");
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 1, skillId: "controller", name: "controller", version: grantVersion,
    files: [{ path: "SKILL.md", contentBase64: content.toString("base64"), sha256: createHash("sha256").update(content).digest("hex") }],
  }));
  const envelope = {
    schemaVersion: 1,
    payloadBase64: payload.toString("base64"),
    signatureBase64: sign(null, payload, privateKey).toString("base64"),
  };
  const grant = { skillId: "controller", version: grantVersion, digest: createHash("sha256").update(payload).digest("hex"), expiresAt: Date.now() + 60_000 };
  const reply = (data: unknown) => Response.json({ code: 0, data }, { headers: { "Cache-Control": "no-store" } });
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    if (url.pathname.endsWith("/authorize")) return reply(grant);
    if (url.pathname.endsWith("/content")) return reply(envelope);
    return reply({ userId: "2", accessToken: "access", refreshToken: "refresh", expiresTime: Date.now() + 60_000 });
  }));
  const loaded = { version: currentVersion, digest: grant.digest, skillMd: "# locked\n", files: [{ path: "SKILL.md", bytes: new Uint8Array(content) }] } as const;
  const store = { install: vi.fn(async () => {}), status: vi.fn(async () => ({ state: "ready", current: { version: currentVersion } })), load: vi.fn(async () => loaded) };
  const app = createControllerApplication({ apiBaseUrl: "https://login.invalid/api/", trusts: [trust], lockedStore: store, sessionStore: {
    load: async () => ({ version: 1, apiBaseUrl: "https://login.invalid/api/", tenantId: "1", userId: "2", refreshToken: "refresh" }),
    save: async () => {}, clear: async () => {},
  } });
  return { app, store, loaded };
}

describe("confidential controller locked store", () => {
  it("installs the verified bundle after assembly", async () => {
    const { app, store } = fixture();
    await app.getBootstrap();
    expect(store.install).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
  });

  it("checks the internal update source after login and installs a newer grant", async () => {
    const { app, store } = fixture({ grantVersion: 2, currentVersion: 1 });

    await app.account.login({ tenantId: "1", username: "tester", password: "password" });
    await vi.waitFor(() => expect(store.install).toHaveBeenCalledWith(expect.objectContaining({ version: 2 })));
  });

  it("does not download or install when the grant is not newer than the current version", async () => {
    const { app, store } = fixture({ grantVersion: 1, currentVersion: 1 });
    const fetcher = vi.mocked(fetch);

    await app.account.login({ tenantId: "1", username: "tester", password: "password" });
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => (url as URL).pathname.endsWith("/authorize"))).toBe(true));
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => (url as URL).pathname.endsWith("/content")).length).toBe(1));
    expect(store.install).toHaveBeenCalledOnce();
  });

  it("keeps locked content available after logout", async () => {
    const { app, store, loaded } = fixture();
    await app.getBootstrap();
    await app.account.logout();
    expect(store.install).toHaveBeenCalledOnce();
    await expect(app.getLockedContent()).resolves.toBe(loaded);
  });

  it("forwards locked content loading", async () => {
    const { app, store, loaded } = fixture();
    await expect(app.getLockedContent()).resolves.toBe(loaded);
    expect(store.load).toHaveBeenCalledOnce();
  });

  it("rejects locked content access when storage is not configured", async () => {
    const app = createControllerApplication({ apiBaseUrl: "https://login.invalid/", trusts: [] });
    await expect(app.getLockedContent()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
