import {
  createServiceLogger,
  type ServiceLogger,
} from "#src/logger/serviceLogger.js";
import {
  COMMAND_CHANNEL_COMMAND_TYPES,
  CommandChannelValidationError,
  formatCommandChannelTimestamp,
  parseCommandChannelEnvelope,
  serializeCommandChannelResponse,
  type CommandChannelCommandEnvelope,
  type CommandChannelRejectedResponse,
} from "./schema.js";
import type {
  CommandChannelAuditEvent,
  CommandChannelPolicy,
  CommandChannelPolicyVerdict,
  CommandChannelProcessResult,
  CommandChannelProcessor,
  CommandChannelProcessorOptions,
  CommandChannelRejectionReason,
  CommandChannelResponse,
  CommandChannelScopeLimits,
} from "./contract.js";
import { evaluateCommandChannelPolicy } from "./policy.js";

/**
 * 处理核心（任务卡 20261022-C4 管线，顺序为拍板口径）：
 *
 * 指令：schema（MALFORMED）→ 验签（INVALID_SIGNATURE）→ 过期（EXPIRED）→
 *       类型白名单（UNKNOWN_TYPE，双保险）→ 策略门（POLICY_DISABLED）→
 *       scope 校验（SCOPE_INVALID）→ 幂等检查（重放返回原结果字节）→ 执行端口
 *       → executed + 审计。
 *       注意 1：未知 type 的信封穿过基础 schema，在验签与过期之后才判 UNKNOWN_TYPE
 *       （M7-R3 / S11-d：伪造 `exec` 回 UNKNOWN_TYPE；若同时验签失败则按管线顺序回
 *       INVALID_SIGNATURE）。
 *       注意 2：过期判定先于幂等命中（按任务卡管线顺序），过期重放回 EXPIRED 而非原结果。
 *
 * 通告：schema → 验签 → 分发端口（不进命令处理，M7-R2）。通告不做过期/策略/幂等：
 * 按序号补取是通道义务（M7-R1），版本单调性归下游所有者（总控更新器/专家目录/策略位）。
 *
 * 审计：每条终态（executed/rejected/dispatched）都经审计钩子留痕（M7-R4 客户端侧）；
 * 审计 sink 抛错降级为 warn 日志，不阻断响应返回。执行端口抛错向调用方传播且
 * 不冻结幂等结果（失败不是终态，可重试）。
 */

/** scope 上限默认值（M7-R3「拉取范围必须限定」；具体数值待中台对齐后调整）。 */
export const DEFAULT_COMMAND_CHANNEL_SCOPE_LIMITS: CommandChannelScopeLimits = {
  // 7 天时窗上限：覆盖中台常规补拉需求，同时阻断全量历史拖取。
  maxTimeRangeMs: 7 * 24 * 60 * 60 * 1000,
  maxSessionIdLength: 256,
};

// 控制字符（C0/C1/DEL）：用 Unicode 属性 \p{Cc} 等价表达 [\u0000-\u001f\u007f-\u009f]，
// 避免 no-control-regex 警告（本卡禁用一切 lint disable，语义不变）。
const CONTROL_CHARACTERS = /\p{Cc}/u;

function timeRangeScopeError(
  from: string,
  to: string,
  limits: CommandChannelScopeLimits,
): string | undefined {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!(fromMs < toMs)) return "timeRange from must be strictly before to";
  if (toMs - fromMs > limits.maxTimeRangeMs) {
    return `timeRange window exceeds maxTimeRangeMs=${String(limits.maxTimeRangeMs)}`;
  }
  return undefined;
}

/** scope 校验（纯函数）：返回错误描述表示 SCOPE_INVALID；undefined 表示通过。 */
export function validateCommandChannelScope(
  envelope: CommandChannelCommandEnvelope,
  limits: CommandChannelScopeLimits,
): string | undefined {
  if (envelope.type === "command.pull_chat_logs") {
    const { sessionId, timeRange } = envelope.params.scope;
    // 至少一个限定必须存在：无界拉取违反 M7-R6「拉取范围必须限定」。
    if (sessionId === undefined && timeRange === undefined) {
      return "chat logs scope requires sessionId or timeRange";
    }
    if (sessionId !== undefined) {
      // sessionId 格式/长度是 scope 语义（非结构错误）：越界回 SCOPE_INVALID 而非 MALFORMED。
      if (sessionId.length < 1 || sessionId.length > limits.maxSessionIdLength) {
        return `sessionId length must be within [1,${String(limits.maxSessionIdLength)}]`;
      }
      if (CONTROL_CHARACTERS.test(sessionId)) {
        return "sessionId must not contain control characters";
      }
    }
    if (timeRange !== undefined) {
      return timeRangeScopeError(timeRange.from, timeRange.to, limits);
    }
    return undefined;
  }
  const { timeRange } = envelope.params.scope;
  return timeRangeScopeError(timeRange.from, timeRange.to, limits);
}

