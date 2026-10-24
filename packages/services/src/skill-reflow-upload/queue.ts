// ============================================================
// skill-reflow-upload 上传队列（spec §6.4 失败重试与不阻塞 / §5.1 所有者）
// ============================================================
// - 形态：单文件 JSON（待传条目唯一持有者；持久化于 CCode 私有数据目录，
//   进程重启存活）。唯一写入者/消费者为 SkillReflowUploadService；Renderer、
//   Agent 进程、技能加载路径均不读写队列（spec §5.1）。
// - 幂等：同 key 同 digest 至多一条（重试不重复入队）；同 key 变更 digest →
//   替换旧条目并重置重试计数（条目级无差分，变更即全量重传，spec §6.3）。
// - 失败语义：fail() 只累计 attempts 与固定错误码（{code, at}），不用超时掩盖
//   同步问题；终态出队统一走 settle()（accepted/dedupHit/filterHit 均终态）。
// - 队列文件损坏/撕裂 → 重置为空并 warn：队列丢失后由下一次触发重新扫描入队，
//   去重账本保证已受理内容零冗余请求（spec §6.3），故不做行级抢救。
// - 写入：临时文件 + 原子替换；异步 IO；操作经内部 promise 链串行。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  SkillReflowEntry,
  SkillReflowErrorCode,
  SkillReflowUploadQueue,
} from "./contract.js";

/** 队列文件名（固定，单例全局；导出供测试与存储审计回读）。 */
export const SKILL_REFLOW_QUEUE_FILE_NAME = "skill-reflow-queue.json";

const QUEUE_SCHEMA_VERSION = 1;

interface StoredQueueFile {
  readonly schemaVersion: number;
  readonly items: SkillReflowEntry[];
}

export interface SkillReflowQueueOptions {
  storageDirectory: string;
  logger?: ServiceLogger;
}

function isStoredEntry(value: unknown): value is SkillReflowEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    typeof candidate.relativePath === "string" &&
    typeof candidate.name === "string" &&
    (candidate.sourceType === "user" || candidate.sourceType === "workspace") &&
    typeof candidate.contentDigest === "string" &&
    typeof candidate.lastModified === "string" &&
    typeof candidate.queuedAt === "string" &&
    typeof candidate.attempts === "number" &&
    typeof candidate.rootId === "string" &&
    typeof candidate.directoryPath === "string"
  );
}

/** 创建持久化上传队列（待传条目唯一持有者，进程重启恢复）。 */
export function createSkillReflowQueueFile(
  options: SkillReflowQueueOptions,
): SkillReflowUploadQueue & { dispose(): Promise<void> } {
  const logger = options.logger ?? createServiceLogger("skill-reflow-upload");
  const filePath = join(options.storageDirectory, SKILL_REFLOW_QUEUE_FILE_NAME);
  let items: SkillReflowEntry[] = [];
  let opened = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => undefined);
    return next;
  }

  async function persist(): Promise<void> {
    await mkdir(options.storageDirectory, { recursive: true, mode: 0o700 });
    const file: StoredQueueFile = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      items,
    };
    // 临时文件 + 原子替换，防止重启读到半份队列。
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function open(): Promise<void> {
    await mkdir(options.storageDirectory, { recursive: true, mode: 0o700 });
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(content) as StoredQueueFile;
      if (
        parsed.schemaVersion === QUEUE_SCHEMA_VERSION &&
        Array.isArray(parsed.items) &&
        parsed.items.every(isStoredEntry)
      ) {
        // 恢复时同 key 只保留先入队者（写入端已保证唯一，此为防御）。
        const restored = new Map<string, SkillReflowEntry>();
        for (const item of parsed.items) {
          if (!restored.has(item.key)) {
            restored.set(item.key, item);
          }
        }
        items = [...restored.values()];
        return;
      }
      throw new Error("unexpected queue shape");
    } catch {
      // 队列损坏：重置为空并 warn；下次触发全量扫描 + 账本去重重建队列（spec §6.3）。
      items = [];
      logger.warn(undefined, "skill reflow queue corrupted; reset to empty");
    }
  }

  async function ensureOpen(): Promise<void> {
    if (!opened) {
      await open();
      opened = true;
    }
  }

  return {
    async enqueue(entry) {
      await run(async () => {
        await ensureOpen();
        const index = items.findIndex((item) => item.key === entry.key);
        if (index >= 0) {
          const existing = items[index]!;
          if (existing.contentDigest === entry.contentDigest) {
            // 同 key 同 digest：幂等命中，不重复入队（spec §6.4）。
            return;
          }
          // 同 key 变更 digest：替换旧条目（全量重传语义），重置重试计数与错误。
          items[index] = entry;
          await persist();
          return;
        }
        items.push(entry);
        await persist();
      });
    },
    async take(limit) {
      return run(async () => {
        await ensureOpen();
        return items.slice(0, Math.max(0, limit));
      });
    },
    async settle(keys) {
      return run(async () => {
        await ensureOpen();
        const settled = new Set(keys);
        const remaining: SkillReflowEntry[] = [];
        let removed = 0;
        for (const item of items) {
          if (settled.has(item.key)) {
            removed += 1;
          } else {
            remaining.push(item);
          }
        }
        if (removed > 0) {
          items = remaining;
          await persist();
        }
        return removed;
      });
    },
    async fail(key, code: SkillReflowErrorCode, at) {
      await run(async () => {
        await ensureOpen();
        const index = items.findIndex((item) => item.key === key);
        if (index < 0) {
          // 未知 key（已出队或从未入队）：忽略，debug 可观察。
          logger.debug(undefined, `skill reflow queue: fail() on unknown key: ${key}`);
          return;
        }
        const existing = items[index]!;
        items[index] = {
          ...existing,
          attempts: existing.attempts + 1,
          lastError: { code, at },
        };
        await persist();
      });
    },
    dispose() {
      return writeChain.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
