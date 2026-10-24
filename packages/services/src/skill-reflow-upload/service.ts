// ============================================================
// skill-reflow-upload 服务编排（spec §5.1 单一所有者 / §6.1 触发 / §6.5 状态面）
// ============================================================
// - 本服务是上传队列与去重账本的唯一写入者；触发器、扫描器、上传器（后续卡）是
//   其内部阶段，不是独立写路径（spec §5.1）。
// - 每日首启触发：日界判定幂等（lastTriggerDate，本地时区自然日）；判定通过先落
//   持久化标记再扫描——进程崩溃不造成当日重复会话（spec §6.1），入队幂等（同 key
//   同 digest 至多一条）进一步保证崩溃恢复零冗余。
// - 本卡为基础层：不含网络上传器；sending/needLogin/retryableFailed 状态由后续
//   上传器卡经 markSending/markNeedLogin/markRetryableFailed 驱动。
// - 状态面只读、不含内容；任何失败不阻塞调用方关键路径（异常内化为状态与错误码）。

import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  SkillReflowDedupLedger,
  SkillReflowErrorCode,
  SkillReflowError,
  SkillReflowRootProvider,
  SkillReflowScanResult,
  SkillReflowSessionReceipt,
  SkillReflowStatus,
  SkillReflowStatusState,
  SkillReflowTriggerScheduler,
  SkillReflowUploadQueue,
} from "./contract.js";
import { scanSkillReflowRoots } from "./scanner.js";
import {
  createSkillReflowStateFile,
  type SkillReflowPersistedState,
} from "./status.js";
import { localDayKey, millisecondsUntilNextLocalMidnight, shouldTriggerDailyScan } from "./trigger.js";

export interface SkillReflowUploadServiceOptions {
  readonly rootProvider: SkillReflowRootProvider;
  readonly ledger: SkillReflowDedupLedger;
  readonly queue: SkillReflowUploadQueue;
  /** lastTriggerDate / lastSuccessAt 持久化目录（CCode 私有数据目录，spec §5.1）。 */
  readonly stateDirectory: string;
  /** 触发器调度端口（注入，不实现定时；缺省不排程，仅手动触发可用）。 */
  readonly scheduler?: SkillReflowTriggerScheduler;
  readonly now?: () => Date;
  readonly logger?: ServiceLogger;
  readonly onTriggerSession?: (outcome: SkillReflowTriggerOutcome) => void;
}

export type SkillReflowTriggerOutcome = {
  readonly triggered: boolean;
  readonly reason: "newDay" | "alreadyTriggeredToday" | "scanFailed";
  readonly session?: {
    readonly scanned: number;
    readonly queued: number;
    readonly dedupSkipped: number;
    readonly optOutSkipped: number;
    readonly rangeExcluded: number;
  };
  readonly error?: SkillReflowError;
};

