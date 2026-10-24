import {
  isConfidentialControllerSkill,
  isExpertSkillIdentity,
  isReservedExpertSkillIdentity,
} from "./contract.js";

/**
 * 标准调用示例：保留名/专家命名空间身份判定直接复用权威纯函数；
 * 消费方（contracts 转出口、services skill-reflow-upload 组合判定）不得
 * 复制实现或加本地分支。
 */
export function shouldExcludeFromUserSkillScope(identity: string): boolean {
  return isConfidentialControllerSkill(identity) || isExpertSkillIdentity(identity);
}

/** 专家信任清单部署期校验：skillId/name 任一命中保留身份即拒绝。 */
export function isConflictingExpertTrust(trust: {
  skillId: string;
  name: string;
}): boolean {
  return [trust.name, trust.skillId].some(isReservedExpertSkillIdentity);
}
