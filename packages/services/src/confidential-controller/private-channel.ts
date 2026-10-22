import {
  ConfidentialControllerError,
  type ControllerBootstrap,
  type ControllerLease,
  type ControllerPrivateChannel,
  type ControllerPrivateCommand,
  type ControllerPrivateEvent,
} from "./contract.js";
import { waitForCaller } from "./cancellation.js";

const MAX_ACTIVE_CALLS = 8;
const CORE_SKILL_ID = "controller";

interface PendingCall {
  abort: AbortController;
  complete?: () => void;
}

/** One trusted process connection. Holds call correlation only, never task state. */
export function createControllerPrivateChannel(options: {
  getBootstrap?(): Promise<ControllerBootstrap>;
  acquire?(input: {
    skillId: string;
    version?: number;
    signal: AbortSignal;
  }): Promise<ControllerLease>;
  /** Synchronous private transport; must throw if delivery cannot be queued. Never log payload. */
  send(event: ControllerPrivateEvent): void;
  /** Owner must close the process port so the consumer cancels outstanding calls. */
  close(): void;
}): ControllerPrivateChannel {
  const pending = new Map<number, PendingCall>();
  let lastRequestId = 0;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const call of pending.values()) call.abort.abort();
    pending.clear();
    try {
      options.close();
    } catch {
      /* Transport teardown must not expose payload errors. */
    }
  };
  const send = (event: ControllerPrivateEvent) => {
    if (disposed) return;
    try {
      options.send(event);
    } catch {
      // 子进程关闭可能使发送失败；不能把包含正文的异常向通用日志传播。
      dispose();
    }
  };
  const run = async (
    command: Extract<ControllerPrivateCommand, { type: "acquire" }>,
    call: PendingCall,
  ) => {
    try {
      if (!options.acquire) throw new ConfidentialControllerError("UNAVAILABLE");
      const lease = await options.acquire({
        skillId: CORE_SKILL_ID,
        version: command.version,
        signal: call.abort.signal,
      });
      await lease.use(async (instruction, signal) => {
        if (signal.aborted || disposed) throw new ConfidentialControllerError("CANCELLED");
        let removeAbortListener = () => {};
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new ConfidentialControllerError("CANCELLED"));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          call.complete = resolve;
          send({
            type: "ready",
            requestId: command.requestId,
            version: lease.version,
            digest: lease.digest,
            instruction,
          });
          // 同步发送失败/重入取消也必须结束等待，不能留下存活的正文闭包。
          if (signal.aborted || disposed) onAbort();
        }).finally(() => {
          removeAbortListener();
          call.complete = undefined;
        });
      }, call.abort.signal);
      send({ type: "completed", requestId: command.requestId });
    } catch (error) {
      send({
        type: "failed",
        requestId: command.requestId,
        code: error instanceof ConfidentialControllerError ? error.code : "UNAVAILABLE",
      });
    } finally {
      pending.delete(command.requestId);
    }
  };
  const runBootstrap = async (
    command: Extract<ControllerPrivateCommand, { type: "bootstrap" }>,
    call: PendingCall,
  ) => {
    try {
      if (!options.getBootstrap) throw new ConfidentialControllerError("UNAVAILABLE");
      const configuration = await waitForCaller(options.getBootstrap(), call.abort.signal);
      if (call.abort.signal.aborted) throw new ConfidentialControllerError("CANCELLED");
      send({ type: "bootstrap-ready", requestId: command.requestId, ...configuration });
    } catch (error) {
      send({
        type: "failed",
        requestId: command.requestId,
        code: error instanceof ConfidentialControllerError ? error.code : "UNAVAILABLE",
      });
    } finally {
      pending.delete(command.requestId);
    }
  };
  return {
    dispose,
    invalidate() {
      for (const call of pending.values()) call.abort.abort();
      pending.clear();
      send({ type: "invalidated" });
    },
    receive(message) {
      if (disposed) return;
      const command = parseControllerPrivateCommand(message);
      if (!command) {
        dispose();
        return;
      }
      if (command.type === "acquire" || command.type === "bootstrap") {
        if (command.requestId <= lastRequestId) {
          dispose();
          return;
        }
        lastRequestId = command.requestId;
        if (pending.size >= MAX_ACTIVE_CALLS) {
          send({ type: "failed", requestId: command.requestId, code: "CAPACITY_EXCEEDED" });
          return;
        }
        const call: PendingCall = { abort: new AbortController() };
        pending.set(command.requestId, call);
        if (command.type === "bootstrap") void runBootstrap(command, call);
        else void run(command, call);
      } else {
        const call = pending.get(command.requestId);
        if (!call) return;
        if (command.type === "cancel") call.abort.abort();
        else if (call.complete) call.complete();
        else {
          dispose();
        }
      }
    },
  };
}

export function parseControllerPrivateCommand(
  value: unknown,
): ControllerPrivateCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const command = value as Record<string, unknown>;
  if (
    typeof command.requestId !== "number" ||
    !Number.isSafeInteger(command.requestId) ||
    command.requestId <= 0
  )
    return;
  if (command.type === "acquire") {
    if (Object.keys(command).some((key) => !["type", "requestId", "version"].includes(key))) return;
    if (
      command.version !== undefined &&
      (typeof command.version !== "number" ||
        !Number.isSafeInteger(command.version) ||
        command.version <= 0)
    )
      return;
    return {
      type: "acquire",
      requestId: command.requestId,
      ...(typeof command.version === "number" ? { version: command.version } : {}),
    };
  }
  if (
    (command.type === "bootstrap" || command.type === "complete" || command.type === "cancel") &&
    Object.keys(command).every((key) => key === "type" || key === "requestId")
  )
    return { type: command.type, requestId: command.requestId };
}
