import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { ManagedSkillPayload } from "@zcode/shared/managed-skills";
import { createControllerApplication } from "../src/confidential-controller/application.js";

const apiBaseUrl = "https://login.invalid/api/";
const input = {
  tenantId: "1",
  username: "tester",
  password: "synthetic-password",
};
const persisted = {
  version: 1,
  apiBaseUrl,
  tenantId: "1",
  userId: "2",
  refreshToken: "refresh-old",
};

function store(initial: unknown = undefined) {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: unknown) => {
      value = structuredClone(next);
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
    value: () => value,
  };
}
function app(
  sessionStore: ReturnType<typeof store>,
  trusts: Parameters<typeof createControllerApplication>[0]["trusts"] = [],
  lockedStore?: Parameters<typeof createControllerApplication>[0]["lockedStore"],
) {
  return createControllerApplication({ apiBaseUrl, trusts, sessionStore, lockedStore });
}
// 锁定存储内存实现：install 捉住验签后的包，load 以 LockedContent 形状回放（digest 与 grant 同源计算）。
function lockedContentStore(payloadBytes: Buffer) {
  let installed:
    | { version: number; digest: string; skillMd: string; files: { path: string; bytes: Uint8Array }[] }
    | undefined;
  return {
    install: vi.fn(async (verified: { version: number; files: { path: string; bytes: Uint8Array }[] }) => {
      const skill = verified.files.find((file) => file.path === "SKILL.md") ?? verified.files[0]!;
      installed = {
        version: verified.version,
        digest: createHash("sha256").update(payloadBytes).digest("hex"),
        skillMd: Buffer.from(skill.bytes).toString("utf8"),
        files: verified.files,
      };
    }),
    status: vi.fn(async () => ({
      state: installed ? "ready" : "empty",
      ...(installed ? { current: { version: installed.version } } : {}),
    })),
    load: vi.fn(async () => {
      if (!installed) throw new Error("empty locked store");
      return installed;
    }),
  };
}
function reply(refreshToken = "refresh-new", userId = "2") {
  return Response.json({
    code: 0,
    data: {
      userId,
      accessToken: "synthetic-access",
      refreshToken,
      expiresTime: Date.now() + 60_000,
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CCode persisted login", () => {
  it("prefetches the trusted controller once after the first successful login", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const trust = {
      skillId: "controller",
      name: "总控派单",
      minimumVersion: 1,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const payload: ManagedSkillPayload = {
      schemaVersion: 1,
      skillId: trust.skillId,
      name: trust.name,
      version: 1,
      files: [
        {
          path: "SKILL.md",
          contentBase64: Buffer.from("# synthetic controller\n", "utf8").toString("base64"),
          sha256: createHash("sha256").update("# synthetic controller\n", "utf8").digest("hex"),
        },
      ],
    };
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const envelope = {
      schemaVersion: 1,
      payloadBase64: payloadBytes.toString("base64"),
      signatureBase64: sign(null, payloadBytes, privateKey).toString("base64"),
    };
    const grant = {
      skillId: trust.skillId,
      version: payload.version,
      digest: createHash("sha256").update(payloadBytes).digest("hex"),
      expiresAt: Date.now() + 60_000,
    };
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/ccode-controller/authorize")) {
        return Response.json(
          { code: 0, data: grant },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (url.pathname.endsWith("/ccode-controller/content")) {
        return Response.json(
          { code: 0, data: envelope },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return reply();
    });
    vi.stubGlobal("fetch", fetcher);
    const owner = app(store(), [trust], lockedContentStore(payloadBytes));

    expect(await owner.account.login(input)).toMatchObject({
      authenticated: true,
    });
    expect(await owner.account.getState()).toMatchObject({
      authenticated: true,
    });
    const bootstraps = await Promise.all([owner.getBootstrap(), owner.getBootstrap()]);
    expect(bootstraps[0]).toEqual({
      version: 1,
      digest: grant.digest,
      systemPrompt: "## SKILL.md\n# synthetic controller\n",
    });
    expect(bootstraps[1]).toBe(bootstraps[0]);
    vi.spyOn(Date, "now").mockReturnValue(grant.expiresAt + 360_000);
    expect(await owner.getBootstrap()).toBe(bootstraps[0]);
    const send = vi.fn();
    const close = vi.fn();
    const channel = owner.createPrivateChannel({ send, close });
    // 2026-10-27 启动门禁解耦与锁定存储架构后，私有通道的 bootstrap 事件退役：
    // 老协议消息必须显式失败（不得回退网络装配），Agent 消费改走 locked-content。
    channel.receive({ type: "bootstrap", requestId: 1 });
    expect(send).toHaveBeenCalledWith({ type: "failed", requestId: 1, code: "UNAVAILABLE" });
    channel.receive({ type: "locked-content", requestId: 2 });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "locked-content-ready",
        requestId: 2,
        version: 1,
        digest: grant.digest,
        skillMd: "# synthetic controller\n",
      }),
    );
    expect(close).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.filter(([url]) =>
        (url as URL).pathname.endsWith("/ccode-controller/authorize"),
      ),
    ).toHaveLength(1);
    await owner.account.logout();
    expect(send).toHaveBeenCalledWith({ type: "invalidated" });
    expect(close).not.toHaveBeenCalled();
    await expect(owner.getBootstrap()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(
      fetcher.mock.calls.filter(([url]) =>
        (url as URL).pathname.endsWith("/ccode-controller/content"),
      ),
    ).toHaveLength(1);
  });

  it.each([undefined, "invalid-id"])(
    "retains credentials for malformed server identity %s",
    async (userId) => {
      const saved = store(persisted);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const response = await reply().json();
          response.data.userId = userId;
          return Response.json(response);
        }),
      );
      await expect(app(saved).account.getState()).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      expect(saved.value()).toEqual(persisted);
    },
  );
  it("cannot reuse a disposed application and retains its saved credential", async () => {
    const saved = store(persisted);
    const owner = app(saved);
    owner.dispose();
    await expect(owner.account.getState()).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(owner.account.login(input)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(saved.value()).toEqual(persisted);
  });

  it("retains credentials when the server returns malformed token data", async () => {
    const saved = store(persisted);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 0, data: {} })),
    );
    await expect(app(saved).account.getState()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(saved.value()).toEqual(persisted);
  });

  it("does not publish login when clearing or saving credentials fails", async () => {
    for (const operation of ["clear", "save"] as const) {
      const saved = store();
      saved[operation].mockRejectedValueOnce(new Error("storage unavailable"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply()),
      );
      const owner = app(saved);
      await expect(owner.account.login(input)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      expect(await owner.account.getState()).toEqual({ authenticated: false });
    }
  });

  it("queues logout deletion after an already running restore save", async () => {
    const saved = store(persisted);
    const write = saved.save.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    saved.save.mockImplementation(async (value) => {
      started();
      await pending;
      await write(value);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply()),
    );
    const owner = app(saved);
    const restore = Promise.resolve(owner.account.getState()).catch((error: unknown) => error);
    await seen;
    const logout = owner.account.logout();
    release();
    await Promise.all([restore, logout]);
    expect(saved.value()).toBeUndefined();
    expect(await owner.account.getState()).toEqual({ authenticated: false });
  });

  it("restores after app disposal through the public account port and rotates credentials", async () => {
    const saved = store();
    const fetcher = vi.fn(async (_url: URL) => reply());
    vi.stubGlobal("fetch", fetcher);
    const first = app(saved);
    expect(await first.account.login(input)).toEqual({
      authenticated: true,
      tenantId: "1",
      userId: "2",
    });
    expect(saved.value()).toEqual({
      ...persisted,
      refreshToken: "refresh-new",
    });
    expect(JSON.stringify(saved.value())).not.toContain(input.password);
    expect(JSON.stringify(saved.value())).not.toContain("synthetic-access");
    first.dispose();
    expect(saved.value()).toBeDefined();
    fetcher.mockImplementation(async () => reply("refresh-rotated"));
    const second = app(saved);
    const states = await Promise.all([second.account.getState(), second.account.getState()]);
    expect(states).toEqual([
      { authenticated: true, tenantId: "1", userId: "2" },
      { authenticated: true, tenantId: "1", userId: "2" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0].pathname).toBe("/api/system/auth/refresh-token");
    expect(saved.value()).toEqual({
      ...persisted,
      refreshToken: "refresh-rotated",
    });
  });

  it("retains the encrypted credential on network failure and retries getState", async () => {
    const saved = store(persisted);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal("fetch", fetcher);
    const owner = app(saved);
    await expect(owner.account.getState()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(saved.value()).toEqual(persisted);
    expect(await owner.account.getState()).toMatchObject({
      authenticated: true,
    });
  });

  it.each([401, 403])("clears explicitly rejected credentials (%s)", async (status) => {
    const saved = store(persisted);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    expect(await app(saved).account.getState()).toEqual({
      authenticated: false,
    });
    expect(saved.value()).toBeUndefined();
  });

  it.each([429, 500, 503])("retains credentials on temporary HTTP failure (%s)", async (status) => {
    const saved = store(persisted);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    await expect(app(saved).account.getState()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(saved.value()).toEqual(persisted);
  });

  it.each([{ ...persisted, apiBaseUrl: "https://other.invalid/" }, { invalid: true }])(
    "rejects mismatched or malformed saved credentials without sending them",
    async (value) => {
      const saved = store(value);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(await app(saved).account.getState()).toEqual({
        authenticated: false,
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(saved.value()).toBeUndefined();
    },
  );

  it("logout prevents a late restore response from recreating disk or memory state", async () => {
    const saved = store(persisted);
    let finish!: (response: Response) => void;
    let started!: () => void;
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const owner = app(saved);
    const restore = Promise.resolve(owner.account.getState()).catch((error: unknown) => error);
    await seen;
    await owner.account.logout();
    finish(reply());
    await restore;
    expect(saved.value()).toBeUndefined();
    expect(await owner.account.getState()).toEqual({ authenticated: false });
  });
});
