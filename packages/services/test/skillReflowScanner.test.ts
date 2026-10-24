import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REFLOW_NO_UPLOAD_MARKER_FILE_NAME,
  scanSkillReflowRoots,
} from "../src/skill-reflow-upload/index.js";
import {
  makeSkillReflowTestDirectory,
  removeSkillReflowTestDirectory,
  skillMarkdown,
  userScanRoot,
  writeNoUploadMarker,
  writeSkillEntry,
} from "./skillReflowUploadFixtures.js";

/**
 * 扫描器单测（spec §6.2 退出标记 / §5.3 范围互斥 / §5.2 条目与 digest）：
 * 验收场景 1（退出区两日不出现）、4（范围互斥零误收）、5（增量变更）、7（退出区恢复）的扫描侧判据。
 */

let directory: string;

beforeEach(async () => {
  directory = await makeSkillReflowTestDirectory();
});

afterEach(async () => {
  await removeSkillReflowTestDirectory(directory);
});

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function scan(rootPath: string) {
  return scanSkillReflowRoots([userScanRoot(rootPath)], { logger: quietLogger });
}

describe("skill reflow scanner opt-out markers", () => {
  it("skips .no-upload and private/ subtrees on both scans and counts optOutSkipped exactly (场景 1)", async () => {
    await writeSkillEntry(directory, "alpha", {
      skillMd: skillMarkdown({ name: "alpha", description: "正常技能" }),
    });
    const optOut = await writeSkillEntry(directory, "optout-a", {
      skillMd: skillMarkdown({ name: "optout-a" }),
    });
    await writeFile(join(optOut, REFLOW_NO_UPLOAD_MARKER_FILE_NAME), "", "utf8");
    await writeSkillEntry(directory, "private/hidden-b", {
      skillMd: skillMarkdown({ name: "hidden-b" }),
    });
    // 中间目录放标记：其下整棵子树退出（spec §6.2 主机制的中间目录语义）。
    await writeNoUploadMarker(directory, "staging");
    await writeSkillEntry(directory, "staging/inner", {
      skillMd: skillMarkdown({ name: "inner" }),
    });

    // 连续两次扫描（两日两次日界触发的扫描侧模拟）：退出区两日均不出现。
    const firstScan = await scan(directory);
    const secondScan = await scan(directory);
    for (const result of [firstScan, secondScan]) {
      expect(result.entries.map((entry) => entry.relativePath)).toEqual(["alpha"]);
      expect(result.counters).toEqual({
        scanned: 1,
        optOutSkipped: 3,
        rangeExcluded: 0,
      });
      // 退出区内容不进任何条目字段（可观察面只有计数，spec §6.2）。
      expect(JSON.stringify(result)).not.toContain("hidden-b");
      expect(JSON.stringify(result)).not.toContain("inner");
    }
    expect(secondScan.entries).toEqual(firstScan.entries);
  });

  it("re-admits a skill after its .no-upload marker is removed (场景 7 首传语义)", async () => {
    const recovered = await writeSkillEntry(directory, "recovered", {
      skillMd: skillMarkdown({ name: "recovered" }),
    });
    await writeFile(join(recovered, REFLOW_NO_UPLOAD_MARKER_FILE_NAME), "", "utf8");
    const before = await scan(directory);
    expect(before.entries).toHaveLength(0);
    expect(before.counters.optOutSkipped).toBe(1);

    await rm(join(recovered, REFLOW_NO_UPLOAD_MARKER_FILE_NAME));
    const after = await scan(directory);
    expect(after.entries.map((entry) => entry.relativePath)).toEqual(["recovered"]);
    expect(after.counters.optOutSkipped).toBe(0);
  });

  it("counts a nested opt-out subtree only once when entry collection and walk overlap", async () => {
    // 根自身是条目（有 SKILL.md）；其 staging/ 中间目录带 .no-upload 且下有独立 skill。
    // 遍历层与条目内容收集层都会经过 staging：退出条目 inner 必须只计一次。
    await writeSkillEntry(directory, "", {
      skillMd: skillMarkdown({ name: "root-entry" }),
    });
    await writeNoUploadMarker(directory, "staging");
    await writeSkillEntry(directory, "staging/inner", {
      skillMd: skillMarkdown({ name: "inner" }),
    });
    const result = await scan(directory);
    expect(result.counters.optOutSkipped).toBe(1);
    expect(result.counters.scanned).toBe(1);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([""]);
  });
});

describe("skill reflow scanner range exclusion", () => {
  it("excludes reserved-name and expert-prefixed identities without reading their content (场景 4)", async () => {
    await writeSkillEntry(directory, "总控派单", {
      skillMd: skillMarkdown({ name: "总控派单" }),
    });
    // Windows 目录名不允许冒号，expert: 前缀经 frontmatter name 构造（身份判定同规则）。
    await writeSkillEntry(directory, "expert-cache", {
      skillMd: skillMarkdown({ name: "expert:foo" }),
    });
    await writeSkillEntry(directory, "plain", {
      skillMd: skillMarkdown({ name: "plain" }),
    });
    const result = await scan(directory);
    expect(result.entries.map((entry) => entry.name)).toEqual(["plain"]);
    expect(result.counters.rangeExcluded).toBe(2);
    expect(result.counters.scanned).toBe(1);
  });

  it("excludes remote/plugin/bundled source roots entirely while keeping counts observable", async () => {
    for (const source of ["remote", "plugin", "bundled"] as const) {
      const rootDirectory = join(directory, source);
      await writeSkillEntry(rootDirectory, `skill-${source}`, {
        skillMd: skillMarkdown({ name: `skill-${source}` }),
      });
    }
    const result = await scanSkillReflowRoots(
      [
        { id: "r", path: join(directory, "remote"), scope: "user", source: "remote" },
        { id: "p", path: join(directory, "plugin"), scope: "user", source: "plugin" },
        { id: "b", path: join(directory, "bundled"), scope: "user", source: "bundled" },
      ],
      { logger: quietLogger },
    );
    expect(result.entries).toHaveLength(0);
    expect(result.counters.rangeExcluded).toBe(3);
    expect(result.counters.scanned).toBe(0);
  });
});

