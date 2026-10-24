/**
 * audit-telemetry 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 注意：登记该模块需执行 `pnpm architecture:adopt audit-telemetry --root packages/services/src/audit-telemetry --layer adapters --owner desktop-settings`；
 * 本卡执行时 architecture-policy.yaml 处于在途未提交修改状态，按任务卡约束未编辑该文件，
 * adopt 待在途改动收敛后补跑（见回执异常段）。
 */
export const auditTelemetryModule = {
  id: "audit-telemetry",
  requires: ["services"],
  provides: ["audit-telemetry"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
