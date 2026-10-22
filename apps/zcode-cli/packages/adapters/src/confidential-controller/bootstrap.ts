import { z } from "zod";
import { PrivateControllerError } from "./contract.js";

const STARTUP_TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 32 * 1024 * 1024;
const bootstrapSchema = z.strictObject({
  type: z.literal("bootstrap-ready"),
  requestId: z.literal(1),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  systemPrompt: z.string().min(1).max(MAX_PROMPT_CHARS),
});
const failureSchema = z.strictObject({
  type: z.literal("failed"),
  requestId: z.literal(1),
  code: z.enum([
    "AUTHORIZATION_EXPIRED",
    "AUTHORIZATION_REJECTED",
    "AUTH_REQUIRED",
    "IDENTITY_CHANGED",
    "CANCELLED",
    "UNAVAILABLE",
    "EXECUTION_FAILED",
    "INVALID_RELEASE",
    "VERSION_CHANGED",
    "CAPACITY_EXCEEDED",
  ]),
});

/** 启动配置只读取一次；模型执行不再持有授权租约或等待 complete。 */
export function readControllerBootstrap(
  ipc: Pick<NodeJS.Process, "on" | "off" | "send" | "connected"> = process,
  signal?: AbortSignal,
): Promise<{ version: number; digest: string; systemPrompt: string }> {
  if (signal?.aborted) return Promise.reject(new PrivateControllerError("CANCELLED"));
  if (!ipc.connected || !ipc.send) return Promise.reject(new PrivateControllerError("UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ipc.off("message", receive);
      ipc.off("disconnect", disconnected);
      signal?.removeEventListener("abort", cancelled);
    };
    const fail = (code: ConstructorParameters<typeof PrivateControllerError>[0]) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PrivateControllerError(code));
    };
    const disconnected = () => fail("UNAVAILABLE");
    const cancelled = () => fail("CANCELLED");
    const receive = (message: unknown) => {
      if (settled) return;
      const failure = failureSchema.safeParse(message);
      if (failure.success) return fail(failure.data.code);
      const parsed = bootstrapSchema.safeParse(message);
      if (!parsed.success) return fail("INVALID_RELEASE");
      settled = true;
      cleanup();
      const { version, digest, systemPrompt } = parsed.data;
      resolve({ version, digest, systemPrompt });
    };
    const timer = setTimeout(disconnected, STARTUP_TIMEOUT_MS);
    timer.unref();
    ipc.on("message", receive);
    ipc.on("disconnect", disconnected);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      ipc.send!({ type: "bootstrap", requestId: 1 }, (error: Error | null) => {
        if (error) disconnected();
      });
    } catch {
      disconnected();
    }
  });
}
