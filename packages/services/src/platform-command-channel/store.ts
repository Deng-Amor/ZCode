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
import type {
  CommandChannelCommandStore,
  CommandChannelDiskStoreOptions,
  CommandChannelStoreIdentity,
} from "./contract.js";

/**
 * 幂等命令存储的磁盘实现（M7-R4：同 commandId 重发返回原结果，字节一致、不改写）。
 *
 * - 形态：按登录身份隔离的 JSONL 追加文件（身份 key = tenantId+userId，与
 *   audit-telemetry 队列同款口径；多租户指令结果互不可见）。
 * - 只存 executed 结果的冻结字节；freeze 对同 commandId 第二次调用返回 false 且不改写。
 * - 无容量淘汰（**有意**）：淘汰已执行记录会让重放重新执行，破坏 S11-b 幂等判据；
 *   容量与归档策略留后续卡（单条记录为小 JSON 行，长期增长可控）。
 * - 重启恢复：逐行读回；撕裂行（无换行结尾）与损坏行丢弃并计数后原子重写，
 *   防止后续 append 拼进残行；同 commandId 重复行取首条（先入队者名义不可改写）。
 * - 异步 IO；所有写操作经内部 promise 链串行；单存储单所有者（Main 侧一个实例）。
 */

/** 身份 key → 存储文件名（导出供测试与存储隔离审计回读）。 */
export function commandChannelStoreFileName(
  identity: CommandChannelStoreIdentity,
): string {
  const digest = createHash("sha256")
    .update(`${identity.tenantId}\u0000${identity.userId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `platform-command-store-${digest}.jsonl`;
}

interface StoredRecord {
  readonly commandId: string;
  readonly serializedResponse: string;
}

function parseStoredLine(line: string): StoredRecord | undefined {
  let parsed: { commandId?: unknown; serializedResponse?: unknown };
  try {
    parsed = JSON.parse(line) as {
      commandId?: unknown;
      serializedResponse?: unknown;
    };
  } catch {
    return undefined;
  }
  if (
    typeof parsed.commandId !== "string" ||
    parsed.commandId.length === 0 ||
    typeof parsed.serializedResponse !== "string" ||
    parsed.serializedResponse.length === 0
  ) {
    return undefined;
  }
  return {
    commandId: parsed.commandId,
    serializedResponse: parsed.serializedResponse,
  };
}

export function createCommandChannelDiskStore(
  options: CommandChannelDiskStoreOptions,
): CommandChannelCommandStore {
  const logger: ServiceLogger =
    options.logger ?? createServiceLogger("platform-command-channel");
  const filePath = join(
    options.storageDirectory,
    commandChannelStoreFileName(options.identity),
  );

  let frozen = new Map<string, string>();
  let recoveredCorruptLines = 0;
  let opened = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  async function rewriteAll(): Promise<void> {
    // 临时文件 + 原子替换防止重启读到半份存储（同 audit-telemetry 队列先例）。
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      const lines = [...frozen.entries()].map(
        ([commandId, serializedResponse]) =>
          JSON.stringify({ commandId, serializedResponse }),
      );
      await writeFile(
        temporary,
        lines.join("\n") + (lines.length ? "\n" : ""),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let tornTail = false;
    let lines = content.split("\n");
    if (content.length && !content.endsWith("\n")) {
      // 末行无换行结尾 = 写入中断的撕裂行，丢弃并计数（不可让半行复活成可重放结果）。
      tornTail = true;
      recoveredCorruptLines += 1;
      lines = lines.slice(0, -1);
    }
    const recovered = new Map<string, string>();
    for (const line of lines) {
      if (!line) continue;
      const record = parseStoredLine(line);
      if (!record) {
        recoveredCorruptLines += 1;
        continue;
      }
      // 同 commandId 重复行只取第一条：先冻结的名义不可改写（后行属异常写放大）。
      if (!recovered.has(record.commandId)) {
        recovered.set(record.commandId, record.serializedResponse);
      } else {
        recoveredCorruptLines += 1;
      }
    }
    frozen = recovered;
    if (recoveredCorruptLines > 0 || tornTail) {
      // 存储损坏：丢弃行已计数并落 error 日志；被丢弃 commandId 的下次重放会重新执行，
      // 该风险由计数与日志暴露（recoveredCorruptLines 可回读），不静默吞掉。
      logger.error(
        undefined,
        `command channel store recovered with corruption: lines=${recoveredCorruptLines}`,
      );
      await rewriteAll();
    }
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
    get(commandId) {
      return run(async () => {
        await ensureOpen();
        return frozen.get(commandId);
      });
    },
    freeze(commandId, serializedResponse) {
      return run(async () => {
        await ensureOpen();
        const existing = frozen.get(commandId);
        if (existing !== undefined) {
          // 幂等名义已冻结：不改写、不追加（返回 false，调用方应改读原结果）。
          return false;
        }
        frozen.set(commandId, serializedResponse);
        await appendFile(
          filePath,
          `${JSON.stringify({ commandId, serializedResponse })}\n`,
          "utf8",
        );
        return true;
      });
    },
    dispose() {
      // 等待在途写操作收尾；不删除存储文件（跨重启保留是幂等义务）。
      return writeChain.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
