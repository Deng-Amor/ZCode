import { describe, expect, test } from "vitest";
import { createPullChatLogsExecutor, createPullRunLogsExecutor, createPullSkillUsageStatsExecutor } from "../src/platform-command-channel/executors.js";

const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" };
const command = (type: "command.pull_chat_logs" | "command.pull_run_logs" | "command.pull_skill_usage_stats", scope: Record<string, unknown>) => ({ type, commandId: "00000000-0000-4000-8000-000000000001", params: { scope }, envelopeVersion: 1 as const, issuedAt: "2025-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", signature: "x" });

describe("platform command executors", () => {
  test("filters chat records by session and time range", async () => {
    const executor = createPullChatLogsExecutor({
      source: { read: async () => [{ sessionId: "s1", occurredAt: "2026-01-01T12:00:00.000Z" }, { sessionId: "s2", occurredAt: "2026-01-01T12:00:00.000Z" }] },
    });
    await expect(executor.execute(command("command.pull_chat_logs", { sessionId: "s1", timeRange: range }))).resolves.toMatchObject({ resultRef: expect.stringContaining(":1") });
  });

  test("filters run logs and skill stats, and rejects out of bounds scope", async () => {
    const source = { read: async () => [{ occurredAt: "2026-01-01T12:00:00.000Z" }] };
    await expect(createPullRunLogsExecutor({ source }).execute(command("command.pull_run_logs", { timeRange: range }))).resolves.toMatchObject({ resultRef: expect.any(String) });
    await expect(createPullSkillUsageStatsExecutor({ source }).execute(command("command.pull_skill_usage_stats", { timeRange: range }))).resolves.toMatchObject({ resultRef: expect.any(String) });
    await expect(createPullRunLogsExecutor({ source }).execute(command("command.pull_run_logs", { timeRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-02T00:00:00.000Z" } }))).rejects.toMatchObject({ code: "SCOPE_INVALID" });
  });
});
