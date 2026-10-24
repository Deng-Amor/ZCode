import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  createServiceLogger,
  type ServiceLogger,
} from "#src/logger/serviceLogger.js";
import type { AuditTelemetryChannel, AuditTelemetryEvent } from "./schema.js";
import { serializeAuditTelemetryEvent } from "./schema.js";
import type {
  AuditTelemetryDiskQueueLimits,
  AuditTelemetryDiskQueueOptions,
  AuditTelemetryEnqueueResult,
  AuditTelemetryQueue,
  AuditTelemetryQueueIdentity,
  AuditTelemetryQueueRecord,
  AuditTelemetryQueueStats,
} from "./contract.js";

/**
 * 持久化队列骨架（spec §5.2「队列持久化纪律」+ §4 规则 3「内容冻结」）。
 *
 * - 形态：按登录身份隔离的磁盘 JSONL（身份 key = tenantId+userId；loginId 每次登录变化，
 *   不参与隔离——注销/切换身份不清空队列，补传以认证后的身份上下文为准）。
 * - FIFO；容量上限（条数与字节）超限淘汰最老并计 droppedOldest，不静默丢弃；
 *   淘汰计数经注入的 mintOverflowEvent 作为一条低频 diagnostic 事件补报
 *   （队列内同时至多一条未 ACK 的补报事件，防止计数事件自激刷队列）。
 * - 内容冻结：入队时白名单投影 + 固定键序序列化一次，落盘字节即出网字节；
 *   同 commandId 同字节重放幂等（不重复入队），同 commandId 异字节拒绝（内容冲突计数）。
 * - 进程重启恢复：逐行读回；末行撕裂（无换行结尾）与无法解析的行丢弃并计数，
 *   并原子重写文件防止后续 append 拼进残行。
 * - ACK 出队：以中台逐条受理状态为准（accepted 视同受理，含幂等重放）。
 * - 异步 IO；所有文件操作经内部 promise 链串行，避免并发 append 交错。
 *   单队列单所有者（Main 侧一个实例）；同身份并发多实例不在本骨架语义内。
 */

/** 容量上限默认值（常数待评审，OQ-A9：本地队列容量上限与淘汰可见性）。 */
export const DEFAULT_AUDIT_TELEMETRY_QUEUE_LIMITS = {
  maxRecords: 2000,
  maxBytes: 2 * 1024 * 1024,
} as const;

interface StoredRecord {
  readonly commandId: string;
  readonly channel: AuditTelemetryChannel;
  readonly serializedEvent: string;
  readonly byteLength: number;
  readonly isOverflowCounter: boolean;
}

