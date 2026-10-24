import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { parseWorkflowRunProgressObservation } from "@zcode/shared/zcode-protocol-v4";
import type {
  WorkflowHostObservationCommitErrorMetadata,
  WorkflowHostObservationPhase,
  WorkflowHostObservationReasonCode,
  WorkflowObservationOwner,
} from "../zcode-protocol-v4/v4-gateway.js";
import type {
  WorkflowHostObservationAdapterFactory,
  WorkflowHostObservationOutcome,
} from "./workflow-host-observation/contract.js";

const WORKFLOW_HOST_OBSERVATION_TIMEOUT_MS = 25000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PHASES: readonly WorkflowHostObservationPhase[] = [
  "append",
  "handoff",
  "verify",
  "forward",
  "observe",
  "old_flight",
  "strict_load",
  "candidate",
  "adopt",
  "postcondition",
  "delivery",
  "dispose",
];
const REASONS: readonly WorkflowHostObservationReasonCode[] = [
  "invalid_observation",
  "runtime_unavailable",
  "append_rejected",
  "identity_unverifiable",
  "owner_unavailable",
  "stale_owner",
  "handoff_failed",
  "apply_failed",
  "strict_load_failed",
  "target_not_applied",
  "postcondition_failed",
  "timeout",
  "disposed",
  "delivery_fault",
];

interface ObservationJob {
  owner: WorkflowObservationOwner;
  forwarded: boolean;
  phase: WorkflowHostObservationPhase;
  cancel(reason: "timeout" | "disposed"): void;
}

type FailureMetadata = Omit<WorkflowHostObservationCommitErrorMetadata, "strictAttempted"> & {
  strictAttempted: boolean | "unknown";
};

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : fallback;
}

function hostRunId(event: SessionEvent): string | undefined {
  if (event.type !== SessionEventType.DynamicWorkflowRunProgress) return undefined;
  const observation = parseWorkflowRunProgressObservation(event.payload);
  return observation.kind === "host-reconciliation" ? observation.value.runId : undefined;
}

function safeMetadata(error: unknown): WorkflowHostObservationCommitErrorMetadata | undefined {
  if (!error || typeof error !== "object") return undefined;
  try {
    // 任意异常对象可带抛错的 getter；只读取闭集字段一次，不能让诊断再次制造无人接管的拒绝。
    const { phase, reasonCode, strictAttempted } =
      error as Partial<WorkflowHostObservationCommitErrorMetadata>;
    if (
      !PHASES.includes(phase as WorkflowHostObservationPhase) ||
      !REASONS.includes(reasonCode as WorkflowHostObservationReasonCode) ||
      typeof strictAttempted !== "boolean"
    )
      return undefined;
    return { phase: phase!, reasonCode: reasonCode!, strictAttempted };
  } catch {
    return undefined;
  }
}

