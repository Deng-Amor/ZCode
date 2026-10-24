/** 只登记既有 workflow 生命周期事实派生，依赖与 policy 一致。 */
export const workflowTelemetryFactsModule = {
  id: "workflow-telemetry-facts",
  requires: ["shared", "zcode-cli"],
  provides: ["workflow-telemetry-facts"],
  publicEntrypoints: ["../conversation-telemetry-workflow-facts.ts", "contract.ts"],
} as const;
