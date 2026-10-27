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
  /** 登录验证成功后的回调（D1 设备注册挂点，2026-10-27）：fire-and-forget，
   * 异常内化不阻塞登录返回；input 含一次性密码，回调自行保证不落日志。 */
  onLoginVerified?: (input: PlatformLoginInput, state: { authenticated: boolean; tenantId?: string; userId?: string }) => void;
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
  let ensureAttempt: Promise<void> | undefined;
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
  const assembleLocked = async (signal: AbortSignal): Promise<ControllerBootstrap> => {
    try {
      if (!options.lockedStore) throw new ConfidentialControllerError("AUTH_REQUIRED");
      // §5.5 装配本地优先：已有锁定副本时装配不依赖中台在线（更新检查已在调用方后台进行），
      // 避免中台不可达把已持有合法副本的环境误判为总控不可用。
      const locked = (await options.lockedStore.load()) as LockedContent;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      // 与网络装配同一拼法，保证两条来源产出的 systemPrompt 字节一致。
      const parts = locked.files.map((file) => `## ${file.path}\n${decoder.decode(file.bytes)}`);
      return Object.freeze({ version: locked.version, digest: locked.digest, systemPrompt: parts.join("\n\n") });
    } catch (error) {
      if (signal.aborted) throw new ConfidentialControllerError("IDENTITY_CHANGED");
      // getBootstrap 对外只抛 ConfidentialControllerError：锁定存储的 ControllerLockedStoreError
      // 及读盘/解密异常在此统一包装为 UNAVAILABLE（细分错误由锁定存储状态与审计遥测承接，§5.5）；
      // 不 import 该错误类以维持本模块对锁定存储仅依赖结构化端口（LockedStorePort）的边界。
      if (error instanceof ConfidentialControllerError) throw error;
      throw new ConfidentialControllerError("UNAVAILABLE");
    }
  };
  const getBootstrap = async (): Promise<ControllerBootstrap> => {
    if (disposed) throw new ConfidentialControllerError("CANCELLED");
    await auth.restore();
    if (!identity) throw new ConfidentialControllerError("AUTH_REQUIRED");
    // 装配结果属于登录生命周期；下载授权到期不再取消后续模型执行。
    if (!bootstrap) {
      // §5.5 装配本地优先：缓存未命中先读本地锁定清单；已有副本则不经中台装配，
      // 更新检查后台进行且失败不影响返回。清单读失败不能当作「有副本」，也不能堵死首装，回退网络路径。
      let hasLocal = false;
      if (options.lockedStore) {
        try {
          hasLocal = Boolean((await options.lockedStore.status()).current);
        } catch {
          hasLocal = false;
        }
      }
      if (hasLocal) {
        await checkForUpdate().catch(() => {
          /* 更新失败不影响现版本可用（§5.5）；失败计数由后续审计遥测接入。 */
        });
        bootstrap = waitForCaller(assembleLocked(generation.signal), generation.signal);
      } else {
        bootstrap = waitForCaller(assemble(identity, generation.signal), generation.signal);
      }
    }
    const pending = bootstrap;
    try {
      return await pending;
    } catch (error) {
      // 旧代次失败不得清掉新登录正在装配的 Promise。
      if (bootstrap === pending) bootstrap = undefined;
      throw error;
    }
  };
  // §5.5 启动门禁解耦（2026-10-27 拍板）：登录门禁只反映登录态，总控装配（authorize/download/install）
  // 一律在认证成功后后台执行；装配失败（租户无发布物、403/503、验签失败、网络失败）在这里内化，
  // 由锁定存储状态与审计错误码承接，窗口聚焦或下次登录自动重试，绝不冒泡回 getState/login。
  const ensureControllerReady = (): Promise<void> => {
    // 沿用 checkForUpdate 的单飞守卫模式：聚焦风暴反复触发 getState 时，同代次只允许一次首装配在途。
    if (ensureAttempt) return ensureAttempt;
    const attemptGeneration = generation;
    ensureAttempt = (async () => {
      let assembled = false;
      try {
        const status = options.lockedStore ? await options.lockedStore.status() : undefined;
        if (status?.current) {
          await checkForUpdate().catch(() => {
            /* 更新失败不影响现版本可用（§5.5）；失败计数由后续审计遥测接入。 */
          });
        } else {
          await getBootstrap();
        }
        assembled = true;
      } catch {
        // 首装配失败状态由锁定存储/审计承接，不阻塞登录门禁；useCcodeAccount 在窗口聚焦
        // 或下次登录时会重新调 getState 进入这里自动重试。
      } finally {
        // 只有失败才放行守卫让下一次聚焦/登录重试；成功后本代次不再重复触发。
        if (!assembled && generation === attemptGeneration) ensureAttempt = undefined;
      }
    })();
    return ensureAttempt;
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
      ensureAttempt = undefined;
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
          // §5.5 启动门禁解耦：门禁成败只由会话恢复决定，总控装配后台执行且失败不冒泡。
          void ensureControllerReady();
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
        try {
          // D1 设备注册挂点（2026-10-27）：fire-and-forget，异常内化不阻塞登录；
          // input 含一次性密码，回调方自行保证不落日志（注册幂等键稳定，可下次重试）。
          options.onLoginVerified?.(input, state);
        } catch {
          /* 回调故障不影响登录结果。 */
        }
        // §5.5 启动门禁解耦：登录结果只由凭证验证决定，总控装配后台执行且失败不冒泡。
        void ensureControllerReady();
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
