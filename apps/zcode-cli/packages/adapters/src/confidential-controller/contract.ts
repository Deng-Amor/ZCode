export interface PrivateControllerContent {
  readonly version: number;
  readonly digest: string;
  readonly instruction: string;
  readonly signal: AbortSignal;
}

export interface PrivateControllerClient {
  /** Consumer must return a plain JSON tree and buffer output without side effects until resolution.
   * Non-JSON values, accessors, repeated object references and excessive depth/size are rejected.
   */
  use<T>(
    consume: (content: PrivateControllerContent) => Promise<T>,
    options?: { version?: number; signal?: AbortSignal },
  ): Promise<{ version: number; digest: string; value: T }>;
  dispose(): void;
}

export type PrivateControllerCode =
  | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REJECTED'
  | 'AUTH_REQUIRED' | 'IDENTITY_CHANGED' | 'CANCELLED' | 'UNAVAILABLE'
  | 'EXECUTION_FAILED' | 'INVALID_RELEASE' | 'VERSION_CHANGED' | 'CAPACITY_EXCEEDED';

export class PrivateControllerError extends Error {
  constructor(readonly code: PrivateControllerCode) {
    super(code === 'AUTHORIZATION_EXPIRED'
      ? '总控授权续期失败，当前授权已到期。请检查网络和中台连接后继续任务。'
      : code === 'AUTHORIZATION_REJECTED'
        ? '中台已拒绝总控授权，请确认账号权限及总控版本状态。'
        : `Confidential controller: ${code}`);
    this.name = 'PrivateControllerError';
  }
}
