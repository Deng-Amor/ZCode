/**
 * platform-command-channel 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 登记命令：`pnpm architecture:adopt platform-command-channel --root packages/services/src/platform-command-channel --layer adapters --owner desktop-settings`。
 */
export const platformCommandChannelModule = {
  id: "platform-command-channel",
  requires: ["services"],
  provides: ["platform-command-channel"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
