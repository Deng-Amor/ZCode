import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCcodePlatformRuntime,
  type CcodePlatformRuntime,
  type CcodePlatformRuntimeDeps,
} from "@zcode/services/ccode-platform-runtime";
import { createAuditTelemetryCollector, createAuditTelemetryDiskQueue, createAuditTelemetryHttpUploader, createAuditTelemetryPolicyGate, createAuditTelemetryUploadScheduler, createDiagnosticBundleTrigger, DEFAULT_AUDIT_TELEMETRY_POLICY, type AuditTelemetryAttribution, type AuditTelemetryRawEvent } from "@zcode/services/audit-telemetry";
import { createExpertSkillCacheStore } from "@zcode/services/expert-skills";
import { createSkillReflowHttpUploader, createSkillReflowLedgerFile, createSkillReflowQueueFile, createSkillReflowRootsProvider, createSkillReflowUploadDriver, createSkillReflowUploadService, type SkillReflowPlatform } from "@zcode/services/skill-reflow-upload";
import { createCommandChannelDiskStore, createCommandChannelProcessor, createCommandChannelReceiptUploader, createDeviceChallengeClient, createLongPollTransport, createNotCollectedSource, createPullChatLogsExecutor, createPullRunLogsExecutor, createPullSkillUsageStatsExecutor, createRunLogsSource, deviceProofHeaders, pollRequestSha256Hex, receiptsRequestSha256Hex, verifyCommandChannelEnvelopeSignature, DEFAULT_COMMAND_CHANNEL_POLICY } from "@zcode/services/platform-command-channel";
import type { DesktopCcodePlatformRuntimeWiring, DesktopCcodePlatformRuntimeWiringOptions } from "./contract.js";

