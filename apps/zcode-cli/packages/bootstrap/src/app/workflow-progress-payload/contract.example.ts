import type { HostReconciliationSerializer } from "./contract.js";

/** 仅为公开契约提供合成输入，不创建 run、写日志或执行效果。 */
export const exampleHostReconciliationInput: Parameters<HostReconciliationSerializer>[0] = {
  runId: "example-workflow-run",
  toolCallId: "example-create-call",
  error: {
    code: "RecoveryUncertain",
    message: "External result is unknown and needs verification",
  },
};
