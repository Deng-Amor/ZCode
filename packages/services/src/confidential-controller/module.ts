export const confidentialControllerModule = {
  id: "confidential-controller",
  requires: ["managed-skills", "shared"],
  provides: ["confidential-controller"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