/** 身份 key → 队列文件名（导出供测试与存储隔离审计回读）。 */
export function auditTelemetryQueueFileName(
  identity: AuditTelemetryQueueIdentity,
): string {
  const digest = createHash("sha256")
    .update(`${identity.tenantId}\u0000${identity.userId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `audit-telemetry-queue-${digest}.jsonl`;
}

function isSerializedOverflowCounter(serializedEvent: string): boolean {
  try {
    const parsed = JSON.parse(serializedEvent) as {
      type?: unknown;
      payload?: { errorCode?: unknown };
    };
    return (
      parsed.type === "runtime.error" &&
      parsed.payload?.errorCode === "AUDIT_QUEUE_OVERFLOW"
    );
  } catch {
    return false;
  }
}

export function createAuditTelemetryDiskQueue(
  options: AuditTelemetryDiskQueueOptions,
): AuditTelemetryQueue {
  const logger = options.logger ?? createServiceLogger("audit-telemetry");
  const limits: AuditTelemetryDiskQueueLimits = {
    ...DEFAULT_AUDIT_TELEMETRY_QUEUE_LIMITS,
    ...options.limits,
  };
  if (!Number.isInteger(limits.maxRecords) || limits.maxRecords < 1) {
    throw new RangeError(
      `maxRecords must be a positive integer, got ${String(limits.maxRecords)}`,
    );
  }
  if (!Number.isFinite(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError(
      `maxBytes must be a positive finite number, got ${String(limits.maxBytes)}`,
    );
  }
  const filePath = join(
    options.storageDirectory,
    auditTelemetryQueueFileName(options.identity),
  );

  let records: StoredRecord[] = [];
  const byCommandId = new Map<string, StoredRecord>();
  const pendingOverflowCounters = new Set<string>();
  let droppedOldestTotal = 0;
  let commandIdConflicts = 0;
  let recoveredCorruptLines = 0;
  let opened = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  function totalBytes(): number {
    let bytes = 0;
    for (const record of records) bytes += record.byteLength;
    return bytes;
  }

  async function rewriteAll(): Promise<void> {
    // 临时文件 + 原子替换防止重启读到半份队列（同 encrypted-login-store 先例）。
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        records.map((r) => r.serializedEvent).join("\n") +
          (records.length ? "\n" : ""),
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function appendRecordLine(record: StoredRecord): Promise<void> {
    await appendFile(filePath, `${record.serializedEvent}\n`, "utf8");
  }

  async function open(): Promise<void> {
    await mkdir(options.storageDirectory, { recursive: true, mode: 0o700 });
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let tornTail = false;
    let lines = content.split("\n");
    if (content.length && !content.endsWith("\n")) {
      // 末行无换行结尾 = 写入中断的撕裂行，丢弃并计数（telemetry 可容忍丢失，不可容忍半行复活）。
      tornTail = true;
      recoveredCorruptLines += 1;
      lines = lines.slice(0, -1);
    }
    const valid: StoredRecord[] = [];
    for (const line of lines) {
      if (!line) continue;
      let parsed: { commandId?: unknown; channel?: unknown };
      try {
        parsed = JSON.parse(line) as { commandId?: unknown; channel?: unknown };
      } catch {
        recoveredCorruptLines += 1;
        continue;
      }
      if (
        typeof parsed.commandId !== "string" ||
        (parsed.channel !== "lifecycle" && parsed.channel !== "diagnostic")
      ) {
        recoveredCorruptLines += 1;
        continue;
      }
      const record: StoredRecord = {
        commandId: parsed.commandId,
        channel: parsed.channel,
        serializedEvent: line,
        byteLength: Buffer.byteLength(line, "utf8"),
        isOverflowCounter: isSerializedOverflowCounter(line),
      };
      // 重启恢复优先保留先入队者：同 commandId 重复行只取第一条（后行属异常写放大）。
      if (!byCommandId.has(record.commandId)) {
        byCommandId.set(record.commandId, record);
        valid.push(record);
      } else {
        recoveredCorruptLines += 1;
      }
    }
    records = valid;
    for (const record of records) {
      if (record.isOverflowCounter)
        pendingOverflowCounters.add(record.commandId);
    }
    if (recoveredCorruptLines > 0 || tornTail) {
      // 队列存储损坏：丢弃行已计数，重写防止后续 append 拼进残行（spec §6.8 error 级）。
      logger.error(
        undefined,
        `audit telemetry queue recovered with corruption: lines=${recoveredCorruptLines}`,
      );
      await rewriteAll();
    }
  }

  function evictOverflowCounter(record: StoredRecord): void {
    if (record.isOverflowCounter)
      pendingOverflowCounters.delete(record.commandId);
  }

  function register(record: StoredRecord): void {
    records.push(record);
    byCommandId.set(record.commandId, record);
    if (record.isOverflowCounter) pendingOverflowCounters.add(record.commandId);
  }

  async function enqueueSerialized(
    commandId: string,
    channel: AuditTelemetryChannel,
    serializedEvent: string,
    allowMint: boolean,
  ): Promise<AuditTelemetryEnqueueResult> {
    const byteLength = Buffer.byteLength(serializedEvent, "utf8");
    if (byteLength > limits.maxBytes) {
      return {
        status: "rejected-oversized",
        droppedOldest: 0,
        droppedOldestTotal,
      };
    }
    const existing = byCommandId.get(commandId);
    if (existing) {
      if (existing.serializedEvent === serializedEvent) {
        // 内容冻结的客户端面：同 commandId 同字节重放幂等（中台 M4-R2 同 ID 同内容）。
        return {
          status: "duplicate-replay",
          droppedOldest: 0,
          droppedOldestTotal,
        };
      }
      // 同 ID 异内容属铸造缺陷：拒绝入队并计数，不改写已冻结名义（服务端同判拒+审计）。
      commandIdConflicts += 1;
      return {
        status: "command-id-conflict",
        droppedOldest: 0,
        droppedOldestTotal,
      };
    }
    const incoming: StoredRecord = {
      commandId,
      channel,
      serializedEvent,
      byteLength,
      isOverflowCounter: isSerializedOverflowCounter(serializedEvent),
    };
    register(incoming);
    let evictedThisCall = 0;
    // 淘汰最老直到回到双上限内；新事件已通过单条字节上限预检，不会淘汰到自身。
    while (
      records.length > limits.maxRecords ||
      totalBytes() > limits.maxBytes
    ) {
      const oldest = records.shift();
      if (!oldest) break;
      byCommandId.delete(oldest.commandId);
      evictOverflowCounter(oldest);
      droppedOldestTotal += 1;
      evictedThisCall += 1;
    }
    if (evictedThisCall > 0) {
      logger.warn(
        undefined,
        `audit telemetry queue dropped oldest events: count=${evictedThisCall}`,
      );
    }
    if (evictedThisCall === 0) {
      await appendRecordLine(incoming);
    } else {
      // 发生淘汰时重写即包含新行，避免 append+rewrite 双写竞态。
      await rewriteAll();
    }
    // 低频补报：仅当没有未 ACK 的补报事件在队时铸造，防计数事件自激。
    if (
      evictedThisCall > 0 &&
      allowMint &&
      options.mintOverflowEvent &&
      pendingOverflowCounters.size === 0
    ) {
      const overflowEvent = options.mintOverflowEvent(droppedOldestTotal);
      if (overflowEvent) {
        const nested = await enqueueSerialized(
          overflowEvent.commandId,
          overflowEvent.channel,
          serializeAuditTelemetryEvent(overflowEvent),
          false,
        );
        evictedThisCall += nested.droppedOldest;
      }
    }
    return {
      status: "enqueued",
      droppedOldest: evictedThisCall,
      droppedOldestTotal,
    };
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => undefined);
    return next;
  }

  async function ensureOpen(): Promise<void> {
    if (!opened) {
      await open();
      opened = true;
    }
  }

  return {
    enqueue(event) {
      // async 包裹：序列化/校验失败以 rejected Promise 冔回（strict schema 拒绝不进任何文件或内存状态）。
      const serializedPromise = Promise.resolve().then(() => {
        const serializedEvent = serializeAuditTelemetryEvent(event);
        return {
          serializedEvent,
          commandId: event.commandId,
          channel: event.channel,
        };
      });
      return serializedPromise.then(({ serializedEvent, commandId, channel }) =>
        run(async () => {
          await ensureOpen();
          return enqueueSerialized(commandId, channel, serializedEvent, true);
        }),
      );
    },
    take(limit, channel) {
      return run(async () => {
        await ensureOpen();
        const taken: AuditTelemetryQueueRecord[] = [];
        for (const record of records) {
          if (taken.length >= limit) break;
          if (channel && record.channel !== channel) continue;
          taken.push({
            commandId: record.commandId,
            channel: record.channel,
            serializedEvent: record.serializedEvent,
            byteLength: record.byteLength,
          });
        }
        return taken;
      });
    },
    ack(commandIds) {
      const acknowledged = new Set(commandIds);
      return run(async () => {
        await ensureOpen();
        const remaining: StoredRecord[] = [];
        let removed = 0;
        for (const record of records) {
          if (acknowledged.has(record.commandId)) {
            byCommandId.delete(record.commandId);
            evictOverflowCounter(record);
            removed += 1;
          } else {
            remaining.push(record);
          }
        }
        if (removed > 0) {
          records = remaining;
          await rewriteAll();
        }
        return removed;
      });
    },
    stats() {
      return run(async () => {
        await ensureOpen();
        return {
          pendingRecords: records.length,
          pendingBytes: totalBytes(),
          droppedOldestTotal,
          commandIdConflicts,
          recoveredCorruptLines,
        } satisfies AuditTelemetryQueueStats;
      });
    },
    dispose() {
      // 等待在途写操作收尾；不删除队列文件（跨重启保留是队列义务）。
      return writeChain.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
