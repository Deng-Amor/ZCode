import { describe, expect, it } from "vitest";
import {
  CommandChannelValidationError,
  parseCommandChannelEnvelope,
  serializeCommandChannelResponse,
} from "#src/platform-command-channel/index.js";
import {
  DEFAULT_COMMAND_CHANNEL_POLICY,
  evaluateCommandChannelPolicy,
} from "#src/platform-command-channel/policy.js";

/**
 * 契约级单测（架构治理 managed 模块自带）：信封 strict schema 严格性、
 * 未知 type 的两段式放行语义、响应固定键序序列化、策略默认位。
 * 管线行为（S11 四组判据、幂等、审计、通告路由、磁盘存储）见
 * packages/services/test/platformCommandChannel.test.ts。
 */

const ISSUED_AT = "2026-10-22T11:59:00.000Z";
const EXPIRES_AT = "2026-10-22T12:10:00.000Z";
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOTICE_ID = "123e4567-e89b-42d3-a456-426614174010";

function pullRunLogsEnvelope(): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    type: "command.pull_run_logs",
    commandId: COMMAND_ID,
    params: {
      scope: {
        timeRange: { from: "2026-10-22T11:00:00.000Z", to: "2026-10-22T12:00:00.000Z" },
      },
    },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    signature: "test-signature",
  };
}

function skillUpdateNoticeEnvelope(): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    type: "skill.update.notice",
    noticeId: NOTICE_ID,
    params: { version: 2, digest: "6a".repeat(32), seq: 1 },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    signature: "test-signature",
  };
}

function pullChatLogsEnvelope(sessionId?: string): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    type: "command.pull_chat_logs",
    commandId: COMMAND_ID,
    params: { scope: sessionId === undefined ? {} : { sessionId } },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    signature: "test-signature",
  };
}

