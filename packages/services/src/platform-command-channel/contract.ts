import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  CommandChannelCommandEnvelope,
  CommandChannelEnvelopeBase,
  CommandChannelNoticeEnvelope,
  CommandChannelResponse,
  CommandChannelRejectionReason,
} from "./schema.js";

/**
 * platform-command-channel 模块公共契约（中台 PRD v0.2.1 §3.7 M7 / §4.7，任务卡 20261022-C4）。
 * 本文件只声明端口与结果类型；信封 strict schema 见 schema.ts，策略默认值与评估见
 * policy.ts，磁盘幂等存储实现见 store.ts，处理核心见 processor.ts。
 * 端口全部注入：本卡不含网络 transport、验签实现与密钥管理、三类指令执行体、
 * 总控更新器/专家目录刷新接线、Main 装配（后续卡）。
 */

/** 验签端口：信封签名验证（实现与密钥管理留后续卡；返回 false → INVALID_SIGNATURE）。 */
export interface CommandChannelSignatureVerifier {
  /**
   * 输入为基础信封形态（未知 type 的信封也在验签之后才判 UNKNOWN_TYPE，按任务卡
   * 20261022-C4 管线顺序）；签名覆盖的规范化字节由实现按中台契约（M6-R4 信任根体系）
   * 自行重建，端口不预设签名算法。
   */
  verify(envelope: CommandChannelEnvelopeBase): Promise<boolean>;
}

/** 指令执行结果：只有结果摘要引用；数据本体经独立上传链路回传（§4.7）。 */
export interface CommandChannelExecutionOutcome {
  readonly resultRef: string;
}

/** 指令执行端口：v1 三类指令的执行体由后续卡注入；抛错表示执行失败（不冻结幂等结果）。 */
export interface CommandChannelExecutor {
  execute(command: CommandChannelCommandEnvelope): Promise<CommandChannelExecutionOutcome>;
}

/**
 * 本地审计钩子端口（M7-R4 双向审计的客户端侧）：记录执行/拒绝/分发事件；
 * record 抛错不阻断处理（处理核心捕获后降级为 warn 日志）。
 */
export type CommandChannelAuditEvent =
  | {
      /** MALFORMED/UNKNOWN_TYPE：信封家族不可知（type 可能缺失或枚举外）。 */
      readonly kind: "envelope.rejected";
      readonly type?: string;
      readonly commandId?: string;
      readonly noticeId?: string;
      readonly reason: CommandChannelRejectionReason;
      readonly at: string;
    }
  | {
      readonly kind: "command.executed";
      readonly commandId: string;
      readonly type: string;
      readonly issuedAt: string;
      readonly resultRef: string;
      readonly at: string;
    }
  | {
      readonly kind: "command.rejected";
      readonly commandId: string;
      readonly type: string;
      readonly reason: CommandChannelRejectionReason;
      readonly at: string;
    }
  | {
      readonly kind: "notice.dispatched";
      readonly noticeId: string;
      readonly type: string;
      readonly issuedAt: string;
      readonly at: string;
    }
  | {
      readonly kind: "notice.rejected";
      readonly noticeId: string;
      readonly type: string;
      readonly reason: CommandChannelRejectionReason;
      readonly at: string;
    };

export interface CommandChannelAuditSink {
  record(event: CommandChannelAuditEvent): Promise<void>;
}

/**
 * 通告分发端口：notice 类不进命令处理（M7-R2），经本端口回调分发到既有流程
 * （总控拉取-验签-原子落地 / 专家目录刷新协商 / 策略位更新，后续卡接线）。
 * 抛错表示分发失败，向调用方传播（按序号补通告是通道层义务，M7-R1）。
 */
export interface CommandChannelNoticeSink {
  dispatch(notice: CommandChannelNoticeEnvelope): Promise<void>;
}

/**
 * 幂等命令存储端口（唯一持久化所有者，M7-R4）：commandId → 已执行结果的冻结字节；
 * 只冻结 executed 结果（拒绝不冻结：策略/时效可能变化，重放按当前护栏重判）。
 */
export interface CommandChannelCommandStore {
  /** 命中返回冻结的响应字节；未命中返回 undefined。 */
  get(commandId: string): Promise<string | undefined>;
  /** 冻结结果字节；同 commandId 已存在返回 false 且不改写原字节。 */
  freeze(commandId: string, serializedResponse: string): Promise<boolean>;
  /** 等待在途写操作收尾；不删除存储文件（跨重启保留）。 */
  dispose(): Promise<void>;
}

