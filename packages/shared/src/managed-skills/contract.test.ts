import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANAGED_SKILL_BUNDLE_LIMITS as limits,
  ManagedSkillBundleError,
  verifyManagedSkillBundle,
  type ManagedSkillPayload,
} from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trust = {
  skillId: "controller",
  name: "Controller",
  minimumVersion: 2,
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
function file(path = "SKILL.md", bytes = Buffer.from("# Controller")) {
  return {
    path,
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function payload(): ManagedSkillPayload {
  return {
    schemaVersion: 1,
    skillId: trust.skillId,
    name: trust.name,
    version: 2,
    files: [file()],
  };
}
function envelopeBytes(bytes: Buffer) {
  return {
    schemaVersion: 1,
    payloadBase64: bytes.toString("base64"),
    signatureBase64: sign(null, bytes, privateKey).toString("base64"),
  };
}
function envelope(value: unknown = payload()) {
  return envelopeBytes(Buffer.from(JSON.stringify(value)));
}
function rejects(value: unknown, code: string, policy = trust) {
  expect(() => verifyManagedSkillBundle(value, policy)).toThrow(
    expect.objectContaining({ name: "ManagedSkillBundleError", code }),
  );
}

describe("managed skill signed bundle contract", () => {
  it("returns authenticated file bytes including binary references", () => {
    const value = payload();
    value.files.push(file("references/data.bin", Buffer.from([0, 255, 1])));
    const verified = verifyManagedSkillBundle(envelope(value), trust);
    expect(verified.version).toBe(2);
    expect(Buffer.from(verified.files[0]!.bytes).toString()).toBe("# Controller");
    expect([...verified.files[1]!.bytes]).toEqual([0, 255, 1]);
  });
  it("verifies original bytes without canonicalizing JSON", () => {
    expect(
      verifyManagedSkillBundle(
        envelopeBytes(Buffer.from(JSON.stringify(payload(), null, 2))),
        trust,
      ).skillId,
    ).toBe(trust.skillId);
    const signed = envelope();
    signed.payloadBase64 = Buffer.from(JSON.stringify(payload(), null, 2)).toString("base64");
    rejects(signed, "INVALID_SIGNATURE");
  });
  it("rejects tampering and a different signing key", () => {
    const signed = envelope();
    const changed = payload();
    changed.version++;
    signed.payloadBase64 = Buffer.from(JSON.stringify(changed)).toString("base64");
    rejects(signed, "INVALID_SIGNATURE");
    rejects(envelope(), "INVALID_SIGNATURE", {
      ...trust,
      publicKeyPem: generateKeyPairSync("ed25519")
        .publicKey.export({ format: "pem", type: "spki" })
        .toString(),
    });
  });
  it("rejects wrong key algorithms and malformed trust", () => {
    rejects(envelope(), "INVALID_TRUST", { ...trust, publicKeyPem: "invalid" });
    rejects(envelope(), "INVALID_TRUST", { ...trust, minimumVersion: 0 });
    rejects(envelope(), "INVALID_TRUST", {
      ...trust,
      publicKeyPem: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .publicKey.export({ format: "pem", type: "spki" })
        .toString(),
    });
  });
  it.each(["a/b", "a\\b", "a:b"])(
    "rejects qualified identities %j in payload and trust",
    (identity) => {
      rejects(envelope({ ...payload(), skillId: identity }), "INVALID_PAYLOAD");
      rejects(envelope({ ...payload(), name: identity }), "INVALID_PAYLOAD");
      rejects(envelope(), "INVALID_TRUST", { ...trust, skillId: identity });
      rejects(envelope(), "INVALID_TRUST", { ...trust, name: identity });
    },
  );
  it("requires a public PEM and rejects private or concatenated key material", () => {
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    rejects(envelope(), "INVALID_TRUST", { ...trust, publicKeyPem: privatePem });
    rejects(envelope(), "INVALID_TRUST", {
      ...trust,
      publicKeyPem: trust.publicKeyPem + privatePem,
    });
  });
  it("rejects unknown fields at every schema level", () => {
    rejects({ ...envelope(), publicKeyPem: trust.publicKeyPem }, "INVALID_ENVELOPE");
    rejects(envelope({ ...payload(), extra: true }), "INVALID_PAYLOAD");
    rejects(
      envelope({ ...payload(), files: [{ ...file(), symlink: "other" }] }),
      "INVALID_PAYLOAD",
    );
  });
  it("rejects malformed UTF-8 and JSON only after verifying bytes", () => {
    rejects(envelopeBytes(Buffer.from([0xff])), "INVALID_PAYLOAD");
    rejects(envelopeBytes(Buffer.from("{")), "INVALID_PAYLOAD");
    const signed = envelopeBytes(Buffer.from("{"));
    signed.signatureBase64 = Buffer.alloc(64).toString("base64");
    rejects(signed, "INVALID_SIGNATURE");
  });
  it("rejects noncanonical base64 for payload, signature and files", () => {
    rejects({ ...envelope(), payloadBase64: envelope().payloadBase64 + "\n" }, "INVALID_BASE64");
    const signed = envelope();
    signed.signatureBase64 = signed.signatureBase64.slice(0, -2) + "==";
    // 64-byte signatures end in two padding bytes; replace with a whitespace alias.
    signed.signatureBase64 = " " + signed.signatureBase64.slice(1);
    rejects(signed, "INVALID_BASE64");
    rejects(
      envelope({
        ...payload(),
        files: [{ ...file(), contentBase64: file().contentBase64 + "\n" }],
      }),
      "INVALID_BASE64",
    );
  });
  it.each([
    "../a",
    "/a",
    "a/../b",
    "./a",
    "a//b",
    "a/",
    "a\\b",
    "C:/a",
    "a:b",
    "a.",
    "a ",
    "CON",
    "con.txt",
    "CON .txt",
    "CONIN$",
    "conout$.log",
    "COM1.log",
    "lpt²",
    "AUX",
    "NUL/x",
    "a/\u0000",
    "a/?",
    "e\u0301.md",
  ])("rejects unsafe path %j", (path) => {
    rejects(envelope({ ...payload(), files: [file(), file(path)] }), "INVALID_PATH");
  });
  it.each(["\ud800.md", "\ud801.md", "\udc00.md"])("rejects unpaired surrogate %j", (path) => {
    rejects(envelope({ ...payload(), files: [file(), file(path)] }), "INVALID_PATH");
  });
  it("rejects distinct malformed names which collapse to the same UTF-8 path", () => {
    expect(Buffer.from("\ud800.md")).toEqual(Buffer.from("\ud801.md"));
    rejects(
      envelope({ ...payload(), files: [file(), file("\ud800.md"), file("\ud801.md")] }),
      "INVALID_PATH",
    );
  });
  it("accepts a correctly paired emoji in a file path", () => {
    const path = "references/\ud83d\ude00.md";
    expect(
      verifyManagedSkillBundle(envelope({ ...payload(), files: [file(), file(path)] }), trust)
        .files[1]!.path,
    ).toBe(path);
  });
  it.each([
    ["README.md", "readme.md"],
    ["I.md", "ı.md"],
    ["a", "a/b"],
    ["A/b", "a"],
    ["a", "a"],
  ])("rejects path collision %s and %s", (first, second) => {
    rejects(envelope({ ...payload(), files: [file(), file(first), file(second)] }), "INVALID_PATH");
  });
  it("requires exactly spelled root SKILL.md", () => {
    rejects(envelope({ ...payload(), files: [file("skill.md")] }), "MISSING_SKILL");
    rejects(envelope({ ...payload(), files: [file("nested/SKILL.md")] }), "MISSING_SKILL");
  });
  it("rejects hash mismatch, identity mismatch and version rollback", () => {
    rejects(
      envelope({ ...payload(), files: [{ ...file(), sha256: "0".repeat(64) }] }),
      "HASH_MISMATCH",
    );
    rejects(envelope({ ...payload(), skillId: "other" }), "IDENTITY_MISMATCH");
    rejects(envelope({ ...payload(), name: "Other" }), "IDENTITY_MISMATCH");
    rejects(envelope({ ...payload(), version: 1 }), "VERSION_REJECTED");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid version %s", (version) => {
    rejects(envelope({ ...payload(), version }), "INVALID_PAYLOAD");
  });
  it("accepts the file count limit and rejects an additional file", () => {
    const files = [
      file(),
      ...Array.from({ length: limits.files - 1 }, (_, i) => file("f" + i, Buffer.alloc(0))),
    ];
    expect(verifyManagedSkillBundle(envelope({ ...payload(), files }), trust).files).toHaveLength(
      limits.files,
    );
    rejects(envelope({ ...payload(), files: [...files, file("extra")] }), "INVALID_PAYLOAD");
  });
  it("accepts per-file and total byte limits and rejects exceeding them", () => {
    const bytes = Buffer.alloc(limits.fileBytes);
    const files = Array.from({ length: 5 }, (_, i) => file(i === 0 ? "SKILL.md" : "f" + i, bytes));
    expect(verifyManagedSkillBundle(envelope({ ...payload(), files }), trust).files).toHaveLength(
      5,
    );
    rejects(
      envelope({ ...payload(), files: [...files, file("extra", Buffer.from("x"))] }),
      "LIMIT_EXCEEDED",
    );
    rejects(
      envelope({ ...payload(), files: [file("SKILL.md", Buffer.alloc(limits.fileBytes + 1))] }),
      "LIMIT_EXCEEDED",
    );
  });
  it("rejects envelopes beyond their total encoded size", () => {
    rejects({ ...envelope(), payloadBase64: "A".repeat(limits.envelopeBytes) }, "LIMIT_EXCEEDED");
  });
  it("exposes typed diagnostic errors", () => {
    expect(new ManagedSkillBundleError("INVALID_SIGNATURE", "rejected")).toBeInstanceOf(Error);
  });
});
