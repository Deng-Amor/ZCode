import type { ChatLogsSource, ScopedRecord, SkillUsageSource } from "./executors.js";

export type NotCollectedReason = "NOT_COLLECTED";
export type NotCollectedSource<T extends ScopedRecord = ScopedRecord> =
  (ChatLogsSource<T> | SkillUsageSource<T>) & { readonly reason: NotCollectedReason };

// chat-logs：待 OQ-12 合规确认与 CLI 侧导出路径设计后实现；skill-usage：统计存储尚未落地。
export function createNotCollectedSource<T extends ScopedRecord = ScopedRecord>(): NotCollectedSource<T> {
  return { reason: "NOT_COLLECTED", async read() { return []; } };
}
