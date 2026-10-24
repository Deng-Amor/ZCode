// 队列→上传→回执的唯一编排所有者；Main 接线归后续卡，本文件不实现触发器。

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  SkillReflowEntry,
  SkillReflowErrorCode,
  SkillReflowUploadQueue,
} from "./contract.js";
import { SkillReflowHttpUploadError, type SkillReflowHttpUploader, type SkillReflowTriggerType } from "./http-uploader.js";
import { collectEntryContentFiles, type ScanContext } from "./scanner.js";
import type { SkillReflowUploadService } from "./service.js";

export interface SkillReflowUploadDriverOptions {
  readonly service: SkillReflowUploadService;
  readonly queue: SkillReflowUploadQueue;
  readonly uploader: SkillReflowHttpUploader;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly maxFileBytes?: number;
}

export interface SkillReflowUploadDriveSummary {
  readonly sessions: number;
  readonly entriesUploaded: number;
  readonly stopped?: "needLogin" | "retryableFailed";
  readonly errorCode?: SkillReflowErrorCode;
}

function scanContext(logger: ServiceLogger): ScanContext {
  return {
    entries: [], scanned: 0, optOutSkipped: 0, rangeExcluded: 0,
    seenEntryDirectories: new Set(), countedOptOutEntryDirectories: new Set(), logger,
  };
}

async function materialize(
  entry: SkillReflowEntry,
  logger: ServiceLogger,
  maxFileBytes: number,
): Promise<{ path: string; contentBase64: string }[]> {
  const collected = await collectEntryContentFiles(entry.directoryPath, 0, scanContext(logger));
  const files = [{ relativePath: "SKILL.md", absolutePath: join(entry.directoryPath, "SKILL.md") }, ...collected.files];
  const result: { path: string; contentBase64: string }[] = [];
  for (const file of files) {
    const metadata = await stat(file.absolutePath);
    if (!metadata.isFile() || metadata.size > maxFileBytes) throw new Error("file exceeds upload limit or is not regular");
    const content = await readFile(file.absolutePath);
    result.push({ path: file.relativePath, contentBase64: content.toString("base64") });
  }
  return result;
}

export function createSkillReflowUploadDriver(options: SkillReflowUploadDriverOptions) {
  const logger = options.logger ?? createServiceLogger("skill-reflow-upload");
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 10;
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;

  return {
    async run(triggerType: SkillReflowTriggerType): Promise<SkillReflowUploadDriveSummary> {
      let sessions = 0;
      let entriesUploaded = 0;
      const failedKeys = new Set<string>();
      try {
        while (true) {
          const pending = await options.queue.take(Number.MAX_SAFE_INTEGER);
          const batch = pending.filter((entry) => !failedKeys.has(entry.key)).slice(0, batchSize);
          if (batch.length === 0) { options.service.markDone(); return { sessions, entriesUploaded }; }
          options.service.markSending();
          const uploadEntries = [];
          for (const entry of batch) {
            try {
              uploadEntries.push({ entry, files: await materialize(entry, logger, maxFileBytes) });
            } catch (error) {
              await options.queue.fail(entry.key, "IO_FAILED", now().toISOString());
              failedKeys.add(entry.key);
              logger.warn(undefined, `skill reflow upload driver: entry read failed: ${entry.key}: ${String(error)}`);
            }
          }
          if (uploadEntries.length === 0) continue;
          const receipts = await options.uploader.uploadSession({ triggerType, entries: uploadEntries });
          sessions += 1;
          for (const receipt of receipts) { await options.service.recordReceipt(receipt); entriesUploaded += 1; }
        }
      } catch (error) {
        if (error instanceof SkillReflowHttpUploadError) {
          if (error.error.code === "NEED_LOGIN") { options.service.markNeedLogin(); return { sessions, entriesUploaded, stopped: "needLogin", errorCode: error.error.code }; }
          options.service.markRetryableFailed(error.error.code);
          return { sessions, entriesUploaded, stopped: "retryableFailed", errorCode: error.error.code };
        }
        logger.error(undefined, `skill reflow upload driver failed: ${String(error)}`);
        options.service.markRetryableFailed("IO_FAILED");
        return { sessions, entriesUploaded, stopped: "retryableFailed", errorCode: "IO_FAILED" };
      }
    },
  };
}
