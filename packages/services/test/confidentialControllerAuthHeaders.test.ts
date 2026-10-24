import { describe, expect, it } from "vitest";
import { createControllerApplication } from "../src/confidential-controller/application.js";

describe("confidential controller auth headers", () => {
  it("rejects the platform header request when logged out", async () => {
    const app = createControllerApplication({ apiBaseUrl: "https://example.test/", trusts: [] });
    await expect(app.account.getAuthHeaders()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    app.dispose();
  });
});
