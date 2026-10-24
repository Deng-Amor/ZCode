/** 引用既有实现的真实签名，不建立包装层或第二份序列化规则。 */
export type WorkflowProtocolEventSerializer =
  typeof import("../dynamic-workflow-run-progress-payload.js").toProtocolEvent;
export type WorkflowProgressSerializer =
  typeof import("../dynamic-workflow-run-progress-payload.js").toProgressPayload;
export type HostReconciliationSerializer =
  typeof import("../dynamic-workflow-run-progress-payload.js").toHostReconciliationProgress;
