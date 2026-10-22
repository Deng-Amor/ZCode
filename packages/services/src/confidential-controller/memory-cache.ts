import { createHash } from "node:crypto";
import { isControllerTransportFailure } from "./transport-failure.js";
import { waitForCaller } from "./cancellation.js";
import { verifyManagedSkillBundle, type ManagedSkillTrust } from "@zcode/shared/managed-skills";
import {
  ConfidentialControllerError,
  type ControllerCacheOptions,
  type ControllerGrant,
  type ControllerIdentity,
  type ControllerLease,
} from "./contract.js";

interface CachedRelease {
  digest: string;
  instruction: string;
  bytes: number;
}

const MAX_RELEASES = 64;
const MAX_GRANTS = 128;
const MAX_AUTHORIZATIONS = 8;
const MAX_DOWNLOADS = 4;
const RENEW_AT_LIFETIME_RATIO = 0.6;
const RENEW_RETRY_MS = 5_000;

/** Application-scoped owner. No disk IO, environment variables, logging or runtime imports. */
export class ConfidentialControllerCache {
  #identity?: ControllerIdentity;
  #generation = new AbortController();
  #releases = new Map<string, CachedRelease>();
  #grants = new Map<string, ControllerGrant>();
  #authorizing = new Map<string, Promise<ControllerGrant>>();
  #downloading = new Map<string, Promise<CachedRelease>>();
  #trusts = new Map<string, ManagedSkillTrust>();
  #bytes = 0;
  #options: ControllerCacheOptions;
  #now: () => number;
  #maxBytes: number;
  #maxGrantLifetimeMs: number;

