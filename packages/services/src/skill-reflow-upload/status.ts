// ============================================================
// skill-reflow-upload 状态持久化（lastTriggerDate / lastSuccessAt）
// ============================================================
// 日界标记必须跨进程重启存活（spec §6.1「判定依据为持久化标记，进程崩溃不造成
// 当日重复会话」）；lastSuccessAt 同文件留痕。只读状态面（SkillReflowStatus）的
// 内存计数与 state 由 service.ts 持有，本文件只负责两个持久化时间戳。
// 损坏 → 重置为空：最坏效果是当日多触发一次扫描，入队幂等（同 key 同 digest
// 至多一条）保证零冗余请求。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

/** 状态文件名（固定，单例全局；导出供测试与存储审计回读）。 */
export const SKILL_REFLOW_STATE_FILE_NAME = "skill-reflow-state.json";

const STATE_SCHEMA_VERSION = 1;

export interface SkillReflowPersistedState {
  /** 最近一次日界判定通过的日期（YYYY-MM-DD，本地时区自然日）。 */
  lastTriggerDate?: string;
  lastSuccessAt?: string;
}

interface StoredStateFile extends SkillReflowPersistedState {
  readonly schemaVersion: number;
}

export interface SkillReflowStateFileOptions {
  storageDirectory: string;
  logger?: ServiceLogger;
}

/** 创建持久化状态文件读写器（原子写、损坏重置）。 */
export function createSkillReflowStateFile(options: SkillReflowStateFileOptions): {
  getState(): Promise<SkillReflowPersistedState>;
  markTriggered(dayKey: string): Promise<void>;
  markSuccess(at: string): Promise<void>;
  dispose(): Promise<void>;
} {
  const logger = options.logger ?? createServiceLogger("skill-reflow-upload");
  const filePath = join(options.storageDirectory, SKILL_REFLOW_STATE_FILE_NAME);
  let state: SkillReflowPersistedState = {};
  let opened = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => undefined);
    return next;
  }

  async function persist(next: SkillReflowPersistedState): Promise<void> {
    state = next;
    await mkdir(options.storageDirectory, { recursive: true, mode: 0o700 });
    const file: StoredStateFile = {
      schemaVersion: STATE_SCHEMA_VERSION,
      ...(next.lastTriggerDate ? { lastTriggerDate: next.lastTriggerDate } : {}),
      ...(next.lastSuccessAt ? { lastSuccessAt: next.lastSuccessAt } : {}),
    };
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
      const parsed = JSON.parse(content) as StoredStateFile;
      if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error("unexpected state schemaVersion");
      }
      state = {
        ...(typeof parsed.lastTriggerDate === "string"
          ? { lastTriggerDate: parsed.lastTriggerDate }
          : {}),
        ...(typeof parsed.lastSuccessAt === "string"
          ? { lastSuccessAt: parsed.lastSuccessAt }
          : {}),
      };
    } catch {
      state = {};
      logger.warn(undefined, "skill reflow state file corrupted; reset to empty");
    }
  }

  async function ensureOpen(): Promise<void> {
    if (!opened) {
      await open();
      opened = true;
    }
  }

  return {
    getState() {
      return run(async () => {
        await ensureOpen();
        return { ...state };
      });
    },
    markTriggered(dayKey: string) {
      return run(async () => {
        await ensureOpen();
        await persist({ ...state, lastTriggerDate: dayKey });
      });
    },
    markSuccess(at: string) {
      return run(async () => {
        await ensureOpen();
        await persist({ ...state, lastSuccessAt: at });
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
