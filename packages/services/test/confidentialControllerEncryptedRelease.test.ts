import { createCipheriv, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MANAGED_SKILL_BUNDLE_LIMITS } from "@zcode/shared/managed-skills";
import { verifyEncryptedControllerRelease } from "../src/confidential-controller/encrypted-release.js";

const marker = "SYNTHETIC_PRIVATE_MARKDOWN";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
type Options = {
  payload?: (value: Record<string, any>) => void;
  envelope?: (value: Record<string, any>) => void;
  plaintext?: (value: Buffer) => Buffer;
  aad?: (value: Record<string, any>) => Buffer;
  manifest?: (value: Record<string, any>) => Buffer;
  protected?: string;
};

function fixture(options: Options = {}) {
  const inner = generateKeyPairSync("ed25519");
  const outer = generateKeyPairSync("ed25519");
  const file = Buffer.from(`# ${marker}\n`);
  const payload = {
    schemaVersion: 1,
    skillId: "controller",
    name: "Controller",
    version: 2,
    files: [{ path: "SKILL.md", contentBase64: file.toString("base64"), sha256: hash(file) }],
  };
  options.payload?.(payload);
  const payloadBytes = json(payload);
  const envelope = {
    schemaVersion: 1,
    payloadBase64: payloadBytes.toString("base64"),
    signatureBase64: sign(null, payloadBytes, inner.privateKey).toString("base64"),
  };
  options.envelope?.(envelope);
  const plaintext = options.plaintext?.(json(envelope)) ?? json(envelope);
  const expected = {
    tenantId: "tenant",
    skillId: "controller",
    version: 2,
    releasePayloadDigest: hash(payloadBytes),
  };
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const header = {
    schemaVersion: 1,
    ...expected,
    plaintextBytes: plaintext.length,
    algorithm: "AES-256-GCM",
    ivBase64url: iv.toString("base64url"),
  };
  const aad = options.aad?.(header) ?? json(header);
  const cipher = createCipheriv("aes-256-gcm", cek, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const manifest = {
    schemaVersion: 1,
    headerBase64url: aad.toString("base64url"),
    ciphertextDigest: hash(ciphertext),
    ciphertextBytes: ciphertext.length,
    tagBase64url: cipher.getAuthTag().toString("base64url"),
  };
  const manifestBytes = options.manifest?.(manifest) ?? json(manifest);
  const protectedText =
    options.protected ?? '{"alg":"EdDSA","kid":"content","typ":"ccode-encrypted-manifest+jws"}';
  const signingInput = `${Buffer.from(protectedText).toString("base64url")}.${manifestBytes.toString("base64url")}`;
  const input = {
    manifestJws: `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), outer.privateKey).toString("base64url")}`,
    ciphertext,
  };
  const trusts = [{ kid: "content", publicKey: outer.publicKey }];
  const innerTrust = {
    skillId: "controller",
    name: "Controller",
    minimumVersion: 2,
    publicKeyPem: inner.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return { input, expected, trusts, innerTrust, cek, outer, file, signingInput };
}
function open(f: ReturnType<typeof fixture>) {
  return verifyEncryptedControllerRelease(f.input, f.expected, f.trusts, f.innerTrust, f.cek);
}
function rejected(f: ReturnType<typeof fixture>, code: string) {
  let returned: unknown;
  let caught: unknown;
  try {
    returned = open(f);
  } catch (error) {
    caught = error;
  }
  expect(returned).toBeUndefined();
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toHaveProperty("code", code);
  expect(caught).not.toHaveProperty("cause");
  expect(String(caught)).not.toContain(marker);
  expect(JSON.stringify(caught)).not.toContain(marker);
  expect(String(caught)).not.toContain(f.cek.toString("hex"));
}

describe("encrypted controller release content verification", () => {
  it("verifies independent Node RFC JWS signing input, AES-GCM and inner Ed25519 bytes", () => {
    const f = fixture();
    expect(f.input.manifestJws.slice(0, f.input.manifestJws.lastIndexOf("."))).toBe(f.signingInput);
    const ciphertext = Buffer.from(f.input.ciphertext);
    const cek = Buffer.from(f.cek);
    const result = open(f);
    expect(result.files[0]?.bytes).toEqual(f.file);
    expect(result.version).toBe(2);
    expect(f.input.ciphertext).toEqual(ciphertext);
    expect(f.cek).toEqual(cek);
    result.files[0]!.bytes.fill(0);
    expect(open(f).files[0]?.bytes).toEqual(f.file);
  });
  it("uses raw signed JSON and AAD bytes with whitespace and reordered properties", () => {
    const f = fixture({
      aad: (h) =>
        Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(h).reverse()), null, 2)),
      manifest: (m) => Buffer.from(JSON.stringify(m, null, 2)),
      protected: '{ "typ":"ccode-encrypted-manifest+jws", "kid":"content", "alg":"EdDSA" }',
    });
    expect(open(f).files[0]?.bytes).toEqual(f.file);
  });
  it.each(["none", "HS256", "RS256", "Ed448"])("rejects alg %s", (alg) => {
    rejected(
      fixture({
        protected: JSON.stringify({ alg, kid: "content", typ: "ccode-encrypted-manifest+jws" }),
      }),
      "INVALID_ENVELOPE",
    );
  });
  it.each(["crit", "b64", "jwk", "jku", "x5c", "x5u", "x5t", "zip"])(
    "rejects header member %s",
    (name) => {
      rejected(
        fixture({
          protected: JSON.stringify({
            alg: "EdDSA",
            kid: "content",
            typ: "ccode-encrypted-manifest+jws",
            [name]: name === "b64" ? true : [],
          }),
        }),
        "INVALID_ENVELOPE",
      );
    },
  );
  it.each(["alg", "kid", "typ"])("uses the last protected %s including escaped names", (name) => {
    const valid = { alg: "EdDSA", kid: "content", typ: "ccode-encrypted-manifest+jws" };
    const rest = JSON.stringify(valid).slice(1);
    const f = fixture({ protected: `{"${name}":"wrong",${rest}` });
    expect(open(f).version).toBe(2);
    const escapedName = `\\u${name.charCodeAt(0).toString(16).padStart(4, "0")}${name.slice(1)}`;
    rejected(
      fixture({ protected: `${JSON.stringify(valid).slice(0, -1)},"${escapedName}":"wrong"}` }),
      name === "kid" ? "UNTRUSTED_SIGNATURE" : "INVALID_ENVELOPE",
    );
  });
  it.each(["version", "tenantId"])("uses the last AAD %s", (name) => {
    const f = fixture({
      aad: (h) => Buffer.from(`{"${name}":"wrong",${JSON.stringify(h).slice(1)}`),
    });
    expect(open(f).version).toBe(2);
    rejected(
      fixture({
        aad: (h) =>
          Buffer.from(
            `${JSON.stringify(h).slice(0, -1)},"${name}":${name === "version" ? 3 : '"other"'}}`,
          ),
      }),
      "BINDING_MISMATCH",
    );
  });
  it("uses last manifest ciphertextBytes and does not discard repeated unknown fields", () => {
    expect(
      open(
        fixture({
          manifest: (m) => Buffer.from(`{"ciphertextBytes":1,${JSON.stringify(m).slice(1)}`),
        }),
      ).version,
    ).toBe(2);
    rejected(
      fixture({
        manifest: (m) => Buffer.from(`${JSON.stringify(m).slice(0, -1)},"unknown":1,"unknown":2}`),
      }),
      "INVALID_ENVELOPE",
    );
  });
  it.each([
    "private-object",
    "private-pem",
    "double-pem",
    "ed448",
    "empty",
    "duplicate",
    "unknown",
    "too-many",
    "oversize-pem",
  ])("rejects untrusted key %s", (kind) => {
    const f = fixture();
    const publicPem = f.outer.publicKey.export({ type: "spki", format: "pem" }).toString();
    if (kind === "empty") f.trusts = [];
    else if (kind === "duplicate") f.trusts.push(f.trusts[0]!);
    else if (kind === "unknown") f.trusts[0]!.kid = "other";
    else if (kind === "too-many")
      f.trusts = Array.from({ length: 33 }, (_, i) => ({
        kid: String(i),
        publicKey: f.outer.publicKey,
      }));
    else
      f.trusts[0]!.publicKey = (
        kind === "private-object"
          ? f.outer.privateKey
          : kind === "private-pem"
            ? f.outer.privateKey.export({ type: "pkcs8", format: "pem" })
            : kind === "double-pem"
              ? publicPem + publicPem
              : kind === "oversize-pem"
                ? " ".repeat(1025) + publicPem
                : generateKeyPairSync("ed448").publicKey
      ) as typeof f.outer.publicKey;
    rejected(f, "UNTRUSTED_SIGNATURE");
  });
  it("accepts a single trusted SPKI public PEM", () => {
    const f = fixture();
    f.trusts[0]!.publicKey = f.outer.publicKey
      .export({ type: "spki", format: "pem" })
      .toString() as unknown as typeof f.outer.publicKey;
    expect(open(f).version).toBe(2);
  });
  it.each([
    "padding",
    "alphabet",
    "empty",
    "four-segments",
    "pad-bits",
    "oversize",
    "changed-signature",
    "changed-payload",
  ])("rejects compact %s", (kind) => {
    const f = fixture();
    const [h, p, s] = f.input.manifestJws.split(".") as [string, string, string];
    const changed = s[0] === "A" ? "B" : "A";
    f.input.manifestJws =
      kind === "padding"
        ? `${h}=.${p}.${s}`
        : kind === "alphabet"
          ? `+.${p}.${s}`
          : kind === "empty"
            ? `${h}..${s}`
            : kind === "four-segments"
              ? `${h}.${p}.${s}.x`
              : kind === "pad-bits"
                ? `${h}.${p}.${s.slice(0, -1)}${String.fromCharCode(s.charCodeAt(s.length - 1) + 1)}`
                : kind === "oversize"
                  ? "A".repeat(16385)
                  : kind === "changed-signature"
                    ? `${h}.${p}.${changed}${s.slice(1)}`
                    : `${h}.${Buffer.concat([Buffer.from(p, "base64url"), Buffer.from(" ")]).toString("base64url")}.${s}`;
    rejected(f, kind.startsWith("changed") ? "UNTRUSTED_SIGNATURE" : "INVALID_ENVELOPE");
  });
  it.each(["tenantId", "skillId", "version", "releasePayloadDigest"])(
    "rejects expected %s mismatch",
    (field) => {
      const f = fixture();
      Object.assign(f.expected, {
        [field]:
          field === "version" ? 3 : field === "releasePayloadDigest" ? "0".repeat(64) : "other",
      });
      rejected(f, "BINDING_MISMATCH");
    },
  );
  it.each(["ciphertext", "tag", "iv", "aad", "mix"])(
    "rejects authenticated encryption %s tampering",
    (kind) => {
      const f = fixture(
        kind === "tag"
          ? { manifest: (m) => json({ ...m, tagBase64url: randomBytes(16).toString("base64url") }) }
          : kind === "iv" || kind === "aad"
            ? {
                manifest: (m) => {
                  const h = JSON.parse(Buffer.from(m.headerBase64url, "base64url").toString());
                  if (kind === "iv") h.ivBase64url = randomBytes(12).toString("base64url");
                  const raw = kind === "aad" ? JSON.stringify(h, null, 2) : JSON.stringify(h);
                  return json({ ...m, headerBase64url: Buffer.from(raw).toString("base64url") });
                },
              }
            : {},
      );
      if (kind === "ciphertext") f.input.ciphertext[0]! ^= 1;
      if (kind === "mix") f.input.ciphertext = fixture().input.ciphertext;
      rejected(f, kind === "ciphertext" || kind === "mix" ? "BINDING_MISMATCH" : "DECRYPT_FAILED");
    },
  );
  it.each(["short", "wrong"])("rejects %s CEK without mutating caller", (kind) => {
    const f = fixture();
    f.cek = randomBytes(kind === "short" ? 31 : 32);
    const original = Buffer.from(f.cek);
    rejected(f, kind === "short" ? "INVALID_ENVELOPE" : "DECRYPT_FAILED");
    expect(f.cek).toEqual(original);
  });
  it.each(["header", "manifest", "aad", "inner"])("rejects BOM at %s", (layer) => {
    const bom = Buffer.from([239, 187, 191]);
    rejected(
      fixture(
        layer === "header"
          ? {
              protected:
                '\uFEFF{"alg":"EdDSA","kid":"content","typ":"ccode-encrypted-manifest+jws"}',
            }
          : layer === "manifest"
            ? { manifest: (m) => Buffer.concat([bom, json(m)]) }
            : layer === "aad"
              ? { aad: (h) => Buffer.concat([bom, json(h)]) }
              : { plaintext: (p) => Buffer.concat([bom, p]) },
      ),
      layer === "inner" ? "INVALID_CONTENT" : "INVALID_ENVELOPE",
    );
  });
  it.each(["manifest", "aad", "inner"])("rejects invalid UTF8 at %s", (layer) => {
    rejected(
      fixture(
        layer === "manifest"
          ? { manifest: () => Buffer.from([0xff]) }
          : layer === "aad"
            ? { aad: () => Buffer.from([0xff]) }
            : { plaintext: () => Buffer.from([0xff]) },
      ),
      layer === "inner" ? "INVALID_CONTENT" : "INVALID_ENVELOPE",
    );
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])("rejects version %s", (version) => {
    rejected(fixture({ aad: (h) => json({ ...h, version }) }), "INVALID_ENVELOPE");
  });
  it.each([
    "manifest-missing",
    "aad-extra",
    "ciphertext-length",
    "plaintext-length",
    "iv-length",
    "tag-length",
    "algorithm",
    "header-limit",
    "manifest-limit",
    "aad-limit",
    "tenant-limit",
  ])("rejects invalid schema/limit %s", (kind) => {
    const f = fixture(
      kind.startsWith("manifest") || kind === "ciphertext-length" || kind === "tag-length"
        ? {
            manifest: (m) => {
              if (kind === "manifest-missing") delete m.ciphertextDigest;
              if (kind === "ciphertext-length") m.ciphertextBytes++;
              if (kind === "tag-length") m.tagBase64url = randomBytes(15).toString("base64url");
              return kind === "manifest-limit"
                ? Buffer.concat([json(m), Buffer.alloc(8193, 32)])
                : json(m);
            },
          }
        : kind === "header-limit"
          ? { protected: " ".repeat(1025) }
          : {
              aad: (h) => {
                if (kind === "aad-extra") h.extra = true;
                if (kind === "plaintext-length") h.plaintextBytes++;
                if (kind === "iv-length") h.ivBase64url = randomBytes(11).toString("base64url");
                if (kind === "algorithm") h.algorithm = "AES-128-GCM";
                if (kind === "tenant-limit") h.tenantId = "界".repeat(86);
                return kind === "aad-limit"
                  ? Buffer.concat([json(h), Buffer.alloc(4097, 32)])
                  : json(h);
              },
            },
    );
    rejected(f, "INVALID_ENVELOPE");
  });
  it("rejects ciphertext beyond the limit before copying it", () => {
    const f = fixture();
    f.input.ciphertext = Buffer.alloc(MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes + 1);
    rejected(f, "INVALID_ENVELOPE");
  });
  it.each([
    "signature",
    "hash",
    "path",
    "missing-skill",
    "non-markdown",
    "floor",
    "inner-version",
    "digest",
  ])("rejects inner %s after valid outer crypto", (kind) => {
    const f = fixture(
      kind === "signature"
        ? {
            envelope: (e) => {
              e.signatureBase64 = Buffer.alloc(64).toString("base64");
            },
          }
        : {
            payload: (p) => {
              if (kind === "hash") p.files[0].sha256 = "0".repeat(64);
              if (kind === "path") p.files[0].path = "../SKILL.md";
              if (kind === "missing-skill") p.files[0].path = "other.md";
              if (kind === "non-markdown") p.files.push({ ...p.files[0], path: "script.js" });
              if (kind === "inner-version") p.version = 3;
            },
            aad: (h) =>
              json(kind === "digest" ? { ...h, releasePayloadDigest: "0".repeat(64) } : h),
          },
    );
    if (kind === "floor") f.innerTrust.minimumVersion = 3;
    if (kind === "digest") f.expected.releasePayloadDigest = "0".repeat(64);
    rejected(f, "INVALID_CONTENT");
  });
});
