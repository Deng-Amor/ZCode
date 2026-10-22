export const cliConfidentialControllerModule = {
  id: 'cli-confidential-controller',
  requires: ['zcode-cli'],
  provides: ['private-controller-client'],
  publicEntrypoints: ['index.ts', 'contract.ts'],
} as const;
