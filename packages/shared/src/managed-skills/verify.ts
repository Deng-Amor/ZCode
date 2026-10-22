import { createHash, createPublicKey, verify } from "node:crypto";
import {
  MANAGED_SKILL_BUNDLE_LIMITS as limits,
  ManagedSkillBundleError,
  managedSkillEnvelopeSchema,
  managedSkillIdentitySchema,
  managedSkillPayloadSchema,
  type ManagedSkillBundleVerifier,
} from "./contract.js";

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new ManagedSkillBundleError("INVALID_BASE64", "Expected canonical padded base64");
  }
  return bytes;
}

function validatePath(path: string): string {
  const segments = path.split("/");
  if (
    // 孤立代理字符编码为 UTF-8 时会替换成同一个 U+FFFD，必须在路径去重前拒绝。
    !path.isWellFormed() ||
    path.normalize("NFC") !== path ||
    /[\\:<>"|?*]/u.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(
          segment.split(".")[0]!.trimEnd(),
        ),
    )
  ) {
    throw new ManagedSkillBundleError("INVALID_PATH", "Unsafe bundle file path");
  }
  return path.toUpperCase();
}

export const verifyManagedSkillBundle: ManagedSkillBundleVerifier = (input, trust) => {
  const envelopeResult = managedSkillEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    throw new ManagedSkillBundleError("INVALID_ENVELOPE", "Invalid signed envelope");
  }
  const envelope = envelopeResult.data;
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > limits.envelopeBytes) {
    throw new ManagedSkillBundleError("LIMIT_EXCEEDED", "Envelope exceeds size limit");
  }
  if (
    !trust ||
    !managedSkillIdentitySchema.safeParse(trust.skillId).success ||
    !managedSkillIdentitySchema.safeParse(trust.name).success ||
    !Number.isSafeInteger(trust.minimumVersion) ||
    trust.minimumVersion < 1
  ) {
    throw new ManagedSkillBundleError("INVALID_TRUST", "Invalid deployment trust policy");
  }
  let key;
  try {
    // createPublicKey 也会接受私钥并派生公钥；客户端信任配置只允许单个 SPKI 公钥块。
    if (
      typeof trust.publicKeyPem !== "string" ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(
        trust.publicKeyPem.trim(),
      )
    ) {
      throw new Error("Expected a single public PEM block");
    }
    key = createPublicKey(trust.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong key type");
  } catch {
    throw new ManagedSkillBundleError("INVALID_TRUST", "Expected trusted Ed25519 public key");
  }
  const payloadBytes = decodeBase64(envelope.payloadBase64);
  if (payloadBytes.length > limits.payloadBytes) {
    throw new ManagedSkillBundleError("LIMIT_EXCEEDED", "Payload exceeds size limit");
  }
  const signature = decodeBase64(envelope.signatureBase64);
  if (signature.length !== 64 || !verify(null, payloadBytes, key, signature)) {
    throw new ManagedSkillBundleError("INVALID_SIGNATURE", "Bundle signature rejected");
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    throw new ManagedSkillBundleError("INVALID_PAYLOAD", "Payload must be UTF-8 JSON");
  }
  const payloadResult = managedSkillPayloadSchema.safeParse(rawPayload);
  if (!payloadResult.success) {
    throw new ManagedSkillBundleError("INVALID_PAYLOAD", "Invalid bundle payload");
  }
  const payload = payloadResult.data;
  if (payload.skillId !== trust.skillId || payload.name !== trust.name) {
    throw new ManagedSkillBundleError("IDENTITY_MISMATCH", "Unexpected skill identity");
  }
  if (payload.version < trust.minimumVersion) {
    throw new ManagedSkillBundleError("VERSION_REJECTED", "Bundle below deployment version floor");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = payload.files.map((file) => {
    const pathKey = validatePath(file.path);
    if (paths.has(pathKey)) {
      throw new ManagedSkillBundleError("INVALID_PATH", "Duplicate or case-conflicting path");
    }
    paths.add(pathKey);
    const bytes = decodeBase64(file.contentBase64);
    totalBytes += bytes.length;
    if (bytes.length > limits.fileBytes || totalBytes > limits.totalFileBytes) {
      throw new ManagedSkillBundleError("LIMIT_EXCEEDED", "Bundle content exceeds size limit");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new ManagedSkillBundleError("HASH_MISMATCH", "Bundle file hash mismatch");
    }
    return { path: file.path, bytes, sha256: file.sha256 };
  });
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      if (paths.has(segments.slice(0, index).join("/"))) {
        throw new ManagedSkillBundleError("INVALID_PATH", "File conflicts with parent directory");
      }
    }
  }
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new ManagedSkillBundleError("MISSING_SKILL", "Bundle requires root SKILL.md");
  }
  return {
    schemaVersion: 1,
    skillId: payload.skillId,
    name: payload.name,
    version: payload.version,
    files,
  };
};
