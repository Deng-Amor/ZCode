// ============================================================
// AgentRuntime-backed WorkflowDriver：模型侧失败的收容
// ============================================================
// 底层恢复完成后，仅将模型侧最终错误映射到既有的单 ask 或整 run 结算通道。

import {
  inspectWorkflowModelFailure,
  type WorkflowModelFailureInspection,
} from "@zcode/adapters/model";
import {
  refToString,
  WorkflowError,
  type InstanceRef,
  type ProviderStopDetails,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS, subagentLabel } from "./workflow-driver-helpers.js";
import type { SessionState } from "./workflow-driver-types.js";

/** Driver 只提供结果通道，不拥有第三层重试预算。 */
export interface ModelFailureHost {
  readonly sink: WorkflowReportSink;
}

/**
 * turn 被拒时的模型侧收容：driver 与 runner 读同一张策略表。返回 `false` 表示这不是模型层错误
 * （inspect 返回 undefined），调用方按 driver 侧失败处理；返回 `true` 表示已按策略处置。
 */
export function handleModelTurnFailure(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): boolean {
  const inspected = inspectWorkflowModelFailure(error);
  if (inspected === undefined) return false;
  switch (inspected.policy.decision) {
    case "stop":
      // 确定性的模型侧错误：整个 run 停下（stopped(provider)，可恢复），不结算节点。
      host.sink.stopRun(providerStopError(state, inspected, error));
      return true;
    case "context_exceeded":
      // core 已压缩失败：ask 本身太大，是脚本之错——节点以 ContextLimit 失败，脚本可 catch。
      host.sink.askFailed(
        instance,
        new WorkflowError(
          "ContextLimit",
          `Subagent ${subagentLabel(state)} exceeded the model's context window even after ` +
            `compaction. Give this ask a smaller input or split the work across subagents.`,
          { cause: error },
        ),
      );
      return true;
    default:
      // 底层请求预算与 Core 流恢复已经结束；Driver 不重放未知副作用，也不再创建新 turn。
      host.sink.askFailed(
        instance,
        new WorkflowError(
          "RecoveryExhausted",
          `Subagent ${subagentLabel(state)} exhausted model recovery (${inspected.reason}).`,
          { cause: error },
        ),
      );
      return true;
  }
}

/** `ProviderStop` 错误：策略表判 stop 的模型侧错误 + 通知文案要的结构化明细。 */
function providerStopError(
  state: SessionState,
  inspected: WorkflowModelFailureInspection,
  cause: unknown,
): WorkflowError {
  const kind = inspected.policy.decision === "stop" ? inspected.policy.kind : "other";
  const rawMessage = (
    inspected.rawMessage ?? (cause instanceof Error ? cause.message : String(cause))
  ).slice(0, PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS);
  const details: ProviderStopDetails = {
    kind,
    reason: inspected.reason,
    subagent: refToString(state.actor),
    ...(state.actorName === undefined ? {} : { subagentName: state.actorName }),
    ...(inspected.providerId === undefined ? {} : { providerId: inspected.providerId }),
    ...(inspected.modelId === undefined ? {} : { modelId: inspected.modelId }),
    ...(inspected.providerCode === undefined ? {} : { providerCode: inspected.providerCode }),
    ...(rawMessage.length === 0 ? {} : { rawMessage }),
    ...(inspected.resetAt === undefined ? {} : { resetAt: inspected.resetAt }),
  };
  const code = inspected.providerCode === undefined ? "" : ` [${inspected.providerCode}]`;
  return new WorkflowError(
    "ProviderStop",
    `Subagent ${subagentLabel(state)} hit a permanent model-side error ` +
      `(${inspected.reason}${code}): ${rawMessage}`,
    { cause, providerStop: details },
  );
}
