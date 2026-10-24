import type { AuditTelemetryChannel } from "./schema.js";

/**
 * 上报器端口（spec §5.2 / §5.3）：**注入接口，本基础层不实现网络**（A10：出网通道
 * 属于后续卡；认证复用 CcodePlatformAuth，端点细节以配置注入，OQ-A3）。
 * 唯一出网所有者实现本接口并消费队列冻结字节；实现方不得改写 records 的
 * serializedEvent（内容冻结，spec §4 规则 3 / 中台 M4-R2）。
 */
export interface AuditTelemetryUploader {
  upload(input: {
    channel: AuditTelemetryChannel;
    records: readonly { commandId: string; serializedEvent: string }[];
  }): Promise<AuditTelemetryUploadOutcome>;
}

/** 服务端拒收原因（spec §6.5 / 中台 M4-R8 兜底）：进本地死信计数，不再重试。 */
export type AuditTelemetryRejectionReason =
  | "attribution-missing"
  | "schema-unknown"
  | "sensitive-match";

/**
 * 一次上报批的结果，分支对应 spec §4 出网调度的 alt 分支：
 * - accepted：逐条受理（幂等重放返回原结果视同受理，spec §5.2）；驱动队列 ACK 出队；
 * - rejected：拒收明细（死信，同批其余条目不受牵连）；
 * - rate-limited：留队 + 退避降速，不弃数据（§6.4）；
 * - retryable-failure：网络失败/中台不可用/超时 → 留队 + 指数退避，不改写内容不换 commandId（§6.2）；
 * - auth-required：暂停出网、队列保留、等重新登录（§6.6，认证丢失不清队列）。
 */
export type AuditTelemetryUploadOutcome =
  | { kind: "accepted"; acknowledgedCommandIds: readonly string[] }
  | {
      kind: "rejected";
      reasons: readonly {
        commandId: string;
        reason: AuditTelemetryRejectionReason;
      }[];
    }
  | { kind: "rate-limited" }
  | { kind: "retryable-failure" }
  | { kind: "auth-required" };
