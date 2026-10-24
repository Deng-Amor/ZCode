import type {
  ManagedSkillEnvelope,
  VerifiedManagedSkillBundle,
} from "../managed-skills/index.js";

// ============================================================
// Expert skill distribution contracts
// 中台专家 skill 按需下发的客户端契约（docs/specs/ccode-expert-skills-distribution.md §5.4）
// ============================================================

/** 目录条目：仅元数据，不携带任何文件正文（中台 PRD M2-R2/M2-R4）。 */
export interface ExpertSkillCatalogEntry {
  readonly skillId: string;
  readonly name: string;
  /** 领域标签，供命中判定（schema 粒度待中台定，spec OQ-6）。 */
  readonly domainTags: readonly string[];
  readonly summary: string;
  /** 每 skillId 单调递增正整数（payload 内字段）。 */
  readonly version: number;
  /** payload 原始字节的 SHA-256 hex；缓存内容寻址键与协商参数（spec §6.2）。 */
  readonly digest: string;
  /** 适用范围标识（中台 PRD M2-R1；粒度待中台定）。 */
  readonly scopeRef: string;
}

/** digest 协商命中：中台内容未变化，轻量响应不重传正文（中台 PRD M2-R4）。 */
export interface NotModified {
  readonly notModified: true;
  /** 命中协商的 digest 回显，供调用方复核。 */
  readonly digest?: string;
}

export interface ExpertSkillSearchQuery {
  readonly domainTags?: readonly string[];
  readonly keywords?: readonly string[];
}

export interface ExpertSkillGetOptions {
  /** 已缓存 digest（If-None-Match 语义）；内容未变化时返回 NotModified。 */
  readonly cachedDigest?: string;
}

/**
 * 专家 skill 传输端口：HTTP 与 MCP 双实现的统一抽象（spec §6.1，通道由中台 OQ-4 定）。
 * 通道只承担运输与授权；信任根内置、验签由调用方独立执行，不信任传输层即信
 * （PRD §4.2 共通硬要求 1）。identity 为登录身份键（账号/tenant 隔离键，spec §5.2），
 * 由认证所有者提供；本端口不持有凭据。
 */
export interface ExpertSkillTransport {
  /** 检索目录：仅元数据条目，供命中判定与版本协商。 */
  search(
    identity: string,
    query: ExpertSkillSearchQuery,
    signal?: AbortSignal,
  ): Promise<ExpertSkillCatalogEntry[]>;
  /** 获取签名包；digest 协商命中时返回轻量 NotModified，不重传正文。 */
  get(
    identity: string,
    skillId: string,
    options?: ExpertSkillGetOptions,
    signal?: AbortSignal,
  ): Promise<ManagedSkillEnvelope | NotModified>;
}

/**
 * 缓存条目状态（spec §5.2）：
 * available=可加载；revoked=中台撤销/适用范围收回，禁止加载且不静默回退缓存；
 * versionRejected=低于信任清单 minimumVersion（VERSION_REJECTED 语义），等待重新获取。
 */
export type ExpertSkillCacheEntryState = "available" | "revoked" | "versionRejected";

export interface ExpertSkillCacheEntry {
  readonly skillId: string;
  readonly name: string;
  readonly version: number;
  /** payload 原始字节的 SHA-256 hex；put 时与验签产物绑定（见 ExpertSkillVerifiedInput）。 */
  readonly digest: string;
  /** 已物化文件目录；references 相对路径解析必须落在该目录内（spec §6.5/OQ-8）。 */
  readonly filesBaseDir: string;
  readonly cachedAt: number;
  /** 有效期（epoch ms）；null 表示无固定有效期、待协商刷新。届满不等于不可加载（spec §6.3）。 */
  readonly validUntil: number | null;
  readonly state: ExpertSkillCacheEntryState;
}

/**
 * put 输入：验签产物 + payload digest。digest 是 payload 原始字节的 SHA-256
 * （与 grant/目录条目同源计算，参照 confidential-controller application.ts）；
 * 验签后 payload 原始字节不再保留，无法从 VerifiedManagedSkillBundle 重建，
 * 必须显式传递——这是对 spec §5.4 草案 put(identity, verified) 签名的落地修正。
 */
export interface ExpertSkillVerifiedInput {
  readonly verified: VerifiedManagedSkillBundle;
  readonly payloadDigest: string;
}

export type ExpertSkillCacheErrorCode =
  | "INVALID_INPUT"
  | "CAPACITY_EXCEEDED"
  | "HASH_MISMATCH"
  | "CACHE_CORRUPT"
  | "IO_FAILED";

/** 缓存负向事件按固定错误码抛出，供审计台账回读（spec §6.6）。 */
export class ExpertSkillCacheError extends Error {
  constructor(
    public readonly code: ExpertSkillCacheErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExpertSkillCacheError";
  }
}

/**
 * 专家 skill 缓存存储端口：缓存区唯一写入者（spec §5.1），按登录身份隔离（spec §5.2）。
 * put 原子替换（temp + rename，失败保留旧有效版本）；get 返回条目前逐文件 sha256 复验，
 * 篡改按缓存损坏抛 ExpertSkillCacheError（HASH_MISMATCH/CACHE_CORRUPT），被篡改内容
 * 不得进入会话上下文。 revoked 条目仍返回（state 标记），由调用方拒绝加载。
 */
export interface ExpertSkillCacheStore {
  get(identity: string, skillId: string): Promise<ExpertSkillCacheEntry | undefined>;
  put(identity: string, input: ExpertSkillVerifiedInput): Promise<void>;
  markRevoked(identity: string, skillId: string): Promise<void>;
  clearIdentity(identity: string): Promise<void>;
}
