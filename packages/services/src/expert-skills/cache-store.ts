import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ExpertSkillCacheError,
  type ExpertSkillCacheEntry,
  type ExpertSkillCacheEntryState,
  type ExpertSkillCacheStore,
  type ExpertSkillVerifiedInput,
} from "@zcode/shared/expert-skills";
import { managedSkillIdentitySchema } from "@zcode/shared/managed-skills";
import { atomicWriteJson } from "#src/fs/atomicFileUtils.js";
import { maybeThrowInjectedFsFault } from "#src/fs/fsFaultInjection.js";
import type { ExpertSkillCacheStoreOptions } from "./contract.js";

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
// 崩溃残留的 tmp 目录按陈旧阈值清理，避免误删另一线程刚创建的 staging 目录。
const TEMP_DIR_STALE_MS = 60_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface StoredFileRecord {
  path: string;
  sha256: string;
  bytes: number;
}

interface StoredEntry {
  skillId: string;
  name: string;
  version: number;
  digest: string;
  cachedAt: number;
  validUntil: number | null;
  state: ExpertSkillCacheEntryState;
  lastUsedAt: number;
  totalBytes: number;
  files: StoredFileRecord[];
}

interface IdentityIndex {
  schemaVersion: 1;
  entries: StoredEntry[];
}

/**
 * put 入口独立复核相对路径安全：调用方传入的「已验签产物」可能是绕过
 * verifyManagedSkillBundle 构造的对象，缓存存储不能信任调用方，路径规则与
 * managed-skills verify 的 INVALID_PATH 校验保持一致，防止越出缓存目录。
 */
function assertSafeRelativePath(path: string): void {
  const segments = path.split("/");
  if (
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
        /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(segment),
    )
  ) {
    throw new ExpertSkillCacheError("INVALID_INPUT", "Unsafe bundle file path");
  }
}

function parseIdentityIndex(raw: string): IdentityIndex {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ExpertSkillCacheError("CACHE_CORRUPT", "Cache index is not valid JSON");
  }
  const index = value as IdentityIndex;
  if (
    index === null ||
    typeof index !== "object" ||
    index.schemaVersion !== 1 ||
    !Array.isArray(index.entries)
  ) {
    throw new ExpertSkillCacheError("CACHE_CORRUPT", "Cache index schema mismatch");
  }
  for (const entry of index.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.skillId !== "string" ||
      typeof entry.name !== "string" ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1 ||
      typeof entry.digest !== "string" ||
      !SHA256_HEX.test(entry.digest) ||
      !Number.isSafeInteger(entry.cachedAt) ||
      !(entry.validUntil === null || Number.isSafeInteger(entry.validUntil)) ||
      (entry.state !== "available" && entry.state !== "revoked" && entry.state !== "versionRejected") ||
      !Number.isSafeInteger(entry.lastUsedAt) ||
      !Number.isSafeInteger(entry.totalBytes) ||
      entry.totalBytes < 0 ||
      !Array.isArray(entry.files) ||
      entry.files.some(
        (file) =>
          !file ||
          typeof file !== "object" ||
          typeof file.path !== "string" ||
          !file.path ||
          typeof file.sha256 !== "string" ||
          !SHA256_HEX.test(file.sha256) ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 0,
      )
    ) {
      throw new ExpertSkillCacheError("CACHE_CORRUPT", "Cache index entry malformed");
    }
  }
  return index;
}

