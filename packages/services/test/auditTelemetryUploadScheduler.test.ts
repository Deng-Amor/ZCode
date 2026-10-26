import { describe, expect, it } from "vitest";
import type {
  AuditTelemetryQueue,
  AuditTelemetryQueueRecord,
} from "../src/audit-telemetry/contract.js";
import type { AuditTelemetryUploader } from "../src/audit-telemetry/uploader.js";
import {
  createAuditTelemetryUploadScheduler,
  type AuditTelemetrySchedulerTimers,
} from "../src/audit-telemetry/upload-scheduler.js";

function record(channel: AuditTelemetryQueueRecord["channel"], id: string): AuditTelemetryQueueRecord {
  return { commandId: id, channel, serializedEvent: "{}", byteLength: 2 };
}

function harness(records: AuditTelemetryQueueRecord[], outcomes: AuditTelemetryUploader["upload"] extends (...args: never[]) => Promise<infer T> ? T[] : never[]) {
  const pending = [...records];
  const acked: string[][] = [];
  const uploads: { channel: string; ids: string[] }[] = [];
  const queue: AuditTelemetryQueue = {
    enqueue: async () => ({ status: "enqueued", droppedOldest: 0, droppedOldestTotal: 0 }),
    take: async (limit, channel) => pending.filter((item) => !channel || item.channel === channel).slice(0, limit),
    ack: async (ids) => {
      acked.push([...ids]);
      for (const id of ids) {
        const index = pending.findIndex((item) => item.commandId === id);
        if (index >= 0) pending.splice(index, 1);
      }
      return ids.length;
    },
    stats: async () => ({ pendingRecords: pending.length, pendingBytes: 0, droppedOldestTotal: 0, commandIdConflicts: 0, recoveredCorruptLines: 0 }),
    dispose: async () => undefined,
  };
  let outcomeIndex = 0;
  const uploader: AuditTelemetryUploader = {
    upload: async ({ channel, records: batch }) => {
      uploads.push({ channel, ids: batch.map((item) => item.commandId) });
      return outcomes[outcomeIndex++] ?? { kind: "accepted", acknowledgedCommandIds: batch.map((item) => item.commandId) };
    },
  };
  return { queue, uploader, uploads, acked, pending };
}

function timers(): { timers: AuditTelemetrySchedulerTimers; advance: (ms: number) => void } {
  let now = 0;
  let nextId = 0;
  const callbacks = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      now: () => now,
      schedule: (callback, delay) => {
        const id = ++nextId;
        callbacks.set(id, { at: now + delay, callback });
        return id;
      },
      cancel: (id) => callbacks.delete(id),
    },
    advance: (ms) => {
      now += ms;
      for (const [id, item] of Array.from(callbacks)) {
        if (item.at <= now) {
          callbacks.delete(id);
          item.callback();
        }
      }
    },
  };
}

describe("audit telemetry upload scheduler", () => {
  it("keeps polling after an accepted batch and an empty window", async () => {
    const clock = timers();
    const h = harness([record("lifecycle", "first")], []);
    const scheduler = createAuditTelemetryUploadScheduler({ queue: h.queue, uploader: h.uploader, timers: clock.timers, lifecycleIntervalMs: 100, diagnosticIntervalMs: 1000 });
    scheduler.start();
    await scheduler.notifyOnline();
    expect(scheduler.state().nextLifecycleFlushAt).toBe(100);
    clock.advance(100);
    await scheduler.notifyOnline();
    expect(scheduler.state().nextLifecycleFlushAt).toBe(200);
    h.pending.push(record("lifecycle", "second"));
    clock.advance(100);
    await scheduler.notifyOnline();
    expect(h.uploads.map((item) => item.ids)).toEqual([["first"], ["second"]]);
    await scheduler.dispose();
  });

  it("flushes lifecycle on batch size and diagnostic on its window", async () => {
    const clock = timers();
    const h = harness([record("lifecycle", "l1"), record("diagnostic", "d1")], []);
    const scheduler = createAuditTelemetryUploadScheduler({
      queue: h.queue,
      uploader: h.uploader,
      timers: clock.timers,
      lifecycleBatchSize: 1,
      lifecycleIntervalMs: 5000,
      diagnosticIntervalMs: 10000,
      batchSize: 10,
    });
    scheduler.start();
    await scheduler.notifyOnline();
    expect(h.uploads).toEqual([{ channel: "lifecycle", ids: ["l1"] }, { channel: "diagnostic", ids: ["d1"] }]);
    expect(scheduler.state().flushes).toBe(2);
    await scheduler.dispose();
  });

  it("handles outcomes, auth recovery, capped retry backoff, rate slowdown, and never rejects", async () => {
    const clock = timers();
    const h = harness(
      [record("lifecycle", "a"), record("lifecycle", "b")],
      [{ kind: "rejected", reasons: [{ commandId: "a", reason: "schema-unknown" }] }, { kind: "auth-required" }, { kind: "retryable-failure" }, { kind: "rate-limited" }],
    );
    const scheduler = createAuditTelemetryUploadScheduler({ queue: h.queue, uploader: h.uploader, timers: clock.timers, lifecycleBatchSize: 1, batchSize: 1, lifecycleIntervalMs: 100, maxRetryDelayMs: 250 });
    scheduler.start();
    await expect(scheduler.notifyOnline()).resolves.toBeUndefined();
    await expect(scheduler.notifyOnline()).resolves.toBeUndefined();
    expect(scheduler.state()).toMatchObject({ deadLettered: 1, authPaused: true });
    await expect(scheduler.notifyOnline()).resolves.toBeUndefined();
    await scheduler.notifyAuthenticated();
    await expect(scheduler.notifyOnline()).resolves.toBeUndefined();
    clock.advance(1000);
    expect(scheduler.state().retries).toBeGreaterThanOrEqual(1);
    await scheduler.dispose();
  });
});
