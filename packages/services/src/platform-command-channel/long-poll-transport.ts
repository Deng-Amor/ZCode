import type { CommandChannelProcessor } from "./contract.js";

export interface LongPollTransportOptions {
  readonly endpoint: string;
  readonly cursor?: string;
  readonly cursorParam?: string;
  readonly fetchImpl?: typeof fetch;
  readonly processEnvelope?: CommandChannelProcessor["processEnvelope"] | ((envelope: unknown) => Promise<unknown>);
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly backoff?: { readonly initialMs?: number; readonly multiplier?: number; readonly maxMs?: number };
}

export interface LongPollTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  cursor(): string | undefined;
}

export class CommandChannelTransportError extends Error {
  constructor(readonly code: "TRANSPORT_HTTP_ERROR" | "TRANSPORT_NETWORK_ERROR" | "TRANSPORT_MALFORMED_RESPONSE", message: string) {
    super(message);
    this.name = "CommandChannelTransportError";
  }
}

type PollPayload = { readonly envelopes?: readonly unknown[]; readonly envelope?: unknown; readonly nextCursor?: string };

export function createLongPollTransport(options: LongPollTransportOptions): LongPollTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const backoff = { initialMs: 250, multiplier: 2, maxMs: 30_000, ...options.backoff };
  const cursorParam = options.cursorParam ?? "cursor";
  let currentCursor = options.cursor;
  let stopped = false;
  let running: Promise<void> | undefined;

  async function poll(): Promise<void> {
    let delay = backoff.initialMs;
    while (!stopped) {
      try {
        const url = new URL(options.endpoint);
        if (currentCursor !== undefined) url.searchParams.set(cursorParam, currentCursor);
        const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
        if (!response.ok) throw new CommandChannelTransportError("TRANSPORT_HTTP_ERROR", `long poll returned ${response.status}`);
        let payload: PollPayload;
        try { payload = (await response.json()) as PollPayload; } catch { throw new CommandChannelTransportError("TRANSPORT_MALFORMED_RESPONSE", "long poll response is not JSON"); }
        if (!payload || typeof payload !== "object" || (payload.nextCursor !== undefined && typeof payload.nextCursor !== "string")) throw new CommandChannelTransportError("TRANSPORT_MALFORMED_RESPONSE", "long poll response has invalid shape");
        for (const envelope of payload.envelopes ?? (payload.envelope === undefined ? [] : [payload.envelope])) await options.processEnvelope?.(envelope);
        if (payload.nextCursor !== undefined) currentCursor = payload.nextCursor;
        delay = backoff.initialMs;
      } catch (error) {
        if (stopped) break;
        if (error instanceof CommandChannelTransportError && error.code === "TRANSPORT_MALFORMED_RESPONSE") throw error;
        await sleep(delay);
        delay = Math.min(backoff.maxMs, Math.max(backoff.initialMs, delay * backoff.multiplier));
      }
    }
  }
  return {
    start: () => { running ??= poll(); return running; },
    stop: async () => { stopped = true; await running; },
    cursor: () => currentCursor,
  };
}
