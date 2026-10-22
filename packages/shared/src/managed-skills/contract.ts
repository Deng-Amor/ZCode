import { z } from "zod";

export const MANAGED_SKILL_BUNDLE_LIMITS = Object.freeze({
  envelopeBytes: 20 * 1024 * 1024,
  payloadBytes: 15 * 1024 * 1024,
  totalFileBytes: 10 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  files: 512,
});
export const managedSkillFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  contentBase64: z.string().max(4 * Math.ceil(MANAGED_SKILL_BUNDLE_LIMITS.fileBytes / 3)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Managed identities are unqualified identifiers, never paths or namespace expressions. */
export const managedSkillIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\:]+$/u);
export const managedSkillPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skillId: managedSkillIdentitySchema,
  name: managedSkillIdentitySchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  files: z.array(managedSkillFileSchema).min(1).max(MANAGED_SKILL_BUNDLE_LIMITS.files),
});
export const managedSkillEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  payloadBase64: z.string().max(MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes),
  signatureBase64: z.string().length(88),
});
export type ManagedSkillPayload = z.infer<typeof managedSkillPayloadSchema>;
export type ManagedSkillEnvelope = z.infer<typeof managedSkillEnvelopeSchema>;
export interface ManagedSkillTrust {
  skillId: string;
  name: string;
  /** A single SPKI PUBLIC KEY PEM block; private keys and concatenated PEM are rejected. */
  publicKeyPem: string;
  minimumVersion: number;
}
export interface VerifiedManagedSkillBundle {
  readonly schemaVersion: 1;
  readonly skillId: string;
  readonly name: string;
  readonly version: number;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }[];
}
export type ManagedSkillBundleErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_BASE64"
  | "INVALID_TRUST"
  | "INVALID_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "IDENTITY_MISMATCH"
  | "VERSION_REJECTED"
  | "INVALID_PATH"
  | "LIMIT_EXCEEDED"
  | "HASH_MISMATCH"
  | "MISSING_SKILL";
export class ManagedSkillBundleError extends Error {
  constructor(
    public readonly code: ManagedSkillBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedSkillBundleError";
  }
}
/**
 * Publishers UTF-8 encode JSON.stringify(payload), then Ed25519 sign exact bytes
 * (algorithm null). Verification never reserializes signed bytes. Base64 must be
 * canonical padded base64. Deployment supplies trust, independently of envelopes.
 * Returns owned file bytes: consumers must not reread files from disk.
 * No IO, events, persistence, or global state. Throws ManagedSkillBundleError.
 */
export interface ManagedSkillBundleVerifier {
  (envelope: unknown, trust: ManagedSkillTrust): VerifiedManagedSkillBundle;
}
