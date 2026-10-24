import { z } from "zod";
import { PrivateControllerError } from "./contract.js";

export interface LockedContentPort {
  on(event: "message" | "close", listener: (event: { data?: unknown } | unknown) => void): void;
  off?(event: "message" | "close", listener: (event: { data?: unknown } | unknown) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

const id = z.number().int().positive().safe();
const response = z.discriminatedUnion("type", [
  z.object({ type: z.literal("locked-content-ready"), requestId: id, version: id, digest: z.string().regex(/^[a-f0-9]{64}$/), skillMd: z.string().min(1).max(32 * 1024 * 1024) }).strict(),
  z.object({ type: z.literal("failed"), requestId: id, code: z.enum(["AUTHORIZATION_EXPIRED", "AUTHORIZATION_REJECTED", "AUTH_REQUIRED", "IDENTITY_CHANGED", "CANCELLED", "UNAVAILABLE", "EXECUTION_FAILED", "INVALID_RELEASE", "VERSION_CHANGED", "CAPACITY_EXCEEDED"]) }).strict(),
]);

export function createLockedContentClient(port: LockedContentPort, options?: { timeoutMs?: number; now?: () => number }) {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: { version: number; digest: string; skillMd: string }) => void; reject: (error: PrivateControllerError) => void; timer: ReturnType<typeof setTimeout> }>();
  const onMessage = (event: { data?: unknown } | unknown) => {
    const parsed = response.safeParse(typeof event === "object" && event !== null && "data" in event ? event.data : event);
    if (!parsed.success) return;
    const call = pending.get(parsed.data.requestId);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(parsed.data.requestId);
    if (parsed.data.type === "failed") call.reject(new PrivateControllerError(parsed.data.code));
    else call.resolve(parsed.data);
  };
  const unavailable = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new PrivateControllerError("UNAVAILABLE")); } pending.clear(); };
  port.on("message", onMessage); port.on("close", unavailable); port.start?.();
  return { load(): Promise<{ version: number; digest: string; skillMd: string }> {
    const requestId = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new PrivateControllerError("UNAVAILABLE")); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { port.postMessage({ type: "locked-content", requestId }); } catch { clearTimeout(timer); pending.delete(requestId); reject(new PrivateControllerError("UNAVAILABLE")); }
    });
  } };
}
