import type {
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelTextRequest,
  ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import { WORKFLOW_QUOTA_PROVIDER_CODES } from "../model/workflow-model-failure-policy.js";
import { ModelFailureReason } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../model/errors.js";

/** 保留模型分类和重试字段；丢弃可能回显系统正文的 message、cause 和 provider payload。 */
export function privateGlobalPromptModelError(error: unknown): Error {
  if (!(error instanceof AiSdkModelAdapterError)) {
    const safe = new Error("Protected model request failed");
    if (error instanceof Error && error.name === "AbortError") safe.name = "AbortError";
    return safe;
  }
  const context = error.context ?? {};
  const reason = Object.values(ModelFailureReason).find((value) => value === context.reason);
  const providerCode = context.providerCode ?? context.providerErrorCode;
  return new AiSdkModelAdapterError(error.code, "Protected model request failed", {
    usage: error.usage,
    context: {
      ...(reason ? { reason } : {}),
      retryable: context.retryable === true,
      ...(typeof context.statusCode === "number" ? { statusCode: context.statusCode } : {}),
      ...(typeof context.retryAfterMs === "number" ? { retryAfterMs: context.retryAfterMs } : {}),
      ...(typeof context.streamOutputCommitted === "boolean"
        ? { streamOutputCommitted: context.streamOutputCommitted }
        : {}),
      ...(context.errorPhase === "connect" || context.errorPhase === "stream"
        ? { errorPhase: context.errorPhase }
        : {}),
      ...(typeof providerCode === "string" && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)
        ? { providerCode, providerErrorCode: providerCode }
        : {}),
    },
  });
}

const privateSinks = new WeakMap<ModelStatusSink, ModelStatusSink>();

/** Explicit projection: new provider fields never become telemetry by default. */
export function privateControllerStatusSink(sink?: ModelStatusSink): ModelStatusSink | undefined {
  if (!sink) return undefined;
  const existing = privateSinks.get(sink);
  if (existing) return existing;
  const wrapped: ModelStatusSink = {
    publish(event) {
      const base = {
        timestamp: event.timestamp,
        traceId: event.traceId,
        queryId: event.queryId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        parentSessionId: event.parentSessionId,
        toolCallId: event.toolCallId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        requestId: event.requestId,
        providerId: event.providerId,
        modelId: event.modelId,
        transport: event.transport,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
      let safe: ModelNetworkStatusEvent;
      switch (event.type) {
        case "model_request_observation":
          return;
        case "model_request_failed":
          safe = {
            ...base,
            type: event.type,
            reason: event.reason,
            retryable: event.retryable,
            message: "Protected model request failed",
            statusCode: event.statusCode,
            errorCode: event.errorCode,
            retryAfterMs: event.retryAfterMs,
            durationMs: event.durationMs,
            errorPhase: event.errorPhase,
            streamOutputCommitted: event.streamOutputCommitted,
            // 额度耗尽必须保留受控分类，否则治理器会误作普通限流冻结共享桶。
            ...(event.providerErrorCode &&
            WORKFLOW_QUOTA_PROVIDER_CODES.has(event.providerErrorCode)
              ? { providerErrorCode: event.providerErrorCode }
              : {}),
          };
          break;
        case "model_retry_scheduled":
          safe = {
            ...base,
            type: event.type,
            reason: event.reason,
            delayMs: event.delayMs,
            nextAttempt: event.nextAttempt,
            message: "Protected model request retrying",
            statusCode: event.statusCode,
            errorCode: event.errorCode,
            retryAfterMs: event.retryAfterMs,
          };
          break;
        case "model_request_completed":
          safe = {
            ...base,
            type: event.type,
            durationMs: event.durationMs,
            streamOutputCommitted: event.streamOutputCommitted,
          };
          break;
        case "model_request_admitted":
          safe = { ...base, type: event.type, queuedMs: event.queuedMs };
          break;
        case "model_stream_stalled":
          safe = {
            ...base,
            type: event.type,
            idleMs: event.idleMs,
            timeoutMs: event.timeoutMs,
            message: "Protected model request stalled",
          };
          break;
        case "model_first_provider_event":
        case "model_first_content":
        case "model_first_text":
          safe = { ...base, type: event.type, elapsedMs: event.elapsedMs };
          break;
        default:
          safe = { ...base, type: event.type };
      }
      return sink.publish(safe);
    },
    // No publishFailure: the runner must never forward a raw SDK exception.
  };
  privateSinks.set(sink, wrapped);
  privateSinks.set(wrapped, wrapped);
  return wrapped;
}

export function protectControllerModelRequest<T extends ModelTextRequest>(request: T): T {
  if (request.metadata?.confidentialController !== true) return request;
  const admission = request.modelRequestAdmission;
  const wrapTicket = (ticket: ModelRequestAdmissionTicket): ModelRequestAdmissionTicket => ({
    publish: (event) => privateControllerStatusSink(ticket)!.publish(event),
    release: () => ticket.release(),
  });
  return {
    ...request,
    metadata: { ...request.metadata, skipTranscript: true },
    statusSink: privateControllerStatusSink(request.statusSink),
    modelRequestAdmission: admission
      ? {
          ...(admission.tryAcquire
            ? {
                tryAcquire: (input: Parameters<NonNullable<typeof admission.tryAcquire>>[0]) => {
                  const ticket = admission.tryAcquire!(input);
                  return ticket ? wrapTicket(ticket) : undefined;
                },
              }
            : {}),
          acquire: async (input) => wrapTicket(await admission.acquire(input)),
        }
      : undefined,
  };
}
