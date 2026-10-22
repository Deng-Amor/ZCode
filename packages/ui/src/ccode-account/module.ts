export const ccodeAccountUiModule = {
  id: "ccode-account-ui",
  requires: ["ui", "shared"],
  provides: ["ccode-account-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