export function createDesktopCcodePlatformRuntimeWiring(options: DesktopCcodePlatformRuntimeWiringOptions): DesktopCcodePlatformRuntimeWiring {
  const warn = options.warn ?? (() => undefined);
  let runtime: CcodePlatformRuntime | undefined;
  let transport: { start(): Promise<void>; stop(): Promise<void> } | undefined;
  let disposed = false;
  let runtimeIdentity: string | undefined;
  let active = false;
  let transition: Promise<void> = Promise.resolve();
  let diagnosticTrigger: ReturnType<typeof createDiagnosticBundleTrigger> | undefined;
  let collector: ReturnType<typeof createAuditTelemetryCollector> | undefined;
  let collectorSink: ((event: AuditTelemetryRawEvent) => void) | undefined;
  let currentAttribution: AuditTelemetryAttribution | undefined;
  const turnAttributions = new Map<string, Promise<AuditTelemetryAttribution | undefined>>();
  const turnKey = (taskId: string, turnId: string) => JSON.stringify([taskId, turnId]);
  const authFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await options.account.getAuthHeaders())) headers.set(name, value);
    return (options.fetchImpl ?? fetch)(input, { ...init, headers });
  };
  const build = async (identity: { tenantId: string; userId: string }) => {
    const expectedIdentity = JSON.stringify([identity.tenantId, identity.userId]);
    // 设备身份前置加载（D2/D3）：无 deviceId 时 poll/receipts 链路不建（见 runtime 创建后），
    // 幂等存储 identity 带 deviceId 隔离（重装=新 deviceId 从零，两台机器不重复执行）。
    const device = await options.deviceIdentity?.get().catch(() => undefined);
    const deviceId = device?.deviceId;
    const tokenProvider = { getHeaders: async () => {
      const before = await options.account.getState();
      if (JSON.stringify([before.tenantId, before.userId]) !== expectedIdentity || !before.authenticated) throw new Error("AUTH_REQUIRED");
      const headers = await options.account.getAuthHeaders();
      const after = await options.account.getState();
      if (JSON.stringify([after.tenantId, after.userId]) !== expectedIdentity || !after.authenticated) throw new Error("AUTH_REQUIRED");
      return headers;
    } };
    const scopedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await tokenProvider.getHeaders())) headers.set(name, value);
      return (options.fetchImpl ?? fetch)(input, { ...init, headers });
    };
    const deps: CcodePlatformRuntimeDeps = {
      createAudit: () => {
        const queue = createAuditTelemetryDiskQueue({ storageDirectory: options.storageDirectory, identity });
        const policyGate = createAuditTelemetryPolicyGate(DEFAULT_AUDIT_TELEMETRY_POLICY);
        const scheduler = createAuditTelemetryUploadScheduler({ queue, uploader: createAuditTelemetryHttpUploader({ baseUrl: options.apiBaseUrl, tokenProvider, fetchImpl: scopedFetch }), timers: { now: Date.now, schedule: (cb, ms) => setTimeout(cb, ms) as unknown as number, cancel: (id) => clearTimeout(id) } });
        collector = createAuditTelemetryCollector({
          source: { subscribe: (listener) => { collectorSink = listener; return () => { if (collectorSink === listener) collectorSink = undefined; }; } },
          attribution: () => currentAttribution!,
          queue,
          policy: policyGate,
        });
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
      createCommandChannel: () => createCommandChannelProcessor({ verifier: { verify: async (envelope) => verifyCommandChannelEnvelopeSignature(envelope, options.commandSignerPublicKeyPem) }, executor: { execute: async (command) => {
  // run-logs 源给近 31 天宽窗口+大分页；执行体按指令 scope 再过滤（executors.ts 为唯一范围判定，窗口上限 31 天）。
  // chat-logs / skill-usage 如实 NOT_COLLECTED（OQ-12 门控未开/统计存储未落地，stub-sources.ts 注释为凭）。
  if (command.type === "command.pull_run_logs") {
    const to = Date.now();
    return createPullRunLogsExecutor({ source: createRunLogsSource({ from: new Date(to - 31 * 24 * 60 * 60 * 1000).toISOString(), to: new Date(to).toISOString(), pageSize: Number.MAX_SAFE_INTEGER }) }).execute(command);
  }
  if (command.type === "command.pull_chat_logs") return createPullChatLogsExecutor({ source: createNotCollectedSource() }).execute(command);
  return createPullSkillUsageStatsExecutor({ source: createNotCollectedSource() }).execute(command);
} }, noticeSink: { dispatch: async () => {} }, auditSink: { record: async () => {} }, store: createCommandChannelDiskStore({ storageDirectory: options.storageDirectory, identity: { ...identity, ...(deviceId ? { deviceId } : {}) } }), getPolicy: () => DEFAULT_COMMAND_CHANNEL_POLICY, now: () => new Date() }),
      // 长轮询 start 返回运行至 stop 的 Promise；等待它会卡住登录启动与身份切换。
      startTransport: () => { void transport?.start().catch((error) => warn("CCode command channel poll failed", error)); },
      stopTransport: async () => transport?.stop(),
    };
    runtime = options.createRuntime?.(deps) ?? createCcodePlatformRuntime({ storageDirectory: options.storageDirectory }, deps);
    const processEnvelope = (envelope: unknown) => runtime!.processCommand(envelope);
    // 无 deviceId（未注册/身份不可用）时不建 transport：poll 不启动，receipts 无来源，
    // 避免对关闭中的服务端门无限退避；注册成功后 notifyDeviceIdentityChanged 强制重建。
    if (!deviceId || !device) {
      transport = undefined;
      return runtime;
    }
    // D2 证明头 fetch 包装：每次请求先领挑战→签名本次请求内容→注入三头；
    // 401 挑战类失败（过期/重放）领新挑战重试一次。authFetch 本体不动（skill-reflow/wiring.fetch 不受影响）。
    const challengeClient = createDeviceChallengeClient({ baseUrl: options.apiBaseUrl, tokenProvider: { getHeaders: async () => ({}) }, fetchImpl: authFetch });
    const proofHeaders = async (purpose: "poll" | "receipts", requestSha256Hex: string) => {
      const challenge = await challengeClient.fetch({ purpose, deviceId });
      return deviceProofHeaders({ challenge, deviceId, purpose, requestSha256Hex, signer: device.signer });
    };
    const deviceProofFetch = (purpose: "poll" | "receipts", requestSha256Of: (input: RequestInfo | URL, init?: RequestInit) => string): typeof fetch =>
      async (input, init) => {
        const attempt = await (async () => {
          const headers = new Headers(init?.headers);
          for (const [name, value] of Object.entries(await proofHeaders(purpose, requestSha256Of(input, init)))) headers.set(name, value);
          return authFetch(input, { ...init, headers });
        })();
        if (attempt.status !== 401) return attempt;
        // 挑战可能在校验前过期（领与用之间）：领新挑战重试一次。
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(await proofHeaders(purpose, requestSha256Of(input, init)))) headers.set(name, value);
        return authFetch(input, { ...init, headers });
      };
    const pollProofFetch: typeof fetch = (input, init) => {
      // poll 的 requestSha256=游标参数原文（URL 里无 cursor 即空串）。
      const cursor = new URL(String(input)).searchParams.get("cursor") ?? undefined;
      return deviceProofFetch("poll", () => pollRequestSha256Hex(cursor))(input, init);
    };
    const receiptsProofFetch: typeof fetch = (input, init) =>
      deviceProofFetch("receipts", (_input, innerInit) =>
        receiptsRequestSha256Hex(Buffer.from(String(innerInit?.body ?? ""), "utf8")))(input, init);
    // 回执上行（2026-10-25 与中台对齐）：缓冲 + 逐批 POST system/ccode-commands/receipts；
    // 失败保留重发（按 commandId/noticeId 幂等，中台侧消化重复），缓冲封顶丢最旧防无界增长。
    // 游标与幂等存储按 deviceId 隔离（D3）：重装=新 deviceId 自然从零，两台机器不重复执行。
    const cursorDir = join(options.storageDirectory, "command-channel");
    const cursorFile = join(cursorDir, `cursor-${deviceId}.txt`);
    const priorCursor = await readFile(cursorFile, "utf8").then((text) => {
      const trimmed = text.trim();
      return trimmed.length > 0 && trimmed.length <= 4096 ? trimmed : undefined;
    }).catch(() => undefined);
    const receiptUploader = createCommandChannelReceiptUploader({ baseUrl: options.apiBaseUrl, tokenProvider, fetchImpl: receiptsProofFetch });
    const pendingReceipts: string[] = [];
    const maxPendingReceipts = 1000;
    let flushingReceipts = false;
    const flushReceipts = async () => {
      if (flushingReceipts) return;
      flushingReceipts = true;
      try {
        while (pendingReceipts.length > 0) {
          const batch = pendingReceipts.slice(0, 100);
          const outcome = await receiptUploader.upload(batch);
          if (outcome === "accepted") pendingReceipts.splice(0, batch.length);
          else break; // auth-required / rate-limited / retryable：保留缓冲，下轮 poll 后再试。
        }
      } catch (error) {
        warn("CCode command channel receipt flush failed", error);
      } finally {
        flushingReceipts = false;
      }
    };
    const raw = createLongPollTransport({
      endpoint: new URL("system/ccode-commands/poll", options.apiBaseUrl).toString(),
      fetchImpl: pollProofFetch,
      processEnvelope,
      cursor: priorCursor,
      minEmptyPollIntervalMs: options.minEmptyPollIntervalMs,
      onPollSuccess: async (cursor) => {
        // 游标持久化：写失败不阻断轮询（最坏重复下发，靠信封幂等键消化）；异步落盘。
        if (cursor === undefined) return;
        try {
          await mkdir(cursorDir, { recursive: true });
          await writeFile(cursorFile, cursor, "utf8");
        } catch (error) {
          warn("CCode command channel cursor persist failed", error);
        }
      },
      onReceipts: (receipts) => {
        for (const receipt of receipts) {
          const serialized = (receipt as { serializedResponse?: unknown } | null | undefined)?.serializedResponse;
          if (typeof serialized !== "string") continue;
          if (pendingReceipts.length >= maxPendingReceipts) {
            pendingReceipts.shift();
            warn("CCode command channel receipt buffer overflow; dropped oldest", undefined);
          }
          pendingReceipts.push(serialized);
        }
        void flushReceipts();
      },
    });
    transport = options.createTransport?.(raw) ?? raw;
    return runtime;
  };
  const teardown = async () => {
    active = false;
    collector?.stop();
    await collector?.flush();
    try { await runtime?.stop(); await runtime?.dispose(); } finally {
      runtime = undefined; runtimeIdentity = undefined; transport = undefined;
      collector = undefined; collectorSink = undefined; diagnosticTrigger = undefined;
      currentAttribution = undefined; turnAttributions.clear();
    }
  };
  const sync = async () => {
    if (disposed) return;
    try {
      const state = await options.account.getState();
      const identity = state.authenticated && state.tenantId && state.userId
        ? { tenantId: state.tenantId, userId: state.userId } : undefined;
      const key = identity ? JSON.stringify([identity.tenantId, identity.userId]) : undefined;
      if (runtime && runtimeIdentity !== key) await teardown();
      if (!identity) return;
      if (runtime) { await runtime.auditTelemetry?.scheduler.notifyAuthenticated(); return; }
      const current = await build(identity);
      runtimeIdentity = key;
      await current.start(); active = true; collector?.start();
      await current.auditTelemetry?.scheduler.notifyAuthenticated();
      void diagnosticTrigger?.runDailyDigest();
    } catch (error) { warn("CCode platform runtime state transition failed", error); void diagnosticTrigger?.triggerOnError("controller_bootstrap_failed"); }
  };
  const unsubscribe = options.account.onStateChanged(() => { transition = transition.then(sync); });
  transition = transition.then(sync);
  return {
    fetch: authFetch,
    // build 前没有 diagnosticTrigger；未登录或未配置 builder 时按契约静默 no-op。
    reportDiagnosticErrorTrigger: (reason) => { void diagnosticTrigger?.triggerOnError(reason); },
    reportTaskStarted: async (taskId, turnId) => {
      const ccodeRelease = options.ccodeRelease;
      if (!active || !collectorSink || !options.getControllerAttribution || !options.instanceId || !ccodeRelease || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(ccodeRelease)) return;
      const identity = runtimeIdentity;
      const key = turnKey(taskId, turnId);
      if (turnAttributions.has(key)) return;
      if (turnAttributions.size >= 1000) turnAttributions.delete(turnAttributions.keys().next().value!);
      // 先登记 Promise，再读账号/锁定副本；极快的终态也能等待同一轮开始归因。
      const attribution = (async (): Promise<AuditTelemetryAttribution | undefined> => {
        const state = await options.account.getState();
        if (!state.authenticated || JSON.stringify([state.tenantId, state.userId]) !== identity) return undefined;
        const controller = await options.getControllerAttribution!();
        return {
          ccodeRelease,
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
          skillVersion: String(controller.version), skillDigest: controller.digest,
          instanceId: options.instanceId,
        };
      })().catch((error) => { warn("CCode audit task start attribution unavailable", error); return undefined; });
      turnAttributions.set(key, attribution);
      await attribution;
      if (identity !== runtimeIdentity) turnAttributions.delete(key);
    },
    reportTaskTerminal: async (taskId, turnId, result) => {
      const key = turnKey(taskId, turnId);
      const pendingAttribution = turnAttributions.get(key);
      if (!active || !collectorSink || !pendingAttribution) return;
      turnAttributions.delete(key);
      const identity = runtimeIdentity;
      try {
        const attribution = await pendingAttribution;
        if (!attribution || !active || !collectorSink || identity !== runtimeIdentity) return;
        const state = await options.account.getState();
        if (!state.authenticated || JSON.stringify([state.tenantId, state.userId]) !== identity) return;
        currentAttribution = attribution;
        collectorSink({ kind: "turn", result, subjectRef: { kind: "session", id: taskId } });
        await collector?.flush();
      } catch (error) { warn("CCode audit task terminal attribution unavailable", error); }
    },
    /** 设备身份变化（D1 注册成功/身份恢复）：强制重建以挂接或摘除 poll/receipts 证明头链路。 */
    notifyDeviceIdentityChanged: () => {
      transition = transition.then(async () => {
        if (disposed || !runtime) return;
        await teardown();
      }).then(sync);
    },
    dispose: async () => { if (disposed) return; disposed = true; unsubscribe(); transition = transition.then(async () => { try { await teardown(); } catch (error) { warn("CCode platform runtime dispose failed", error); } }); await transition; },
  };
}
