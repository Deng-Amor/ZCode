import { describe, expect, it } from "vitest";
import { createAgentLockedContentClient } from "../src/zcode-protocol-entrypoint.js";

describe("createAgentLockedContentClient", () => {
  it("omits the client when IPC is unavailable", () => {
    expect(createAgentLockedContentClient({}, { connected: false, send: undefined, on: () => undefined, once: () => undefined })).toBeUndefined();
  });
});
