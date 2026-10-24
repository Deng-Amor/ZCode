// ============================================================
// Skill identity predicates - 保留名/命名空间身份判定的唯一权威实现
// ============================================================
// 2026-10-22 批次2b 卡5：本段从 apps/zcode-cli/packages/contracts/src/skills/index.ts
// 原样迁入（语义逐字节保持：NFKC 归一 + 路径分段匹配），消除 services 层镜像与
// contracts/services 双份实现的漂移风险。contracts（`@zcode/contracts/skills`）与
// services skill-reflow-upload 均从 `@zcode/shared/skill-identity` 转出口/导入，
// 不再各自持有实现或镜像；判定语义变更必须以本文件为唯一事实来源。

export const CONFIDENTIAL_CONTROLLER_SKILL_NAME = "总控派单";

/** 同名插件与路径别名必须服从同一保留身份规则，不能绕过私有加载入口。 */
export function isConfidentialControllerSkill(value: string): boolean {
  return value.normalize("NFKC").split(/[\\/:]/u)
    .some((part) => part.trim() === CONFIDENTIAL_CONTROLLER_SKILL_NAME);
}

/** 总控锁定 skill 的保留 skillId（spec ccode-expert-skills-distribution E4 部署形态）。 */
export const CONFIDENTIAL_CONTROLLER_SKILL_ID = "controller";

/** 中台专家 skill 的限定名前缀：`expert:<skillId>`，skillId 为不含 `/ \ :` 的裸标识符。 */
export const EXPERT_SKILL_NAMESPACE = "expert";

/**
 * 判定是否专家命名空间身份：NFKC 归一后首段路径分段等于 `expert` 且后随分隔符。
 * 与 isConfidentialControllerSkill 同族（NFKC 归一 + 路径分段，单一事实来源在
 * `@zcode/shared/skill-identity`），全角 `ｅｘｐｅｒｔ：` 等变体同样命中；裸名
 * `expert` 不占用命名空间。供 discover 过滤用户侧占用专家命名空间的条目
 * （spec §5.3 硬规则 2/3）。
 */
export function isExpertSkillIdentity(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  const segments = normalized.split(/[\\/:]/u);
  return segments.length > 1 && segments[0]!.trim() === EXPERT_SKILL_NAMESPACE;
}

/**
 * 专家信任清单部署期校验（spec §5.3 硬规则 1 前置防线）：skillId/name 命中保留身份
 * （`controller`/「总控派单」）的专家条目拒绝部署。按 NFKC + 路径分段匹配，
 * 路径别名无法绕过；与 adapters 既有 `[trust.name, trust.skillId].some(...)` 用法组合。
 */
export function isReservedExpertSkillIdentity(value: string): boolean {
  return value.normalize("NFKC").split(/[\\/:]/u)
    .some(
      (part) =>
        part.trim() === CONFIDENTIAL_CONTROLLER_SKILL_ID ||
        part.trim() === CONFIDENTIAL_CONTROLLER_SKILL_NAME,
    );
}
