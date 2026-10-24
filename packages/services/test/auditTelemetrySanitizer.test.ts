import { describe, expect, it } from "vitest";
import {
  AUDIT_TELEMETRY_SANITIZED_SUMMARY_MAX,
  redactSecrets,
  sanitizeErrorPayload,
  serializeAuditTelemetryEvent,
} from "../src/audit-telemetry/index.js";
import {
  COMPLETE_ATTRIBUTION,
  testRuntimeErrorEvent,
} from "./auditTelemetryFixtures.js";

/**
 * 脱敏负面清单单测（spec §5.1.6 / 验收 AT-1、AT-3）：
 * 构造含凭据样本的原始 ErrorPayload，投影 + 组信封序列化后对 token 全文检索零命中。
 */

const SK_TOKEN = "sk-proj-4f8A9b2C7d1E6f3G5h8J0k2L4m6N8p9Q1r";
const JWT_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const HIGH_ENTROPY_SECRET = "Fu9jN2mL5pQ8rT4vW7xY1zA3bC6dE0fG";
const BEARER_TOKEN = "Bearer Ya9b8c7d6e5f4g3h2i1j0k9l8m7n6o5p";

describe("audit telemetry sanitizer", () => {
  it("masks every credential sample in free text with zero full-token residue", () => {
    const text = `request failed: key=${SK_TOKEN} jwt=${JWT_TOKEN} secret=${HIGH_ENTROPY_SECRET} header=${BEARER_TOKEN}`;
    const masked = redactSecrets(text);
    expect(masked).not.toContain(SK_TOKEN);
    expect(masked).not.toContain(JWT_TOKEN);
    expect(masked).not.toContain(HIGH_ENTROPY_SECRET);
    expect(masked).not.toContain(BEARER_TOKEN.slice("Bearer ".length));
    expect(masked).toContain("[REDACTED:key]");
    expect(masked).toContain("[REDACTED:jwt]");
    expect(masked).toContain("[REDACTED:high-entropy]");
    expect(masked).toContain("[REDACTED:bearer]");
  });

  it("keeps ordinary words and lowercase hex digests readable", () => {
    const digest =
      "6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a";
    const masked = redactSecrets(
      `model xxx1 failed after 3 retries; digest=${digest}`,
    );
    expect(masked).toContain(digest);
    expect(masked).toContain("model xxx1 failed after 3 retries");
  });

  it("drops raw error fields and leaks no token through the full envelope (AT-1/AT-3 判据)", () => {
    const rawError = {
      type: "ModelApiError",
      code: "provider_401",
      message: `auth rejected for ${SK_TOKEN} via ${JWT_TOKEN} with ${BEARER_TOKEN}`,
      detail: `internal detail contains ${HIGH_ENTROPY_SECRET}`,
      underlyingErrorMessage: `deep cause ${BEARER_TOKEN}`,
      stack: `Error: boom\n    at ModelRunner.request (E:\\repo\\src\\runner.ts:42:19)\n    token=${SK_TOKEN}`,
      data: { responseBody: `{"accessToken":"${HIGH_ENTROPY_SECRET}"}` },
      attribution: {
        source: "provider",
        reason: "free text reason with sk-not-a-token",
        errorPhase: "response",
        exceptionKind: "transport",
        statusCode: 401,
        retryable: true,
        providerId: "bigmodel",
      },
    };
    const sanitized = sanitizeErrorPayload(rawError);
    // 原文字段与自由文本一律不出现在投影键集里（负面清单 #7 + 可聚合纪律）。
    for (const forbiddenKey of [
      "message",
      "detail",
      "underlyingErrorMessage",
      "underlyingErrorDetail",
      "stack",
      "data",
      "type",
      "code",
      "source",
      "reason",
      "providerId",
    ]) {
      expect(sanitized).not.toHaveProperty(forbiddenKey);
    }
    expect(sanitized).toEqual({
      sanitizedSummary: expect.any(String),
      errorPhase: "response",
      exceptionKind: "transport",
      retryable: true,
      statusCode: 401,
    });
    // 信封级全文检索：出网字节对 token 全文零命中。
    const event = {
      ...testRuntimeErrorEvent({ attribution: COMPLETE_ATTRIBUTION }),
      payload: { errorCode: "AGENT_AUTHENTICATION", ...sanitized },
    };
    const serialized = serializeAuditTelemetryEvent(event);
    for (const secret of [
      SK_TOKEN,
      JWT_TOKEN,
      HIGH_ENTROPY_SECRET,
      "Ya9b8c7d6e5f4g3h2i1j0k9l8m7n6o5p",
    ]) {
      expect(serialized.includes(secret)).toBe(false);
    }
    expect(serialized).not.toContain("internal detail");
    expect(serialized).not.toContain("responseBody");
    expect(serialized).not.toContain("accessToken");
  });

  it("truncates sanitizedSummary to the 512-character cap and collapses whitespace", () => {
    const long = `failure ${"a".repeat(2000)}`;
    const sanitized = sanitizeErrorPayload({ message: long });
    expect(sanitized.sanitizedSummary.length).toBe(
      AUDIT_TELEMETRY_SANITIZED_SUMMARY_MAX,
    );
    expect(sanitized.sanitizedSummary.startsWith("failure ")).toBe(true);
    const multiline = sanitizeErrorPayload({
      message: "line1\n\tline2\r\nline3",
    });
    expect(multiline.sanitizedSummary).toBe("line1 line2 line3");
    const controlChars = sanitizeErrorPayload({
      message: "bad\u0007bell\u001f end",
    });
    expect(controlChars.sanitizedSummary).toBe("badbell end");
  });

  it("falls back to a placeholder summary when no message text exists", () => {
    expect(sanitizeErrorPayload({}).sanitizedSummary).toBe("[no-summary]");
    expect(sanitizeErrorPayload({ message: "   " }).sanitizedSummary).toBe(
      "[no-summary]",
    );
    expect(
      sanitizeErrorPayload({ underlyingErrorMessage: "fallback text" })
        .sanitizedSummary,
    ).toBe("fallback text");
  });

  it("drops aggregation values outside the fixed vocabularies", () => {
    const sanitized = sanitizeErrorPayload({
      message: "boom",
      attribution: {
        errorPhase: "not-a-phase",
        exceptionKind: "not-a-kind",
        statusCode: 42,
      },
    });
    expect(sanitized).not.toHaveProperty("errorPhase");
    expect(sanitized).not.toHaveProperty("exceptionKind");
    expect(sanitized.statusCode).toBe(42);
  });
});
