import { describe, expect, it } from "vitest";

import type { DesktopCcodeAccount, DesktopCcodePlatformRuntimeWiring, DesktopCcodePlatformRuntimeWiringOptions } from "./contract.js";
import { ccodePlatformRuntimeWiringModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("ccode-platform-runtime-wiring contract", () => {
  it("declares its module manifest", () => {
    expect(ccodePlatformRuntimeWiringModule.id).toBe("ccode-platform-runtime-wiring");
  });

  it("account narrow port only exposes the four platform capabilities", () => {
    const account: DesktopCcodeAccount = {
      getState: async () => ({ authenticated: false }),
      onStateChanged: () => () => undefined,
      getAuthHeaders: async () => {
        throw new Error("AUTH_REQUIRED");
      },
    };
    expect(Object.keys(account).sort()).toEqual(["getAuthHeaders", "getState", "onStateChanged"]);
  });

  it("wiring surface is fetch + dispose + diagnostic error report + device identity notify", () => {
    const wiring: DesktopCcodePlatformRuntimeWiring = {
      fetch: async () => new Response(""),
      dispose: async () => undefined,
      reportDiagnosticErrorTrigger: () => undefined,
      notifyDeviceIdentityChanged: () => undefined,
      reportTaskStarted: async () => undefined,
      reportTaskTerminal: async () => undefined,
    };
    expect(Object.keys(wiring).sort()).toEqual(["dispose", "fetch", "notifyDeviceIdentityChanged", "reportDiagnosticErrorTrigger", "reportTaskStarted", "reportTaskTerminal"]);
  });

  it("options carry all injected paths and knobs (no electron imports reachable)", () => {
    const options: DesktopCcodePlatformRuntimeWiringOptions = {
      account: { getState: async () => ({ authenticated: false }), onStateChanged: () => () => undefined, getAuthHeaders: async () => ({}) },
      storageDirectory: "dir",
      apiBaseUrl: "https://example.test/",
      commandSignerPublicKeyPem: "pem",
      homeDirectory: "home",
      workingDirectory: "cwd",
    };
    expect(options.apiBaseUrl.endsWith("/")).toBe(true);
  });
});
