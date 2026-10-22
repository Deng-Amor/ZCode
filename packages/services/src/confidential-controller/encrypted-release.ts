import { createDecipheriv, createHash, createPublicKey, KeyObject, verify } from "node:crypto";
import { z } from "zod";
import {
  MANAGED_SKILL_BUNDLE_LIMITS,
  managedSkillIdentitySchema,
  verifyManagedSkillBundle,
  type ManagedSkillTrust,
  type VerifiedManagedSkillBundle,
} from "@zcode/shared/managed-skills";

type EncryptedReleaseErrorCode =
  | "INVALID_ENVELOPE"
  | "UNTRUSTED_SIGNATURE"
  | "BINDING_MISMATCH"
  | "DECRYPT_FAILED"
  | "INVALID_CONTENT";

export class EncryptedControllerReleaseError extends Error {
  constructor(readonly code: EncryptedReleaseErrorCode) {
    super(`Encrypted controller release: ${code}`);
    this.name = "EncryptedControllerReleaseError";
  }
}

const limit = MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes;
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const expectedSchema = z.strictObject({
  tenantId: identifier,
  skillId: managedSkillIdentitySchema,
  version: positiveInteger,
  releasePayloadDigest: digest,
});
const protectedSchema = z.strictObject({
  alg: z.literal("EdDSA"),
  kid: identifier,
  typ: z.literal("ccode-encrypted-manifest+jws"),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  headerBase64url: z.string(),
  ciphertextDigest: digest,
  ciphertextBytes: positiveInteger.max(limit),
  tagBase64url: z.string(),
});
const headerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...expectedSchema.shape,
  plaintextBytes: positiveInteger.max(limit),
  algorithm: z.literal("AES-256-GCM"),
  ivBase64url: z.string(),
});
const inputSchema = z.strictObject({
  manifestJws: z
    .string()
    .min(1)
    .max(16 * 1024),
  ciphertext: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength > 0 && value.byteLength <= limit),
});

function decode(value: string, max: number, exact?: number): Buffer {
  // 必须先限制编码长度；Buffer 的宽松 base64url 解码不能代替规范编码校验。
  if (value.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length > max ||
    (exact !== undefined && bytes.length !== exact) ||
    bytes.toString("base64url") !== value
  )
    throw new Error();
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  // fatal UTF-8 不拒绝 BOM，需显式挡住；每个结构仅一次 JSON.parse，统一 last-wins。
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function publicKey(value: unknown): KeyObject {
  let key: KeyObject;
  if (value instanceof KeyObject) key = value;
  else {
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      Buffer.byteLength(value, "utf8") > 1024 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(
        value.trim(),
      )
    )
      throw new Error();
    key = createPublicKey(value);
  }
  // createPublicKey 可接受私钥，先检查输入格式且对象必须显式为 public。
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error();
  return key;
}

function trustedKeys(input: unknown): Map<string, KeyObject> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw new Error();
  const keys = new Map<string, KeyObject>();
  const entrySchema = z.strictObject({ kid: identifier, publicKey: z.unknown() });
  for (const entry of input) {
    const item = entrySchema.parse(entry);
    if (keys.has(item.kid)) throw new Error();
    keys.set(item.kid, publicKey(item.publicKey));
  }
  return keys;
}

/** Private synchronous content verification only. A verified bundle is not authorization. */
export function verifyEncryptedControllerRelease(
  input: unknown,
  expectedRelease: unknown,
  contentTrusts: unknown,
  innerTrust: ManagedSkillTrust,
  cek: Uint8Array,
): VerifiedManagedSkillBundle {
  let code: EncryptedReleaseErrorCode = "INVALID_ENVELOPE";
  let keyCopy: Buffer | undefined;
  const temporary: Buffer[] = [];
  let bundle: VerifiedManagedSkillBundle | undefined;
  let accepted = false;
  try {
    const wire = inputSchema.parse(input);
    const expected = expectedSchema.parse(expectedRelease);
    if (!(cek instanceof Uint8Array) || cek.byteLength !== 32) throw new Error();
    code = "UNTRUSTED_SIGNATURE";
    const keys = trustedKeys(contentTrusts);
    code = "INVALID_ENVELOPE";
    const ciphertext = Buffer.from(wire.ciphertext);
    keyCopy = Buffer.from(cek);
    const parts = wire.manifestJws.split(".");
    if (parts.length !== 3) throw new Error();
    const [protectedSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
    const protectedBytes = decode(protectedSegment, 1024);
    const payloadBytes = decode(payloadSegment, 8192);
    const signature = decode(signatureSegment, 64, 64);
    const protectedHeader = protectedSchema.parse(parseJson(protectedBytes));
    code = "UNTRUSTED_SIGNATURE";
    const key = keys.get(protectedHeader.kid);
    if (
      !key ||
      !verify(null, Buffer.from(`${protectedSegment}.${payloadSegment}`, "ascii"), key, signature)
    )
      throw new Error();

    code = "INVALID_ENVELOPE";
    const manifest = manifestSchema.parse(parseJson(payloadBytes));
    const aad = decode(manifest.headerBase64url, 4096);
    const header = headerSchema.parse(parseJson(aad));
    const iv = decode(header.ivBase64url, 12, 12);
    const tag = decode(manifest.tagBase64url, 16, 16);
    if (
      ciphertext.length !== manifest.ciphertextBytes ||
      ciphertext.length !== header.plaintextBytes
    )
      throw new Error();
    code = "BINDING_MISMATCH";
    if (
      header.tenantId !== expected.tenantId ||
      header.skillId !== expected.skillId ||
      header.skillId !== innerTrust?.skillId ||
      header.version !== expected.version ||
      header.releasePayloadDigest !== expected.releasePayloadDigest ||
      createHash("sha256").update(ciphertext).digest("hex") !== manifest.ciphertextDigest
    )
      throw new Error();

    code = "DECRYPT_FAILED";
    const decipher = createDecipheriv("aes-256-gcm", keyCopy, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    temporary.push(decipher.update(ciphertext));
    // update 输出不能提前解析或释放，只有 final 成功后才组合明文。
    temporary.push(decipher.final());
    const plaintext = Buffer.concat(temporary);
    temporary.push(plaintext);
    code = "INVALID_CONTENT";
    if (plaintext.length !== header.plaintextBytes) throw new Error();
    const envelope = parseJson(plaintext);
    bundle = verifyManagedSkillBundle(envelope, innerTrust);
    // 原 verifier 已验证 envelope/base64 结构，摘要仍针对原 payload bytes。
    const innerPayload = Buffer.from(
      (envelope as { payloadBase64: string }).payloadBase64,
      "base64",
    );
    temporary.push(innerPayload);
    if (
      createHash("sha256").update(innerPayload).digest("hex") !== header.releasePayloadDigest ||
      bundle.skillId !== expected.skillId ||
      bundle.version !== expected.version ||
      bundle.files.some((file) => !/\.md$/i.test(file.path))
    )
      throw new Error();
    accepted = true;
    return bundle;
  } catch {
    // 不携带原 crypto/schema/JSON 异常或中间明文，统一固定安全码。
    throw new EncryptedControllerReleaseError(code);
  } finally {
    keyCopy?.fill(0);
    for (const bytes of temporary) bytes.fill(0);
    if (!accepted && bundle) for (const file of bundle.files) file.bytes.fill(0);
  }
}
