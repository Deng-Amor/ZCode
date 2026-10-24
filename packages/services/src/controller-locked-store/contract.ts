import type { ManagedSkillTrust, VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";

export interface LockedStoreEncryption {
  isAvailable(): Promise<boolean>;
  encrypt(plain: Uint8Array): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<Uint8Array>;
}
export interface ControllerUpdateSource { fetchUpdate(input: { currentVersion?: number }): Promise<{ kind: "envelope"; envelope: unknown } | { kind: "upToDate" }>; }
export interface ControllerLockedVersion { version: number; digest: string; landedAt: string; }
export interface ControllerLockedContent { version: number; digest: string; skillMd: string; files: readonly { path: string; bytes: Uint8Array }[]; }
export type ControllerLockedStatus = { state: "empty" | "ready" | "updateFailed"; current?: ControllerLockedVersion; lastErrorCode?: string };
export type ControllerLockedStoreErrorCode = "ENCRYPTION_UNAVAILABLE" | "VERIFY_FAILED" | "NOT_INSTALLED" | "DIGEST_MISMATCH" | "IO_FAILED";
export class ControllerLockedStoreError extends Error {
  constructor(public readonly code: ControllerLockedStoreErrorCode, message: string = code) { super(message); this.name = "ControllerLockedStoreError"; }
}
export interface ControllerLockedStore {
  install(verified: VerifiedManagedSkillBundle): Promise<ControllerLockedVersion>;
  load(): Promise<ControllerLockedContent>;
  /** 读盘取清单（不 decrypt）；新进程实例首次调用必须反映磁盘现状，不能只看内存缓存。 */
  status(): Promise<ControllerLockedStatus>;
  rollback(): Promise<ControllerLockedVersion>;
}
export interface ControllerLockedStoreOptions {
  storageDirectory: string;
  encryption: LockedStoreEncryption;
  trust: ManagedSkillTrust;
  verify?: (envelope: unknown, trust: ManagedSkillTrust) => VerifiedManagedSkillBundle;
  now?: () => Date;
  logger?: { warn?(message: string, error?: unknown): void };
}