describe("platform-command-channel contract", () => {
  it("rejects unknown envelope fields with CommandChannelValidationError (strict)", () => {
    const contaminated = {
      ...pullRunLogsEnvelope(),
      tenantId: "tenant-must-not-ride-along",
    };
    expect(() => parseCommandChannelEnvelope(contaminated)).toThrow(
      CommandChannelValidationError,
    );
    // 未知字段也拒绝通告与基础层：版本/摘要之外的任何键都不可越界。
    expect(() =>
      parseCommandChannelEnvelope({
        ...skillUpdateNoticeEnvelope(),
        body: "notice must not carry payload body",
      }),
    ).toThrow(CommandChannelValidationError);
  });

  it("lets unknown envelope types pass the schema for the UNKNOWN_TYPE stage (S11-d)", () => {
    const forged = {
      envelopeVersion: 1,
      type: "command.exec",
      commandId: COMMAND_ID,
      params: { argv: ["rm", "-rf", "/"] },
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      signature: "forged-signature",
    };
    // 未知 type 不是 MALFORMED：穿过基础 schema，由处理核心在验签/过期之后判 UNKNOWN_TYPE。
    expect(parseCommandChannelEnvelope(forged).kind).toBe("unknown-type");
  });

  it("strictly validates per-type params and id ownership for known types", () => {
    // 已知类型 params 内的未知字段 → MALFORMED。
    expect(() =>
      parseCommandChannelEnvelope({
        ...pullRunLogsEnvelope(),
        params: {
          scope: {
            timeRange: { from: ISSUED_AT, to: EXPIRES_AT },
            argv: ["ls"],
          },
        },
      }),
    ).toThrow(CommandChannelValidationError);
    // 指令缺 commandId → MALFORMED（幂等键归属由分支 schema 判定）。
    const missingCommandId = pullRunLogsEnvelope();
    delete missingCommandId.commandId;
    expect(() => parseCommandChannelEnvelope(missingCommandId)).toThrow(
      CommandChannelValidationError,
    );
    // 指令携带 noticeId → 未知字段 MALFORMED。
    expect(() =>
      parseCommandChannelEnvelope({
        ...pullRunLogsEnvelope(),
        noticeId: "123e4567-e89b-42d3-a456-426614174099",
      }),
    ).toThrow(CommandChannelValidationError);
    // 信封版本协商外（v2）→ MALFORMED。
    expect(() =>
      parseCommandChannelEnvelope({
        ...pullRunLogsEnvelope(),
        envelopeVersion: 2,
      }),
    ).toThrow(CommandChannelValidationError);
    // 非法 UUID 幂等键 → MALFORMED。
    expect(() =>
      parseCommandChannelEnvelope({
        ...pullRunLogsEnvelope(),
        commandId: "not-a-uuid",
      }),
    ).toThrow(CommandChannelValidationError);
    // run_logs 携带 sessionId 越出其 scope schema → MALFORMED。
    expect(() =>
      parseCommandChannelEnvelope({
        ...pullRunLogsEnvelope(),
        params: { scope: { sessionId: "session-1" } },
      }),
    ).toThrow(CommandChannelValidationError);
  });

  it("parses valid known envelopes into notice/command kinds", () => {
    expect(parseCommandChannelEnvelope(skillUpdateNoticeEnvelope())).toMatchObject(
      { kind: "notice" },
    );
    expect(parseCommandChannelEnvelope(pullRunLogsEnvelope())).toMatchObject({
      kind: "command",
    });
    // chat logs 的 sessionId-only scope 结构合法（范围限定性由 scope 校验判）。
    expect(
      parseCommandChannelEnvelope(pullChatLogsEnvelope("session-1")),
    ).toMatchObject({ kind: "command" });
  });

  it("serializes responses with fixed key order for byte-identical replay", () => {
    expect(
      serializeCommandChannelResponse({
        status: "executed",
        commandId: "123e4567-e89b-42d3-a456-426614174001",
        resultRef: "ref-1",
      }),
    ).toBe(
      '{"status":"executed","commandId":"123e4567-e89b-42d3-a456-426614174001","resultRef":"ref-1"}',
    );
    expect(
      serializeCommandChannelResponse({
        status: "rejected",
        reason: "POLICY_DISABLED",
      }),
    ).toBe('{"status":"rejected","reason":"POLICY_DISABLED"}');
    expect(
      serializeCommandChannelResponse({
        status: "dispatched",
        noticeId: "123e4567-e89b-42d3-a456-426614174002",
      }),
    ).toBe(
      '{"status":"dispatched","noticeId":"123e4567-e89b-42d3-a456-426614174002"}',
    );
  });

  it("defaults to the silent visibility (2026-10-22 A3 拍板) with pull_chat_logs disabled", () => {
    expect(DEFAULT_COMMAND_CHANNEL_POLICY.visibility).toBe("silent");
    expect(DEFAULT_COMMAND_CHANNEL_POLICY.channelEnabled).toBe(true);
    // P2 分期：pull_chat_logs 依赖 OQ-12 合规确认后启用，默认关。
    expect(
      DEFAULT_COMMAND_CHANNEL_POLICY.commands["command.pull_chat_logs"].enabled,
    ).toBe(false);
    expect(
      DEFAULT_COMMAND_CHANNEL_POLICY.commands["command.pull_run_logs"].enabled,
    ).toBe(true);
    expect(
      evaluateCommandChannelPolicy(
        DEFAULT_COMMAND_CHANNEL_POLICY,
        "command.pull_run_logs",
      ),
    ).toBe("allowed");
    expect(
      evaluateCommandChannelPolicy(
        DEFAULT_COMMAND_CHANNEL_POLICY,
        "command.pull_chat_logs",
      ),
    ).toBe("type-disabled");
    // 通道总开关优先于按类型开关。
    expect(
      evaluateCommandChannelPolicy(
        { ...DEFAULT_COMMAND_CHANNEL_POLICY, channelEnabled: false },
        "command.pull_run_logs",
      ),
    ).toBe("channel-disabled");
  });
});
