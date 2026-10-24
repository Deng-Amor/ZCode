import type { AuditTelemetryChannel } from "./schema.js";

/**
 * 管理策略位与采样门（spec §6.4 / 中台 M5-R3、M4-R6）。
 * 策略经中台配置通道下发；未下发时用客户端默认值。取舍在**入队前**决定，
 * 被丢弃的事件仅本地计数（droppedByPolicy/droppedSampled），不传明细。
 */

/** diagnostic 通道默认采样率（常数待评审，OQ-A11 / 中台限流阈值未定）。 */
export const DEFAULT_DIAGNOSTIC_SAMPLING_RATE = 0.1;

/**
 * 上报可见性（拍板 #4 / OQ-A8 已拍板）：默认甲案 silent（静默后台执行，不打扰用户）；
 * announced = 乙案（明示低调），保留为管理端策略位，客户端只执行策略位——
 * 明示的 UI 形态属产品层另行设计（spec §6.7）。
 */
export type AuditTelemetryVisibility = "silent" | "announced";

export interface AuditTelemetryManagementPolicy {
  visibility: AuditTelemetryVisibility;
  channels: {
    /** lifecycle 通道默认全量（拍板 #2 准实时；租户策略可关）。 */
    lifecycle: { enabled: boolean };
    /** diagnostic 通道批量 + 采样；租户策略可整体关闭（「仅生命周期」档）。 */
    diagnostic: { enabled: boolean; samplingRate: number };
  };
}

/** 客户端默认策略：静默（2026-10-22 A3 拍板）+ lifecycle 全量 + diagnostic 采样 0.1。 */
export const DEFAULT_AUDIT_TELEMETRY_POLICY: AuditTelemetryManagementPolicy = {
  visibility: "silent",
  channels: {
    lifecycle: { enabled: true },
    diagnostic: {
      enabled: true,
      samplingRate: DEFAULT_DIAGNOSTIC_SAMPLING_RATE,
    },
  },
};

export interface AuditTelemetryPolicyCounters {
  readonly droppedByPolicy: number;
  readonly droppedSampled: number;
}

export type AuditTelemetryPolicyVerdict =
  | "enqueue"
  | "dropped-by-policy"
  | "dropped-sampled";

export interface AuditTelemetryPolicyGate {
  /** 入队前调用；random 注入点供确定性测试，缺省 Math.random。 */
  decide(
    channel: AuditTelemetryChannel,
    random?: number,
  ): AuditTelemetryPolicyVerdict;
  counters(): AuditTelemetryPolicyCounters;
}

function validatePolicy(policy: AuditTelemetryManagementPolicy): void {
  const rate = policy.channels.diagnostic.samplingRate;
  // 采样率越界是配置错误，宁可 fail-fast 也不静默钳制（策略位可回读、可审计）。
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(
      `diagnostic samplingRate must be within [0,1], got ${String(rate)}`,
    );
  }
}

/** 策略门工厂：纯逻辑、无 IO；计数器只增不减，供验收回读（AT-7）。 */
export function createAuditTelemetryPolicyGate(
  policy: AuditTelemetryManagementPolicy = DEFAULT_AUDIT_TELEMETRY_POLICY,
): AuditTelemetryPolicyGate {
  validatePolicy(policy);
  let droppedByPolicy = 0;
  let droppedSampled = 0;
  return {
    decide(channel, random) {
      const config = policy.channels[channel];
      if (!config.enabled) {
        droppedByPolicy += 1;
        return "dropped-by-policy";
      }
      if (channel === "diagnostic") {
        const draw = random ?? Math.random();
        // 修复 TS2339：channels[channel] 的联合类型（lifecycle 档无 samplingRate）不携带该键，
        // 须在 diagnostic 字面量分支内显式取 diagnostic 档配置，让编译器按分支收窄。
        if (draw >= policy.channels.diagnostic.samplingRate) {
          droppedSampled += 1;
          return "dropped-sampled";
        }
      }
      return "enqueue";
    },
    counters() {
      return { droppedByPolicy, droppedSampled };
    },
  };
}
