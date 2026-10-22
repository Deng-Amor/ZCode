import type { CcodeAccountPort } from "./contract.js";

/** Subscribe first, then read; notifications never contain account data. */
export async function readCcodeAccountExample(account: CcodeAccountPort) {
  return account.getState();
}
