import type {
  AuditTelemetryChannel,
  AuditTelemetryQueue,
  AuditTelemetryQueueRecord,
} from "./contract.js";
import type { AuditTelemetryUploadOutcome, AuditTelemetryUploader } from "./uploader.js";

export interface AuditTelemetrySchedulerTimers {
  now(): number;
  schedule(callback: () => void, delayMs: number): number;
  cancel(id: number): void;
}

export interface AuditTelemetryUploadSchedulerOptions {
  queue: AuditTelemetryQueue;
  uploader: AuditTelemetryUploader;
  timers: AuditTelemetrySchedulerTimers;
  now?: () => number;
  lifecycleBatchSize?: number;
  lifecycleIntervalMs?: number;
  diagnosticIntervalMs?: number;
  batchSize?: number;
  maxRetryDelayMs?: number;
}

export interface AuditTelemetryUploadSchedulerState {
  readonly flushes: number;
  readonly retries: number;
  readonly deadLettered: number;
  readonly rateLimitedBackoffs: number;
  readonly nextLifecycleFlushAt?: number;
  readonly nextDiagnosticFlushAt?: number;
  readonly authPaused: boolean;
}

export interface AuditTelemetryUploadScheduler {
  start(): void;
  notifyOnline(): Promise<void>;
  notifyAuthenticated(): Promise<void>;
  dispose(): Promise<void>;
  state(): AuditTelemetryUploadSchedulerState;
}

const DEFAULT_LIFECYCLE_BATCH_SIZE = 20;
const DEFAULT_LIFECYCLE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 30 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRY_DELAY_MS = 60 * 60_000;

export function createAuditTelemetryUploadScheduler(
  options: AuditTelemetryUploadSchedulerOptions,
): AuditTelemetryUploadScheduler {
  const lifecycleBatchSize = options.lifecycleBatchSize ?? DEFAULT_LIFECYCLE_BATCH_SIZE;
  const lifecycleIntervalMs = options.lifecycleIntervalMs ?? DEFAULT_LIFECYCLE_INTERVAL_MS;
  const diagnosticIntervalMs = options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS;
  const baseBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const now = options.now ?? options.timers.now;
  const timerIds: Partial<Record<AuditTelemetryChannel, number>> = {};
  const nextFlush: Partial<Record<AuditTelemetryChannel, number>> = {};
  const retryAttempts: Record<AuditTelemetryChannel, number> = { lifecycle: 0, diagnostic: 0 };
  const sendBatchSize: Record<AuditTelemetryChannel, number> = {
    lifecycle: baseBatchSize,
    diagnostic: baseBatchSize,
  };
  const inFlight: Partial<Record<AuditTelemetryChannel, Promise<void>>> = {};
  let started = false;
  let disposed = false;
  let authPaused = false;
  let flushes = 0;
  let retries = 0;
  let deadLettered = 0;
  let rateLimitedBackoffs = 0;

  function clearTimer(channel: AuditTelemetryChannel): void {
    const id = timerIds[channel];
    if (id !== undefined) options.timers.cancel(id);
    delete timerIds[channel];
    delete nextFlush[channel];
  }

  function schedule(channel: AuditTelemetryChannel, delayMs: number): void {
    clearTimer(channel);
    const at = now() + delayMs;
    nextFlush[channel] = at;
    timerIds[channel] = options.timers.schedule(() => {
      void flush(channel).catch(() => undefined);
    }, delayMs);
  }

  function retryDelay(channel: AuditTelemetryChannel): number {
    const delay = Math.min(maxRetryDelayMs, 1000 * 2 ** retryAttempts[channel]);
    retryAttempts[channel] += 1;
    return delay;
  }

  async function flush(channel: AuditTelemetryChannel): Promise<void> {
    if (disposed || authPaused || inFlight[channel]) return inFlight[channel] ?? Promise.resolve();
    clearTimer(channel);
    const work = (async () => {
      let records: readonly AuditTelemetryQueueRecord[] = [];
      try {
        const limit = channel === "lifecycle"
          ? Math.min(sendBatchSize[channel], lifecycleBatchSize)
          : sendBatchSize[channel];
        records = await options.queue.take(limit, channel);
        // 成功或空队列也必须重排周期窗口；旧实现首次 flush 后就不再定时上传。
        if (records.length === 0) {
          schedule(channel, channel === "lifecycle" ? lifecycleIntervalMs : diagnosticIntervalMs);
          return;
        }
        flushes += 1;
        let outcome: AuditTelemetryUploadOutcome;
        try {
          outcome = await options.uploader.upload({ channel, records });
        } catch {
          outcome = { kind: "retryable-failure" };
        }
        if (outcome.kind === "accepted") {
          await options.queue.ack(outcome.acknowledgedCommandIds);
          retryAttempts[channel] = 0;
          sendBatchSize[channel] = baseBatchSize;
          schedule(channel, channel === "lifecycle" ? lifecycleIntervalMs : diagnosticIntervalMs);
          return;
        }
        if (outcome.kind === "rejected") {
          deadLettered += outcome.reasons.length;
          await options.queue.ack(outcome.reasons.map((item) => item.commandId));
          retryAttempts[channel] = 0;
          schedule(channel, channel === "lifecycle" ? lifecycleIntervalMs : diagnosticIntervalMs);
          return;
        }
        if (outcome.kind === "auth-required") {
          authPaused = true;
          return;
        }
        retries += 1;
        const delay = retryDelay(channel);
        if (outcome.kind === "rate-limited") {
          rateLimitedBackoffs += 1;
          sendBatchSize[channel] = Math.max(1, Math.ceil(sendBatchSize[channel] / 2));
        }
        if (!disposed && !authPaused) schedule(channel, delay);
      } catch {
        // 上报异常只能留队并计数，不能穿透到任务或 heartbeat 调用方。
        retries += 1;
        if (!disposed && !authPaused) schedule(channel, retryDelay(channel));
      }
    })();
    inFlight[channel] = work;
    try {
      await work;
    } finally {
      delete inFlight[channel];
    }
  }

  async function flushBoth(): Promise<void> {
    await Promise.all([flush("lifecycle"), flush("diagnostic")]);
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      schedule("lifecycle", lifecycleIntervalMs);
      schedule("diagnostic", diagnosticIntervalMs);
      void flushBoth().catch(() => undefined);
    },
    async notifyOnline() {
      if (!started || disposed) return;
      await flushBoth();
    },
    async notifyAuthenticated() {
      authPaused = false;
      if (!started || disposed) return;
      await flushBoth();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer("lifecycle");
      clearTimer("diagnostic");
      // dispose 时允许已经开始的批次完成；随后再取一次两通道待发数据。
      await Promise.all(Object.values(inFlight));
      if (!authPaused) {
        disposed = false;
        await flushBoth();
        disposed = true;
        clearTimer("lifecycle");
        clearTimer("diagnostic");
      }
      await options.queue.dispose();
    },
    state() {
      return {
        flushes,
        retries,
        deadLettered,
        rateLimitedBackoffs,
        nextLifecycleFlushAt: nextFlush.lifecycle,
        nextDiagnosticFlushAt: nextFlush.diagnostic,
        authPaused,
      };
    },
  };
}
