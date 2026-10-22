import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptedPlatformSessionStore } from "../src/confidential-controller/encrypted-login-store.js";

const directories: string[] = [];
const session = {
  version: 1 as const,
  apiBaseUrl: "https://login.invalid/api/",
  tenantId: "1",
  userId: "2",
  refreshToken: "synthetic-refresh-secret",
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ccode-auth-test-"));
  directories.push(root);
  const filePath = join(root, "session.enc");
  const key = randomBytes(32);
  let available = true;
  const encryption = {
    isAvailable: async () => available,
    encrypt: async (text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt: async (data: Uint8Array) => {
      const bytes = Buffer.from(data);
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  return {
    root,
    filePath,
    encryption,
    disable: () => {
      available = false;
    },
    store: createEncryptedPlatformSessionStore({ filePath, encryption }),
  };
}

describe("OS-encrypted platform session file", () => {
  it("round-trips and atomically replaces ciphertext without plaintext or leftover temp files", async () => {
    const fixtureValue = await fixture();
    const { store, filePath, root, encryption } = fixtureValue;
    expect(await store.load()).toBeUndefined();
    await store.save(session);
    const encrypted = await readFile(filePath);
    expect(encrypted.includes(Buffer.from(session.refreshToken))).toBe(false);
    expect(encrypted.includes(Buffer.from(session.apiBaseUrl))).toBe(false);
    const restarted = createEncryptedPlatformSessionStore({ filePath, encryption });
    expect(await restarted.load()).toEqual(session);
    await restarted.save({ ...session, refreshToken: "rotated" });
    expect(await store.load()).toEqual({ ...session, refreshToken: "rotated" });
    expect(await readdir(root)).toEqual(["session.enc"]);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
  it("never writes plaintext when system encryption is unavailable", async () => {
    const { store, root, disable } = await fixture();
    disable();
    await expect(store.save(session)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await readdir(root)).toEqual([]);
  });
  it("preserves existing ciphertext while the system key is unavailable", async () => {
    const { store, filePath, disable } = await fixture();
    await store.save(session);
    const before = await readFile(filePath);
    disable();
    await expect(store.load()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await readFile(filePath)).toEqual(before);
  });
  it("preserves ciphertext when decryption fails without a reliable cause", async () => {
    const { store, filePath } = await fixture();
    await writeFile(filePath, "damaged");
    await expect(store.load()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await readFile(filePath, "utf8")).toBe("damaged");
  });
  it("returns invalid data only after successful decryption of invalid JSON", async () => {
    const { store, filePath, encryption } = await fixture();
    await writeFile(filePath, await encryption.encrypt("invalid-json"));
    expect(await store.load()).toBeNull();
  });
});
