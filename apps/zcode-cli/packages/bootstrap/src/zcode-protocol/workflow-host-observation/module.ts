export const workflowHostObservationModule = {
  id: "workflow-host-observation",
  requires: ["shared", "zcode-cli"],
  provides: ["workflow-host-observation"],
  publicEntrypoints: ["../workflow-host-observation-adapter.ts", "contract.ts"],
} as const;
