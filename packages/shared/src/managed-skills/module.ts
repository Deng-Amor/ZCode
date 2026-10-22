/**
 * managed-skills 模块清单（architecture-governance managed 模块）。
 * 层：adapters（Node crypto）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const managedSkillsModule = {
  id: "managed-skills",
  requires: [],
  provides: ["managed-skills"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
