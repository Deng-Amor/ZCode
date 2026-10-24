import { describe, expect, it } from "vitest";

import { skillReflowUploadModule } from "./module.js";
import {
  isRangeExcludedIdentity,
  isRangeExcludedRoot,
  isRangeExcludedSource,
  localDayKey,
  millisecondsUntilNextLocalMidnight,
  readSkillReflowFrontmatter,
  shouldTriggerDailyScan,
} from "./index.js";
// 权威身份判定直接从 @zcode/shared/skill-identity 断言（2026-10-22 批次2b 卡5
// 去镜像后单一事实来源；reflow 组合判定仍从本模块出口断言）。
import {
  isConfidentialControllerSkill,
  isExpertSkillIdentity,
} from "@zcode/shared/skill-identity";
import type { SkillReflowScanRoot } from "./contract.js";

// 契约测试只 Import 契约、模块清单与公开入口暴露的纯判定，不知道持久化实现是谁；
// 文件系统行为（扫描/账本/队列/服务编排）的判据在 packages/services/test/。
describe("skill-reflow-upload contract", () => {
  it("declares its module manifest", () => {
    expect(skillReflowUploadModule.id).toBe("skill-reflow-upload");
    expect(skillReflowUploadModule.requires).toContain("shared");
  });

  it("delegates reserved-name semantics to the shared skill-identity authority (NFKC + path segments)", () => {
    // 权威语义在 @zcode/shared/skill-identity（批次2b 卡5 去镜像）：
    // 全角变体、路径别名、前后空白都命中；普通名不命中。
    expect(isConfidentialControllerSkill("总控派单")).toBe(true);
    expect(isConfidentialControllerSkill("skills/总控派单")).toBe(true);
    expect(isConfidentialControllerSkill("a\\总控派单/b")).toBe(true);
    expect(isConfidentialControllerSkill(" 总控派单 ")).toBe(true);
    expect(isConfidentialControllerSkill("总控派单副本")).toBe(false);
    expect(isConfidentialControllerSkill("report-helper")).toBe(false);
    expect(isExpertSkillIdentity("expert:foo")).toBe(true);
    // 首段路径分段必须是 expert 命名空间：前缀不在首段的路径不命中。
    expect(isExpertSkillIdentity("expert:foo/sub")).toBe(true);
    expect(isExpertSkillIdentity("skills/expert:foo")).toBe(false);
    expect(isExpertSkillIdentity("expert")).toBe(false);
    expect(isExpertSkillIdentity("my-expert:foo")).toBe(false);
    expect(isRangeExcludedIdentity("expert:foo")).toBe(true);
    expect(isRangeExcludedIdentity("总控派单")).toBe(true);
    expect(isRangeExcludedIdentity("plain")).toBe(false);
  });

  it("excludes remote/plugin/bundled roots but keeps user/project agents roots (spec §5.3)", () => {
    const root = (overrides: Partial<SkillReflowScanRoot>): SkillReflowScanRoot => ({
      id: "root",
      path: "/skills",
      scope: "user",
      source: "agents",
      ...overrides,
    });
    expect(isRangeExcludedRoot(root({ source: "remote" }))).toBe(true);
    expect(isRangeExcludedRoot(root({ source: "plugin" }))).toBe(true);
    expect(isRangeExcludedRoot(root({ source: "bundled" }))).toBe(true);
    expect(isRangeExcludedRoot(root({ source: "agents", scope: "user" }))).toBe(false);
    expect(isRangeExcludedRoot(root({ source: "zcode", scope: "project" }))).toBe(false);
    expect(isRangeExcludedSource("remote")).toBe(true);
    expect(isRangeExcludedSource("plugin")).toBe(true);
    expect(isRangeExcludedSource("bundled")).toBe(true);
    expect(isRangeExcludedSource("agents")).toBe(false);
    expect(isRangeExcludedSource("zcode")).toBe(false);
  });

  it("uses local-timezone natural days and keeps the trigger idempotent within a day (spec §6.1)", () => {
    const morning = new Date(2026, 9, 22, 6, 30);
    const evening = new Date(2026, 9, 22, 23, 59);
    const nextDay = new Date(2026, 9, 23, 0, 1);
    expect(localDayKey(morning)).toBe("2026-10-22");
    expect(localDayKey(evening)).toBe("2026-10-22");
    expect(localDayKey(nextDay)).toBe("2026-10-23");
    // 从未触发 / 昨日触发 → 今日应触发；今日已触发 → 幂等不触发。
    expect(shouldTriggerDailyScan(undefined, morning)).toBe(true);
    expect(shouldTriggerDailyScan("2026-10-21", morning)).toBe(true);
    expect(shouldTriggerDailyScan("2026-10-22", evening)).toBe(false);
    expect(shouldTriggerDailyScan("2026-10-22", nextDay)).toBe(true);
    // 距下一个本地零点：当天 23:00 剩 1 小时；零点整剩 24 小时。
    expect(
      millisecondsUntilNextLocalMidnight(new Date(2026, 9, 22, 23, 0, 0, 0)),
    ).toBe(60 * 60 * 1000);
    expect(
      millisecondsUntilNextLocalMidnight(new Date(2026, 9, 23, 0, 0, 0, 0)),
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("reads frontmatter name/description with directory-name fallback (E3 范式)", () => {
    const markdown = [
      "---",
      'name: "报表助手"',
      "description: 把库存整理成表",
      "---",
      "正文不参与元数据",
    ].join("\n");
    expect(readSkillReflowFrontmatter(markdown, "dir-name")).toEqual({
      name: "报表助手",
      description: "把库存整理成表",
    });
    // 无 frontmatter / 缺 name：回退目录名；description 缺省省略。
    expect(readSkillReflowFrontmatter("just body", "dir-name")).toEqual({
      name: "dir-name",
    });
    expect(
      readSkillReflowFrontmatter("---\ndescription: only\n---\n", "dir-name"),
    ).toEqual({ name: "dir-name", description: "only" });
  });
});