export interface SkillReflowUploadService {
  /** 每日首启触发（幂等）：日界判定 → 扫描 → 账本去重 → 入队 → 账本清理。 */
  runDailyFirstLaunchTrigger(): Promise<SkillReflowTriggerOutcome>;
  /** 按「下一个本地自然日零点」排程下一次触发（经注入的调度端口；spec §6.1）。 */
  armDailyTrigger(): void;
  /** 消费中台条目级回执（M3-R8）：回写账本、出队、更新计数（上传器卡调用）。 */
  recordReceipt(receipt: SkillReflowSessionReceipt): Promise<void>;
  markSending(): void;
  markNeedLogin(): void;
  markRetryableFailed(code: SkillReflowErrorCode): void;
  markDone(): void;
  getStatus(): SkillReflowStatus;
  dispose(): Promise<void>;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

/** 创建回流上传服务（队列与账本的唯一写入者）。 */
export function createSkillReflowUploadService(
  options: SkillReflowUploadServiceOptions,
): SkillReflowUploadService {
  const logger = options.logger ?? createServiceLogger("skill-reflow-upload");
  const now = options.now ?? (() => new Date());
  const stateFile = createSkillReflowStateFile({
    storageDirectory: options.stateDirectory,
    logger,
  });
  let state: SkillReflowStatusState = "idle";
  let queueDepth = 0;
  let persistedState: SkillReflowPersistedState = {};
  const counters = {
    scanned: 0,
    uploaded: 0,
    dedupSkipped: 0,
    optOutSkipped: 0,
    rangeExcluded: 0,
    filterHit: 0,
    failed: 0,
  };
  let lastError: SkillReflowError | undefined;

  function notifyTriggerSession(outcome: SkillReflowTriggerOutcome): void {
    try {
      options.onTriggerSession?.(outcome);
    } catch (error) {
      // 回调仅观察，失败不阻塞 spec §6.4。
      logger.warn(undefined, `skill reflow trigger observer failed: ${String(error)}`);
    }
  }

  async function applyScanResult(result: SkillReflowScanResult): Promise<{
    queued: number;
    dedupSkipped: number;
  }> {
    let queued = 0;
    let dedupSkipped = 0;
    const queuedAt = nowIso(now);
    for (const entry of result.entries) {
      const accepted = await options.ledger.getAccepted(entry.key);
      if (accepted && accepted.contentDigest === entry.contentDigest) {
        // 内容不变零入队（本地账本第一层去重，spec §6.3；验收场景 2）。
        dedupSkipped += 1;
        continue;
      }
      await options.queue.enqueue({
        key: entry.key,
        relativePath: entry.relativePath,
        name: entry.name,
        sourceType: entry.sourceType,
        contentDigest: entry.contentDigest,
        lastModified: entry.lastModified,
        queuedAt,
        attempts: 0,
        rootId: entry.rootId,
        directoryPath: entry.directoryPath,
      });
      queued += 1;
    }
    counters.scanned += result.counters.scanned;
    counters.optOutSkipped += result.counters.optOutSkipped;
    counters.rangeExcluded += result.counters.rangeExcluded;
    counters.dedupSkipped += dedupSkipped;
    // 本地删除 skill → 账本条目本地过期清理（spec §6.3；无 tombstone、无远端删除通告）。
    const presentKeys = result.entries.map((entry) => entry.key);
    await options.ledger.pruneAbsent(presentKeys);
    return { queued, dedupSkipped };
  }

  return {
    async runDailyFirstLaunchTrigger() {
      try {
        persistedState = await stateFile.getState();
        if (!shouldTriggerDailyScan(persistedState.lastTriggerDate, now())) {
          // 同日重启不重复扫描（验收场景 8；spec §6.1 源 1 判定）。
          return { triggered: false, reason: "alreadyTriggeredToday" };
        }
        // 先落日界标记再扫描：崩溃恢复不产生当日重复会话；入队幂等兜底。
        const dayKey = localDayKey(now());
        await stateFile.markTriggered(dayKey);
        persistedState = { ...persistedState, lastTriggerDate: dayKey };
        state = "scanning";
        const roots = await options.rootProvider.listRoots();
        const result = await scanSkillReflowRoots(roots, { logger });
        const { queued, dedupSkipped } = await applyScanResult(result);
        queueDepth = (await options.queue.take(Number.MAX_SAFE_INTEGER)).length;
        if (queued > 0) {
          state = "queued";
        } else {
          state = "done";
          // 修复：markSuccess 只落盘，内存投影 persistedState 不同步会使只读状态面
          // 的 lastSuccessAt 在重启前恒为 undefined（spec §6.5 状态面须即时可回读）。
          const successAt = nowIso(now);
          await stateFile.markSuccess(successAt);
          persistedState = { ...persistedState, lastSuccessAt: successAt };
        }
        logger.info(
          undefined,
          `skill reflow trigger session: scanned=${result.counters.scanned} queued=${queued} dedup=${dedupSkipped} optOut=${result.counters.optOutSkipped} rangeExcluded=${result.counters.rangeExcluded}`,
        );
        const outcome = {
          triggered: true,
          reason: "newDay",
          session: {
            scanned: result.counters.scanned,
            queued,
            dedupSkipped,
            optOutSkipped: result.counters.optOutSkipped,
            rangeExcluded: result.counters.rangeExcluded,
          },
        } as const;
        notifyTriggerSession(outcome);
        return outcome;
      } catch (error) {
        // 触发链路任何异常内化为可观察状态，不抛给调用方（spec §6.4 绝不阻塞）。
        counters.failed += 1;
        state = "retryableFailed";
        lastError = { code: "SCAN_FAILED", at: nowIso(now) };
        logger.error(undefined, `skill reflow trigger failed: ${String(error)}`);
        const outcome = { triggered: true, reason: "scanFailed" as const, error: lastError };
        notifyTriggerSession(outcome);
        return outcome;
      }
    },
    armDailyTrigger() {
      if (!options.scheduler) {
        logger.debug(undefined, "skill reflow: no scheduler injected; daily trigger not armed");
        return;
      }
      // 修复：排程时刻改用注入时钟（与日界判定同一时间源）。原实现用 Date.now()，
      // 测试注入固定 now() 时会得到漂移的 dueAt，且两个时间源在真实运行中也可能
      // 因时钟回拨相互矛盾（spec §6.1：日界判定与排程必须基于同一时钟语义）。
      const dueAt = now().getTime() + millisecondsUntilNextLocalMidnight(now());
      options.scheduler.schedule(dueAt, () => {
        void this.runDailyFirstLaunchTrigger();
      });
    },
    async recordReceipt(receipt) {
      const pending = await options.queue.take(Number.MAX_SAFE_INTEGER);
      const entry = pending.find((item) => item.key === receipt.key);
      if (receipt.outcome === "filterHit") {
        // 过滤命中为终态，不重试、不回写账本（服务端已受理处置，spec §6.4）。
        counters.filterHit += 1;
        await options.queue.settle([receipt.key]);
        queueDepth = Math.max(0, queueDepth - 1);
        return;
      }
      if (entry) {
        // accepted / dedupHit 均按已受理回写账本（次日增量依据，spec §四 阶段 6）。
        await options.ledger.recordAccepted(
          receipt.key,
          entry.contentDigest,
          receipt.settledAt,
        );
        counters.uploaded += 1;
      }
      const settled = await options.queue.settle([receipt.key]);
      if (settled > 0) {
        queueDepth = Math.max(0, queueDepth - settled);
      }
    },
    markSending() {
      state = "sending";
    },
    markNeedLogin() {
      state = "needLogin";
    },
    markRetryableFailed(code) {
      state = "retryableFailed";
      lastError = { code, at: nowIso(now) };
    },
    markDone() {
      state = "done";
    },
    getStatus() {
      return {
        state,
        queueDepth,
        ...(persistedState.lastTriggerDate ? { lastTriggerDate: persistedState.lastTriggerDate } : {}),
        ...(persistedState.lastSuccessAt ? { lastSuccessAt: persistedState.lastSuccessAt } : {}),
        counters: { ...counters },
        ...(lastError ? { lastError } : {}),
      };
    },
    async dispose() {
      options.scheduler?.cancel();
      await stateFile.dispose();
    },
  };
}
