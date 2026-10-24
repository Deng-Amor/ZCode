import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 指令/订阅通道单测共享夹具：确定性 UUID、信封工厂、固定时钟、临时目录。 */

/** 固定时钟（处理器注入用）：所有信封的签发/过期窗口都相对该时刻构造。 */
export const FIXED_NOW = new Date("2026-10-22T12:00:00.000Z");

export const FIXED_ISSUED_AT = "2026-10-22T11:59:00.000Z";
export const FIXED_EXPIRES_AT = "2026-10-22T12:10:00.000Z";

let uuidCounter = 0;

/** 确定性合法 UUID（格式合法、每次调用不同），保证测试可回读且幂等键不碰撞。 */
export function nextTestUuid(prefix = 1): string {
  uuidCounter += 1;
  const hex =
    `${prefix.toString(16).padStart(4, "0")}${uuidCounter.toString(16)}`.padStart(
      12,
      "0",
    );
  return `00000000-0000-4000-8000-${hex.slice(0, 12)}`;
}

export interface TestEnvelopeOverrides {
  commandId?: string;
  noticeId?: string;
  expiresAt?: string;
  signature?: string;
}

function envelopeTimingFields(overrides: TestEnvelopeOverrides) {
  return {
    envelopeVersion: 1,
    issuedAt: FIXED_ISSUED_AT,
    expiresAt: overrides.expiresAt ?? FIXED_EXPIRES_AT,
    signature: overrides.signature ?? "test-signature",
  };
}

export function testPullRunLogsEnvelope(
  overrides: TestEnvelopeOverrides & {
    timeRange?: { from: string; to: string };
  } = {},
) {
  return {
    ...envelopeTimingFields(overrides),
    type: "command.pull_run_logs",
    commandId: overrides.commandId ?? nextTestUuid(1),
    params: {
      scope: {
        timeRange: overrides.timeRange ?? {
          from: "2026-10-22T11:00:00.000Z",
          to: "2026-10-22T12:00:00.000Z",
        },
      },
    },
  };
}

export function testPullChatLogsEnvelope(
  overrides: TestEnvelopeOverrides & {
    sessionId?: string;
    timeRange?: { from: string; to: string };
  } = {},
) {
  const scope: Record<string, unknown> = {};
  if (overrides.sessionId !== undefined) scope.sessionId = overrides.sessionId;
  if (overrides.timeRange !== undefined) scope.timeRange = overrides.timeRange;
  return {
    ...envelopeTimingFields(overrides),
    type: "command.pull_chat_logs",
    commandId: overrides.commandId ?? nextTestUuid(1),
    params: { scope },
  };
}

export function testPullSkillUsageStatsEnvelope(
  overrides: TestEnvelopeOverrides & {
    timeRange?: { from: string; to: string };
  } = {},
) {
  return {
    ...envelopeTimingFields(overrides),
    type: "command.pull_skill_usage_stats",
    commandId: overrides.commandId ?? nextTestUuid(1),
    params: {
      scope: {
        timeRange: overrides.timeRange ?? {
          from: "2026-10-22T11:00:00.000Z",
          to: "2026-10-22T12:00:00.000Z",
        },
      },
    },
  };
}

export function testSkillUpdateNoticeEnvelope(
  overrides: TestEnvelopeOverrides & {
    version?: number;
    digest?: string;
    seq?: number;
  } = {},
) {
  return {
    ...envelopeTimingFields(overrides),
    type: "skill.update.notice",
    noticeId: overrides.noticeId ?? nextTestUuid(2),
    params: {
      version: overrides.version ?? 2,
      digest: overrides.digest ?? "6a".repeat(32),
      seq: overrides.seq ?? 1,
    },
  };
}

export async function makeCommandChannelTestDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "platform-command-channel-"));
}

export async function removeCommandChannelTestDirectory(
  directory: string,
): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
