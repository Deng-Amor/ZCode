import { MANAGED_SKILL_BUNDLE_LIMITS } from "@zcode/shared/managed-skills";
import { waitForCaller } from "./cancellation.js";
import {
  ConfidentialControllerError,
  type ConfidentialControllerSource,
  type ControllerGrant,
  type ControllerHttpSourceOptions,
  type ControllerIdentity,
} from "./contract.js";
import { ControllerTransportFailure, isControllerConnectionFailure } from "./transport-failure.js";

/** Private Node-side transport. Never use a browser cache or expose responses to renderer. */
export function createControllerHttpSource(
  options: ControllerHttpSourceOptions,
): ConfidentialControllerSource {
  const base = new URL(options.apiBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new ConfidentialControllerError("INVALID_RELEASE");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ConfidentialControllerError("INVALID_RELEASE");
  }

  async function post(
    path: string,
    identity: ControllerIdentity,
    body: object,
    parentSignal: AbortSignal,
    maxBytes: number,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([parentSignal, timeoutSignal]);
    let fetchStarted = false;
    let response: Response | undefined;
    const classify = (error: unknown): ConfidentialControllerError => {
      // 调用方取消优先；身份拒绝和已固定的协议失败不因超时取得备用候选资格。
      if (parentSignal.aborted) return new ConfidentialControllerError("CANCELLED");
      if (error instanceof ConfidentialControllerError) return error;
      if (fetchStarted) {
        if (
          timeoutSignal.aborted &&
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        )
          return new ControllerTransportFailure("unavailable-timeout");
        if (!signal.aborted && isControllerConnectionFailure(error)) {
          return new ControllerTransportFailure("unavailable-connection");
        }
      }
      return new ConfidentialControllerError(signal.aborted ? "CANCELLED" : "UNAVAILABLE");
    };
    try {
      const token = await waitForCaller(options.getAccessToken(identity, signal), signal);
      if (signal.aborted) throw new ConfidentialControllerError("CANCELLED");
      if (!token) throw new ConfidentialControllerError("AUTH_REQUIRED");
      fetchStarted = true;
      response = await fetch(new URL(path, base), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "tenant-id": identity.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new ConfidentialControllerError("AUTH_REQUIRED");
      }
      if (
        !response.ok ||
        !response.headers.get("content-type")?.toLowerCase().includes("application/json")
      ) {
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
      if (
        !response.headers
          .get("cache-control")
          ?.toLowerCase()
          .split(",")
          .some((part) => part.trim() === "no-store")
      ) {
        throw new ConfidentialControllerError("INVALID_RELEASE");
      }
      const result = await readBoundedJson(response, maxBytes, classify);
      if (!isRecord(result) || typeof result.code !== "number") {
        throw new ConfidentialControllerError("INVALID_RELEASE");
      }
      // HTTP成功但业务拒绝（包括撤销）的事实不能误当网络故障进入重试兜底。
      if (result.code !== 0) throw new ConfidentialControllerError("AUTHORIZATION_REJECTED");
      if (!("data" in result)) throw new ConfidentialControllerError("INVALID_RELEASE");
      return result.data;
    } catch (error) {
      throw classify(error);
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  return {
    async authorize({ identity, skillId, version, signal }): Promise<ControllerGrant> {
      const data = await post(
        "system/ccode-controller/authorize",
        identity,
        { skillId, version },
        signal,
        8192,
      );
      if (
        !isRecord(data) ||
        typeof data.skillId !== "string" ||
        typeof data.version !== "number" ||
        typeof data.digest !== "string" ||
        typeof data.expiresAt !== "number"
      )
        throw new ConfidentialControllerError("INVALID_RELEASE");
      return {
        skillId: data.skillId,
        version: data.version,
        digest: data.digest,
        expiresAt: data.expiresAt,
      };
    },
    download({ identity, grant, signal }) {
      return post(
        "system/ccode-controller/content",
        identity,
        {
          skillId: grant.skillId,
          version: grant.version,
          digest: grant.digest,
        },
        signal,
        MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes + 8192,
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  classify: (error: unknown) => ConfidentialControllerError,
): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    throw new ConfidentialControllerError("INVALID_RELEASE");
  }
  if (!response.body) throw new ConfidentialControllerError("INVALID_RELEASE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ConfidentialControllerError("INVALID_RELEASE");
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      // 解析失败已是终止事实，必须在异步清理前固定，不能被迟到超时改判。
      throw new ConfidentialControllerError("UNAVAILABLE");
    }
  } catch (error) {
    throw classify(error);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