/**
 * 通道策略（M7-R5：租户级，可整体关通道、可单关某类指令；经 policy.update 通告由后续卡接线更新）。
 * visibility 默认甲案静默（2026-10-22 A3 拍板）：静默语义 = 不产生用户可见副作用；
 * announced（乙案明示低调）保留为管理端策略位。
 */
export interface CommandChannelPolicy {
  readonly channelEnabled: boolean;
  readonly commands: {
    readonly "command.pull_chat_logs": { readonly enabled: boolean };
    readonly "command.pull_run_logs": { readonly enabled: boolean };
    readonly "command.pull_skill_usage_stats": { readonly enabled: boolean };
  };
  readonly visibility: "silent" | "announced";
}

/** 策略门判定：两种关闭最终都映射 POLICY_DISABLED（固定原因码），细节供审计回读。 */
export type CommandChannelPolicyVerdict =
  | "allowed"
  | "channel-disabled"
  | "type-disabled";

/** scope 上限（M7-R3「拉取范围必须限定」；默认常数与校验见 processor.ts，待中台对齐）。 */
export interface CommandChannelScopeLimits {
  /** 时间段最大时窗（毫秒）。 */
  readonly maxTimeRangeMs: number;
  /** sessionId 最大长度（最小长度恒为 1：空串属 SCOPE_INVALID）。 */
  readonly maxSessionIdLength: number;
}

/** processEnvelope 的统一返回：结构化响应 + 固定键序字节（幂等重放字节一致）+ 重放标记。 */
export interface CommandChannelProcessResult {
  readonly response: CommandChannelResponse;
  readonly serializedResponse: string;
  /** true = 命中幂等存储，返回的是已冻结原结果（字节一致，未重新执行）。 */
  readonly replay: boolean;
}

export interface CommandChannelProcessor {
  processEnvelope(envelope: unknown): Promise<CommandChannelProcessResult>;
}

export interface CommandChannelProcessorOptions {
  readonly verifier: CommandChannelSignatureVerifier;
  readonly executor: CommandChannelExecutor;
  readonly noticeSink: CommandChannelNoticeSink;
  readonly auditSink: CommandChannelAuditSink;
  readonly store: CommandChannelCommandStore;
  /**
   * 本机已注册 deviceId（2026-10-27 与中台对齐，D3 定向投递的客户端侧防护）：
   * 信封验签通过后，其 deviceId（若携带）必须与本值逐字匹配，否则按
   * INVALID_SIGNATURE 拒绝——定向完整性属签名验证链，不误用其他原因码。
   * 未注册（undefined）时不比对（隔离联调允许无设备形态的信封）。
   */
  readonly expectedDeviceId?: string;
  /** 策略提供者（每次处理现取；policy.update 通告生效后的动态读数）。 */
  readonly getPolicy: () => CommandChannelPolicy;
  readonly scopeLimits?: Partial<CommandChannelScopeLimits>;
  /** 时钟注入（过期判定与审计时间戳）；缺省真实时钟。 */
  readonly now?: () => Date;
  readonly logger?: ServiceLogger;
}

/** 幂等存储按登录身份隔离的键（与 audit-telemetry 队列同款口径：tenantId+userId；
 * deviceId 可选——D3 设备定向投递时按设备隔离，重装=新 deviceId 从零）。 */
export interface CommandChannelStoreIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId?: string;
}

export interface CommandChannelDiskStoreOptions {
  readonly storageDirectory: string;
  readonly identity: CommandChannelStoreIdentity;
  readonly logger?: ServiceLogger;
}

export type {
  CommandChannelNoticeType,
  CommandChannelCommandType,
  CommandChannelKnownType,
  CommandChannelNoticeParams,
  CommandChannelTimeRange,
  CommandChannelChatLogsParams,
  CommandChannelTimeOnlyParams,
  CommandChannelEnvelopeBase,
  SkillUpdateNoticeEnvelope,
  SkillRevokeNoticeEnvelope,
  PolicyUpdateNoticeEnvelope,
  PullChatLogsCommandEnvelope,
  PullRunLogsCommandEnvelope,
  PullSkillUsageStatsCommandEnvelope,
  CommandChannelNoticeEnvelope,
  CommandChannelCommandEnvelope,
  CommandChannelEnvelope,
  CommandChannelRejectionReason,
  CommandChannelExecutedResponse,
  CommandChannelRejectedResponse,
  CommandChannelDispatchedResponse,
  CommandChannelResponse,
  ParsedCommandChannelEnvelope,
} from "./schema.js";
