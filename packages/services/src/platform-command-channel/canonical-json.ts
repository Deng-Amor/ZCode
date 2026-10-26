import { createPublicKey, verify as ed25519Verify, type KeyObject } from "node:crypto";
import type { CommandChannelEnvelopeBase } from "./schema.js";

/**
 * 信封签名的规范化字节（2026-10-25 与中台对齐定稿，PRD §4.7）：
 * 基础信封移除 signature 字段后，按 RFC 8785（JCS）规范化的 JSON 的 UTF-8 字节。
 *
 * 修复原因：0.0.9 desktop wiring 曾用「含 signature 的 JSON.stringify」做验签输入，
 * 自引用不可签；该链路当时端点未上线、从未真实运行，本文件为首个可执行口径。
 *
 * JCS 值域安全子集：本模块只承诺信封 schema 域（字符串/整数/对象/数组）。
 * 浮点与非安全整数直接抛错——RFC 8785 的数字规范化依赖 ES6 序列化细节，
 * 与 JSON.stringify 在 -0/1e21/精度边界存在分歧，宁可 fail-fast 不可静默错签。
 * （信封字段域：envelopeVersion/params.seq/version 为整数、其余为字符串/嵌套对象。）
 */

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("command channel signature input: non-safe-integer numbers are outside the canonical subset");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // JS 默认排序即 UTF-16 码单元序，与 RFC 8785 §3.2.3 的键序一致。
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  throw new Error("command channel signature input: unsupported value type");
}

/** RFC 8785 规范化 JSON 字符串（仅限本模块声明的值域子集）。 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** 验签输入字节：信封深拷贝移除 signature 后的规范化 JSON UTF-8。 */
export function commandChannelSignatureInput(envelope: CommandChannelEnvelopeBase): Buffer {
  const { signature: _signature, ...withoutSignature } = envelope;
  void _signature;
  return Buffer.from(canonicalJsonString(withoutSignature), "utf8");
}

let cachedKeyPem: string | undefined;
let cachedKey: KeyObject | undefined;

function resolveKey(publicKeyPem: string): KeyObject {
  if (cachedKeyPem === publicKeyPem && cachedKey) return cachedKey;
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("command channel signature: expected Ed25519 public key");
  cachedKeyPem = publicKeyPem;
  cachedKey = key;
  return key;
}

/** Ed25519 验签：signature 为 base64；任何输入异常都归为验签失败（false），不抛错。 */
export function verifyCommandChannelEnvelopeSignature(
  envelope: CommandChannelEnvelopeBase,
  publicKeyPem: string,
): boolean {
  try {
    const input = commandChannelSignatureInput(envelope);
    const signature = Buffer.from(envelope.signature, "base64");
    return ed25519Verify(null, input, resolveKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}
