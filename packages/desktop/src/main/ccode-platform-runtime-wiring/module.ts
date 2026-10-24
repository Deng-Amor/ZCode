/**
 * ccode-platform-runtime-wiring 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const ccodePlatformRuntimeWiringModule = {
  id: "ccode-platform-runtime-wiring",
  requires: ["audit-telemetry", "ccode-platform-runtime", "expert-skills-cache", "platform-command-channel", "skill-reflow-upload", "services"],
  provides: ["ccode-platform-runtime-wiring"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
