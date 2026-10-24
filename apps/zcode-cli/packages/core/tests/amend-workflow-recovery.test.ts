import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type DynamicWorkflowRunPort,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";

it("AmendWorkflow exposes recovery uncertainty as a tool failure with trusted identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dwf-amend-uncertain-"));
  try {
    const sessionId = createSessionId("amend-uncertain");
    const turnId = createTurnId("amend-uncertain");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    let amends = 0;
    let approvals = 0;
    const port = {
      async getScript() {
        return 'interface R { done: boolean }\nconst r = await agent("worker").ask<R>("do");\nreturn r.done;';
      },
      async getTask(taskId: string) {
        return {
          runId: taskId,
          taskId,
          parentSessionId: sessionId,
          startedAt: new Date(0),
          status: "failed",
          runStatus: "errored",
        };
      },
      async amend() {
        amends += 1;
        return {
          ok: false,
          reason: "recovery_uncertain",
          uncertainty: { runId: "trusted-run", instance: { siteId: "world-site", ordinal: 2 } },
        };
      },
    } as unknown as DynamicWorkflowRunPort;
    const registry = createToolRegistry();
    registry.register(amendWorkflowToolEntry);
    const executor = createToolExecutor({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: port,
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          approvals += 1;
          return { decision: "allow" };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: cwd,
    });
    // settings-only 沿用真实前驱解析和脚本校验，避免技能读取成为本回归的旁支。
    const result = await executor.execute(
      {
        id: createToolCallId("amend-uncertain"),
        name: "AmendWorkflow",
        input: { run_id: "untrusted-request", name: "revised" },
      },
      { traceContext },
    );
    expect(amends).toBe(1);
    expect(approvals).toBe(0);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error?.code).toBe("30");
    const message = String(result.error?.message);
    expect(message).toMatch(/^workflow_run_recovery_uncertain:/u);
    expect(message).toContain("trusted-run");
    expect(message).toContain("world-site#2");
    expect(message).toMatch(/outcome is unknown.*verif/iu);
    expect(message).not.toMatch(/untrusted-request|AmendWorkflow|CreateWorkflow|force/u);
  } finally {
    const path = relative(resolve(tmpdir()), resolve(cwd));
    if (!path || path.startsWith("..") || isAbsolute(path))
      throw new Error("unsafe fixture cleanup path");
    await rm(cwd, { recursive: true, force: true });
  }
});
