import { createHash } from "node:crypto";
import { verifyManagedSkillBundle, type ManagedSkillTrust } from "@zcode/shared/managed-skills";
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

/** Instantiate once for the Electron application, not once per window or Agent. */
export function createControllerApplication(options: {
  apiBaseUrl: string;
  trusts: readonly ManagedSkillTrust[];
  sessionStore?: PlatformSessionStore;
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
  let identity: ControllerIdentity | undefined;
  let generation = new AbortController();
  let bootstrap: Promise<ControllerBootstrap> | undefined;
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
        if (state.authenticated) await prefetchController();
        return state;
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
        return state;
      },
      logout: () => auth.logout(),
    }),
    /** Private process channel only: never register on normal renderer/mobile service RPC. */
    getBootstrap,
    /** Main may attach only a dedicated trusted child-process port, never renderer RPC. */
    createPrivateChannel: (transport: {
      send(event: ControllerPrivateEvent): void;
      close(): void;
    }) => {
      if (disposed) throw new ConfidentialControllerError("CANCELLED");
      if (channels.size >= MAX_PRIVATE_CHANNELS)
        throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
      const channel = createControllerPrivateChannel({
        getBootstrap,
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
