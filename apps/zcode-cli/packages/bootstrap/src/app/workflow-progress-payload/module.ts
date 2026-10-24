/** 只登记既有序列化职责，requires 与 architecture-policy.yaml 保持一致。 */
export const workflowProgressPayloadModule = {
  id: "workflow-progress-payload",
  requires: ["shared", "zcode-cli"],
  provides: ["workflow-progress-payload"],
  publicEntrypoints: ["../dynamic-workflow-run-progress-payload.ts", "contract.ts"],
} as const;
