/**
 * skill-identity 模块清单（architecture-governance managed 模块）。
 * 层：adapters（纯函数，零运行时依赖）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const skillIdentityModule = {
  id: "skill-identity",
  requires: [],
  provides: ["skill-identity"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
