import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManagedSkillBundleError, type VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";
import { createControllerLockedStore, createControllerLockedUpdater } from "../src/controller-locked-store/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const bundle = (version: number, body = `secret-${version}`): VerifiedManagedSkillBundle => ({
  schemaVersion: 1,
  skillId: "controller",
  name: "总控派单",
  version,
  files: [{ path: "SKILL.md", bytes: bytes(body), sha256: createHash("sha256").update(bytes(body)).digest("hex") }],
});

const identity = { isAvailable: async () => true, encrypt: async (v: Uint8Array) => Uint8Array.from(v, byte => byte ^ 0xff), decrypt: async (v: Uint8Array) => Uint8Array.from(v, byte => byte ^ 0xff) };

describe("controller locked store", () => {
  it("installs encrypted content and reports its digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    const installed = await store.install(bundle(1));
    expect(await store.status()).toMatchObject({ state: "ready", current: { version: 1, digest: installed.digest } });
    // 新进程实例（同目录冷缓存）首次 status 必须读盘反映现状，不能误报 empty。
    const coldStore = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    expect(await coldStore.status()).toMatchObject({ state: "ready", current: { version: 1 } });
    const files = await readdir(dir);
    expect(files).toContain("locked.bin");
    expect((await readFile(join(dir, "locked.bin"))).toString()).not.toContain("secret-1");
  });

  it("loads content and rejects tampering without returning正文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    await store.install(bundle(1));
    const content = await store.load();
    expect(new TextDecoder().decode(content.files[0].bytes)).toBe("secret-1");
    const cipher = await readFile(join(dir, "locked.bin"));
    cipher[0] ^= 1;
    await writeFile(join(dir, "locked.bin"), cipher);
    await expect(store.load()).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
  });

  it("does not write when encryption is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: { ...identity, isAvailable: async () => false }, trust: {} as never });
    await expect(store.install(bundle(1))).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("supports update and rollback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    const first = await store.install(bundle(1));
    await store.install(bundle(2));
    expect((await store.load()).version).toBe(2);
    expect((await store.rollback()).digest).toBe(first.digest);
    expect((await store.load()).version).toBe(1);
  });

  it("rejects a failed verification without changing the installed bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    await store.install(bundle(1));
    const before = await readFile(join(dir, "locked.bin"));
    const updater = createControllerLockedUpdater({ store, source: { fetchUpdate: async () => ({ kind: "envelope", envelope: {} }) }, verify: () => { throw new ManagedSkillBundleError("INVALID_SIGNATURE", "bad signature"); } });
    expect(await updater.checkAndInstall()).toMatchObject({ outcome: "rejected", errorCode: "INVALID_SIGNATURE" });
    expect(await readFile(join(dir, "locked.bin"))).toEqual(before);
  });

  it("does not write for an up-to-date source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    await store.install(bundle(1));
    const before = await readFile(join(dir, "locked.bin"));
    const outcome = await createControllerLockedUpdater({ store, source: { fetchUpdate: async () => ({ kind: "upToDate" }) } }).checkAndInstall();
    expect(outcome).toEqual({ outcome: "upToDate" });
    expect(await readFile(join(dir, "locked.bin"))).toEqual(before);
  });

  it("converts source failures to IO_FAILED and reports missing installation honestly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    await expect(store.load()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    const result = await createControllerLockedUpdater({ store, source: { fetchUpdate: async () => { throw new Error("offline"); } } }).checkAndInstall();
    expect(result).toEqual({ outcome: "rejected", errorCode: "IO_FAILED" });
  });

  it("rejects rollback when there is no previous valid version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-store-"));
    const store = createControllerLockedStore({ storageDirectory: dir, encryption: identity, trust: {} as never });
    await expect(store.rollback()).rejects.toMatchObject({ code: "IO_FAILED" });
  });
});
