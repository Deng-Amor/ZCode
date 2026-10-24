import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_TELEMETRY_POLICY,
  DEFAULT_DIAGNOSTIC_SAMPLING_RATE,
  createAuditTelemetryPolicyGate,
} from "../src/audit-telemetry/index.js";
import type { AuditTelemetryManagementPolicy } from "../src/audit-telemetry/index.js";

/** 策略位与采样计数单测（spec §6.4 / 验收 AT-7 的客户端侧判据）。 */

describe("audit telemetry policy gate", () => {
  it("defaults to silent visibility, full lifecycle and sampled diagnostics", () => {
    const policy = DEFAULT_AUDIT_TELEMETRY_POLICY;
    // 2026-10-22 A3 拍板：甲案（静默后台）为默认口径；乙案保留为管理端策略位。
    expect(policy.visibility).toBe("silent");
    expect(policy.channels.lifecycle.enabled).toBe(true);
    expect(policy.channels.diagnostic.enabled).toBe(true);
    expect(policy.channels.diagnostic.samplingRate).toBe(
      DEFAULT_DIAGNOSTIC_SAMPLING_RATE,
    );
    const gate = createAuditTelemetryPolicyGate(policy);
    expect(gate.decide("lifecycle")).toBe("enqueue");
    expect(gate.decide("lifecycle", 0.999)).toBe("enqueue");
  });

  it("drops lifecycle events only when the tenant policy disables the channel", () => {
    const policy: AuditTelemetryManagementPolicy = {
      ...DEFAULT_AUDIT_TELEMETRY_POLICY,
      channels: {
        ...DEFAULT_AUDIT_TELEMETRY_POLICY.channels,
        lifecycle: { enabled: false },
      },
    };
    const gate = createAuditTelemetryPolicyGate(policy);
    expect(gate.decide("lifecycle")).toBe("dropped-by-policy");
    expect(gate.decide("lifecycle")).toBe("dropped-by-policy");
    expect(gate.counters()).toEqual({ droppedByPolicy: 2, droppedSampled: 0 });
  });

  it("counts droppedSampled for diagnostic events outside the sampling window", () => {
    const gate = createAuditTelemetryPolicyGate();
    // 默认采样率 0.1：注入 random 判定（draw >= rate 被采样丢弃）。
    expect(gate.decide("diagnostic", 0.099)).toBe("enqueue");
    expect(gate.decide("diagnostic", 0.1)).toBe("dropped-sampled");
    expect(gate.decide("diagnostic", 0.999)).toBe("dropped-sampled");
    expect(gate.counters()).toEqual({ droppedByPolicy: 0, droppedSampled: 2 });
  });

  it("supports the tenant policy that disables diagnostics entirely (仅生命周期档)", () => {
    const policy: AuditTelemetryManagementPolicy = {
      visibility: "announced",
      channels: {
        lifecycle: { enabled: true },
        diagnostic: { enabled: false, samplingRate: 0.5 },
      },
    };
    const gate = createAuditTelemetryPolicyGate(policy);
    expect(gate.decide("diagnostic", 0)).toBe("dropped-by-policy");
    expect(gate.decide("lifecycle")).toBe("enqueue");
    expect(gate.counters()).toEqual({ droppedByPolicy: 1, droppedSampled: 0 });
  });

  it("treats sampling boundaries deterministically", () => {
    const policy: AuditTelemetryManagementPolicy = {
      ...DEFAULT_AUDIT_TELEMETRY_POLICY,
      channels: {
        ...DEFAULT_AUDIT_TELEMETRY_POLICY.channels,
        diagnostic: { enabled: true, samplingRate: 0.25 },
      },
    };
    const gate = createAuditTelemetryPolicyGate(policy);
    expect(gate.decide("diagnostic", 0)).toBe("enqueue");
    expect(gate.decide("diagnostic", 0.2499)).toBe("enqueue");
    expect(gate.decide("diagnostic", 0.25)).toBe("dropped-sampled");
    // rate=0 → 全部被采样丢弃；rate=1 → 全部入队。
    const zero = createAuditTelemetryPolicyGate({
      ...policy,
      channels: {
        ...policy.channels,
        diagnostic: { enabled: true, samplingRate: 0 },
      },
    });
    expect(zero.decide("diagnostic", 0)).toBe("dropped-sampled");
    const one = createAuditTelemetryPolicyGate({
      ...policy,
      channels: {
        ...policy.channels,
        diagnostic: { enabled: true, samplingRate: 1 },
      },
    });
    expect(one.decide("diagnostic", 0.999)).toBe("enqueue");
  });

  it("fails fast on an out-of-range sampling rate instead of silently clamping", () => {
    for (const samplingRate of [-0.1, 1.5, Number.NaN]) {
      expect(() =>
        createAuditTelemetryPolicyGate({
          ...DEFAULT_AUDIT_TELEMETRY_POLICY,
          channels: {
            ...DEFAULT_AUDIT_TELEMETRY_POLICY.channels,
            diagnostic: { enabled: true, samplingRate },
          },
        }),
      ).toThrow(RangeError);
    }
  });
});
