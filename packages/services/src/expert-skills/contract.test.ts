import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifiedManagedSkillBundle } from "@zcode/shared/managed-skills";
import {
  createFsFaultInjector,
  setFsFaultInjectorForTests,
} from "#src/fs/fsFaultInjection.js";
import {
  createExpertSkillCacheStore,
  type ExpertSkillCacheStore,
  type ExpertSkillCacheStoreOptions,
} from "./index.js";
// 契约测试只 import contract 与 module 入口，不感知实现细节之外的内部符号。
import { expertSkillsCacheModule } from "./module.js";

afterEach(() => {
  setFsFaultInjectorForTests(null);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bundle(input?: {
  skillId?: string;
  version?: number;
}): { verified: VerifiedManagedSkillBundle; payloadDigest: string } {
  const skillId = input?.skillId ?? "pdd-expert";
  const version = input?.version ?? 1;
  const main = Buffer.from(`# 专家 ${skillId} v${version}\n`, "utf8");
  const guide = Buffer.from("## 操作指南\n", "utf8");
  const verified: VerifiedManagedSkillBundle = {
    schemaVersion: 1,
    skillId,
    name: `${skillId}-name`,
    version,
    files: [
      { path: "SKILL.md", bytes: main, sha256: sha256(main) },
      { path: "references/guide.md", bytes: guide, sha256: sha256(guide) },
    ],
  };
  const payloadDigest = sha256(Buffer.from(JSON.stringify({ skillId, version }), "utf8"));
  return { verified, payloadDigest };
}

async function newStore(
  options?: Partial<ExpertSkillCacheStoreOptions>,
): Promise<{ store: ExpertSkillCacheStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "expert-skill-cache-"));
  const store = createExpertSkillCacheStore({ baseDir, ...options });
  return { store, baseDir };
}

async function entryDirs(baseDir: string, identity: string): Promise<string[]> {
  const hash = sha256(Buffer.from(identity, "utf8"));
  return readdir(join(baseDir, "identities", hash, "entries")).catch(() => [] as string[]);
}

