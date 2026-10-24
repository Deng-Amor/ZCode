import type { SessionEvent } from "@zcode/contracts";
import type {
  WorkflowHostObservationCommitErrorMetadata,
  WorkflowHostObservationCommitResult,
  WorkflowHostObservationPhase,
  WorkflowObservationOwner,
} from "../../zcode-protocol-v4/v4-gateway.js";

export type WorkflowHostObservationOutcome = {
  sessionId: string;
  eventId: string;
  runId: string;
  elapsedMs: number;
} & (
  | {
      event: "workflow.host_observation.sync.completed";
      phase: WorkflowHostObservationPhase;
      strictAttempted: boolean;
      reasonCode?: never;
    }
  | ({
      event: "workflow.host_observation.sync.failed";
      strictAttempted: boolean | "unknown";
    } & Omit<WorkflowHostObservationCommitErrorMetadata, "strictAttempted">)
);

/** 闭包必须捕获原 direct record/app/store；不按 sessionId 查替代实例。 */
export interface WorkflowHostObservationAdapterDeps {
  isCurrent(): boolean;
  /** 精确查同 id 恰好一条，并核验完整身份；缺 owner/store/gateway 必须安全拒绝。 */
  verifyStored(event: SessionEvent, signal: AbortSignal): Promise<SessionEvent>;
  /** 直接返回 gateway 原 Promise；abort 栈内同步拒绝，保留权威 attempt 元数据。 */
  ensureCommit(
    event: SessionEvent,
    owner: WorkflowObservationOwner,
  ): Promise<WorkflowHostObservationCommitResult>;
  report(outcome: WorkflowHostObservationOutcome): void;
  now(): number;
}

export interface WorkflowHostObservationAdapter {
  /** 同步接单；forward 包含完整 onSessionEvent 前置步骤，不返回 commit Promise。 */
  accept(event: SessionEvent, forward?: () => void): void;
  /** 先撤销 owner，再终结 jobs；不取消共享普通 hydration。 */
  dispose(): void;
}

export type WorkflowHostObservationAdapterFactory = (
  deps: WorkflowHostObservationAdapterDeps,
) => WorkflowHostObservationAdapter;
