/**
 * ccode-platform-runtime 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import type { AuditTelemetryPolicyGate, AuditTelemetryQueue, AuditTelemetryUploadScheduler } from "#src/audit-telemetry/index.js";
import type { ExpertSkillCacheStore } from "#src/expert-skills/index.js";
import type { SkillReflowStatus, SkillReflowUploadService } from "#src/skill-reflow-upload/index.js";
import type { CommandChannelPolicy, CommandChannelProcessResult, CommandChannelProcessor } from "#src/platform-command-channel/index.js";

export interface CcodePlatformRuntimeConfig {
  readonly storageDirectory: string;
  readonly auditTelemetry?: { readonly queueLimits?: { readonly maxRecords?: number; readonly maxBytes?: number }; readonly samplingRate?: number; readonly visibility?: "silent" | "announced" };
  readonly expertSkills?: { readonly maxEntries?: number; readonly maxTotalBytes?: number };
  readonly skillReflow?: { readonly trigger?: Record<string, unknown> };
  readonly commandChannelPolicy?: Partial<CommandChannelPolicy>;
}

export interface CcodePlatformRuntimeDeps {
  readonly createAudit: (config: CcodePlatformRuntimeConfig, deps: CcodePlatformRuntimeDeps) => { readonly queue: AuditTelemetryQueue; readonly policyGate: AuditTelemetryPolicyGate; readonly scheduler: AuditTelemetryUploadScheduler };
  readonly createExpert: (config: CcodePlatformRuntimeConfig, deps: CcodePlatformRuntimeDeps) => ExpertSkillCacheStore;
  readonly createReflow: (config: CcodePlatformRuntimeConfig, deps: CcodePlatformRuntimeDeps) => SkillReflowUploadService;
  readonly createCommandChannel: (config: CcodePlatformRuntimeConfig, deps: CcodePlatformRuntimeDeps) => CommandChannelProcessor;
  readonly startTransport?: () => Promise<void> | void;
  readonly stopTransport?: () => Promise<void> | void;
}

export interface CcodePlatformRuntimeStatus { readonly started: boolean; readonly disposed: boolean; readonly skillReflow: SkillReflowStatus; readonly auditQueue: Awaited<ReturnType<AuditTelemetryQueue["stats"]>>; readonly commandChannelPolicy: CommandChannelPolicy; }
export interface CcodePlatformRuntime {
  readonly auditTelemetry: { readonly queue: AuditTelemetryQueue; readonly policyGate: AuditTelemetryPolicyGate; readonly scheduler: AuditTelemetryUploadScheduler };
  readonly expertSkills: ExpertSkillCacheStore;
  readonly skillReflow: SkillReflowUploadService;
  readonly commandChannel: CommandChannelProcessor;
  start(): Promise<void>; stop(): Promise<void>; dispose(): Promise<void>; status(): Promise<CcodePlatformRuntimeStatus>;
  processCommand(envelope: unknown): Promise<CommandChannelProcessResult>;
}
