import {
  deviceRegisterSignatureInput,
  isRegisterNonce,
  type DeviceProofSigner,
} from "./device-proof.js";

/**
 * D1 设备注册客户端（2026-10-27 实测合同，服务端 a5cd0080ca）。
 *
 * 三步流（必须同一枚 access token，由注入 tokenProvider 保证）：
 *   POST system/ccode-commands/device/registration-challenge
 *     {publicKeySpkiDer(标准 base44), idempotencyKey} → {challengeId, nonce(32 字符)}
 *   POST system/ccode-commands/device/reauth
 *     {challengeId, password} → {"code":0}   ← 密码仅此一次经 HTTPS 上送，不落日志
 *   POST system/ccode-commands/device/register
 *     {challengeId, nonce, signature} → {deviceId(小写 UUID)}
 *
 * 幂等：同 idempotencyKey+同公钥重复注册返回同一 deviceId；调用方 idempotencyKey
 * 建议取安装公钥 spkiSha256（天然可重试）。ACTIVE 设备超上限 → DEVICE_LIMIT_REACHED。
 */

export interface DeviceRegistrationTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

export type DeviceRegistrationErrorCode =
  | "STEP_UP_REQUIRED"
  | "DEVICE_LIMIT_REACHED"
  | "DEVICE_PROOF_UNAVAILABLE"
  | "DEVICE_REGISTRATION_UNAVAILABLE"
  | "NETWORK_UNAVAILABLE";

export class DeviceRegistrationError extends Error {
  constructor(readonly code: DeviceRegistrationErrorCode) {
    super(code);
    this.name = "DeviceRegistrationError";
  }
}

export interface DeviceRegistrationClientOptions {
  readonly baseUrl: string;
  readonly tokenProvider: DeviceRegistrationTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEVICE_PATH_PREFIX = "system/ccode-commands/device/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createDeviceRegistrationClient(
  options: DeviceRegistrationClientOptions,
): {
  register(input: {
    readonly password: string;
    readonly idempotencyKey: string;
    readonly signer: DeviceProofSigner;
    readonly publicKeySpkiDerBase64: string;
  }): Promise<{ deviceId: string }>;
} {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("device registration client: invalid baseUrl");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post<T>(
    path: string,
    body: Record<string, unknown>,
    interpret: (json: unknown, status: number) => T,
  ): Promise<T> {
    let response: Response | undefined;
    try {
      const headers = { ...(await options.tokenProvider.getHeaders()) };
      response = await doFetch(new URL(path, base), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json: unknown = await response.json().catch(() => null);
      return interpret(json, response.status);
    } catch (error) {
      if (error instanceof DeviceRegistrationError) throw error;
      throw new DeviceRegistrationError("NETWORK_UNAVAILABLE");
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  function mapError(json: unknown, status: number): DeviceRegistrationError {
    const code = typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined;
    if (status === 409 || code === "DEVICE_LIMIT_REACHED") return new DeviceRegistrationError("DEVICE_LIMIT_REACHED");
    if (status === 401 || code === "STEP_UP_REQUIRED" || code === "AUTH_REQUIRED") {
      return new DeviceRegistrationError("STEP_UP_REQUIRED");
    }
    if (status === 503 || code === "DEVICE_PROOF_UNAVAILABLE" || code === "DEVICE_REGISTRATION_UNAVAILABLE") {
      // 注册门未开与 DB 故障对客户端同态：静默等待下次登录重试。
      return new DeviceRegistrationError("DEVICE_REGISTRATION_UNAVAILABLE");
    }
    return new DeviceRegistrationError("DEVICE_REGISTRATION_UNAVAILABLE");
  }

  return {
    register: async ({ password, idempotencyKey, signer, publicKeySpkiDerBase64 }) => {
      // ① 领注册挑战
      const challenge = await post(
        DEVICE_PATH_PREFIX + "registration-challenge",
        { publicKeySpkiDer: publicKeySpkiDerBase64, idempotencyKey },
        (json, status) => {
          if (status !== 200 || typeof json !== "object" || json === null) throw mapError(json, status);
          const record = json as { challengeId?: unknown; nonce?: unknown; error?: unknown };
          if (typeof record.error === "string") throw mapError(record, status);
          if (typeof record.challengeId !== "string" || !UUID_PATTERN.test(record.challengeId) || !isRegisterNonce(record.nonce)) {
            throw new DeviceRegistrationError("DEVICE_REGISTRATION_UNAVAILABLE");
          }
          return { challengeId: record.challengeId, nonce: record.nonce as string };
        },
      );
      // ② 密码重验（仅此一次上送；失败映射 STEP_UP_REQUIRED，不区分密码错与身份失效）
      await post(DEVICE_PATH_PREFIX + "reauth", { challengeId: challenge.challengeId, password }, (json, status) => {
        if (status !== 200 || typeof json !== "object" || json === null) throw mapError(json, status);
        const record = json as { code?: unknown; error?: unknown };
        if (typeof record.error === "string") throw mapError(record, status);
        if (record.code !== 0) throw new DeviceRegistrationError("STEP_UP_REQUIRED");
        return undefined;
      });
      // ③ 注册（签名 = D1 冻结合同：JCS({schemaVersion:1,challengeId,nonce,purpose:register,installKeySpkiSha256})）
      const signature = signer.sign(deviceRegisterSignatureInput(challenge, signer.spkiSha256Hex()));
      return post(DEVICE_PATH_PREFIX + "register", { challengeId: challenge.challengeId, nonce: challenge.nonce, signature }, (json, status) => {
        if (status !== 200 || typeof json !== "object" || json === null) throw mapError(json, status);
        const record = json as { deviceId?: unknown; error?: unknown };
        if (typeof record.error === "string") throw mapError(record, status);
        if (typeof record.deviceId !== "string" || !UUID_PATTERN.test(record.deviceId)) {
          throw new DeviceRegistrationError("DEVICE_REGISTRATION_UNAVAILABLE");
        }
        return { deviceId: record.deviceId };
      });
    },
  };
}
