import { verifyManagedSkillBundle, ManagedSkillBundleError } from "@zcode/shared/managed-skills";
import type { ControllerLockedStore, ControllerLockedStoreOptions, ControllerUpdateSource } from "./contract.js";
import { ControllerLockedStoreError } from "./contract.js";
export function createControllerLockedUpdater(options: { store: ControllerLockedStore; source: ControllerUpdateSource; trust?: ControllerLockedStoreOptions["trust"]; verify?: ControllerLockedStoreOptions["verify"]; }) {
  return { async checkAndInstall() {
    try {
      const current = (await options.store.status()).current;
      const result = await options.source.fetchUpdate({ currentVersion: current?.version });
      if (result.kind === "upToDate") return { outcome: "upToDate" as const };
      let verified;
      try { verified = (options.verify ?? verifyManagedSkillBundle)(result.envelope, options.trust!); }
      catch (error) { if (error instanceof ManagedSkillBundleError) return { outcome: "rejected" as const, errorCode: error.code }; return { outcome: "rejected" as const, errorCode: "VERIFY_FAILED" }; }
      const installed = await options.store.install(verified); return { outcome: "installed" as const, version: installed.version };
    } catch (error) { return { outcome: "rejected" as const, errorCode: error instanceof ControllerLockedStoreError ? error.code : "IO_FAILED" }; }
  } };
}
