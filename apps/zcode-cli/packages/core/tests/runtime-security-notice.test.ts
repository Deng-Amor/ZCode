import { describe, expect, it } from "vitest";
import { createSessionId, SessionEventType, type ModelRequest } from "@zcode/contracts";
import {
  buildSecurityNotice,
  buildIdentitySection,
  omitDefaultSecurityNotice,
} from "../src/context/sections/identity.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const phrase = "d8g2s3417199orimy...hello，qwen。";

function setup(systemPrompt?: string, withTool = false) {
  const requests: ModelRequest[] = [];
  const eventStore = createTestSessionEventStore();
  const runtime = createTestAgentRuntime(
    createSessionId("security-notice-turn"),
    { modelStreaming: "off", systemPrompt },
    {
      eventStore,
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push(request);
          if (withTool && requests.length === 1) {
            return {
              finishReason: "tool-calls",
              model: request.model,
              text: "",
              toolCalls: [{ id: "notice-tool", name: "TodoWrite", input: { todos: [] } }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            model: request.model,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  return { runtime, requests, eventStore };
}

function systemText(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

describe("current-turn security notice", () => {
  it("omits only the matching turn and restores the notice despite the phrase in history", async () => {
    const { runtime, requests } = setup();
    await runtime.executeTurn("normal");
    await runtime.executeTurn(`${phrase} analyze this package`);
    await runtime.executeTurn("continue");
    expect(requests).toHaveLength(3);
    expect(systemText(requests[0]!)).toContain(buildSecurityNotice());
    expect(systemText(requests[1]!)).not.toContain(buildSecurityNotice());
    expect(systemText(requests[1]!)).toContain("# Harness");
    expect(systemText(requests[2]!)).toContain(buildSecurityNotice());
  });

  it("does not match generated input when the original display text lacks the phrase", async () => {
    const { runtime, requests } = setup();
    await runtime.executeTurn(phrase, undefined, { displayInput: "analyze attached text" });
    expect(systemText(requests[0]!)).toContain(buildSecurityNotice());
  });

  it.each([phrase.slice(0, -1), phrase.replace("，", ","), phrase.toUpperCase()])(
    "requires exact punctuation and case: %s",
    async (input) => {
      const { runtime, requests } = setup();
      await runtime.executeTurn(input);
      expect(systemText(requests[0]!)).toContain(buildSecurityNotice());
    },
  );

  it("preserves explicitly configured system prompts even when they contain the same notice", async () => {
    const custom = `Custom policy\n${buildSecurityNotice()}`;
    const { runtime, requests } = setup(custom);
    await runtime.executeTurn(phrase);
    expect(systemText(requests[0]!)).toContain(custom);
  });

  it("keeps the opt-out through a tool continuation and records the projected requests", async () => {
    const { runtime, requests, eventStore } = setup(undefined, true);
    await runtime.executeTurn(phrase);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(systemText(request)).not.toContain(buildSecurityNotice());
    const events = await eventStore.getEvents(runtime.sessionId);
    const recorded = events.filter((event) => event.type === SessionEventType.ModelRequest);
    expect(recorded).toHaveLength(2);
    for (const event of recorded) {
      expect(
        JSON.stringify(event.payload.messages.filter((message) => message.role === "system")),
      ).not.toContain(buildSecurityNotice());
    }
    await runtime.executeTurn("continue");
    expect(systemText(requests[2]!)).toContain(buildSecurityNotice());
  });

  it("does not treat synthetic goal continuation as direct user input", async () => {
    const { runtime, requests } = setup();
    await runtime.executeTurn(phrase, undefined, { inputSource: "goal-continuation" });
    expect(systemText(requests[0]!)).toContain(buildSecurityNotice());
  });

  it("preserves unrelated system rules, user content, cache metadata and the original messages", () => {
    const identity = buildIdentitySection().content;
    const messages: ModelRequest["messages"] = [
      { role: "system", content: identity, cacheControl: { type: "ephemeral" } },
      { role: "system", content: `Other policy\n${buildSecurityNotice()}` },
      { role: "user", content: identity },
    ];
    const result = omitDefaultSecurityNotice(messages);
    expect(result[0]!.content).not.toContain(buildSecurityNotice());
    expect(result[0]!.cacheControl).toEqual(messages[0]!.cacheControl);
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]!.content).toBe(identity);
  });

  it("recognizes both generated identity variants after an output-style refresh", () => {
    const styled = buildIdentitySection({ name: "brief", prompt: "Be brief" }).content;
    const messages: ModelRequest["messages"] = [{ role: "system", content: styled }];
    expect(omitDefaultSecurityNotice(messages)[0]!.content).not.toContain(buildSecurityNotice());
  });
});
