import { describe, expect, it } from "vitest";
import { createExpertSkillsChannelServer } from "../src/main/ccode-platform-runtime-wiring/expert-channel.js";

describe("expert skills channel", () => {
  it("maps catalog entries", async () => {
    const server = createExpertSkillsChannelServer({ store: { list: async () => [{ skillId: "a", name: "A", description: "d", version: 2 }], get: async () => undefined }, scope: () => "s" });
    await expect(server.handle({ type: "expert.get-catalog", requestId: "1" })).resolves.toEqual({ type: "expert.get-catalog", requestId: "1", entries: [{ skillId: "a", name: "A", description: "d", version: 2 }] });
  });
  it("returns cached content", async () => {
    const server = createExpertSkillsChannelServer({ store: { list: async () => [], get: async (scope, id) => ({ scope, id }) }, scope: () => "s" });
    await expect(server.handle({ type: "expert.get-content", requestId: "1", skillId: "a" })).resolves.toEqual({ type: "expert.get-content", requestId: "1", content: { scope: "s", id: "a" } });
  });
  it("returns NOT_CACHED and ignores unknown messages", async () => {
    const server = createExpertSkillsChannelServer({ store: { list: async () => [], get: async () => undefined }, scope: () => "s" });
    await expect(server.handle({ type: "expert.get-content", requestId: "1", skillId: "a" })).resolves.toMatchObject({ errorCode: "NOT_CACHED" });
    await expect(server.handle({ type: "other", requestId: "1" })).resolves.toEqual({ type: "IGNORED" });
  });
});
