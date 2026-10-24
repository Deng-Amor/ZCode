import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import {
  createCcodePlatformRuntime,
  type CcodePlatformRuntime,
  type CcodePlatformRuntimeDeps,
} from "@zcode/services/ccode-platform-runtime";
import { createAuditTelemetryDiskQueue, createAuditTelemetryHttpUploader, createAuditTelemetryPolicyGate, createAuditTelemetryUploadScheduler, createDiagnosticBundleTrigger, DEFAULT_AUDIT_TELEMETRY_POLICY } from "@zcode/services/audit-telemetry";
import { createExpertSkillCacheStore } from "@zcode/services/expert-skills";
import { createSkillReflowHttpUploader, createSkillReflowLedgerFile, createSkillReflowQueueFile, createSkillReflowRootsProvider, createSkillReflowUploadDriver, createSkillReflowUploadService, type SkillReflowPlatform } from "@zcode/services/skill-reflow-upload";
import { createCommandChannelDiskStore, createCommandChannelProcessor, createLongPollTransport, createNotCollectedSource, createPullChatLogsExecutor, createPullRunLogsExecutor, createPullSkillUsageStatsExecutor, createRunLogsSource, DEFAULT_COMMAND_CHANNEL_POLICY } from "@zcode/services/platform-command-channel";
import type { DesktopCcodePlatformRuntimeWiring, DesktopCcodePlatformRuntimeWiringOptions } from "./contract.js";

