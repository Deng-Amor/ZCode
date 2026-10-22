import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { ManagedSkillPayload } from "@zcode/shared/managed-skills";
import { expect, it } from "vitest";
import { ConfidentialControllerCache } from "../src/confidential-controller/index.js";

it("delivers every signed Markdown reference through an in-memory lease without changing release identity", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    skillId: "synthetic-cache-controller",
    name: "Synthetic cache controller",
    minimumVersion: 2,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const files = [
    { path: "SKILL.md", marker: "SYNTHETIC_MAIN_MARKER" },
    { path: "references/example.md", marker: "SYNTHETIC_REFERENCE_MARKER" },
  ];
  const payload: ManagedSkillPayload = {
    schemaVersion: 1,
    skillId: trust.skillId,
    name: trust.name,
    version: 2,
    files: files.map(({ path, marker }) => {
      const bytes = Buffer.from(`# ${marker}\n`, "utf8");
      return {
        path,
        contentBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const envelope = {
    schemaVersion: 1,
    payloadBase64: payloadBytes.toString("base64"),
    signatureBase64: sign(null, payloadBytes, privateKey).toString("base64"),
  };
  const now = 1_000_000;
  const grant = {
    skillId: trust.skillId,
    version: payload.version,
    digest: createHash("sha256").update(payloadBytes).digest("hex"),
    expiresAt: now + 60_000,
  };
  let downloads = 0;
  const cache = new ConfidentialControllerCache({
    trusts: [trust],
    now: () => now,
    source: {
      authorize: async () => grant,
      download: async () => {
        downloads++;
        return envelope;
      },
    },
  });
  cache.setIdentity({ tenantId: "test-tenant", userId: "test-user", loginId: "test-login" });
  try {
    const instructionDigests: string[] = [];
    for (let consumption = 0; consumption < 2; consumption++) {
      const lease = await cache.acquire({ skillId: trust.skillId, version: payload.version });
      expect(lease.version).toBe(grant.version);
      expect(lease.digest).toBe(grant.digest);
      instructionDigests.push(
        await lease.use(async (instruction) => {
          for (const { path, marker } of files) {
            expect(instruction.includes(`## ${path}\n`)).toBe(true);
            expect(instruction.includes(marker)).toBe(true);
          }
          return createHash("sha256").update(instruction, "utf8").digest("hex");
        }),
      );
    }
    expect(instructionDigests[1]).toBe(instructionDigests[0]);
    expect(downloads).toBe(1);
  } finally {
    cache.clear();
  }
});
