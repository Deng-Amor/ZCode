import { randomUUID } from "node:crypto";
import type {
  CommandChannelAuditEvent,
  CommandChannelAuditSink,
  CommandChannelExecutor,
  CommandChannelNoticeSink,
  CommandChannelPolicy,
  CommandChannelProcessResult,
  CommandChannelProcessor,
  CommandChannelSignatureVerifier,
  CommandChannelStoreIdentity,
} from "#src/platform-command-channel/contract.js";
import {
  COMMAND_CHANNEL_ENVELOPE_VERSION,
  formatCommandChannelTimestamp,
} from "#src/platform-command-channel/schema.js";
import {
  DEFAULT_COMMAND_CHANNEL_POLICY,
} from "#src/platform-command-channel/policy.js";
import {
  createCommandChannelDiskStore,
} from "#src/platform-command-channel/store.js";
import {
  createCommandChannelProcessor,
} from "#src/platform-command-channel/processor.js";

/**
 * 最小铸造示例：一条 pull_run_logs 指令信封（服务端→客户端，此处演示客户端侧字段）。
 * issuedAt/expiresAt 用带时区 ISO 字符串；signature 为中台侧签名串（示例占位）。
 */
export function pullRunLogsEnvelopeExample(
  issuedAt: Date,
  expiresAt: Date,
): {
  envelopeVersion: number;
  type: "command.pull_run_logs";
  commandId: string;
  params: { scope: { timeRange: { from: string; to: string } } };
  issuedAt: string;
  expiresAt: string;
  signature: string;
} {
  return {
    envelopeVersion: COMMAND_CHANNEL_ENVELOPE_VERSION,
    type: "command.pull_run_logs",
    commandId: randomUUID(),
    params: {
      scope: {
        timeRange: {
          from: formatCommandChannelTimestamp(
            new Date(issuedAt.getTime() - 60 * 60 * 1000),
          ),
          to: formatCommandChannelTimestamp(issuedAt),
        },
      },
    },
    issuedAt: formatCommandChannelTimestamp(issuedAt),
    expiresAt: formatCommandChannelTimestamp(expiresAt),
    signature: "ed25519-signature-by-middle-platform",
  };
}

/**
 * 装配示例：处理核心 + 磁盘幂等存储 + 注入端口。验签实现与密钥管理、三类指令
 * 执行体、通告下游接线、网络 transport 均属后续卡——此处以最小桩演示端口形状。
 */
export function createExampleProcessor(options: {
  storageDirectory: string;
  identity: CommandChannelStoreIdentity;
  signatureValid: boolean;
  resultRef: string;
  onNotice?: (notice: unknown) => void;
  policy?: CommandChannelPolicy;
}): CommandChannelProcessor {
  const verifier: CommandChannelSignatureVerifier = {
    // 真实实现按中台契约（M6-R4 信任根）重建签名字节并验证；桩只回布尔。
    verify: () => Promise.resolve(options.signatureValid),
  };
  const executor: CommandChannelExecutor = {
    execute: () => Promise.resolve({ resultRef: options.resultRef }),
  };
  const noticeSink: CommandChannelNoticeSink = {
    dispatch: (notice) => {
      options.onNotice?.(notice);
      return Promise.resolve();
    },
  };
  const auditEvents: CommandChannelAuditEvent[] = [];
  const auditSink: CommandChannelAuditSink = {
    record: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
  };
  const store = createCommandChannelDiskStore({
    storageDirectory: options.storageDirectory,
    identity: options.identity,
  });
  const policy = options.policy ?? DEFAULT_COMMAND_CHANNEL_POLICY;
  return {
    processEnvelope(
      envelope: unknown,
    ): Promise<CommandChannelProcessResult> {
      return createCommandChannelProcessor({
        verifier,
        executor,
        noticeSink,
        auditSink,
        store,
        getPolicy: () => policy,
      }).processEnvelope(envelope);
    },
  };
}
