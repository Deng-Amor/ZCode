import { createHash } from "node:crypto";
import { verifyManagedSkillBundle, type ManagedSkillTrust, type VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";
import {
  ConfidentialControllerError,
  type ControllerBootstrap,
  type ControllerIdentity,
  type ControllerPrivateChannel,
  type ControllerPrivateEvent,
  type PlatformLoginInput,
  type PlatformSessionStore,
} from "./contract.js";
import { createControllerPrivateChannel } from "./private-channel.js";
import { waitForCaller } from "./cancellation.js";
import { createControllerHttpSource } from "./http-source.js";
import { CcodePlatformAuth } from "./platform-auth.js";

const MAX_PRIVATE_CHANNELS = 16;
type LockedContent = { version: number; digest: string; skillMd: string; files: readonly { path: string; bytes: Uint8Array }[] };
type LockedStorePort = { install(verified: VerifiedManagedSkillBundle): Promise<unknown>; status(): Promise<{ state: string; current?: { version: number } }>; load(): Promise<unknown> };
type ControllerUpdateSource = { fetchUpdate(input: { currentVersion?: number }): Promise<{ kind: "envelope"; envelope: unknown } | { kind: "upToDate" }> };

/** Instantiate once for the Electron application, not once per window or Agent. */
export function createControllerApplication(options: {
  apiBaseUrl: string;
  trusts: readonly ManagedSkillTrust[];
  sessionStore?: PlatformSessionStore;
  lockedStore?: LockedStorePort;
  updateSource?: ControllerUpdateSource;
}) {
  const stateListeners = new Set<() => void>();
  const channels = new Set<ControllerPrivateChannel>();
  let disposed = false;
  let auth: CcodePlatformAuth;
  const source = createControllerHttpSource({
    apiBaseUrl: options.apiBaseUrl,
    getAccessToken: (identity, signal) => auth.getAccessToken(identity, signal),
  });
  const trust = options.trusts.find((trust) => trust.skillId === "controller");
  const updateSource =
    options.updateSource ??
    (options.lockedStore && trust
      ? {
          fetchUpdate: async ({ currentVersion }: { currentVersion?: number }) => {
            if (!identity) throw new ConfidentialControllerError("AUTH_REQUIRED");
            const grant = await source.authorize({ identity, skillId: trust.skillId, signal: generation.signal });
            if (grant.version <= (currentVersion ?? 0)) return { kind: "upToDate" as const };
            const envelope = await source.download({ identity, grant, signal: generation.signal });
            return { kind: "envelope" as const, envelope };
          },
        }
      : undefined);
  let identity: ControllerIdentity | undefined;
  let generation = new AbortController();
  let bootstrap: Promise<ControllerBootstrap> | undefined;
  let updateCheck: Promise<void> | undefined;
  const checkForUpdate = async () => {
    if (!updateSource || !options.lockedStore || !trust || updateCheck) return;
    updateCheck = (async () => {
      try {
        const status = await options.lockedStore!.status();
        const result = await updateSource.fetchUpdate({ currentVersion: status.current?.version });
        if (result.kind === "envelope") await options.lockedStore!.install(verifyManagedSkillBundle(result.envelope, trust));
      } catch {
        // 更新失败不影响现版本可用，§5.5；失败计数由后续审计遥测接入。
      }
    })();
    await updateCheck;
  };
  const assemble = async (current: ControllerIdentity, signal: AbortSignal) => {
    try {
      if (!trust) throw new ConfidentialControllerError("INVALID_RELEASE");
      const grant = await source.authorize({ identity: current, skillId: trust.skillId, signal });
      if (signal.aborted) throw new ConfidentialControllerError("IDENTITY_CHANGED");
      if (
        grant.skillId !== trust.skillId ||
        !Number.isSafeInteger(grant.version) ||
        grant.version < trust.minimumVersion ||
        !/^[a-f0-9]{64}$/.test(grant.digest) ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt <= Date.now()
      )
        throw new ConfidentialControllerError("INVALID_RELEASE");
      const envelope = await source.download({ identity: current, grant, signal });
      if (signal.aborted) throw new ConfidentialControllerError("IDENTITY_CHANGED");
      const verified = verifyManagedSkillBundle(envelope, trust);
      const digest = createHash("sha256")
        .update(Buffer.from((envelope as { payloadBase64: string }).payloadBase64, "base64"))
        .digest("hex");
      if (verified.version !== grant.version || digest !== grant.digest)
        throw new ConfidentialControllerError("INVALID_RELEASE");
      if (grant.expiresAt <= Date.now())
        throw new ConfidentialControllerError("AUTHORIZATION_EXPIRED");
      if (options.lockedStore) await options.lockedStore.install(verified);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts = verified.files.map((file) => {
        if (!/\.md$/i.test(file.path)) throw new ConfidentialControllerError("INVALID_RELEASE");
        return `## ${file.path}\n${decoder.decode(file.bytes)}`;
      });
      return Object.freeze({ version: verified.version, digest, systemPrompt: parts.join("\n\n") });
    } catch (error) {
      if (signal.aborted) throw new ConfidentialControllerError("IDENTITY_CHANGED");
      if (error instanceof ConfidentialControllerError) throw error;
      throw new ConfidentialControllerError("INVALID_RELEASE");
    }
  };
  const getBootstrap = async (): Promise<ControllerBootstrap> => {
    if (disposed) throw new ConfidentialControllerError("CANCELLED");
    await auth.restore();
    if (!identity) throw new ConfidentialControllerError("AUTH_REQUIRED");
    // 装配结果属于登录生命周期；下载授权到期不再取消后续模型执行。
    if (!bootstrap)
      bootstrap = waitForCaller(assemble(identity, generation.signal), generation.signal);
    const pending = bootstrap;
    try {
      return await pending;
    } catch (error) {
      // 旧代次失败不得清掉新登录正在装配的 Promise。
      if (bootstrap === pending) bootstrap = undefined;
      throw error;
    }
  };
  const prefetchController = async () => {
    if (trust) await getBootstrap();
  };
  auth = new CcodePlatformAuth({
    apiBaseUrl: options.apiBaseUrl,
    sessionStore: options.sessionStore,
    onIdentityChanged: (nextIdentity) => {
      // 首次恢复认证也会发布身份，但不能关闭正在等待这次恢复的启动通道。
      const hadIdentity = identity !== undefined;
      generation.abort();
      generation = new AbortController();
      identity = nextIdentity;
      bootstrap = undefined;
      updateCheck = undefined;
      if (hadIdentity) for (const channel of channels) channel.invalidate?.();
      for (const listener of stateListeners) {
        try {
          listener();
        } catch {
          /* Observers must not break identity invalidation. */
        }
      }
    },
  });

  return {
    /** Only this subset may be adapted to renderer-facing authenticated platform IPC. */
    account: Object.freeze({
      getState: async () => {
        await auth.restore();
        const state = auth.getState();
        if (state.authenticated) {
          await prefetchController();
          void checkForUpdate();
        }
        return state;
      },
      /** 平台出网通道共用认证头（M6-R1 不新增凭据；未登录抛 AUTH_REQUIRED，由调用方退避）。 */
      getAuthHeaders: async () => {
        await auth.restore();
        if (!identity) throw new ConfidentialControllerError("AUTH_REQUIRED");
        const token = await auth.getAccessToken(identity, generation.signal);
        return { authorization: `Bearer ${token}`, "tenant-id": identity.tenantId };
      },
      onStateChanged: (listener: () => void) => {
        stateListeners.add(listener);
        return () => {
          stateListeners.delete(listener);
        };
      },
      listTenants: (signal?: AbortSignal) => auth.listTenants(signal),
      login: async (input: PlatformLoginInput, signal?: AbortSignal) => {
        const state = await auth.login(input, signal);
        await prefetchController();
        void checkForUpdate();
        return state;
      },
      logout: () => auth.logout(),
    }),
    /** Private process channel only: never register on normal renderer/mobile service RPC. */
    getBootstrap,
    getLockedContent: async (): Promise<LockedContent> => {
      if (!options.lockedStore) throw new ConfidentialControllerError("AUTH_REQUIRED");
      return (await options.lockedStore.load()) as LockedContent;
    },
    /** Main may attach only a dedicated trusted child-process port, never renderer RPC. */
    createPrivateChannel: (transport: {
      send(event: ControllerPrivateEvent): void;
      close(): void;
    }) => {
      if (disposed) throw new ConfidentialControllerError("CANCELLED");
      if (channels.size >= MAX_PRIVATE_CHANNELS)
        throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
      const channel = createControllerPrivateChannel({
        getLockedContent: async () => {
          if (!options.lockedStore) throw new ConfidentialControllerError("AUTH_REQUIRED");
          return (await options.lockedStore.load()) as LockedContent;
        },
        send: (event) => transport.send(event),
        close: () => {
          channels.delete(channel);
          transport.close();
        },
      });
      channels.add(channel);
      return channel;
    },
    dispose: () => {
      disposed = true;
      for (const channel of channels) channel.dispose();
      auth.dispose();
    },
  };
}

export type ControllerApplication = ReturnType<typeof createControllerApplication>;
