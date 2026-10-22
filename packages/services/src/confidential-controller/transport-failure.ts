import { ConfidentialControllerError } from "./contract.js";

type TransportFailure = "unavailable-connection" | "unavailable-timeout";

/** Module-private evidence only; never an authorization to use another source. */
export class ControllerTransportFailure extends ConfidentialControllerError {
  constructor(readonly transportFailure: TransportFailure) {
    super(transportFailure === "unavailable-timeout" ? "CANCELLED" : "UNAVAILABLE");
  }
}

export function isControllerTransportFailure(error: unknown): error is ControllerTransportFailure {
  return error instanceof ControllerTransportFailure;
}

const connectionCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isControllerConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  const cause = error.cause;
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  // 只读 Node fetch 的一层 errno；未知/TLS 外层或内层码不能被连接码覆盖。
  const codes = [code, causeCode].filter((value) => value !== undefined && value !== "");
  return (
    codes.length > 0 &&
    codes.every((value) => typeof value === "string" && connectionCodes.has(value))
  );
}
