/** 真实事实派生签名；不新增 telemetry 通道、缓存或生命周期所有者。 */
export type WorkflowLifecycleFactFromProgress =
  typeof import("../conversation-telemetry-workflow-facts.js").workflowLifecycleFactFromProgress;