export function createCommandChannelProcessor(
  options: CommandChannelProcessorOptions,
): CommandChannelProcessor {
  const logger: ServiceLogger =
    options.logger ?? createServiceLogger("platform-command-channel");
  const limits: CommandChannelScopeLimits = {
    ...DEFAULT_COMMAND_CHANNEL_SCOPE_LIMITS,
    ...options.scopeLimits,
  };
  const now = options.now ?? (() => new Date());

  async function recordAudit(event: CommandChannelAuditEvent): Promise<void> {
    try {
      await options.auditSink.record(event);
    } catch (error) {
      // 审计钩子失败不阻断处理（响应仍须回传中台），降级为本地 warn 留痕。
      logger.warn(undefined, "command channel audit sink failed", error);
    }
  }

  async function reject(
    reason: CommandChannelRejectionReason,
    identity: {
      auditKind: "envelope.rejected" | "command.rejected" | "notice.rejected";
      type?: string;
      commandId?: string;
      noticeId?: string;
    },
  ): Promise<CommandChannelProcessResult> {
    const response: CommandChannelRejectedResponse = {
      status: "rejected",
      ...(identity.commandId === undefined
        ? {}
        : { commandId: identity.commandId }),
      ...(identity.noticeId === undefined
        ? {}
        : { noticeId: identity.noticeId }),
      reason,
    };
    await recordAudit({
      kind: identity.auditKind,
      ...(identity.type === undefined ? {} : { type: identity.type }),
      ...(identity.commandId === undefined
        ? {}
        : { commandId: identity.commandId }),
      ...(identity.noticeId === undefined
        ? {}
        : { noticeId: identity.noticeId }),
      reason,
      at: formatCommandChannelTimestamp(now()),
    } as CommandChannelAuditEvent);
    return {
      response,
      serializedResponse: serializeCommandChannelResponse(response),
      replay: false,
    };
  }

  async function processCommand(
    envelope: CommandChannelCommandEnvelope,
  ): Promise<CommandChannelProcessResult> {
    // 类型白名单双保险：parseCommandChannelEnvelope 已保证 kind=command 必属枚举内，
    // 此检查防御未来绕过两段式解析的调用路径（M7-R3 未知类型必须 UNKNOWN_TYPE）。
    if (
      !(COMMAND_CHANNEL_COMMAND_TYPES as readonly string[]).includes(
        envelope.type,
      )
    ) {
      return reject("UNKNOWN_TYPE", {
        auditKind: "envelope.rejected",
        type: envelope.type,
        commandId: envelope.commandId,
      });
    }
    const policy: CommandChannelPolicy = options.getPolicy();
    const verdict: CommandChannelPolicyVerdict = evaluateCommandChannelPolicy(
      policy,
      envelope.type,
    );
    if (verdict !== "allowed") {
      // 通道总开关与按类型开关（M7-R5）对固定原因码同为 POLICY_DISABLED。
      return reject("POLICY_DISABLED", {
        auditKind: "command.rejected",
        type: envelope.type,
        commandId: envelope.commandId,
      });
    }
    const scopeError = validateCommandChannelScope(envelope, limits);
    if (scopeError !== undefined) {
      logger.debug(undefined, `command scope rejected: ${scopeError}`);
      return reject("SCOPE_INVALID", {
        auditKind: "command.rejected",
        type: envelope.type,
        commandId: envelope.commandId,
      });
    }
    // 幂等检查（M7-R4）：命中已冻结结果时原样返回（字节一致），不重新执行、不改写。
    const frozenResponse = await options.store.get(envelope.commandId);
    if (frozenResponse !== undefined) {
      logger.debug(
        undefined,
        `command replay served from frozen result: commandId=${envelope.commandId}`,
      );
      return {
        response: JSON.parse(frozenResponse) as CommandChannelResponse,
        serializedResponse: frozenResponse,
        replay: true,
      };
    }
    // 执行端口（v1 三类指令执行体后续卡注入）。抛错 = 非终态：向调用方传播且不冻结。
    const outcome = await options.executor.execute(envelope);
    if (typeof outcome.resultRef !== "string" || outcome.resultRef.length === 0) {
      // 执行体返回空 resultRef 属端口契约违约：按执行失败处理（不冻结、不回 executed）。
      throw new Error(
        "command channel executor returned an empty resultRef; refusing to freeze an executed response",
      );
    }
    const response: CommandChannelResponse = {
      status: "executed",
      commandId: envelope.commandId,
      resultRef: outcome.resultRef,
    };
    const serializedResponse = serializeCommandChannelResponse(response);
    const frozen = await options.store.freeze(
      envelope.commandId,
      serializedResponse,
    );
    if (!frozen) {
      // 并发竞态下已被冻结：读回原结果返回（名义以先冻结者为准，不改写）。
      const winner = await options.store.get(envelope.commandId);
      if (winner !== undefined) {
        return {
          response: JSON.parse(winner) as CommandChannelResponse,
          serializedResponse: winner,
          replay: true,
        };
      }
      // freeze 失败且读不回原结果：属存储异常，按执行失败传播（不回 executed 以免未冻结假成功）。
      throw new Error(
        `command channel store refused to freeze commandId=${envelope.commandId} and no frozen result was readable`,
      );
    }
    await recordAudit({
      kind: "command.executed",
      commandId: envelope.commandId,
      type: envelope.type,
      issuedAt: envelope.issuedAt,
      resultRef: outcome.resultRef,
      at: formatCommandChannelTimestamp(now()),
    });
    return { response, serializedResponse, replay: false };
  }

  return {
    async processEnvelope(
      envelope: unknown,
    ): Promise<CommandChannelProcessResult> {
      let parsed;
      try {
        parsed = parseCommandChannelEnvelope(envelope);
      } catch (error) {
        // strict schema 拒绝（未知字段/结构错误/已知类型 params 或幂等键不合法）→ MALFORMED。
        // 非 ValidationError 的异常属调用方缺陷，上抛不吞。
        if (!(error instanceof CommandChannelValidationError)) throw error;
        logger.debug(
          undefined,
          `command channel envelope malformed: ${error.message}`,
        );
        return reject("MALFORMED", { auditKind: "envelope.rejected" });
      }
      // 验签（M7-R4 指令信封带服务端签名）：通告/指令/未知类型共用同一安全信封（M7-R7），
      // 管线顺序上先于过期与类型白名单（任务卡 20261022-C4）。
      const signatureValid = await options.verifier.verify(parsed.base);
      // 定向投递防护（2026-10-27 与中台对齐）：信封 deviceId 必须与本机注册 ID
      // 逐字匹配——定向完整性属签名验证链，失败按 INVALID_SIGNATURE 拒绝；
      // 本机未注册（expectedDeviceId 未注入）时不比对（隔离联调兼容无设备形态）。
      const deviceMatched =
        options.expectedDeviceId === undefined ||
        parsed.base.deviceId === undefined ||
        parsed.base.deviceId === options.expectedDeviceId;
      if (!signatureValid || !deviceMatched) {
        if (parsed.kind === "notice") {
          return reject("INVALID_SIGNATURE", {
            auditKind: "notice.rejected",
            type: parsed.base.type,
            noticeId: parsed.base.noticeId,
          });
        }
        if (parsed.kind === "command") {
          return reject("INVALID_SIGNATURE", {
            auditKind: "command.rejected",
            type: parsed.base.type,
            commandId: parsed.base.commandId,
          });
        }
        return reject("INVALID_SIGNATURE", {
          auditKind: "envelope.rejected",
          type: parsed.base.type,
          commandId: parsed.base.commandId,
          noticeId: parsed.base.noticeId,
        });
      }
      if (parsed.kind === "notice") {
        // 通告分发（M7-R2）：不进命令处理；分发失败向调用方传播（补通告归通道层，M7-R1）。
        await options.noticeSink.dispatch(parsed.envelope);
        const response: CommandChannelResponse = {
          status: "dispatched",
          noticeId: parsed.envelope.noticeId,
        };
        await recordAudit({
          kind: "notice.dispatched",
          noticeId: parsed.envelope.noticeId,
          type: parsed.envelope.type,
          issuedAt: parsed.envelope.issuedAt,
          at: formatCommandChannelTimestamp(now()),
        });
        return {
          response,
          serializedResponse: serializeCommandChannelResponse(response),
          replay: false,
        };
      }
      // 指令管线（含未知 type）：过期先于类型白名单（任务卡顺序；M7-R4 指令过期自动失效，
      // 到达 expiresAt 时刻即失效含等值）。
      if (now().getTime() >= Date.parse(parsed.base.expiresAt)) {
        return reject("EXPIRED", {
          auditKind:
            parsed.kind === "command" ? "command.rejected" : "envelope.rejected",
          type: parsed.base.type,
          commandId: parsed.base.commandId,
        });
      }
      if (parsed.kind === "unknown-type") {
        // 类型白名单（M7-R3：客户端对未知类型拒绝 UNKNOWN_TYPE；S11-d 伪造 exec 判据）。
        return reject("UNKNOWN_TYPE", {
          auditKind: "envelope.rejected",
          type: parsed.base.type,
          commandId: parsed.base.commandId,
          noticeId: parsed.base.noticeId,
        });
      }
      return processCommand(parsed.envelope);
    },
  };
}
