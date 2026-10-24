import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";
import type { ControllerLockedStore, ControllerLockedStoreOptions, ControllerLockedVersion } from "./contract.js";
import { ControllerLockedStoreError } from "./contract.js";

const manifestName = "manifest.json";
const lockedName = "locked.bin";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type Snapshot = ControllerLockedVersion & { cipher: string };
type Manifest = { current?: Snapshot; rollback: Snapshot[]; lastErrorCode?: string };

export function createControllerLockedStore(options: ControllerLockedStoreOptions): ControllerLockedStore {
  const dir = options.storageDirectory;
  const now = options.now ?? (() => new Date());
  let cached: Manifest | undefined;
  const manifestPath = join(dir, manifestName);
  const lockedPath = join(dir, lockedName);
  const readManifest = async (): Promise<Manifest> => {
    if (cached) return cached;
    try { cached = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest; return cached; }
    catch { return { rollback: [] }; }
  };
  const atomic = async (path: string, data: Uint8Array | string) => {
    const staging = `${path}.staging-${process.pid}-${Date.now()}`;
    try { await writeFile(staging, data); await rename(staging, path); } catch (error) { await rm(staging, { force: true }); throw error; }
  };
  const serialize = (verified: VerifiedManagedSkillBundle) => JSON.stringify({ schemaVersion: 1, version: verified.version, files: verified.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: Buffer.from(file.bytes).toString("base64") })) });
  const parse = (plain: Uint8Array) => JSON.parse(new TextDecoder().decode(plain)) as { version: number; files: { path: string; sha256: string; bytes: string }[] };
  return {
    async install(verified) {
      if (!(await options.encryption.isAvailable())) throw new ControllerLockedStoreError("ENCRYPTION_UNAVAILABLE");
      const plain = new TextEncoder().encode(serialize(verified));
      const cipher = await options.encryption.encrypt(plain);
      const current = (await readManifest()).current;
      const version: ControllerLockedVersion = { version: verified.version, digest: digest(plain), landedAt: now().toISOString() };
      // 回滚链封顶：每条快照内嵌完整密文副本，无上限会让 manifest 随更新次数线性膨胀；
      // spec §3 只要求保留「上一有效版本」，这里放宽到 3 条兼顾多次连续回滚。
      const next: Manifest = { current: { ...version, cipher: Buffer.from(cipher).toString("base64") }, rollback: current ? [current, ...(await readManifest()).rollback].slice(0, 3) : [] };
      let previousCipher: Buffer | undefined;
      try { previousCipher = await readFile(lockedPath); } catch { /* 首次安装没有旧副本。 */ }
      try { await mkdir(dir, { recursive: true }); await atomic(lockedPath, cipher); await atomic(manifestPath, JSON.stringify(next)); cached = next; return version; }
      catch (error) {
        try { if (previousCipher) await atomic(lockedPath, previousCipher); else await rm(lockedPath, { force: true }); } catch { /* 保留原始 IO 错误。 */ }
        throw new ControllerLockedStoreError("IO_FAILED", String(error));
      }
    },
    async load() {
      const manifest = await readManifest(); if (!manifest.current) throw new ControllerLockedStoreError("NOT_INSTALLED");
      try {
        const cipher = await readFile(lockedPath); const plain = await options.encryption.decrypt(cipher); const parsed = parse(plain);
        if (digest(plain) !== manifest.current.digest || parsed.version !== manifest.current.version) throw new Error("digest");
        const files = parsed.files.map(file => ({ path: file.path, bytes: Uint8Array.from(Buffer.from(file.bytes, "base64")) }));
        if (files.some((file, i) => digest(file.bytes) !== parsed.files[i]?.sha256)) throw new Error("file digest");
        const skillMd = new TextDecoder().decode(files.find(file => file.path === "SKILL.md")?.bytes ?? new Uint8Array());
        return { version: parsed.version, digest: manifest.current.digest, skillMd, files };
      } catch (error) { if (error instanceof ControllerLockedStoreError) throw error; throw new ControllerLockedStoreError("DIGEST_MISMATCH"); }
    },
    // 必须读盘：新进程（Main 重启）首次调用时内存缓存为空，只看缓存会误报 empty。
    async status() { const manifest = await readManifest(); return manifest.current ? { state: "ready" as const, current: manifest.current } : { state: manifest.lastErrorCode ? ("updateFailed" as const) : ("empty" as const), lastErrorCode: manifest.lastErrorCode }; },
    async rollback() {
      const manifest = await readManifest(); const target = manifest.rollback[0]; if (!target) throw new ControllerLockedStoreError("IO_FAILED", "NO_ROLLBACK");
      try { const cipher = Uint8Array.from(Buffer.from(target.cipher, "base64")); await atomic(lockedPath, cipher); const next = { current: target, rollback: manifest.rollback.slice(1) }; await atomic(manifestPath, JSON.stringify(next)); cached = next; return target; }
      catch (error) { throw new ControllerLockedStoreError("IO_FAILED", String(error)); }
    },
  };
}
