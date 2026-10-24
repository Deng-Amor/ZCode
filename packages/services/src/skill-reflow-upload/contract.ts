// ============================================================
// skill-reflow-upload 公共契约（docs/specs/ccode-skill-sync-upload.md，2026-10-22 定稿）
// ============================================================
// 本文件只声明端口与类型；实现单向导入契约（禁止契约↔实现循环依赖，同批
// audit-telemetry 的移型教训见其 contract.ts L63-L66 注释）：
// - 扫描器实现见 scanner.ts（只读文件系统）；
// - 保留名 / expert: 前缀镜像判定见 identity.ts（权威在 CLI contracts，services 不反向依赖 apps）；
// - 去重账本持久化见 ledger.ts；上传队列持久化见 queue.ts；
// - 状态文件与日界判定见 status.ts / trigger.ts；服务编排见 service.ts。
// 本卡为基础层：不含网络上传器实现，不做 Main/启动接线。

/** 扫描根的来源（镜像 apps/zcode-cli/packages/contracts SkillSource 子集，见 identity.ts 说明）。 */
export type SkillReflowRootSource =
  | "agents"
  | "zcode"
  | "bundled"
  | "plugin"
  | "remote";

/** 扫描根身份范围（决定条目 sourceType；extraRoots 等归属不明根的排除归装配层 OQ-5）。 */
export type SkillReflowRootScope = "user" | "project";

/**
 * 回流扫描根（端口注入形态）。roots 解析权威在 apps/zcode-cli/packages/adapters
 * 的 resolveDefaultSkillRoots（spec E1/E6）；services 不得反向依赖 apps，故由装配层
 * （后续集成卡）解析后注入。id 为装配层分配的稳定根标识（参与条目 key，避免同
 * scope 多根的 key 碰撞，如 ~/.zcode/skills 与 ~/.agents/skills 同为 user scope）。
 */
export interface SkillReflowScanRoot {
  readonly id: string;
  readonly path: string;
  readonly scope: SkillReflowRootScope;
  readonly source: SkillReflowRootSource;
}

/** 条目来源类型（spec §5.2 拍板第 5 条「来源类型」：user=用户根，workspace=工作区根）。 */
export type SkillReflowSourceType = "user" | "workspace";

/** 队列/账本通用的固定错误码（spec §6.4：不用超时掩盖同步问题，失败必须可分类回读）。 */
export type SkillReflowErrorCode =
  | "NEED_LOGIN"
  | "AUTH_REJECTED"
  | "NETWORK_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PLATFORM_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "SCHEMA_REJECTED"
  | "IO_FAILED"
  | "SCAN_FAILED";

export interface SkillReflowError {
  readonly code: SkillReflowErrorCode;
  /** ISO 8601。 */
  readonly at: string;
}

/** 扫描产出的待判定条目（尚未与账本比对；内容不驻留内存，上传器后续按路径重读）。 */
export interface SkillReflowScanEntry {
  /** 去重账本主键：`scope/rootId/relativePath`（spec §5.4 key 语义 + 根标识消歧）。 */
  readonly key: string;
  readonly rootId: string;
  readonly sourceType: SkillReflowSourceType;
  /** 相对扫描根的条目路径，"/" 分隔（spec §5.2 本地 skill 标识提案，OQ-1）。 */
  readonly relativePath: string;
  /** 条目目录绝对路径；上传器按此重读内容文件（队列条目携带，见 SkillReflowEntry）。 */
  readonly directoryPath: string;
  /** frontmatter name（回退目录名），读取范式同 settings-sync readSkillMetadataFromMarkdown。 */
  readonly name: string;
  /** frontmatter description，缺省省略（spec §5.2 可选描述）。 */
  readonly description?: string;
  /** SHA-256 hex；规范化基准未冻结（OQ-2），当前按原始字节逐文件计算，见 scanner.ts 常量。 */
  readonly contentDigest: string;
  /** 条目级最近修改时间（纳入文件 mtime 最大值，ISO 8601；spec §5.2 mtime）。 */
  readonly lastModified: string;
}

/** 扫描会话结果（只含计数与条目清单，不含退出区条目内容与路径明细，spec §6.2）。 */
export interface SkillReflowScanResult {
  /** 按 key 排序的稳定顺序（会话摘要/入队顺序确定性）。 */
  readonly entries: readonly SkillReflowScanEntry[];
  readonly counters: {
    /** 命中待传判定的条目数（不含互斥/退出跳过）。 */
    readonly scanned: number;
    /** 命中 .no-upload / private/ 退出区跳过的条目数（仅计数，不记内容）。 */
    readonly optOutSkipped: number;
    /** 范围互斥排除的条目数（保留名 / expert: 前缀 / remote|plugin|bundled 来源）。 */
    readonly rangeExcluded: number;
  };
}

