import type {
  CommandChannelPolicy,
  CommandChannelPolicyVerdict,
} from "./contract.js";
import type { CommandChannelCommandType } from "./schema.js";

/**
 * 通道策略默认值与策略门评估（M7-R5，纯逻辑、无 IO）。
 * 策略可配置注入：装配方（后续卡）以 getPolicy 提供者接入，policy.update 通告
 * 生效后读数即时变化；本文件不持有任何可变状态。
 */

/**
 * 客户端默认策略：
 * - 通道默认开；pull_run_logs / pull_skill_usage_stats 默认开（P2 分期交付面）；
 * - pull_chat_logs 默认**关**：P2 分期明确「依赖 OQ-12 合规确认后启用」，
 *   合规确认前客户端不主动启用聊天日志拉取；
 * - visibility 默认 silent：2026-10-22 A3 拍板甲案静默，语义 = 不产生用户可见副作用。
 */
export const DEFAULT_COMMAND_CHANNEL_POLICY: CommandChannelPolicy = {
  channelEnabled: true,
  commands: {
    "command.pull_chat_logs": { enabled: false },
    "command.pull_run_logs": { enabled: true },
    "command.pull_skill_usage_stats": { enabled: true },
  },
  visibility: "silent",
};

/**
 * 策略门评估：通道总开关优先于按类型开关；两类关闭对固定原因码都是 POLICY_DISABLED
 * （M7-R5），verdict 细分仅供本地审计与测试回读。
 */
export function evaluateCommandChannelPolicy(
  policy: CommandChannelPolicy,
  type: CommandChannelCommandType,
): CommandChannelPolicyVerdict {
  if (!policy.channelEnabled) return "channel-disabled";
  const entry = policy.commands[type];
  // commands 键集与指令枚举同源（COMMAND_CHANNEL_COMMAND_TYPES），缺键属装配缺陷，按关闭处理更安全。
  if (!entry || !entry.enabled) return "type-disabled";
  return "allowed";
}
