/**
 * skill-reflow-upload 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 登记命令：`pnpm architecture:adopt skill-reflow-upload --root packages/services/src/skill-reflow-upload --layer adapters --owner desktop-settings`。
 */
export const skillReflowUploadModule = {
  id: "skill-reflow-upload",
  // 2026-10-22 批次2b 卡5：身份判定权威提升至 @zcode/shared/skill-identity，去镜像后新增该依赖。
  requires: ["services", "shared", "skill-identity"],
  provides: ["skill-reflow-upload"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