  constructor(options: ControllerCacheOptions) {
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.#maxGrantLifetimeMs = options.maxGrantLifetimeMs ?? 5 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.#maxBytes) ||
      this.#maxBytes <= 0 ||
      !Number.isSafeInteger(this.#maxGrantLifetimeMs) ||
      this.#maxGrantLifetimeMs <= 0 ||
      this.#maxGrantLifetimeMs > 2_147_483_647
    )
      throw new ConfidentialControllerError("INVALID_RELEASE");
    for (const trust of options.trusts) {
      if (this.#trusts.has(trust.skillId)) throw new ConfidentialControllerError("INVALID_RELEASE");
      this.#trusts.set(trust.skillId, Object.freeze({ ...trust }));
    }
  }

  setIdentity(identity?: ControllerIdentity): void {
    if (identity && (!identity.tenantId || !identity.userId || !identity.loginId)) {
      throw new ConfidentialControllerError("AUTH_REQUIRED");
    }
    if (
      identity &&
      this.#identity &&
      identity.tenantId === this.#identity.tenantId &&
      identity.userId === this.#identity.userId &&
      identity.loginId === this.#identity.loginId
    )
      return;
    this.clear();
    this.#identity = identity ? Object.freeze({ ...identity }) : undefined;
  }

  clear(): void {
    // 换身份时先撤销代次，迟到的授权/下载不能重新填充当前缓存。
    this.#generation.abort();
    this.#generation = new AbortController();
    this.#identity = undefined;
    this.#releases.clear();
    this.#grants.clear();
    this.#authorizing.clear();
    this.#downloading.clear();
    this.#bytes = 0;
  }

  async acquire(input: {
    skillId: string;
    version?: number;
    signal?: AbortSignal;
  }): Promise<ControllerLease> {
    const generation = this.#generation.signal;
    const identity = this.#identity;
    if (!identity) throw new ConfidentialControllerError("AUTH_REQUIRED");
    if (input.signal?.aborted) throw new ConfidentialControllerError("CANCELLED");
    const grant = await waitForCaller(
      this.#authorize(identity, generation, input.skillId, input.version),
      input.signal,
    );
    await waitForCaller(this.#load(identity, generation, grant), input.signal);
    this.#assertGeneration(generation);
    const lease: ControllerLease = {
      skillId: grant.skillId,
      version: grant.version,
      digest: grant.digest,
      use: async (consume, signal) => {
        this.#assertGeneration(generation);
        if (signal?.aborted) throw new ConfidentialControllerError("CANCELLED");
        const renewed = await waitForCaller(
          this.#authorize(identity, generation, grant.skillId, grant.version),
          signal,
        );
        if (renewed.digest !== grant.digest)
          throw new ConfidentialControllerError("VERSION_CHANGED");
        const release = await waitForCaller(this.#load(identity, generation, renewed), signal);
        this.#assertGeneration(generation);
        let expiresAt = renewed.expiresAt;
        const lifetime = expiresAt - this.#now();
        if (lifetime <= 0) throw new ConfidentialControllerError("AUTHORIZATION_EXPIRED");
        const authorization = new AbortController();
        const operation = AbortSignal.any([
          generation,
          authorization.signal,
          ...(signal ? [signal] : []),
        ]);
        let stopped = false;
        let failure: ConfidentialControllerError | undefined;
        let renewalTimer: ReturnType<typeof setTimeout> | undefined;
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        const fail = (error: ConfidentialControllerError) => {
          if (stopped || authorization.signal.aborted) return;
          failure = error;
          authorization.abort();
        };
        const expire = () => fail(new ConfidentialControllerError("AUTHORIZATION_EXPIRED"));
        const scheduleRenewal = (delay: number) => {
          if (stopped || operation.aborted) return;
          renewalTimer = setTimeout(
            () => {
              void refresh();
            },
            Math.max(1, Math.ceil(delay)),
          );
          renewalTimer.unref?.();
        };
        const armExpiry = () => {
          clearTimeout(expiryTimer);
          expiryTimer = setTimeout(expire, Math.max(1, Math.ceil(expiresAt - this.#now())));
          expiryTimer.unref?.();
        };
        const refresh = async () => {
          if (stopped || operation.aborted) return;
          if (this.#now() >= expiresAt) {
            expire();
            return;
          }
          try {
            // 原先把五分钟授权直接绑定到整次模型/工具运行，长任务因此被误取消。
            // 强制请求新授权，但复用同身份同版本正在进行的请求，正文仍只留内存。
            const next = await waitForCaller(
              this.#authorize(identity, generation, grant.skillId, grant.version, true),
              operation,
            );
            if (stopped || operation.aborted) return;
            this.#assertGeneration(generation);
            if (this.#now() >= expiresAt) {
              expire();
              return;
            }
            if (next.digest !== grant.digest)
              throw new ConfidentialControllerError("VERSION_CHANGED");
            if (next.expiresAt <= expiresAt)
              throw new ConfidentialControllerError("INVALID_RELEASE");
            expiresAt = next.expiresAt;
            armExpiry();
            scheduleRenewal((expiresAt - this.#now()) * RENEW_AT_LIFETIME_RATIO);
          } catch (error) {
            if (stopped || operation.aborted) return;
            if (this.#now() >= expiresAt) {
              expire();
              return;
            }
            if (
              isControllerTransportFailure(error) ||
              (error instanceof ConfidentialControllerError &&
                (error.code === "UNAVAILABLE" || error.code === "CANCELLED"))
            ) {
              // 短暂故障只消耗当前授权剩余时间，绝不擅自延长服务器截止。
              scheduleRenewal(Math.min(RENEW_RETRY_MS, expiresAt - this.#now()));
              return;
            }
            fail(
              error instanceof ConfidentialControllerError
                ? error
                : new ConfidentialControllerError("INVALID_RELEASE"),
            );
          }
        };
        armExpiry();
        scheduleRenewal(lifetime * RENEW_AT_LIFETIME_RATIO);
        try {
          const result = await waitForCaller(consume(release.instruction, operation), operation);
          this.#assertGeneration(generation);
          if (failure) throw failure;
          if (this.#now() >= expiresAt)
            throw new ConfidentialControllerError("AUTHORIZATION_EXPIRED");
          if (operation.aborted) throw new ConfidentialControllerError("CANCELLED");
          return result;
        } catch (error) {
          this.#assertGeneration(generation);
          if (failure) throw failure;
          if (signal?.aborted) throw new ConfidentialControllerError("CANCELLED");
          if (error instanceof ConfidentialControllerError)
            throw new ConfidentialControllerError(error.code);
          throw new ConfidentialControllerError("EXECUTION_FAILED");
        } finally {
          stopped = true;
          clearTimeout(renewalTimer);
          clearTimeout(expiryTimer);
          authorization.abort();
        }
      },
    };
    return Object.freeze(lease);
  }

  #assertGeneration(signal: AbortSignal): void {
    if (signal.aborted || signal !== this.#generation.signal) {
      throw new ConfidentialControllerError("IDENTITY_CHANGED");
    }
  }

  async #authorize(
    identity: ControllerIdentity,
    signal: AbortSignal,
    skillId: string,
    version?: number,
    forceRenewal = false,
  ): Promise<ControllerGrant> {
    this.#assertGeneration(signal);
    const trust = this.#trusts.get(skillId);
    if (
      !trust ||
      (version !== undefined && (!Number.isSafeInteger(version) || version < trust.minimumVersion))
    ) {
      throw new ConfidentialControllerError("INVALID_RELEASE");
    }
    const key = JSON.stringify([skillId, version ?? "latest"]);
    for (const [grantKey, value] of this.#grants) {
      if (value.expiresAt <= this.#now()) this.#grants.delete(grantKey);
    }
    const cached = this.#grants.get(key);
    if (!forceRenewal && cached && cached.expiresAt > this.#now()) return cached;
    const existing = this.#authorizing.get(key);
    if (existing) return existing;
    if (
      this.#authorizing.size >= MAX_AUTHORIZATIONS ||
      (this.#grants.size >= MAX_GRANTS - 1 && !this.#grants.has(key))
    ) {
      throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
    }
    const promise = (async () => {
      try {
        const result = await waitForCaller(
          this.#options.source.authorize({ identity, skillId, version, signal }),
          signal,
        );
        this.#assertGeneration(signal);
        if (
          !result ||
          result.skillId !== skillId ||
          !Number.isSafeInteger(result.version) ||
          result.version < trust.minimumVersion ||
          (version !== undefined && result.version !== version) ||
          typeof result.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(result.digest) ||
          !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt <= this.#now() ||
          result.expiresAt - this.#now() > this.#maxGrantLifetimeMs
        ) {
          throw new ConfidentialControllerError("INVALID_RELEASE");
        }
        const grant = Object.freeze({
          skillId,
          version: result.version,
          digest: result.digest,
          expiresAt: result.expiresAt,
        });
        if (this.#grants.size >= MAX_GRANTS - 1 && !this.#grants.has(key)) {
          throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
        }
        const release = this.#releases.get(releaseKey(grant));
        if (release && release.digest !== grant.digest)
          throw new ConfidentialControllerError("VERSION_CHANGED");
        this.#grants.set(key, grant);
        this.#grants.set(JSON.stringify([skillId, grant.version]), grant);
        return grant;
      } catch (error) {
        if (error instanceof ConfidentialControllerError) throw error;
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
    })();
    this.#authorizing.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.#authorizing.get(key) === promise) this.#authorizing.delete(key);
    }
  }

  async #load(
    identity: ControllerIdentity,
    signal: AbortSignal,
    grant: ControllerGrant,
  ): Promise<CachedRelease> {
    this.#assertGeneration(signal);
    const key = releaseKey(grant);
    const cached = this.#releases.get(key);
    if (cached) {
      if (cached.digest !== grant.digest) throw new ConfidentialControllerError("VERSION_CHANGED");
      return cached;
    }
    const existing = this.#downloading.get(key);
    if (existing) {
      const release = await existing;
      if (release.digest !== grant.digest) throw new ConfidentialControllerError("VERSION_CHANGED");
      return release;
    }
    if (
      this.#downloading.size >= MAX_DOWNLOADS ||
      this.#releases.size + this.#downloading.size >= MAX_RELEASES ||
      this.#bytes >= this.#maxBytes
    ) {
      throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
    }
    const promise = (async () => {
      try {
        const envelope = await waitForCaller(
          this.#options.source.download({ identity, grant, signal }),
          signal,
        );
        this.#assertGeneration(signal);
        const verified = verifyManagedSkillBundle(envelope, this.#trusts.get(grant.skillId)!);
        const payload = (envelope as { payloadBase64: string }).payloadBase64;
        const digest = createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex");
        if (verified.version !== grant.version || digest !== grant.digest) {
          throw new ConfidentialControllerError("INVALID_RELEASE");
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const parts: string[] = [];
        for (const file of verified.files) {
          // 受保护规则只能作为内存文本使用，不把发行包脚本落盘运行。
          if (!/\.md$/i.test(file.path)) throw new ConfidentialControllerError("INVALID_RELEASE");
          parts.push(`## ${file.path}\n${decoder.decode(file.bytes)}`);
        }
        const instruction = parts.join("\n\n");
        const bytes = Buffer.byteLength(instruction, "utf8");
        if (this.#bytes + bytes > this.#maxBytes)
          throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
        const release = { digest, instruction, bytes };
        this.#releases.set(key, release);
        this.#bytes += bytes;
        return release;
      } catch (error) {
        if (error instanceof ConfidentialControllerError) throw error;
        throw new ConfidentialControllerError("INVALID_RELEASE");
      }
    })();
    this.#downloading.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.#downloading.get(key) === promise) this.#downloading.delete(key);
    }
  }
}

function releaseKey(grant: ControllerGrant): string {
  return JSON.stringify([grant.skillId, grant.version]);
}