export const createWorkflowHostObservationAdapter: WorkflowHostObservationAdapterFactory = (
  deps,
) => {
  let active = true;
  const jobs = new Map<string, ObservationJob>();
  const report = (outcome: WorkflowHostObservationOutcome): void => {
    // 诊断出口不是业务提交；即使日志接收方故障也必须释放本 job 的资源。
    try {
      deps.report(outcome);
    } catch {
      /* 同步诊断失败不重试业务或记录任意错误正文。 */
    }
  };

  const forwardOnce = (job: ObservationJob, forward?: () => void): void => {
    if (!forward || job.forwarded || !job.owner.isCurrent()) return;
    job.forwarded = true;
    // persistence/debug/ingest 任一步抛错都不能阻断随后独立的查证与恢复。
    try {
      forward();
    } catch {
      /* gateway 仍以真实应用证据裁决，不按 throw 猜成功。 */
    }
  };

  return {
    accept(event, forward) {
      const startedAt = deps.now();
      const runId = hostRunId(event);
      const identity = {
        sessionId: safeIdentifier(event.sessionId, "invalid-session-id"),
        eventId: safeIdentifier(event.id, "invalid-event-id"),
        runId: safeIdentifier(runId, "invalid-run-id"),
      };
      const failImmediately = (
        phase: WorkflowHostObservationPhase,
        reasonCode: WorkflowHostObservationReasonCode,
      ): void => {
        report({
          ...identity,
          event: "workflow.host_observation.sync.failed",
          phase,
          reasonCode,
          strictAttempted: "unknown",
          elapsedMs: Math.max(0, deps.now() - startedAt),
        });
      };
      if (!active) {
        failImmediately("dispose", "disposed");
        return;
      }
      if (!deps.isCurrent()) {
        failImmediately("handoff", "stale_owner");
        return;
      }
      if (
        !runId ||
        !event.id ||
        !event.sessionId ||
        !Number.isInteger(event.sequenceNumber) ||
        event.sequenceNumber <= 0
      ) {
        failImmediately("handoff", "invalid_observation");
        return;
      }
      const existing = jobs.get(event.id);
      if (existing) {
        forwardOnce(existing, forward);
        return;
      }

      const controller = new AbortController();
      const deadlineAt = startedAt + WORKFLOW_HOST_OBSERVATION_TIMEOUT_MS;
      let ownerActive = true;
      let finished = false;
      let cancellation: FailureMetadata | undefined;
      const owner: WorkflowObservationOwner = {
        signal: controller.signal,
        deadlineAt,
        now: deps.now,
        isCurrent: () =>
          ownerActive &&
          active &&
          !controller.signal.aborted &&
          deps.isCurrent() &&
          deps.now() < deadlineAt,
      };
      const finish = (outcome: WorkflowHostObservationOutcome): void => {
        if (finished) return;
        finished = true;
        ownerActive = false;
        try {
          report(outcome);
        } finally {
          clearTimeout(timer);
          if (jobs.get(event.id) === job) jobs.delete(event.id);
        }
      };
      const fail = (metadata: FailureMetadata): void => {
        finish({
          ...identity,
          event: "workflow.host_observation.sync.failed",
          ...metadata,
          elapsedMs: Math.max(0, deps.now() - startedAt),
        });
      };
      const unavailable = (): FailureMetadata | undefined => {
        if (cancellation) return cancellation;
        if (!active)
          return { phase: "dispose", reasonCode: "disposed", strictAttempted: "unknown" };
        if (deps.now() >= deadlineAt)
          return { phase: job.phase, reasonCode: "timeout", strictAttempted: "unknown" };
        if (!deps.isCurrent())
          return { phase: job.phase, reasonCode: "stale_owner", strictAttempted: "unknown" };
        return undefined;
      };
      const onFailure = (error: unknown, authoritative: boolean): void => {
        if (finished) return;
        const metadata = safeMetadata(error);
        if (metadata) {
          fail({
            ...metadata,
            strictAttempted: authoritative ? metadata.strictAttempted : "unknown",
          });
        } else {
          fail(
            unavailable() ?? {
              phase: job.phase,
              reasonCode: job.phase === "verify" ? "identity_unverifiable" : "apply_failed",
              strictAttempted: "unknown",
            },
          );
        }
      };
      const job: ObservationJob = {
        owner,
        forwarded: false,
        phase: "verify",
        cancel(reason) {
          if (finished || cancellation) return;
          // 先 fence 本 owner，abort 返回后才排本地兜底；原 ensure Promise 的反应可先消费权威历史。
          ownerActive = false;
          cancellation = {
            phase: reason === "disposed" ? "dispose" : job.phase,
            reasonCode: reason,
            strictAttempted: "unknown",
          };
          controller.abort(reason);
          queueMicrotask(() => {
            if (!finished) fail(cancellation!);
          });
        },
      };
      jobs.set(event.id, job);
      // store 后的普通 sink 即使永久 pending，此处的独立 deadline 也已同步建立。
      const timer = setTimeout(() => job.cancel("timeout"), WORKFLOW_HOST_OBSERVATION_TIMEOUT_MS);
      void Promise.resolve()
        .then(() => {
          if (finished) return;
          const beforeVerify = unavailable();
          if (beforeVerify) {
            fail(beforeVerify);
            return;
          }
          return deps.verifyStored(event, controller.signal).then((stored) => {
            if (finished) return;
            const beforeCommit = unavailable();
            if (beforeCommit) {
              fail(beforeCommit);
              return;
            }
            if (
              stored.id !== event.id ||
              stored.sessionId !== event.sessionId ||
              hostRunId(stored) !== runId ||
              !Number.isInteger(stored.sequenceNumber) ||
              stored.sequenceNumber <= 0
            ) {
              fail({
                phase: "verify",
                reasonCode: "identity_unverifiable",
                strictAttempted: "unknown",
              });
              return;
            }
            job.phase = "observe";
            try {
              // 直接挂原 Promise，不经过 async/await 或 race 包装，避免取消兜底抢走真实 attempt 元数据。
              void deps.ensureCommit(stored, owner).then(
                (result) => {
                  if (finished) return;
                  try {
                    // 成功值也可能带违规 getter；单次读取后只复用已校验局部值，不能泄漏拒绝或未校验正文。
                    const strictAttempted = result?.strictAttempted;
                    if (typeof strictAttempted !== "boolean") {
                      onFailure(undefined, false);
                      return;
                    }
                    const invalidOwner = unavailable();
                    if (invalidOwner) {
                      fail({ ...invalidOwner, strictAttempted });
                      return;
                    }
                    finish({
                      ...identity,
                      event: "workflow.host_observation.sync.completed",
                      phase: "postcondition",
                      strictAttempted,
                      elapsedMs: Math.max(0, deps.now() - startedAt),
                    });
                  } catch {
                    // 在原 settlement handler 内终结；链尾 catch 会多排一轮微任务而破坏取消元数据优先级。
                    onFailure(undefined, false);
                  }
                },
                (error: unknown) => {
                  onFailure(error, true);
                },
              );
            } catch (error) {
              onFailure(error, true);
            }
          });
        })
        .catch((error: unknown) => {
          onFailure(error, false);
        });
      forwardOnce(job, forward);
    },
    dispose() {
      // 必须先整体撤销 owner，再触发任意 abort listener，阻止旧 record 的同步回调采用结果。
      active = false;
      for (const job of jobs.values()) job.cancel("disposed");
    },
  };
};
