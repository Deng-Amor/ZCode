import type { ManagedSkillTrust } from "@zcode/shared/managed-skills";
import type {
  CcodePlatformLoginInput,
  CcodePlatformLoginState,
  CcodePlatformTenant,
} from "@zcode/shared";

/** Authentication owner supplies a new loginId for every successful login. No credentials here. */
export interface ControllerIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly loginId: string;
}

export interface ControllerGrant {
  readonly skillId: string;
  readonly version: number;
  /** SHA-256 of the signed payload bytes, not the JSON envelope. */
  readonly digest: string;
  readonly expiresAt: number;
}

/** Private application service port. Never register this on renderer/public RPC. */
export interface ConfidentialControllerSource {
  authorize(input: {
    identity: ControllerIdentity;
    skillId: string;
    version?: number;
    signal: AbortSignal;
  }): Promise<ControllerGrant>;
  /** Bounded transport returns an untrusted signed envelope; the application verifies it. */
  download(input: {
    identity: ControllerIdentity;
    grant: ControllerGrant;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export type ControllerErrorCode =
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_REJECTED"
  | "AUTH_REQUIRED"
  | "IDENTITY_CHANGED"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "EXECUTION_FAILED"
  | "INVALID_RELEASE"
  | "VERSION_CHANGED"
  | "CAPACITY_EXCEEDED";

export class ConfidentialControllerError extends Error {
  constructor(readonly code: ControllerErrorCode) {
    // 外部响应和模型内容不拼进异常，避免进入通用错误日志。
    super(`Confidential controller: ${code}`);
    this.name = "ConfidentialControllerError";
  }
}

export interface ControllerLease {
  readonly skillId: string;
  readonly version: number;
  readonly digest: string;
  /** Rechecks identity/authorization on every use; body must not enter history or logging. */
  use<T>(
    consume: (instruction: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Private child-process messages; never expose this port to renderer/mobile RPC. */
export interface ControllerBootstrap {
  readonly version: number;
  readonly digest: string;
  readonly systemPrompt: string;
}

export type ControllerPrivateCommand =
  | { type: "bootstrap"; requestId: number }
  | { type: "acquire"; requestId: number; version?: number }
  | { type: "complete" | "cancel"; requestId: number };

export type ControllerPrivateEvent =
  | { type: "invalidated" }
  | ({ type: "bootstrap-ready"; requestId: number } & ControllerBootstrap)
  | { type: "ready"; requestId: number; version: number; digest: string; instruction: string }
  | { type: "completed"; requestId: number }
  | { type: "failed"; requestId: number; code: ControllerErrorCode };

export interface ControllerPrivateChannel {
  /** Malformed input closes this channel and cancels all its calls. */
  receive(message: unknown): void;
  /** Application owner revokes consumers without destroying the window Host transport. */
  invalidate?(): void;
  dispose(): void;
}

/** Host-only factory; never attach to public service/RPC registries. */
export type ControllerPrivateChannelFactory = (
  send: (event: ControllerPrivateEvent) => void,
  close: () => void,
) => ControllerPrivateChannel;

export interface ControllerCacheOptions {
  source: ConfidentialControllerSource;
  trusts: readonly ManagedSkillTrust[];
  /** Reject further versions rather than silently evicting/redownloading cached releases. */
  maxBytes?: number;
  /** Upper bound on an authorization granted by the remote endpoint. Default: five minutes. */
  maxGrantLifetimeMs?: number;
  now?: () => number;
}

export interface ControllerHttpSourceOptions {
  /** Trusted deployment configuration, including the API prefix; HTTPS only. */
  apiBaseUrl: string;
  /** Authentication owner must reject an identity from an old login generation. */
  getAccessToken(identity: ControllerIdentity, signal: AbortSignal): Promise<string>;
  timeoutMs?: number;
}

export type PlatformTenant = CcodePlatformTenant;
export type PlatformLoginInput = CcodePlatformLoginInput;
export type PlatformLoginState = CcodePlatformLoginState;

/** Private refresh credential; never expose through renderer RPC or ordinary settings. */
export interface PlatformStoredSession {
  version: 1;
  apiBaseUrl: string;
  tenantId: string;
  userId: string;
  refreshToken: string;
}

export interface PlatformSessionStore {
  load(): Promise<unknown>;
  save(session: PlatformStoredSession): Promise<void>;
  clear(): Promise<void>;
}

export interface PlatformAuthOptions {
  apiBaseUrl: string;
  sessionStore?: PlatformSessionStore;
  /** Wire to the application bootstrap owner. No asynchronous identity transition. */
  onIdentityChanged(identity?: ControllerIdentity): void;
}
