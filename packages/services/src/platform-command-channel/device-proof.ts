import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { canonicalJsonString } from "./canonical-json.js";

/**
 * 设备证明签名核心（D1/D2，2026-10-26 与中台定稿）。
 *
 * 两套签名字节合同（同一 JCS 实现，与指令信封签名共用 canonical-json.ts）：
 * - 注册（D1）：输入 = JCS({schemaVersion:1, challengeId, nonce, purpose:"register",
 *   installKeySpkiSha256})；deviceId 未分配，绑定待注册公钥指纹防换钥。
 * - 挑战响应（D2，poll/receipts）：输入 = JCS({schemaVersion:1, challengeId, deviceId,
 *   nonce, purpose, requestSha256})；绑定本次请求内容（游标/请求体）防替换。
 *
 * nonce wire 格式 = 服务端发行 24 字节随机值、32 字符无填充 base64url；客户端按不透明
 * 字符串原样入签（isServerNonce 仅做格式护栏，用于诊断明显畸形，不替代服务端校验）。
 * 私钥/公钥以 PEM 或 KeyObject 注入；落盘加密（safeStorage）归 Main 装配，本模块不持久化。
 */

const REGISTER_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const CHALLENGE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** D1 注册挑战 nonce 护栏：24 字节随机 → 32 字符无填充 base64url。 */
export function isRegisterNonce(value: unknown): value is string {
  return typeof value === "string" && REGISTER_NONCE_PATTERN.test(value);
}

/** D2 挑战 nonce 护栏：32 字节随机 → 43 字符无填充 base64url（与 D1 不同长）。 */
export function isChallengeNonce(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_NONCE_PATTERN.test(value);
}

/** 安装公钥 SPKI DER 的 SHA-256 小写 hex（与 trust-roots keyId 同口径）。 */
export function installKeySpkiSha256Hex(publicKey: KeyObject | string): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("device proof: expected Ed25519 public key");
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** poll 的 requestSha256：sha256(游标参数原文 UTF-8；无 cursor 对空串)。 */
export function pollRequestSha256Hex(cursor: string | undefined): string {
  return createHash("sha256").update(cursor ?? "", "utf8").digest("hex");
}

/** receipts 的 requestSha256：sha256(实际发送的原始请求体字节)。 */
export function receiptsRequestSha256Hex(rawBodyBytes: Buffer): string {
  return createHash("sha256").update(rawBodyBytes).digest("hex");
}

export interface DeviceRegisterChallenge {
  readonly challengeId: string;
  readonly nonce: string;
}

export interface DeviceChallenge extends DeviceRegisterChallenge {
  readonly deviceId: string;
  readonly purpose: "poll" | "receipts";
  readonly requestSha256: string;
}

/** D1 注册签名输入字节（canonical 字符串的 UTF-8）。 */
export function deviceRegisterSignatureInput(
  challenge: DeviceRegisterChallenge,
  spkiSha256Hex: string,
): Buffer {
  return Buffer.from(
    canonicalJsonString({
      schemaVersion: 1,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      purpose: "register",
      installKeySpkiSha256: spkiSha256Hex,
    }),
    "utf8",
  );
}

/** D2 挑战响应签名输入字节（canonical 字符串的 UTF-8）。 */
export function deviceChallengeSignatureInput(challenge: DeviceChallenge): Buffer {
  return Buffer.from(
    canonicalJsonString({
      schemaVersion: 1,
      challengeId: challenge.challengeId,
      deviceId: challenge.deviceId,
      nonce: challenge.nonce,
      purpose: challenge.purpose,
      requestSha256: challenge.requestSha256,
    }),
    "utf8",
  );
}

export interface DeviceProofSigner {
  /** Ed25519 签名（base64）。私钥形态：安装密钥 PEM 或 KeyObject。 */
  sign(input: Buffer): string;
  /** 本机安装公钥指纹（注册与诊断用）。 */
  spkiSha256Hex(): string;
}

export function createDeviceProofSigner(installPrivateKeyPem: string): DeviceProofSigner {
  const privateKey = createPrivateKey(installPrivateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("device proof: expected Ed25519 private key");
  }
  const publicKey = createPublicKey(privateKey);
  const spkiSha256 = installKeySpkiSha256Hex(publicKey);
  return {
    sign: (input) => ed25519Sign(null, input, privateKey).toString("base64"),
    spkiSha256Hex: () => spkiSha256,
  };
}
