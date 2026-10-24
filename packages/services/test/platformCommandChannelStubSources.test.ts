import { describe, expect, it } from "vitest";
import { createNotCollectedSource } from "../src/platform-command-channel/stub-sources.js";

describe("createNotCollectedSource", () => {
  it("returns an empty read result with the fixed NOT_COLLECTED reason", async () => {
    const source = createNotCollectedSource();
    await expect(source.read()).resolves.toEqual([]);
    expect(source.reason).toBe("NOT_COLLECTED");
  });
});
