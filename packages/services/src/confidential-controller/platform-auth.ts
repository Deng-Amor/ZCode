import { randomUUID } from "node:crypto";
import { waitForCaller } from "./cancellation.js";
import {
  ConfidentialControllerError,
  type ControllerIdentity,
  type PlatformAuthOptions,
  type PlatformLoginInput,
  type PlatformLoginState,
  type PlatformTenant,
  type PlatformSessionStore,
  type PlatformStoredSession,
} from "./contract.js";

interface LoginSession {
  identity: ControllerIdentity;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Private auth owner. Only refresh credentials enter the optional OS-encrypted store. */
export class CcodePlatformAuth {
  #base: URL;
  #session?: LoginSession;
  #lifetime = new AbortController();
  #refresh?: Promise<void>;
  #onIdentityChanged: PlatformAuthOptions["onIdentityChanged"];
  #store?: PlatformSessionStore;
  #storageQueue: Promise<void> = Promise.resolve();
  #restored = false;
  #restoring?: Promise<void>;
  #disposed = false;

  constructor(options: PlatformAuthOptions) {
    this.#base = new URL(options.apiBaseUrl);
    if (
      this.#base.protocol !== "https:" ||
      this.#base.username ||
      this.#base.password ||
      this.#base.search ||
      this.#base.hash
    )
      throw new ConfidentialControllerError("INVALID_RELEASE");
    if (!this.#base.pathname.endsWith("/")) this.#base.pathname += "/";
    this.#onIdentityChanged = options.onIdentityChanged;
    this.#store = options.sessionStore;
  }

  getState(): PlatformLoginState {
    const identity = this.#session?.identity;
    return identity
      ? { authenticated: true, tenantId: identity.tenantId, userId: identity.userId }
      : { authenticated: false };
  }

  /** 合并多窗口启动读取；服务器验证前不把磁盘身份当作已登录。 */
  async restore(): Promise<void> {
    this.#checkActive();
    if (this.#restoring) return this.#restoring;
    if (this.#restored) return;
    this.#restored = true;
    const lifetime = this.#lifetime.signal;
    const restoring = (async () => {
      try {
        const saved = await this.#storage(() => this.#store?.load());
        this.#checkLifetime(lifetime);
        if (saved === undefined) return;
        if (!isStoredSession(saved, this.#base.href))
          throw new ConfidentialControllerError("AUTH_REQUIRED");
        const data = await this.#request("system/auth/refresh-token", {
          tenantId: saved.tenantId,
          contentType: "application/x-www-form-urlencoded",
          body: new URLSearchParams({ refreshToken: saved.refreshToken }).toString(),
          signal: lifetime,
        });
        this.#checkLifetime(lifetime);
        const tokens = readTokens(data);
        if (!isRecord(data) || !isId(data.userId))
          throw new ConfidentialControllerError("UNAVAILABLE");
        if (String(data.userId) !== saved.userId)
          throw new ConfidentialControllerError("AUTH_REQUIRED");
        const session = {
          identity: {
            tenantId: saved.tenantId,
            userId: saved.userId,
            loginId: randomUUID(),
          },
          ...tokens,
        };
        await this.#save(session, lifetime);
        this.#checkLifetime(lifetime);
        this.#session = session;
        this.#onIdentityChanged(session.identity);
      } catch (error) {
        this.#checkLifetime(lifetime);
        if (error instanceof ConfidentialControllerError && error.code === "AUTH_REQUIRED") {
          // 明确无效才删除；网络异常不能让下次启动失去可重试的刷新凭据。
          this.clear();
          await this.#storage(() => this.#store?.clear());
          return;
        }
        this.#restored = false;
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
    })();
    this.#restoring = restoring;
    try {
      await restoring;
    } finally {
      if (this.#restoring === restoring) this.#restoring = undefined;
    }
  }

  #storage<T>(run: () => T | Promise<T>): Promise<T> {
    const operation = this.#storageQueue.then(run);
    this.#storageQueue = operation.then(
      () => {},
      () => {},
    );
    return operation.catch(() => {
      throw new ConfidentialControllerError("UNAVAILABLE");
    });
  }

  async #save(session: LoginSession, lifetime: AbortSignal): Promise<void> {
    await this.#storage(async () => {
      this.#checkLifetime(lifetime);
      await this.#store?.save({
        version: 1,
        apiBaseUrl: this.#base.href,
        tenantId: session.identity.tenantId,
        userId: session.identity.userId,
        refreshToken: session.refreshToken,
      });
    });
  }

  async listTenants(signal?: AbortSignal): Promise<PlatformTenant[]> {
    this.#checkActive();
    const data = await this.#request("system/tenant/simple-list", { method: "GET", signal });
    if (!Array.isArray(data) || data.length > 2000)
      throw new ConfidentialControllerError("UNAVAILABLE");
    return data.map((tenant: unknown) => {
      if (
        !isRecord(tenant) ||
        !isId(tenant.id) ||
        typeof tenant.name !== "string" ||
        tenant.name.length > 256
      ) {
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
      return { id: String(tenant.id), name: tenant.name };
    });
  }

  async login(input: PlatformLoginInput, signal?: AbortSignal): Promise<PlatformLoginState> {
    this.#checkActive();
    if (signal?.aborted) throw new ConfidentialControllerError("CANCELLED");
    if (
      !isId(input.tenantId) ||
      !input.username ||
      !input.password ||
      input.username.length > 128 ||
      input.password.length > 1024 ||
      (input.captchaVerification?.length ?? 0) > 8192
    ) {
      throw new ConfidentialControllerError("AUTH_REQUIRED");
    }
    this.clear();
    const lifetime = this.#lifetime.signal;
    // 清除旧身份先排入同一写入队列，避免旧登录在新登录失败后从磁盘复活。
    await this.#storage(() => this.#store?.clear());
    this.#checkLifetime(lifetime);
    const data = await this.#request("system/auth/login", {
      tenantId: input.tenantId,
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        captchaVerification: input.captchaVerification,
      }),
      signal: AbortSignal.any([lifetime, ...(signal ? [signal] : [])]),
    });
    this.#checkLifetime(lifetime);
    if (signal?.aborted) throw new ConfidentialControllerError("CANCELLED");
    const tokens = readTokens(data);
    if (!isRecord(data) || !isId(data.userId))
      throw new ConfidentialControllerError("AUTH_REQUIRED");
    const identity = Object.freeze({
      tenantId: input.tenantId,
      userId: String(data.userId),
      loginId: randomUUID(),
    });
    const session = { identity, ...tokens };
    await this.#save(session, lifetime);
    this.#checkLifetime(lifetime);
    if (signal?.aborted) {
      // 写入期间取消也必须删除该次凭据，避免下次启动恢复被取消的登录。
      await this.#storage(() => this.#store?.clear());
      throw new ConfidentialControllerError("CANCELLED");
    }
    this.#session = session;
    this.#onIdentityChanged(identity);
    return this.getState();
  }

  clear(): void {
    this.#lifetime.abort();
    this.#lifetime = new AbortController();
    this.#session = undefined;
    this.#refresh = undefined;
    this.#restored = true;
    this.#restoring = undefined;
    this.#onIdentityChanged(undefined);
  }

  async logout(): Promise<void> {
    this.#checkActive();
    const session = this.#session;
    this.clear();
    await this.#storage(() => this.#store?.clear());
    if (!session) return;
    await this.#request("system/auth/logout", {
      tenantId: session.identity.tenantId,
      accessToken: session.accessToken,
    });
  }

  /** Wire directly to the private content source, never to renderer or normal RPC. */
  async getAccessToken(identity: ControllerIdentity, signal: AbortSignal): Promise<string> {
    this.#checkActive();
    this.#checkIdentity(identity);
    if (signal.aborted) throw new ConfidentialControllerError("CANCELLED");
    if (this.#session!.expiresAt - Date.now() < 30_000) {
      await waitForCaller(this.#refreshSession(), signal);
    }
    this.#checkIdentity(identity);
    if (signal.aborted) throw new ConfidentialControllerError("CANCELLED");
    return this.#session!.accessToken;
  }

  #checkIdentity(identity: ControllerIdentity): void {
    const current = this.#session?.identity;
    if (
      !current ||
      current.loginId !== identity.loginId ||
      current.tenantId !== identity.tenantId ||
      current.userId !== identity.userId
    )
      throw new ConfidentialControllerError("AUTH_REQUIRED");
  }

  #checkLifetime(signal: AbortSignal): void {
    this.#checkActive();
    if (signal.aborted || this.#lifetime.signal !== signal)
      throw new ConfidentialControllerError("IDENTITY_CHANGED");
  }

  dispose(): void {
    // 应用销毁保留加密凭据，但旧实例不能再次登录或恢复身份。
    this.#disposed = true;
    this.clear();
  }

  #checkActive(): void {
    if (this.#disposed) throw new ConfidentialControllerError("CANCELLED");
  }

  async #refreshSession(): Promise<void> {
    if (this.#refresh) return this.#refresh;
    const session = this.#session;
    if (!session) throw new ConfidentialControllerError("AUTH_REQUIRED");
    const lifetime = this.#lifetime.signal;
    const refresh = (async () => {
      try {
        // 原接口@RequestParam支持POST表单，避免把刷新令牌拼进URL及代理访问日志。
        const data = await this.#request("system/auth/refresh-token", {
          tenantId: session.identity.tenantId,
          contentType: "application/x-www-form-urlencoded",
          body: new URLSearchParams({ refreshToken: session.refreshToken }).toString(),
          signal: lifetime,
        });
        this.#checkLifetime(lifetime);
        const tokens = readTokens(data);
        if (!isRecord(data) || !isId(data.userId))
          throw new ConfidentialControllerError("UNAVAILABLE");
        if (String(data.userId) !== session.identity.userId)
          throw new ConfidentialControllerError("AUTH_REQUIRED");
        const refreshed = { identity: session.identity, ...tokens };
        await this.#save(refreshed, lifetime);
        this.#checkLifetime(lifetime);
        this.#session = refreshed;
      } catch (error) {
        this.#checkLifetime(lifetime);
        if (error instanceof ConfidentialControllerError && error.code === "AUTH_REQUIRED") {
          this.clear();
          await this.#storage(() => this.#store?.clear());
          throw new ConfidentialControllerError("AUTH_REQUIRED");
        }
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
    })();
    this.#refresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.#refresh === refresh) this.#refresh = undefined;
    }
  }

  async #request(
    path: string,
    input: {
      method?: "GET";
      tenantId?: string;
      accessToken?: string;
      body?: string;
      contentType?: string;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    let response: Response | undefined;
    try {
      response = await fetch(new URL(path, this.#base), {
        method: input.method ?? "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": input.contentType ?? "application/json",
          ...(input.tenantId ? { "tenant-id": input.tenantId } : {}),
          ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {}),
        },
        body: input.body,
      });
      if (response.status === 401 || response.status === 403)
        throw new ConfidentialControllerError("AUTH_REQUIRED");
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("application/json")
      ) {
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 256 * 1024) throw new ConfidentialControllerError("UNAVAILABLE");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const result: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!isRecord(result)) throw new ConfidentialControllerError("UNAVAILABLE");
      if (result.code === 401 || result.code === 403)
        throw new ConfidentialControllerError("AUTH_REQUIRED");
      if (result.code !== 0) throw new ConfidentialControllerError("UNAVAILABLE");
      return result.data;
    } catch (error) {
      if (error instanceof ConfidentialControllerError)
        throw new ConfidentialControllerError(error.code);
      throw new ConfidentialControllerError(input.signal?.aborted ? "CANCELLED" : "UNAVAILABLE");
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }
}

function isStoredSession(value: unknown, apiBaseUrl: string): value is PlatformStoredSession {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.apiBaseUrl === apiBaseUrl &&
    typeof value.tenantId === "string" &&
    isId(value.tenantId) &&
    typeof value.userId === "string" &&
    isId(value.userId) &&
    typeof value.refreshToken === "string" &&
    value.refreshToken.length > 0 &&
    value.refreshToken.length <= 8192
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): boolean {
  return (
    (typeof value === "string" && /^\d{1,19}$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function readTokens(data: unknown): Omit<LoginSession, "identity"> {
  if (
    !isRecord(data) ||
    typeof data.accessToken !== "string" ||
    !data.accessToken ||
    data.accessToken.length > 8192 ||
    typeof data.refreshToken !== "string" ||
    !data.refreshToken ||
    data.refreshToken.length > 8192 ||
    typeof data.expiresTime !== "number" ||
    !Number.isSafeInteger(data.expiresTime) ||
    data.expiresTime <= Date.now()
  ) {
    throw new ConfidentialControllerError("UNAVAILABLE");
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresTime,
  };
}