describe("skill reflow scanner entries and digest", () => {
  it("enumerates entries with frontmatter metadata and user/workspace sourceType", async () => {
    const userRoot = join(directory, "user");
    const projectRoot = join(directory, "project");
    await writeSkillEntry(userRoot, "report-helper", {
      skillMd: skillMarkdown({ name: "报表助手", description: "整理库存" }),
      files: { "references/a.md": "A" },
    });
    await writeSkillEntry(projectRoot, "ws-skill", {
      skillMd: skillMarkdown({ name: "ws-skill" }),
    });
    const result = await scanSkillReflowRoots(
      [userScanRoot(userRoot), { id: "ws", path: projectRoot, scope: "project", source: "agents" }],
      { logger: quietLogger },
    );
    expect(result.entries).toHaveLength(2);
    const userEntry = result.entries.find((entry) => entry.name === "报表助手");
    expect(userEntry).toMatchObject({
      key: "user/user-root/report-helper",
      relativePath: "report-helper",
      sourceType: "user",
      description: "整理库存",
    });
    expect(userEntry?.lastModified).toBeTruthy();
    const projectEntry = result.entries.find((entry) => entry.relativePath === "ws-skill");
    expect(projectEntry).toMatchObject({
      key: "project/ws/ws-skill",
      sourceType: "workspace",
    });
    // description 缺省省略（spec §5.2）。
    expect(projectEntry?.description).toBeUndefined();
  });

  it("changes the digest when only SKILL.md frontmatter changes (SKILL.md 纳入 digest 的回归判据)", async () => {
    const entryDirectory = await writeSkillEntry(directory, "meta-only", {
      skillMd: skillMarkdown({ name: "meta-only", description: "v1" }),
    });
    const first = await scan(directory);
    expect(first.entries).toHaveLength(1);
    await writeFile(
      join(entryDirectory, "SKILL.md"),
      skillMarkdown({ name: "meta-only", description: "v2" }),
      "utf8",
    );
    const second = await scan(directory);
    expect(second.entries[0]!.contentDigest).not.toBe(first.entries[0]!.contentDigest);
    expect(second.entries[0]!.name).toBe(first.entries[0]!.name);
  });

  it("changes the digest when reference files change and keeps nested entries independent", async () => {
    await writeSkillEntry(directory, "parent", {
      skillMd: skillMarkdown({ name: "parent" }),
      files: { "references/a.md": "A1", "references/deep/b.md": "B1" },
    });
    await writeSkillEntry(directory, "parent/child", {
      skillMd: skillMarkdown({ name: "child" }),
      files: { "notes.md": "child notes" },
    });
    const first = await scan(directory);
    expect(first.entries.map((entry) => entry.relativePath).sort()).toEqual([
      "parent",
      "parent/child",
    ]);
    const parentBefore = first.entries.find((entry) => entry.relativePath === "parent");
    // 修改 parent 自有 references 文件：parent digest 变化。
    await writeFile(join(directory, "parent", "references", "a.md"), "A2", "utf8");
    const second = await scan(directory);
    const parentAfter = second.entries.find((entry) => entry.relativePath === "parent");
    expect(parentAfter?.contentDigest).not.toBe(parentBefore?.contentDigest);
    // 修改 child 内容：parent digest 不变（嵌套条目内容不并入父条目）。
    await writeFile(join(directory, "parent", "child", "notes.md"), "changed", "utf8");
    const third = await scan(directory);
    const parentFinal = third.entries.find((entry) => entry.relativePath === "parent");
    expect(parentFinal?.contentDigest).toBe(parentAfter?.contentDigest);
    const childFinal = third.entries.find((entry) => entry.relativePath === "parent/child");
    expect(childFinal?.name).toBe("child");
  });

  it("does not walk shared-policy excluded directories (dot dirs / node_modules)", async () => {
    await writeSkillEntry(directory, "visible", { skillMd: skillMarkdown({ name: "visible" }) });
    await writeSkillEntry(directory, "node_modules/packaged", {
      skillMd: skillMarkdown({ name: "packaged" }),
    });
    await writeSkillEntry(directory, ".hidden/dotted", {
      skillMd: skillMarkdown({ name: "dotted" }),
    });
    const result = await scan(directory);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["visible"]);
    // 共享策略排除的目录既不算条目也不算退出计数（属扫描策略，不属退出语义）。
    expect(result.counters.optOutSkipped).toBe(0);
  });

  it("survives an unreadable root without aborting the session", async () => {
    await writeSkillEntry(directory, "healthy", { skillMd: skillMarkdown({ name: "healthy" }) });
    // 第一个根不存在（readdir ENOENT）：可观察回调 + 跳过，不影响后续根与会话结果。
    const failures: string[] = [];
    const result = await scanSkillReflowRoots(
      [userScanRoot(join(directory, "missing-root")), userScanRoot(directory, "healthy-root")],
      {
        logger: quietLogger,
        onError: (path) => failures.push(path),
      },
    );
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "user/healthy-root/healthy",
    ]);
    expect(failures).toEqual([join(directory, "missing-root")]);
  });
});
