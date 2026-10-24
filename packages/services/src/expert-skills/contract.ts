import type { ExpertSkillCacheStore } from "@zcode/shared/expert-skills";

/**
 * 缓存存储配置（spec §5.2：缓存键与淘汰策略由客户端定）。
 * store 假定单进程唯一写入者（spec §5.1）：所有变更在进程内全局串行，
 * index.json 走 temp+rename 原子写入、不加跨进程文件锁。
 */
export interface ExpertSkillCacheStoreOptions {
  /** 缓存区根目录（CCode 私有数据目录下的专家缓存区）；身份键经 sha256 摘要后作子目录名。 */
  baseDir: string;
  /** 全局条目数上限（跨身份 LRU，含其他身份条目）；默认 32。 */
  maxEntries?: number;
  /** 全局缓存总字节上限（按物化文件内容计）；默认 64 MiB。单个条目超限直接拒绝写入。 */
  maxTotalBytes?: number;
  /** 新条目默认有效期；默认 null（无固定有效期，待协商刷新）。 */
  defaultTtlMs?: number | null;
  /** 可注入时钟，测试用。 */
  now?: () => number;
}

export type {
  ExpertSkillCacheEntry,
  ExpertSkillCacheEntryState,
  ExpertSkillCacheStore,
  ExpertSkillVerifiedInput,
} from "@zcode/shared/expert-skills";
