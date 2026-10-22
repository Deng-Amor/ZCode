import type {
  ConfidentialControllerBinding,
  ConfidentialControllerExecutionPort,
} from "@zcode/contracts";
import { PrivateControllerError, type PrivateControllerClient } from "./contract.js";

/** Task owner creates one scope and shares it with children; no instruction cache. */
export function createControllerExecutionScope(
  client: PrivateControllerClient,
  restored?: ConfidentialControllerBinding,
): ConfidentialControllerExecutionPort & { readonly version: number | undefined } {
  if (
    restored !== undefined &&
    (!Number.isSafeInteger(restored.version) ||
      restored.version <= 0 ||
      !/^[a-f0-9]{64}$/.test(restored.digest))
  )
    throw new PrivateControllerError("INVALID_RELEASE");
  let version = restored?.version;
  let digest = restored?.digest;
  return {
    get version() {
      return version;
    },
    use(consume, options) {
      return client.use(
        async (content) => {
          // 不同租户可复用版本号；同步固定摘要，避免同一任务在并发或重新授权后混用正文。
          if (
            (version !== undefined && version !== content.version) ||
            (digest !== undefined && digest !== content.digest)
          )
            throw new PrivateControllerError("VERSION_CHANGED");
          version = content.version;
          digest = content.digest;
          return consume(content);
        },
        { signal: options?.signal, ...(version === undefined ? {} : { version }) },
      );
    },
  };
}
