// ============================================================
// skill-reflow-upload 去重账本（spec §6.3 增量判定 / §5.1 所有者）
// ============================================================
// - 形态：单文件 JSON（身份无关全局；spec §5.1「与队列同生命周期持久化于 CCode
//   私有数据目录」，存储形态实现期定，本卡取 JSON）。
// - 语义：skillKey → 已受理 contentDigest + uploadedAt；内容不变 → 扫描侧不入队
//   （本地第一层去重），中台 租户+contentDigest 幂等是第二层兜底（spec 拍板第 3 条）。
// - 账本丢失/损坏 → 重置为空并 warn：下次触发按全量重传，中台幂等去重兜底，
//   不产生原始区重复记录（spec §6.3），故不做损坏抢救。
// - 写入：临时文件 + 原子替换（同 encrypted-login-store / audit-telemetry 队列先例），
//   异步 IO，操作经内部 promise 链串行。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { SkillReflowDedupLedger } from "./contract.js";

/** 账本文件名（固定，单例全局；导出供测试与存储审计回读）。 */
export const SKILL_REFLOW_LEDGER_FILE_NAME = "skill-reflow-ledger.json";

const LEDGER_SCHEMA_VERSION = 1;

interface StoredLedgerFile {
  readonly schemaVersion: number;
  readonly accepted: Record<string, { contentDigest: string; uploadedAt: string }>;
}

export interface SkillReflowLedgerOptions {
  storageDirectory: string;
  logger?: ServiceLogger;
}

/** 创建持久化去重账本（身份无关全局单文件）。 */
export function createSkillReflowLedgerFile(
  options: SkillReflowLedgerOptions,
): SkillReflowDedupLedger & { dispose(): Promise<void> } {
  const logger = options.logger ?? createServiceLogger("skill-reflow-upload");
  const filePath = join(options.storageDirectory, SKILL_REFLOW_LEDGER_FILE_NAME);
  let accepted = new Map<string, { contentDigest: string; uploadedAt: string }>();
  let opened = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => undefined);
    return next;
  }

  async function persist(): Promise<void> {
    await mkdir(options.storageDirectory, { recursive: true, mode: 0o700 });
    const file: StoredLedgerFile = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      accepted: Object.fromEntries(accepted),
    };
    // 临时文件 + 原子替换，防止重启读到半份账本。
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
      const parsed = JSON.parse(content) as StoredLedgerFile;
      if (
        parsed.schemaVersion === LEDGER_SCHEMA_VERSION &&
        parsed.accepted &&
        typeof parsed.accepted === "object"
      ) {
        accepted = new Map(
          Object.entries(parsed.accepted).filter(
            ([key, value]) =>
              key.length > 0 &&
              typeof value?.contentDigest === "string" &&
              typeof value?.uploadedAt === "string",
          ),
        );
        return;
      }
      throw new Error("unexpected ledger shape");
    } catch {
      // 账本损坏：重置为空（全量重传由中台幂等兜底，spec §6.3），不中断触发流程。
      accepted = new Map();
      logger.warn(undefined, "skill reflow ledger corrupted; reset to empty");
    }
  }

  async function ensureOpen(): Promise<void> {
    if (!opened) {
      await open();
      opened = true;
    }
  }

  return {
    async getAccepted(key) {
      return run(async () => {
        await ensureOpen();
        return accepted.get(key);
      });
    },
    async recordAccepted(key, contentDigest, uploadedAt) {
      await run(async () => {
        await ensureOpen();
        accepted.set(key, { contentDigest, uploadedAt });
        await persist();
      });
    },
    async pruneAbsent(presentKeys) {
      return run(async () => {
        await ensureOpen();
        const present = new Set(presentKeys);
        let pruned = 0;
        for (const key of accepted.keys()) {
          if (!present.has(key)) {
            accepted.delete(key);
            pruned += 1;
          }
        }
        if (pruned > 0) {
          await persist();
        }
        return pruned;
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
