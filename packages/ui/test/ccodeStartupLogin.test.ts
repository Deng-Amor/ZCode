import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const accountState = vi.hoisted(() => ({ authenticated: false, available: true, unavailable: false }));
const platformState = vi.hoisted(() => ({ closeWindow: vi.fn() }));
vi.mock("@/hooks/useCcodeAccount.js", () => ({
  useCcodeAccount: () => ({
    account: accountState.available ? {} : undefined,
    state: { authenticated: accountState.authenticated },
    unavailable: accountState.unavailable,
    refresh() {},
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: platformState.closeWindow,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/DesktopOverlayWindowControls.js", () => ({ DesktopOverlayWindowControls: () => null }));
vi.mock("@/components/ui/ZCodeAboutLogo.js", () => ({ ZCodeAboutLogo: () => null }));
vi.mock("@/ccode-account/CcodeAccountEntry.js", () => ({
  CcodeAccountForm: () => createElement("form", { "data-testid": "login-form" }),
}));
import { CcodeStartupLogin } from "@/ccode-account/CcodeStartupLogin.js";
beforeEach(() => {
  accountState.authenticated = false;
  accountState.available = true;
  accountState.unavailable = false;
  platformState.closeWindow.mockClear();
});
const render = () =>
  renderToStaticMarkup(createElement(CcodeStartupLogin, { children: "WORKSPACE" }));
it("requires startup sign-in without a misleading skip action", () => {
  const html = render();
  expect(html).toContain("login-form");
  expect(html).not.toContain("WORKSPACE");
  expect(html).not.toContain("skipStartup");
});
it("opens the workspace after authenticated bootstrap", () => {
  accountState.authenticated = true;
  expect(render()).toBe("WORKSPACE");
});
it("preserves Web without an account port", () => {
  accountState.available = false;
  expect(render()).toBe("WORKSPACE");
});

it("provides an exit action when account status is unavailable", () => {
  accountState.unavailable = true;
  expect(render()).toContain("ccode.account.cancel");
});
