import { describe, expect, it } from "vitest";
import {
  CONFIDENTIAL_CONTROLLER_SKILL_ID,
  CONFIDENTIAL_CONTROLLER_SKILL_NAME,
  EXPERT_SKILL_NAMESPACE,
  isConfidentialControllerSkill,
  isExpertSkillIdentity,
  isReservedExpertSkillIdentity,
} from "../src/skills/index.js";

describe("isExpertSkillIdentity（专家命名空间判定，NFKC + 路径分段同族）", () => {
  it.each([
    ["expert:foo", true],
    ["expert:pdd-expert", true],
    // NFKC 归一：全角字母/冒号变体与半角形式同判。
    ["ｅｘｐｅｒｔ:拼多多", true],
    ["expert：foo", true],
    // 命名空间占位（root namespace / Windows 反斜杠别名）同样占用专家命名空间。
    ["expert/foo", true],
    ["expert\\foo", true],
    // 裸名 expert 与普通技能名不占用命名空间。
    ["expert", false],
    ["experts", false],
    ["expert-guide", false],
    ["总控派单", false],
    ["controller", false],
    ["foo:bar", false],
    ["foo/expert:bar", false],
    ["", false],
  ])("%j -> %s", (value, expected) => {
    expect(isExpertSkillIdentity(value)).toBe(expected);
  });

  it("容忍首尾空白与分段内空白，与 isConfidentialControllerSkill 家族一致", () => {
    expect(isExpertSkillIdentity("  expert:foo  ")).toBe(true);
    expect(isExpertSkillIdentity("expert :foo")).toBe(true);
    expect(isExpertSkillIdentity(" expert ")).toBe(false);
  });

  it("保留身份不落入专家命名空间，专家身份也不落入保留名", () => {
    // 「总控派单」是保留名而非 expert 前缀身份，二者互不重叠。
    expect(isExpertSkillIdentity(CONFIDENTIAL_CONTROLLER_SKILL_NAME)).toBe(false);
    expect(isConfidentialControllerSkill(`${EXPERT_SKILL_NAMESPACE}:foo`)).toBe(false);
  });
});

describe("isReservedExpertSkillIdentity（专家信任清单保留名单校验）", () => {
  it.each([
    [CONFIDENTIAL_CONTROLLER_SKILL_ID, true],
    [CONFIDENTIAL_CONTROLLER_SKILL_NAME, true],
    // NFKC 全角变体与路径别名无法绕过保留名单。
    ["ｃｏｎｔｒｏｌｌｅｒ", true],
    [" 总控派单 ", true],
    ["locks/controller", true],
    ["总控派单/alias", true],
    // 专家与普通身份不在保留名单内。
    ["pdd-expert", false],
    ["expert:foo", false],
    ["expert", false],
    ["", false],
  ])("%j -> %s", (value, expected) => {
    expect(isReservedExpertSkillIdentity(value)).toBe(expected);
  });

  it("按 adapters 既有用法对 skillId/name 组合校验", () => {
    const expertTrust = { skillId: "pdd-expert", name: "拼多多专家" };
    expect([expertTrust.name, expertTrust.skillId].some(isReservedExpertSkillIdentity)).toBe(false);
    const conflictingTrust = { skillId: "controller", name: "anything" };
    expect([conflictingTrust.name, conflictingTrust.skillId].some(isReservedExpertSkillIdentity)).toBe(
      true,
    );
  });
});
