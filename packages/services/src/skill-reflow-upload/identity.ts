// ============================================================
// skill-reflow-upload 范围互斥身份判定（spec §5.3 硬规则）
// ============================================================
// 2026-10-22 批次2b 卡5：删除对 contracts 判定的本地镜像（旧实现曾因 services 不
// 依赖 CLI contracts 而整段复制，存在两份语义漂移风险），保留名/专家命名空间判定
// 的唯一权威实现在 `@zcode/shared/skill-identity`，本文件从其公开入口导入并转出口
// 维持既有出口名稳定；此处仅保留 reflow 专属组合（范围互斥、来源互斥、根范围资格）。

import {
  CONFIDENTIAL_CONTROLLER_SKILL_NAME,
  EXPERT_SKILL_NAMESPACE,
  isConfidentialControllerSkill,
  isExpertSkillIdentity,
} from "@zcode/shared/skill-identity";
import type {
  SkillReflowRootScope,
  SkillReflowRootSource,
  SkillReflowScanRoot,
} from "./contract.js";

// 转出口维持 index.ts 既有出口名稳定（scanner/index 消费方零改动）。
export {
  CONFIDENTIAL_CONTROLLER_SKILL_NAME,
  EXPERT_SKILL_NAMESPACE,
  isConfidentialControllerSkill,
  isExpertSkillIdentity,
};

/** 条目身份是否命中范围互斥（保留名或 expert: 前缀；spec §5.3 防御性过滤）。 */
export function isRangeExcludedIdentity(value: string): boolean {
  return isConfidentialControllerSkill(value) || isExpertSkillIdentity(value);
}

/** 上传互斥的来源（spec §5.3：商店分发物与随发行版内容非自建，remote 为受管身份）。 */
export function isRangeExcludedSource(source: SkillReflowRootSource): boolean {
  return source === "remote" || source === "plugin" || source === "bundled";
}

/** 参与上传的根身份范围（extraRoots 等归属不明根的排除归装配层，OQ-5）。 */
export function isEligibleRootScope(scope: SkillReflowRootScope): boolean {
  return scope === "user" || scope === "project";
}

/** 根整体是否被来源互斥排除（排除根仍做只计数遍历，产出 rangeExcluded 可观察计数）。 */
export function isRangeExcludedRoot(root: SkillReflowScanRoot): boolean {
  return isRangeExcludedSource(root.source) || !isEligibleRootScope(root.scope);
}