/**
 * 上传队列条目（spec §5.4 草案 + 装配定位扩展 rootId/directoryPath：上传器重读内容
 * 所需，二者不进 payload 契约则后续卡无法定位本地文件）。
 */
export interface SkillReflowEntry {
  readonly key: string;
  readonly relativePath: string;
  readonly name: string;
  readonly sourceType: SkillReflowSourceType;
  readonly contentDigest: string;
  readonly lastModified: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly lastError?: SkillReflowError;
  readonly rootId: string;
  readonly directoryPath: string;
}

/** 中台条目级回执（M3-R8）消费后的本地终态（本卡只定义类型，消费归上传器卡）。 */
export interface SkillReflowSessionReceipt {
  readonly key: string;
  readonly outcome: "accepted" | "dedupHit" | "filterHit";
  /** filterHit 时中台回告的命中类别（本地只留类别，不回传被滤内容）。 */
  readonly filterCategory?: string;
  readonly settledAt: string;
}

export type SkillReflowStatusState =
  | "idle"
  | "scheduled"
  | "scanning"
  | "queued"
  | "sending"
  | "needLogin"
  | "retryableFailed"
  | "done";

export interface SkillReflowStatusCounters {
  readonly scanned: number;
  readonly uploaded: number;
  readonly dedupSkipped: number;
  readonly optOutSkipped: number;
  readonly rangeExcluded: number;
  readonly filterHit: number;
  readonly failed: number;
}

/** 只读状态面（Renderer/诊断可见，不含内容；spec §6.5）。 */
export interface SkillReflowStatus {
  readonly state: SkillReflowStatusState;
  readonly queueDepth: number;
  readonly lastTriggerDate?: string;
  readonly lastSuccessAt?: string;
  readonly counters: SkillReflowStatusCounters;
  readonly lastError?: SkillReflowError;
}

/** 扫描根提供者端口（roots 解析在 apps 层，装配见后续集成卡；spec E1）。 */
export interface SkillReflowRootProvider {
  listRoots(): Promise<readonly SkillReflowScanRoot[]>;
}

/** 去重账本端口（持久化、身份无关全局；唯一所有者为 SkillReflowUploadService）。 */
export interface SkillReflowDedupLedger {
  getAccepted(key: string): Promise<{ contentDigest: string; uploadedAt: string } | undefined>;
  /** 成功受理（accepted/dedupHit 回执）后回写；内容不变跳过由此判定（spec §6.3）。 */
  recordAccepted(key: string, contentDigest: string, uploadedAt: string): Promise<void>;
  /** 清理当前扫描面已不存在的 key（本地删除 skill 后账本条目本地过期，spec §6.3）；返回清理条数。 */
  pruneAbsent(presentKeys: readonly string[]): Promise<number>;
}

/** 上传队列端口（持久化、待传条目唯一持有者；进程重启恢复，spec §6.4）。 */
export interface SkillReflowUploadQueue {
  /** 同 key 同 digest 至多一条（幂等）；同 key 变更 digest 替换旧条目并重置重试计数。 */
  enqueue(entry: SkillReflowEntry): Promise<void>;
  /** 按入队顺序取最老的至多 limit 条；不出队。 */
  take(limit: number): Promise<readonly SkillReflowEntry[]>;
  /** 按回执终态出队（accepted/dedupHit/filterHit 均为终态）；返回实际出队条数。 */
  settle(keys: readonly string[]): Promise<number>;
  /** 可重试失败：attempts+1 并记录固定错误码；未知 key 忽略（debug 日志）。 */
  fail(key: string, code: SkillReflowErrorCode, at: string): Promise<void>;
}

/** 触发器调度端口（注入，不实现定时；实际定时器由 Main 装配卡提供）。 */
export interface SkillReflowTriggerScheduler {
  /** 在 dueAt（epoch ms）触发一次 fire；重复调用覆盖前次排程。 */
  schedule(dueAt: number, fire: () => void): void;
  cancel(): void;
}

/** 可注入时钟（测试注入固定时间；生产默认 Date.now）。 */
export interface SkillReflowClock {
  now(): Date;
}