describe("expert skill cache store contract", () => {
  it("declares its module manifest", () => {
    expect(expertSkillsCacheModule.id).toBe("expert-skills-cache");
  });

  it("put-get 往返：条目元数据与物化文件一致", async () => {
    const { store, baseDir } = await newStore();
    const { verified, payloadDigest } = bundle({ version: 3 });
    await store.put("tenant-a:user-1", { verified, payloadDigest });
    const entry = await store.get("tenant-a:user-1", "pdd-expert");
    expect(entry).toMatchObject({
      skillId: "pdd-expert",
      name: "pdd-expert-name",
      version: 3,
      digest: payloadDigest,
      state: "available",
    });
    expect(entry?.validUntil).toBeNull();
    expect(entry?.filesBaseDir).toContain(join(baseDir, "identities"));
    expect(await readFile(join(entry!.filesBaseDir, "SKILL.md"), "utf8")).toBe(
      "# 专家 pdd-expert v3\n",
    );
    expect(await readFile(join(entry!.filesBaseDir, "references", "guide.md"), "utf8")).toBe(
      "## 操作指南\n",
    );
    expect(await store.get("tenant-a:user-1", "unknown-skill")).toBeUndefined();
  });

  it("同 digest 重复 put 不重复落盘，仅刷新有效期", async () => {
    let fakeNow = 1_000;
    const { store, baseDir } = await newStore({ defaultTtlMs: 5_000, now: () => fakeNow });
    const { verified, payloadDigest } = bundle();
    await store.put("u1", { verified, payloadDigest });
    fakeNow = 2_000;
    await store.put("u1", { verified, payloadDigest });
    expect(await entryDirs(baseDir, "u1")).toHaveLength(1);
    const entry = await store.get("u1", "pdd-expert");
    expect(entry?.validUntil).toBe(2_000 + 5_000);
    expect(entry?.cachedAt).toBe(1_000);
  });

  it("版本替换：新版本可读，旧 digest 目录被清理", async () => {
    const { store, baseDir } = await newStore();
    const v1 = bundle({ version: 1 });
    const v2 = bundle({ version: 2 });
    await store.put("u1", v1);
    await store.put("u1", v2);
    const entry = await store.get("u1", "pdd-expert");
    expect(entry?.version).toBe(2);
    expect(entry?.digest).toBe(v2.payloadDigest);
    expect(await entryDirs(baseDir, "u1")).toEqual([v2.payloadDigest]);
  });

  it("按身份隔离：跨身份不可见，clearIdentity 只清除目标身份", async () => {
    const { store, baseDir } = await newStore();
    const { verified, payloadDigest } = bundle();
    await store.put("tenant-a:user-1", { verified, payloadDigest });
    expect(await store.get("tenant-b:user-2", "pdd-expert")).toBeUndefined();
    await store.put("tenant-b:user-2", bundle({ skillId: "other-expert" }));
    await store.clearIdentity("tenant-a:user-1");
    expect(await store.get("tenant-a:user-1", "pdd-expert")).toBeUndefined();
    expect((await store.get("tenant-b:user-2", "other-expert"))?.version).toBe(1);
    const hash = sha256(Buffer.from("tenant-a:user-1", "utf8"));
    await expect(readdir(join(baseDir, "identities", hash))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("篡改检测：文件字节被改后拒绝加载（HASH_MISMATCH）", async () => {
    const { store } = await newStore();
    const { verified, payloadDigest } = bundle();
    await store.put("u1", { verified, payloadDigest });
    const entry = await store.get("u1", "pdd-expert");
    await writeFile(join(entry!.filesBaseDir, "SKILL.md"), "tampered", "utf8");
    await expect(store.get("u1", "pdd-expert")).rejects.toMatchObject({
      name: "ExpertSkillCacheError",
      code: "HASH_MISMATCH",
    });
  });

  it("缓存损坏：条目文件缺失按 CACHE_CORRUPT 拒绝", async () => {
    const { store } = await newStore();
    const { verified, payloadDigest } = bundle();
    await store.put("u1", { verified, payloadDigest });
    const entry = await store.get("u1", "pdd-expert");
    await rm(join(entry!.filesBaseDir, "references", "guide.md"));
    await expect(store.get("u1", "pdd-expert")).rejects.toMatchObject({
      code: "CACHE_CORRUPT",
    });
  });

  it("索引被篡改：新实例加载时按 CACHE_CORRUPT 拒绝，不静默清空", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "expert-skill-cache-"));
    const store1 = createExpertSkillCacheStore({ baseDir });
    const { verified, payloadDigest } = bundle();
    await store1.put("u1", { verified, payloadDigest });
    const hash = sha256(Buffer.from("u1", "utf8"));
    await writeFile(join(baseDir, "identities", hash, "index.json"), "not json", "utf8");
    const store2 = createExpertSkillCacheStore({ baseDir });
    await expect(store2.get("u1", "pdd-expert")).rejects.toMatchObject({
      code: "CACHE_CORRUPT",
    });
  });

  it("原子性：写入或 rename 中断不破坏旧版本，也不留半份条目", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "expert-skill-cache-"));
    const store = createExpertSkillCacheStore({ baseDir });
    const v1 = bundle({ version: 1 });
    await store.put("u1", v1);
    // 在 tmp 目录写入阶段注入故障，模拟进程在 rename 前中断。
    setFsFaultInjectorForTests(
      createFsFaultInjector([
        { id: "tmp-write", code: "EIO", operations: ["writeFile"], pathIncludes: "/tmp/" },
      ]),
    );
    await expect(store.put("u1", bundle({ version: 2 }))).rejects.toMatchObject({
      code: "IO_FAILED",
    });
    setFsFaultInjectorForTests(null);
    // 旧版本保持可加载；entries 下只有旧 digest；tmp 无残留。
    expect((await store.get("u1", "pdd-expert"))?.version).toBe(1);
    expect(await entryDirs(baseDir, "u1")).toEqual([v1.payloadDigest]);
    expect(await readdir(join(baseDir, "tmp"))).toEqual([]);
    // rename 阶段中断同样保持该不变量。
    setFsFaultInjectorForTests(
      createFsFaultInjector([
        { id: "entry-rename", code: "EIO", operations: ["rename"], pathIncludes: "/entries/" },
      ]),
    );
    await expect(store.put("u1", bundle({ version: 2 }))).rejects.toMatchObject({
      code: "IO_FAILED",
    });
    setFsFaultInjectorForTests(null);
    expect((await store.get("u1", "pdd-expert"))?.version).toBe(1);
    expect(await entryDirs(baseDir, "u1")).toEqual([v1.payloadDigest]);
    expect(await readdir(join(baseDir, "tmp"))).toEqual([]);
  });

  it("崩溃残留的陈旧 tmp 目录在后续 put 时被清理", async () => {
    const fakeNow = Date.now();
    const { store, baseDir } = await newStore({ now: () => fakeNow });
    const stale = join(baseDir, "tmp", "crash-leftover");
    await mkdir(stale, { recursive: true });
    await utimes(stale, new Date(fakeNow - 120_000), new Date(fakeNow - 120_000));
    await store.put("u1", bundle());
    expect(await readdir(join(baseDir, "tmp"))).toEqual([]);
  });

  it("LRU 条目数上限可配：淘汰最久未用，触达可续命", async () => {
    let fakeNow = 1_000;
    const { store } = await newStore({ maxEntries: 2, now: () => fakeNow });
    await store.put("u1", bundle({ skillId: "s1" }));
    fakeNow = 2_000;
    await store.put("u1", bundle({ skillId: "s2" }));
    fakeNow = 3_000;
    expect(await store.get("u1", "s1")).toBeDefined();
    fakeNow = 4_000;
    await store.put("u1", bundle({ skillId: "s3" }));
    expect(await store.get("u1", "s2")).toBeUndefined();
    expect(await store.get("u1", "s1")).toBeDefined();
    expect(await store.get("u1", "s3")).toBeDefined();
  });

  it("LRU 跨身份生效且顺序随 lastUsedAt 持久化到新实例", async () => {
    let fakeNow = 1_000;
    const baseDir = await mkdtemp(join(tmpdir(), "expert-skill-cache-"));
    const store1 = createExpertSkillCacheStore({ baseDir, now: () => fakeNow });
    await store1.put("u1", bundle({ skillId: "s1" }));
    fakeNow = 2_000;
    await store1.put("u2", bundle({ skillId: "s2" }));
    fakeNow = 3_000;
    // 同 digest 重 put 刷新 s1 的 lastUsedAt 并随本次变更持久化（get 触碰只改内存）。
    await store1.put("u1", bundle({ skillId: "s1" }));
    const store2 = createExpertSkillCacheStore({ baseDir, maxEntries: 2, now: () => fakeNow });
    await store2.put("u3", bundle({ skillId: "s3" }));
    expect(await store2.get("u2", "s2")).toBeUndefined();
    expect(await store2.get("u1", "s1")).toBeDefined();
    expect(await store2.get("u3", "s3")).toBeDefined();
  });

  it("LRU 字节上限可配：超限淘汰旧条目；单条目超限直接拒绝", async () => {
    const big = Buffer.from("x".repeat(10_000), "utf8");
    const singleFile = (skillId: string, bytes: Buffer) => ({
      verified: {
        schemaVersion: 1 as const,
        skillId,
        name: `${skillId}-name`,
        version: 1,
        files: [{ path: "SKILL.md", bytes, sha256: sha256(bytes) }],
      },
      payloadDigest: sha256(Buffer.from(skillId, "utf8")),
    });
    const { store } = await newStore({ maxTotalBytes: 15_000 });
    await store.put("u1", singleFile("s1", big));
    await store.put("u1", singleFile("s2", big));
    expect(await store.get("u1", "s1")).toBeUndefined();
    expect(await store.get("u1", "s2")).toBeDefined();
    const bigger = Buffer.from("y".repeat(20_000), "utf8");
    await expect(store.put("u1", singleFile("s4", bigger))).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
  });

  it("markRevoked：条目保留但状态 revoked；未缓存条目为 no-op", async () => {
    const { store } = await newStore();
    const { verified, payloadDigest } = bundle();
    await store.put("u1", { verified, payloadDigest });
    await expect(store.markRevoked("u1", "not-cached")).resolves.toBeUndefined();
    await store.markRevoked("u1", "pdd-expert");
    expect((await store.get("u1", "pdd-expert"))?.state).toBe("revoked");
  });
});
