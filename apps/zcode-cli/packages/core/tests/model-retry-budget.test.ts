import { describe, expect, it } from "vitest";
import { createSessionId, ModelRetryBudget, type SessionTaskType } from "@zcode/contracts";
import { resolveModelRetryBudgetFromTaskType } from "../src/runtime/methods/model-request-session-type.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// docs/specs/workflow-bounded-recovery.md：workflow actor 保留专用分类，使用有限请求预算。
describe("resolveModelRetryBudgetFromTaskType", () => {
  it.each<{ expected: ModelRetryBudget; taskType: SessionTaskType | undefined }>([
    { expected: "default", taskType: undefined },
    { expected: "default", taskType: "fork" },
    { expected: "default", taskType: "selection_side_chat" },
    { expected: "default", taskType: "workflow_parent" },
    { expected: "workflow-finite", taskType: "workflow_child" },
    { expected: "workflow-finite", taskType: "nested_workflow_child" },
  ])("maps $taskType to $expected", ({ expected, taskType }) => {
    expect(resolveModelRetryBudgetFromTaskType(taskType)).toBe(expected);
  });
});

describe("AgentRuntime model requests carry modelRetryBudget", () => {
  it.each<{ expected: ModelRetryBudget; taskType: SessionTaskType }>([
    { expected: "workflow-finite", taskType: "workflow_child" },
    { expected: "workflow-finite", taskType: "nested_workflow_child" },
    { expected: "default", taskType: "subagent_child" },
    { expected: "default", taskType: "interactive" },
  ])("$taskType → $expected", async ({ expected, taskType }) => {
    const budgets: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`runtime-retry-budget-${taskType}`),
      {
        agentName: "zcode-general-purpose",
        modelStreaming: "off",
        taskType,
        workingDirectory: "/tmp/runtime-retry-budget",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            budgets.push(observation.invocationContext?.modelRetryBudget);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("prompt");

    expect(budgets).toEqual([expected]);
  });

  it.each(["workflow_child", "nested_workflow_child"] as const)(
    "%s uses SingleAttempt for an execution fallback and restores its workflow budget afterwards",
    async (taskType) => {
      const budgets: unknown[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId(`runtime-fallback-budget-${taskType}`),
        {
          modelSelection: { providerId: "test", modelId: "session" },
          modelStreaming: "off",
          taskType,
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              budgets.push(observation.invocationContext?.modelRetryBudget);
              if (String(observation.model.providerId) === "accelerated") {
                throw Object.assign(new Error("Provider authentication failed"), {
                  name: "AiSdkModelAdapterError",
                  code: "provider_not_configured",
                  context: {
                    providerId: "accelerated",
                    modelId: "fast",
                    source: "provider",
                    reason: "auth_failed",
                    retryable: false,
                    statusCode: 401,
                  },
                });
              }
              return {
                finishReason: "stop",
                text: "continued",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );
      const result = await runtime.executeTurn("continue", undefined, {
        intent: {
          sourceCommandId: "fallback-budget",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: "accelerated", modelId: "fast" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: {
            providerId: "accelerated",
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      });
      expect(result.response).toBe("continued");
      expect(budgets).toEqual([ModelRetryBudget.SingleAttempt, "workflow-finite"]);
    },
  );
});