/** 磁盘布局：<baseDir>/identities/<identityHash>/entries/<digest>（内容寻址）+ index.json（唯一提交点）。 */
class ExpertSkillCacheStoreImpl implements ExpertSkillCacheStore {
  readonly #baseDir: string;
  readonly #maxEntries: number;
  readonly #maxTotalBytes: number;
  readonly #defaultTtlMs: number | null;
  readonly #now: () => number;
  /** 身份目录哈希 -> skillId -> 条目。哈希为键使全局 LRU 无需还原身份字符串。 */
  readonly #byHash = new Map<string, Map<string, StoredEntry>>();
  /** 所有变更全局串行：唯一写入者语义下避免替换/淘汰与读取复验交错。 */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: ExpertSkillCacheStoreOptions) {
    if (!options || typeof options.baseDir !== "string" || !options.baseDir.trim()) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "baseDir is required");
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "maxEntries must be a positive integer");
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "maxTotalBytes must be a positive integer");
    }
    if (
      options.defaultTtlMs !== undefined &&
      options.defaultTtlMs !== null &&
      (!Number.isSafeInteger(options.defaultTtlMs) || options.defaultTtlMs <= 0)
    ) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "defaultTtlMs must be null or positive");
    }
    this.#baseDir = options.baseDir;
    this.#maxEntries = maxEntries;
    this.#maxTotalBytes = maxTotalBytes;
    this.#defaultTtlMs = options.defaultTtlMs ?? null;
    this.#now = options.now ?? Date.now;
  }

  get(identity: string, skillId: string): Promise<ExpertSkillCacheEntry | undefined> {
    return this.#enqueue(() => this.#get(this.#identityKey(identity), skillId));
  }

  put(identity: string, input: ExpertSkillVerifiedInput): Promise<void> {
    return this.#enqueue(() => this.#put(this.#identityKey(identity), input));
  }

  markRevoked(identity: string, skillId: string): Promise<void> {
    return this.#enqueue(() => this.#markRevoked(this.#identityKey(identity), skillId));
  }

  clearIdentity(identity: string): Promise<void> {
    return this.#enqueue(() => this.#clearIdentity(this.#identityKey(identity)));
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #identityKey(identity: string): string {
    if (typeof identity !== "string" || !identity.trim()) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "identity must be a non-empty string");
    }
    return identity.trim();
  }

  #hash(identityKey: string): string {
    return createHash("sha256").update(identityKey, "utf8").digest("hex");
  }

  #identityDir(hash: string): string {
    return join(this.#baseDir, "identities", hash);
  }

  #entryDir(hash: string, digest: string): string {
    return join(this.#identityDir(hash), "entries", digest);
  }

  async #get(identityKey: string, skillId: string): Promise<ExpertSkillCacheEntry | undefined> {
    if (!managedSkillIdentitySchema.safeParse(skillId).success) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "skillId is not a bare identifier");
    }
    const entries = await this.#loadIdentity(this.#hash(identityKey));
    const entry = entries.get(skillId);
    if (!entry) return undefined;
    // 内存 LRU 触碰；磁盘 lastUsedAt 随下一次变更持久化刷新，读路径不放大写盘。
    entry.lastUsedAt = this.#now();
    await this.#verifyEntry(this.#hash(identityKey), entry);
    return {
      skillId: entry.skillId,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
      filesBaseDir: this.#entryDir(this.#hash(identityKey), entry.digest),
      cachedAt: entry.cachedAt,
      validUntil: entry.validUntil,
      state: entry.state,
    };
  }

  /** 加载前逐文件 sha256 复验（spec §5.2 防篡改）：内容不一致拒绝加载，缺文件按损坏处理。 */
  async #verifyEntry(hash: string, entry: StoredEntry): Promise<void> {
    for (const file of entry.files) {
      const path = join(this.#entryDir(hash, entry.digest), file.path);
      let bytes: Buffer;
      try {
        maybeThrowInjectedFsFault({ operation: "readFile", path });
        bytes = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ExpertSkillCacheError("CACHE_CORRUPT", `Cached file missing: ${file.path}`);
        }
        throw this.#ioError(`read cached file ${file.path}`, error);
      }
      if (bytes.length !== file.bytes) {
        throw new ExpertSkillCacheError("HASH_MISMATCH", `Cached file size changed: ${file.path}`);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new ExpertSkillCacheError("HASH_MISMATCH", `Cached file hash mismatch: ${file.path}`);
      }
    }
  }

  async #put(identityKey: string, input: ExpertSkillVerifiedInput): Promise<void> {
    this.#assertPutInput(input);
    const { verified, payloadDigest } = input;
    const hash = this.#hash(identityKey);
    const entries = await this.#loadIdentity(hash);
    await this.#sweepStaleTemp();
    const existing = entries.get(verified.skillId);
    if (existing && existing.digest === payloadDigest) {
      // 同 digest 即同内容，不重复落盘；仅刷新有效期与 LRU（spec §5.2/§6.3 协商语义）。
      const now = this.#now();
      existing.lastUsedAt = now;
      existing.validUntil = this.#defaultTtlMs === null ? null : now + this.#defaultTtlMs;
      await this.#persist(hash, entries);
      return;
    }
    const files: StoredFileRecord[] = verified.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
    }));
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (totalBytes > this.#maxTotalBytes) {
      throw new ExpertSkillCacheError(
        "CAPACITY_EXCEEDED",
        `Bundle ${totalBytes}B exceeds cache limit ${this.#maxTotalBytes}B`,
      );
    }
    const entryDir = this.#entryDir(hash, payloadDigest);
    const tempDir = join(this.#baseDir, "tmp", `${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      maybeThrowInjectedFsFault({ operation: "mkdir", path: join(this.#baseDir, "identities") });
      await mkdir(join(this.#baseDir, "identities"), { recursive: true });
      maybeThrowInjectedFsFault({ operation: "mkdir", path: tempDir });
      await mkdir(tempDir, { recursive: true });
      for (const file of verified.files) {
        const target = join(tempDir, file.path);
        maybeThrowInjectedFsFault({ operation: "mkdir", path: target });
        await mkdir(dirname(target), { recursive: true });
        maybeThrowInjectedFsFault({ operation: "writeFile", path: target });
        await writeFile(target, file.bytes);
      }
      // index.json 是唯一提交点：先物化文件到 tmp，再原子 rename 为 entries/<digest>。
      maybeThrowInjectedFsFault({ operation: "mkdir", path: entryDir });
      await mkdir(dirname(entryDir), { recursive: true });
      // 同 digest 残留目录只可能是上次 rename 前中断留下；同 digest 即同内容，可安全重建。
      await rm(entryDir, { force: true, recursive: true });
      maybeThrowInjectedFsFault({ operation: "rename", path: entryDir });
      await rename(tempDir, entryDir);
    } catch (error) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
      throw this.#ioError("materialize cache entry", error);
    }
    const now = this.#now();
    const entry: StoredEntry = {
      skillId: verified.skillId,
      name: verified.name,
      version: verified.version,
      digest: payloadDigest,
      cachedAt: now,
      validUntil: this.#defaultTtlMs === null ? null : now + this.#defaultTtlMs,
      state: "available",
      lastUsedAt: now,
      totalBytes,
      files,
    };
    entries.set(verified.skillId, entry);
    try {
      await this.#persistAndEvict(hash);
    } catch (error) {
      // 索引提交失败：回滚内存并移除未提交目录，保证失败保留上一个仍有效版本。
      if (existing) entries.set(existing.skillId, existing);
      else entries.delete(entry.skillId);
      await rm(entryDir, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    if (existing && existing.digest !== payloadDigest) {
      await rm(this.#entryDir(hash, existing.digest), { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }

  #assertPutInput(input: ExpertSkillVerifiedInput): void {
    if (!input || typeof input !== "object" || !input.verified) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "put requires a verified bundle");
    }
    const { verified } = input;
    if (
      !managedSkillIdentitySchema.safeParse(verified.skillId).success ||
      !managedSkillIdentitySchema.safeParse(verified.name).success ||
      !Number.isSafeInteger(verified.version) ||
      verified.version < 1 ||
      !Array.isArray(verified.files) ||
      verified.files.length === 0 ||
      typeof input.payloadDigest !== "string" ||
      !SHA256_HEX.test(input.payloadDigest)
    ) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "verified bundle shape rejected");
    }
    const paths = new Set<string>();
    for (const file of verified.files) {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.sha256 !== "string" ||
        !SHA256_HEX.test(file.sha256) ||
        !(file.bytes instanceof Uint8Array)
      ) {
        throw new ExpertSkillCacheError("INVALID_INPUT", "verified bundle file rejected");
      }
      assertSafeRelativePath(file.path);
      if (paths.has(file.path.toUpperCase())) {
        throw new ExpertSkillCacheError("INVALID_INPUT", "Duplicate or case-conflicting path");
      }
      paths.add(file.path.toUpperCase());
    }
  }

  async #markRevoked(identityKey: string, skillId: string): Promise<void> {
    if (!managedSkillIdentitySchema.safeParse(skillId).success) {
      throw new ExpertSkillCacheError("INVALID_INPUT", "skillId is not a bare identifier");
    }
    const hash = this.#hash(identityKey);
    const entries = await this.#loadIdentity(hash);
    const entry = entries.get(skillId);
    // 未缓存条目无可撤销标记；撤销已缓存条目按 spec §5.2 禁止加载、不静默回退。
    if (!entry) return;
    entry.state = "revoked";
    await this.#persist(hash, entries);
  }

  async #clearIdentity(identityKey: string): Promise<void> {
    // 身份切换后旧身份缓存不可被新身份读取（spec §5.2）：目录与内存一并清除。
    const hash = this.#hash(identityKey);
    this.#byHash.delete(hash);
    maybeThrowInjectedFsFault({ operation: "rm", path: this.#identityDir(hash) });
    await rm(this.#identityDir(hash), { recursive: true, force: true });
  }

  async #loadIdentity(hash: string): Promise<Map<string, StoredEntry>> {
    const loaded = this.#byHash.get(hash);
    if (loaded) return loaded;
    const entries = new Map<string, StoredEntry>();
    const indexPath = join(this.#identityDir(hash), "index.json");
    let raw: string | undefined;
    try {
      maybeThrowInjectedFsFault({ operation: "readFile", path: indexPath });
      raw = await readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw this.#ioError("read cache index", error);
      }
      raw = undefined;
    }
    if (raw !== undefined) {
      for (const entry of parseIdentityIndex(raw).entries) entries.set(entry.skillId, entry);
    }
    this.#byHash.set(hash, entries);
    await this.#sweepOrphanEntries(hash, entries);
    return entries;
  }

  /** 上限按整个缓存区（跨身份）计算；淘汰前先加载磁盘上的全部身份索引。 */
  async #ensureAllIdentitiesLoaded(): Promise<void> {
    let names: string[];
    try {
      maybeThrowInjectedFsFault({ operation: "readdir", path: join(this.#baseDir, "identities") });
      names = await readdir(join(this.#baseDir, "identities"));
    } catch {
      return;
    }
    for (const name of names) {
      if (!this.#byHash.has(name)) await this.#loadIdentity(name);
    }
  }

  async #persist(hash: string, entries: Map<string, StoredEntry>): Promise<void> {
    const index: IdentityIndex = { schemaVersion: 1, entries: [...entries.values()] };
    maybeThrowInjectedFsFault({ operation: "writeFile", path: join(this.#identityDir(hash), "index.json") });
    await atomicWriteJson(
      join(this.#identityDir(hash), "index.json"),
      index as unknown as Record<string, unknown>,
      // 唯一写入者（spec §5.1）+ 进程内全局串行，无需跨进程锁文件。
      { useFileLock: false },
    );
  }

  async #persistAndEvict(changedHash: string): Promise<void> {
    await this.#ensureAllIdentitiesLoaded();
    const all = [...this.#byHash.entries()].flatMap(([hash, entries]) =>
      [...entries.values()].map((entry) => ({ hash, entry })),
    );
    let count = all.length;
    let bytes = all.reduce((sum, { entry }) => sum + entry.totalBytes, 0);
    const evicted = new Map<string, StoredEntry[]>();
    if (count > this.#maxEntries || bytes > this.#maxTotalBytes) {
      const victims = [...all].sort(
        (a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt || a.entry.cachedAt - b.entry.cachedAt,
      );
      for (const victim of victims) {
        if (count <= this.#maxEntries && bytes <= this.#maxTotalBytes) break;
        this.#byHash.get(victim.hash)?.delete(victim.entry.skillId);
        const list = evicted.get(victim.hash) ?? [];
        list.push(victim.entry);
        evicted.set(victim.hash, list);
        count -= 1;
        bytes -= victim.entry.totalBytes;
      }
    }
    // 先提交索引再删目录：中断只可能留下可被 sweep 清理的孤儿目录，
    // 不可能留下指向已删目录的索引（get 复验按 CACHE_CORRUPT 拒绝）。
    const changed = new Set([changedHash, ...evicted.keys()]);
    for (const hash of changed) {
      await this.#persist(hash, this.#byHash.get(hash) ?? new Map());
    }
    for (const [hash, list] of evicted) {
      for (const entry of list) {
        await rm(this.#entryDir(hash, entry.digest), { force: true, recursive: true }).catch(
          () => undefined,
        );
      }
    }
  }

  async #sweepOrphanEntries(hash: string, entries: Map<string, StoredEntry>): Promise<void> {
    const entriesDir = join(this.#identityDir(hash), "entries");
    let names: string[];
    try {
      names = await readdir(entriesDir);
    } catch {
      return;
    }
    const referenced = new Set([...entries.values()].map((entry) => entry.digest));
    for (const name of names) {
      if (!referenced.has(name)) {
        await rm(join(entriesDir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #sweepStaleTemp(): Promise<void> {
    const tmpRoot = join(this.#baseDir, "tmp");
    let names: string[];
    try {
      names = await readdir(tmpRoot);
    } catch {
      return;
    }
    const now = this.#now();
    for (const name of names) {
      const dir = join(tmpRoot, name);
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs < TEMP_DIR_STALE_MS) continue;
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort 清理崩溃残留。
      }
    }
  }

  #ioError(action: string, error: unknown): Error {
    if (error instanceof ExpertSkillCacheError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ExpertSkillCacheError("IO_FAILED", `${action}: ${message}`);
  }
}

/** 创建专家 skill 缓存存储（spec §5.1 唯一写入者；实现在 services 层，端口在 @zcode/shared/expert-skills）。 */
export function createExpertSkillCacheStore(
  options: ExpertSkillCacheStoreOptions,
): ExpertSkillCacheStore {
  return new ExpertSkillCacheStoreImpl(options);
}