export function createDesktopCcodePlatformRuntimeWiring(options: DesktopCcodePlatformRuntimeWiringOptions): DesktopCcodePlatformRuntimeWiring {
  const warn = options.warn ?? (() => undefined);
  let runtime: CcodePlatformRuntime | undefined;
  let transport: { start(): Promise<void>; stop(): Promise<void> } | undefined;
  let disposed = false;
  let lastAuthenticated: boolean | undefined;
  let active = false;
  let transition: Promise<void> = Promise.resolve();
  let diagnosticTrigger: ReturnType<typeof createDiagnosticBundleTrigger> | undefined;
  const authFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await options.account.getAuthHeaders())) headers.set(name, value);
    return (options.fetchImpl ?? fetch)(input, { ...init, headers });
  };
  const build = async () => {
    if (runtime) return runtime;
    const state = await options.account.getState();
    if (!state.authenticated) return undefined;
    const identity = { tenantId: state.tenantId ?? "unknown", userId: state.userId ?? "unknown" };
    const tokenProvider = { getHeaders: () => options.account.getAuthHeaders() };
    const deps: CcodePlatformRuntimeDeps = {
      createAudit: () => {
        const queue = createAuditTelemetryDiskQueue({ storageDirectory: options.storageDirectory, identity });
        const policyGate = createAuditTelemetryPolicyGate(DEFAULT_AUDIT_TELEMETRY_POLICY);
        const scheduler = createAuditTelemetryUploadScheduler({ queue, uploader: createAuditTelemetryHttpUploader({ baseUrl: options.apiBaseUrl, tokenProvider, fetchImpl: authFetch }), timers: { now: Date.now, schedule: (cb, ms) => setTimeout(cb, ms) as unknown as number, cancel: (id) => clearTimeout(id) } });
        if (options.diagnosticArchiveBuilder) {
          diagnosticTrigger = createDiagnosticBundleTrigger({
            builder: options.diagnosticArchiveBuilder,
            policyGate,
            queue,
            attribution: {
              ccodeRelease: options.ccodeRelease ?? "dev",
              platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
            },
          });
        }
        return { queue, policyGate, scheduler };
      },
      createExpert: () => createExpertSkillCacheStore({ baseDir: join(options.storageDirectory, "expert-skills") }),
      createReflow: () => {
        const queue = createSkillReflowQueueFile({ storageDirectory: options.storageDirectory });
        let driver: ReturnType<typeof createSkillReflowUploadDriver>;
        const service = createSkillReflowUploadService({
          rootProvider: createSkillReflowRootsProvider({ homeDirectory: options.homeDirectory, workingDirectory: options.workingDirectory }),
          ledger: createSkillReflowLedgerFile({ storageDirectory: options.storageDirectory }),
          queue,
          stateDirectory: options.storageDirectory,
          onTriggerSession: (outcome) => {
            if (outcome.triggered) void driver.run("dailyFirstLaunch");
          },
        });
        const uploader = createSkillReflowHttpUploader({
          baseUrl: options.apiBaseUrl,
          tokenProvider,
          attribution: {
            ccodeRelease: options.ccodeRelease ?? "dev",
            platform: (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux") satisfies SkillReflowPlatform,
          },
          fetchImpl: authFetch,
        });
        driver = createSkillReflowUploadDriver({ service, queue, uploader });
        return service;
      },
      createCommandChannel: () => createCommandChannelProcessor({ verifier: { verify: async (envelope) => { try { const key = createPublicKey(options.commandSignerPublicKeyPem); return verify(null, Buffer.from(JSON.stringify(envelope)), key, Buffer.from(envelope.signature, "base64")); } catch { return false; } } }, executor: { execute: async (command) => {
  // run-logs 源给近 31 天宽窗口+大分页；执行体按指令 scope 再过滤（executors.ts 为唯一范围判定，窗口上限 31 天）。
  // chat-logs / skill-usage 如实 NOT_COLLECTED（OQ-12 门控未开/统计存储未落地，stub-sources.ts 注释为凭）。
  if (command.type === "command.pull_run_logs") {
    const to = Date.now();
    return createPullRunLogsExecutor({ source: createRunLogsSource({ from: new Date(to - 31 * 24 * 60 * 60 * 1000).toISOString(), to: new Date(to).toISOString(), pageSize: Number.MAX_SAFE_INTEGER }) }).execute(command);
  }
  if (command.type === "command.pull_chat_logs") return createPullChatLogsExecutor({ source: createNotCollectedSource() }).execute(command);
  return createPullSkillUsageStatsExecutor({ source: createNotCollectedSource() }).execute(command);
} }, noticeSink: { dispatch: async () => {} }, auditSink: { record: async () => {} }, store: createCommandChannelDiskStore({ storageDirectory: options.storageDirectory, identity }), getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY, now: () => new Date() }),
      startTransport: async () => transport?.start(), stopTransport: async () => transport?.stop(),
    };
    runtime = options.createRuntime?.(deps) ?? createCcodePlatformRuntime({ storageDirectory: options.storageDirectory }, deps);
    const processEnvelope = (envelope: unknown) => runtime!.processCommand(envelope);
    const raw = createLongPollTransport({ endpoint: new URL("system/ccode-commands/poll", options.apiBaseUrl).toString(), fetchImpl: authFetch, processEnvelope });
    transport = options.createTransport?.(raw) ?? raw;
    return runtime;
  };
  const sync = async () => { if (disposed) return; try { const state = await options.account.getState(); if (lastAuthenticated === state.authenticated && runtime) return; lastAuthenticated = state.authenticated; const current = await build(); if (!current) return; if (state.authenticated) { if (!active) { await current.start(); active = true; void diagnosticTrigger?.runDailyDigest(); } } else if (active) { await current.stop(); active = false; } } catch (error) { warn("CCode platform runtime state transition failed", error); void diagnosticTrigger?.triggerOnError("controller_bootstrap_failed"); } };
  const unsubscribe = options.account.onStateChanged(() => { transition = transition.then(sync); });
  void sync();
  return {
    fetch: authFetch,
    // build 前没有 diagnosticTrigger；未登录或未配置 builder 时按契约静默 no-op。
    reportDiagnosticErrorTrigger: (reason) => { void diagnosticTrigger?.triggerOnError(reason); },
    dispose: async () => { if (disposed) return; disposed = true; unsubscribe(); transition = transition.then(async () => { try { if (active) await runtime?.stop(); active = false; await runtime?.dispose(); } catch (error) { warn("CCode platform runtime dispose failed", error); } }); await transition; },
  };
}
