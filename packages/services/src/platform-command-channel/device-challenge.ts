import { deviceChallengeSignatureInput, isChallengeNonce, type DeviceProofSigner } from "./device-proof.js";

/**
 * D2 挑战客户端（2026-10-27 实测合同）：POST system/ccode-commands/device/challenge，
 * 体恰 {purpose}，头 x-ccode-device-id（小写 UUID）；响应 {challengeId, nonce(43 字符),
 * expiresAt(epoch 毫秒数字)}。挑战原子消费于服务端独立事务——领一次签一次，不得复用。
 */

export interface DeviceChallengeTokenProvider {
  getHeaders(): Promise<Record<string, string>>;
}

export type DeviceChallengeErrorCode =
  | "CHALLENGE_REQUIRED"
  | "CHALLENGE_EXPIRED"
  | "DEVICE_UNKNOWN"
  | "DEVICE_REVOKED"
  | "CHALLENGE_UNAVAILABLE";

export class DeviceChallengeError extends Error {
  constructor(readonly code: DeviceChallengeErrorCode, readonly httpStatus: number) {
    super(code);
    this.name = "DeviceChallengeError";
  }
}

export interface IssuedDeviceChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface DeviceChallengeClientOptions {
  readonly baseUrl: string;
  readonly tokenProvider: DeviceChallengeTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const CHALLENGE_PATH = "system/ccode-commands/device/challenge";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_CODES: ReadonlySet<string> = new Set([
  "CHALLENGE_REQUIRED",
  "CHALLENGE_EXPIRED",
  "DEVICE_UNKNOWN",
  "DEVICE_REVOKED",
  "CHALLENGE_UNAVAILABLE",
]);

export interface DeviceChallengeClient {
  fetch(input: { readonly purpose: "poll" | "receipts"; readonly deviceId: string }): Promise<IssuedDeviceChallenge>;
}

export function createDeviceChallengeClient(options: DeviceChallengeClientOptions): DeviceChallengeClient {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("device challenge client: invalid baseUrl");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    fetch: async ({ purpose, deviceId }) => {
      if (!UUID_PATTERN.test(deviceId)) throw new DeviceChallengeError("DEVICE_UNKNOWN", 400);
      let response: Response | undefined;
      try {
        const headers = { ...(await options.tokenProvider.getHeaders()) };
        response = await doFetch(new URL(CHALLENGE_PATH, base), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "x-ccode-device-id": deviceId,
            ...headers,
          },
          body: JSON.stringify({ purpose }),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json: unknown = await response.json().catch(() => null);
        const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
        if (response.status !== 200) {
          const code = typeof record.error === "string" && KNOWN_CODES.has(record.error)
            ? (record.error as DeviceChallengeErrorCode)
            : "CHALLENGE_UNAVAILABLE";
          throw new DeviceChallengeError(code, response.status);
        }
        if (
          typeof record.challengeId !== "string" || !UUID_PATTERN.test(record.challengeId) ||
          !isChallengeNonce(record.nonce) ||
          typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)
        ) {
          throw new DeviceChallengeError("CHALLENGE_UNAVAILABLE", response.status);
        }
        return { challengeId: record.challengeId, nonce: record.nonce, expiresAt: record.expiresAt };
      } catch (error) {
        if (error instanceof DeviceChallengeError) throw error;
        throw new DeviceChallengeError("CHALLENGE_UNAVAILABLE", 0);
      } finally {
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    },
  };
}

/** 三证明头注入（poll/receipts 共用）：对本次请求内容签名。 */
export function deviceProofHeaders(input: {
  readonly challenge: IssuedDeviceChallenge;
  readonly deviceId: string;
  readonly purpose: "poll" | "receipts";
  readonly requestSha256Hex: string;
  readonly signer: DeviceProofSigner;
}): Record<string, string> {
  const signature = input.signer.sign(
    deviceChallengeSignatureInput({
      challengeId: input.challenge.challengeId,
      deviceId: input.deviceId,
      nonce: input.challenge.nonce,
      purpose: input.purpose,
      requestSha256: input.requestSha256Hex,
    }),
  );
  return {
    "x-ccode-device-id": input.deviceId,
    "x-ccode-challenge-id": input.challenge.challengeId,
    "x-ccode-device-signature": signature,
  };
}
