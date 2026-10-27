import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCommandChannelProcessor, DEFAULT_COMMAND_CHANNEL_SCOPE_LIMITS } from "../src/platform-command-channel/index.js";
import { FIXED_EXPIRES_AT, FIXED_ISSUED_AT, makeCommandChannelTestDirectory, nextTestUuid, removeCommandChannelTestDirectory, testPullRunLogsEnvelope } from "./platformCommandChannelFixtures.js";

/**
 * 信封 deviceId 定向（2026-10-27 与中台对齐）：服务端签名信封含 deviceId，
 * schema 接收（小写 8-4-4-4-12，非 z.uuid）+ 验签后与本机注册 ID 逐字匹配，
 * 不匹配按 INVALID_SIGNATURE 拒绝；未注册（未注入 expectedDeviceId）不比对。
 */

const DEVICE_A = "6f14c2d9-8b3e-4a57-9c21-d0e5f7a8b123";
const DEVICE_B = "0c1b2a3d-4e5f-4607-8899-aabbccddeeff";

function processorWith(expectedDeviceId?: string) {
  return createCommandChannelProcessor({
    verifier: { verify: async () => true },
    executor: { execute: async () => ({ resultRef: "ref" }) },
    noticeSink: { dispatch: async () => {} },
    auditSink: { record: async () => {} },
    store: { get: async () => undefined, freeze: async () => true, dispose: async () => {} },
    getPolicy: () => ({
      channelEnabled: true,
      commands: {
        "command.pull_chat_logs": { enabled: false },
        "command.pull_run_logs": { enabled: true },
        "command.pull_skill_usage_stats": { enabled: true },
      },
      visibility: "silent",
    }),
    scopeLimits: DEFAULT_COMMAND_CHANNEL_SCOPE_LIMITS,
    now: () => new Date(FIXED_ISSUED_AT),
    expectedDeviceId,
  });
}

describe("信封 deviceId 定向", () => {
  it("schema 接收小写 UUID deviceId；大写/非 UUID 拒为 MALFORMED", async () => {
    const p = processorWith(DEVICE_A);
    const good = { ...testPullRunLogsEnvelope(), deviceId: DEVICE_A };
    const r1 = await p.processEnvelope(good);
    expect(r1.response.status).toBe("executed");
    const upper = { ...testPullRunLogsEnvelope(), deviceId: DEVICE_A.toUpperCase() };
    const r2 = await p.processEnvelope(upper);
    expect(r2.response.status).toBe("rejected");
    expect(r2.response.reason).toBe("MALFORMED");
    const bad = { ...testPullRunLogsEnvelope(), deviceId: "dev-123" };
    const r3 = await p.processEnvelope(bad);
    expect(r3.response.status).toBe("rejected");
    expect(r3.response.reason).toBe("MALFORMED");
  });

  it("信封 deviceId 与本机不匹配 → INVALID_SIGNATURE（不执行）", async () => {
    const p = processorWith(DEVICE_A);
    const r = await p.processEnvelope({ ...testPullRunLogsEnvelope(), deviceId: DEVICE_B });
    expect(r.response.status).toBe("rejected");
    expect(r.response.reason).toBe("INVALID_SIGNATURE");
  });

  it("信封无 deviceId（旧形态）+ 本机已注册 → 不比对、正常执行", async () => {
    const p = processorWith(DEVICE_A);
    const r = await p.processEnvelope(testPullRunLogsEnvelope());
    expect(r.response.status).toBe("executed");
  });

  it("本机未注册（expectedDeviceId 未注入）→ 携带任意 deviceId 均执行", async () => {
    const p = processorWith(undefined);
    const r = await p.processEnvelope({ ...testPullRunLogsEnvelope(), deviceId: DEVICE_B });
    expect(r.response.status).toBe("executed");
  });
});

