/**
 * driver 侧的自适应并发半身（docs/dynamic-workflow/concurrency.md「What the driver observes」，
 * v3 决策 43/44/46）：
 *   - per-actor `ModelRequestAdmission`：tryAcquire = tryAdmit；未命中由 runner 发 queued 事件、这里排队 admit；
 *   - actor runtime 的 ModelNetworkStatus 会话事件按请求链聚合 → askExecuting / askWaiting(slot | backoff)；
 *   - 模型侧错误的收容（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：确定性错误 → stopRun(ProviderStop)；
 *     context_exceeded → ContextLimit；瞬态 → RecoveryExhausted；非模型错误 → DriverError；
 *   - run 级 stall 时钟（决策 4）：20 分钟无一次成功 → runStalled 恰好一次；
 *   - 端口缺席即 runtimeFactory 不收 admission。
 * 用最小 stub runtime（可控 executeTurn + 可注入会话事件），不跑真模型。
 */

import { describe, expect, it, vi } from "vitest";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createTestAgentRuntime, createTestModelFactory } from "./helpers/test-agent-runtime.js";
import { createToolRegistry } from "@zcode/core";
import {
  SessionEventType,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type SessionEvent,
  type SessionEventSink,
  type WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  InMemoryJournalStore,
  type ActorRef,
  type AskWaitInfo,
  type ConcurrencyChange,
  type InstanceRef,
  type RunStallInfo,
  type WorkflowError,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import {
  createRunStallClock,
  WORKFLOW_STALL_NOTIFY_AFTER_MS,
} from "../src/app/workflow-driver-concurrency.js";
import type { WorkflowConcurrencyPort } from "../src/app/workflow-concurrency-governor.js";
import type { ActorTranscriptStore } from "../src/app/workflow-actor-transcript.js";
import { fakeFileSystemPort, unsupportedExecutionPort } from "./workflow-driver.helpers.js";

const RUN = "run-cc";
const ACTOR: ActorRef = { siteId: "actor#1", ordinal: 1 };
const INSTANCE: InstanceRef = { siteId: "ask#1", ordinal: 1 };
const INSTANCE_2: InstanceRef = { siteId: "ask#1", ordinal: 2 };
const MODEL = { providerId: "prov", modelId: "alpha" } as never;

function stubRuntime(executeTurn: () => Promise<unknown>) {
  const sinks = new Set<SessionEventSink>();
  let sessionIdOfRuntime = "";
  const runtime = {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    executeTurn,
    subscribeEvents(sink: SessionEventSink) {
      runtime.subscribeCalls++;
      sinks.add(sink);
      return () => {
        runtime.unsubscribeCalls++;
        sinks.delete(sink);
      };
    },
    getModelRef: () => MODEL,
    closeBrowserSession: async () => {},
    /** 执行器在 handler 之前发的 ToolCallStarted（带解析后的副作用能力）。 */
    emitToolStarted(flags: Record<string, unknown>, sessionId = sessionIdOfRuntime) {
      const event = {
        id: "evt-tool",
        sessionId,
        type: SessionEventType.ToolCallStarted,
        timestamp: new Date(),
        traceId: "trace",
        sequenceNumber: 1,
        payload: { toolCallId: "tc", toolName: "Probe", startedAt: new Date(), ...flags },
      } as unknown as SessionEvent;
      for (const sink of sinks) void sink.onSessionEvent(event);
    },
    emitStatus(payload: Record<string, unknown>, sessionId = sessionIdOfRuntime) {
      const event = {
        id: "evt",
        sessionId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: "trace",
        sequenceNumber: 1,
        payload: { model: MODEL, attempt: 1, maxAttempts: 0, ...payload },
      } as unknown as SessionEvent;
      for (const sink of sinks) void sink.onSessionEvent(event);
    },
    bind(sessionId: string) {
      sessionIdOfRuntime = sessionId;
    },
  };
  return runtime;
}

function recordingSink() {
  const calls = {
    waiting: [] as Array<{ instance: InstanceRef; info: AskWaitInfo }>,
    executing: [] as InstanceRef[],
    mutating: [] as InstanceRef[],
    failed: [] as Array<{ instance: InstanceRef; error: WorkflowError }>,
    concurrency: [] as ConcurrencyChange[],
    stopped: [] as WorkflowError[],
    stalled: [] as RunStallInfo[],
    askStalled: [] as Array<{ instance: InstanceRef; info: RunStallInfo }>,
  };
  const sink: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: (instance, error) => calls.failed.push({ instance, error }),
    askWaiting: (instance, info) => calls.waiting.push({ instance, info }),
    askExecuting: (instance) => calls.executing.push(instance),
    askMutating: (instance) => calls.mutating.push(instance),
    concurrencyChanged: (change) => calls.concurrency.push(change),
    stopRun: (error) => calls.stopped.push(error),
    runStalled: (info) => calls.stalled.push(info),
    askStalled: (instance, info) => calls.askStalled.push({ instance, info }),
  };
  return { sink, calls };
}

/** 假时钟：`now` 可拨，`schedule` 只记录回调，由测试决定何时触发。 */
function fakeClock() {
  const state = {
    now: 0,
    timers: [] as Array<{ callback: () => void; at: number; cancelled: boolean }>,
  };
  const clock = {
    now: () => state.now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, at: state.now + delayMs, cancelled: false };
      state.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  /** 把时间拨到 `to`，触发到期且未撤的闹钟（按到期顺序）。 */
  const advanceTo = (to: number): void => {
    state.now = to;
    for (const timer of [...state.timers].sort((a, b) => a.at - b.at)) {
      if (timer.cancelled || timer.at > to) continue;
      timer.cancelled = true;
      timer.callback();
    }
  };
  const pending = () => state.timers.filter((timer) => !timer.cancelled);
  return { clock, state, advanceTo, pending };
}

function fakeTicket(): ModelRequestAdmissionTicket {
  return { publish: () => {}, release: () => {} };
}

/** 可控端口：`fast` 决定 tryAdmit 命中与否；admit 由测试兑现。 */
function fakePort() {
  const state = {
    fast: true,
    tryAdmits: [] as Array<{ runId: string; key: string }>,
    admits: [] as Array<{
      runId: string;
      key: string;
      signal: AbortSignal;
      resolve: (t: ModelRequestAdmissionTicket) => void;
    }>,
    subscribes: [] as Array<{ runId: string; listener: (change: ConcurrencyChange) => void }>,
    unsubscribe: vi.fn(),
  };
  const port: WorkflowConcurrencyPort = {
    tryAdmit: (runId, key) => {
      state.tryAdmits.push({ runId, key });
      return state.fast ? fakeTicket() : undefined;
    },
    admit: (runId, key, signal) =>
      new Promise((resolve, reject) => {
        state.admits.push({ runId, key, signal, resolve });
        if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
        else
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
      }),
    subscribe: (runId, listener) => {
      state.subscribes.push({ runId, listener });
      return state.unsubscribe;
    },
    // 上界登记是 launch 的事，driver 从不调用。
    setRunBound: () => {},
    clearRunBound: () => {},
  };
  return { port, state };
}

function makeDriver(input: {
  runtime: ReturnType<typeof stubRuntime>;
  otherRuntime?: ReturnType<typeof stubRuntime>;
  concurrency?: WorkflowConcurrencyPort;
  clock?: ReturnType<typeof fakeClock>["clock"] & { stallAfterMs?: number; random?: () => number };
  actorTranscriptStore?: ActorTranscriptStore;
}) {
  const { sink, calls } = recordingSink();
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: RUN,
    caps: { maxConcurrency: 16 },
    spentTokens: 0,
    status: "running",
  });
  const factoryInputs: Array<{
    modelRequestAdmission?: ModelRequestAdmission;
    escalatePort: WorkflowEscalatePort;
  }> = [];
  const escalationRegistry = createWorkflowEscalationRegistry();
  const driver = createAgentRuntimeWorkflowDriver({
    journal,
    emit: () => {},
    escalationRegistry,
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    cwd: process.cwd(),
    runId: RUN,
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: input.actorTranscriptStore }),
    runtimeFactory: ({ sessionId, modelRequestAdmission, escalatePort }) => {
      factoryInputs.push({
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        escalatePort,
      });
      const runtime =
        factoryInputs.length > 1 ? (input.otherRuntime ?? input.runtime) : input.runtime;
      runtime.bind(sessionId);
      return runtime as never;
    },
  })(sink);
  return { driver, calls, factoryInputs, sink, journal, escalationRegistry };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe("workflow driver — waiting / executing 观察（§6，决策 38）", () => {
  it("首个 started → askExecuting；同一 ask 内再 started 不重发；completed 不改相位", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    // 两个观察面各订阅一次：模型活动（waiting / executing）+ 工具活动（askMutating）。
    expect(runtime.subscribeCalls).toBe(2);
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    runtime.emitStatus({ type: "model_request_started", attempt: 1 });
    expect(calls.executing).toEqual([INSTANCE]);
    runtime.emitStatus({ type: "model_request_completed", attempt: 1, durationMs: 10 });
    // 工具执行期间的下一个请求：相位仍是 executing，不重发。
    runtime.emitStatus({ type: "model_request_started", attempt: 1 });
    expect(calls.executing).toEqual([INSTANCE]);
    expect(calls.waiting).toEqual([]);
  });

  it("model_retry_scheduled → askWaiting(backoff)；其后的 started → askExecuting（退避后的重试真的发出了）", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    runtime.emitStatus({ type: "model_request_started", attempt: 1 });

    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 20_000,
      nextAttempt: 2,
      retryAfterMs: 20_000,
      message: "429",
    });
    expect(calls.waiting).toEqual([
      {
        instance: INSTANCE,
        info: {
          cause: "backoff",
          reason: "rate_limited",
          attempt: 2,
          delayMs: 20_000,
          retryAfterMs: 20_000,
        },
      },
    ]);
    runtime.emitStatus({ type: "model_request_started", attempt: 2 });
    expect(calls.executing).toEqual([INSTANCE, INSTANCE]);
    // 再一次限流 + 重试：每一段等待都恰好一对 waiting / executing。
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "server_error",
      delayMs: 3000,
      nextAttempt: 3,
      message: "500",
    });
    expect(calls.waiting).toHaveLength(2);
    expect(calls.waiting[1]!.info).toEqual({
      cause: "backoff",
      reason: "server_error",
      attempt: 3,
      delayMs: 3000,
    });
    runtime.emitStatus({ type: "model_request_started", attempt: 3 });
    expect(calls.executing).toHaveLength(3);
  });

  it("signature repair / auth_refresh 不报；别的会话的事件忽略", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "reasoning_signature_repair",
      delayMs: 0,
      nextAttempt: 2,
      message: "repair",
    });
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "auth_refresh",
      delayMs: 0,
      nextAttempt: 2,
      message: "refresh",
    });
    runtime.emitStatus(
      {
        type: "model_retry_scheduled",
        reason: "server_error",
        delayMs: 4000,
        nextAttempt: 3,
        message: "500",
      },
      "some-other-session",
    );
    runtime.emitStatus({ type: "model_request_started" }, "some-other-session");
    expect(calls.waiting).toEqual([]);
    expect(calls.executing).toEqual([]);
  });

  it("每个 ask 重置：上一个 ask 的 executing 不带到下一个 ask 的首个请求上", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    runtime.emitStatus({ type: "model_request_started" });
    driver.cancelAsk(INSTANCE);
    driver.startAsk(session, INSTANCE_2, { instructions: "again", typed: false });
    runtime.emitStatus({ type: "model_request_started" });
    expect(calls.executing).toEqual([INSTANCE, INSTANCE_2]);
  });

  it("没有在飞 ask 时不报；dispose 退订", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    await driver.createActorSession(ACTOR, {});
    runtime.emitStatus({ type: "model_request_started" });
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 2000,
      nextAttempt: 2,
      message: "429",
    });
    expect(calls.executing).toEqual([]);
    expect(calls.waiting).toEqual([]);
    driver.dispose?.();
    expect(runtime.unsubscribeCalls).toBe(2);
  });
});

describe("workflow driver — per-actor 准入（§4，决策 34/36）", () => {
  it("端口在场：runtimeFactory 收到 admission；tryAdmit 命中不发 waiting；订阅 run 级 cap 变化并扇出", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { port, state } = fakePort();
    const { driver, calls, factoryInputs } = makeDriver({ runtime, concurrency: port });
    expect(state.subscribes).toEqual([expect.objectContaining({ runId: RUN })]);
    const session = await driver.createActorSession(ACTOR, {});
    const admission = factoryInputs[0]!.modelRequestAdmission;
    expect(admission).toBeDefined();
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    const ticket = await admission!.acquire({ model: MODEL });
    expect(ticket).toBeDefined();
    expect(state.tryAdmits).toEqual([{ runId: RUN, key: "prov/alpha" }]);
    expect(state.admits).toEqual([]);
    expect(calls.waiting).toEqual([]);

    const change: ConcurrencyChange = {
      key: "prov/alpha",
      previous: 8,
      next: 4,
      reason: "rate_limited",
      cooldownMs: 5000,
    };
    state.subscribes[0]!.listener(change);
    expect(calls.concurrency).toEqual([change]);

    driver.dispose?.();
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("tryAcquire = tryAdmit；未命中时 acquire 排队；waiting(slot) 由 runner 的 queued 事件报，不由包装发（决策 44）", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { port, state } = fakePort();
    state.fast = false;
    const { driver, calls, factoryInputs } = makeDriver({ runtime, concurrency: port });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    const admission = factoryInputs[0]!.modelRequestAdmission!;

    expect(admission.tryAcquire!({ model: MODEL })).toBeUndefined();
    expect(state.tryAdmits).toEqual([{ runId: RUN, key: "prov/alpha" }]);
    // 包装本身不再报 waiting：那是 runner 看到 tryAcquire 未命中后发 queued 事件的事。
    expect(calls.waiting).toEqual([]);
    runtime.emitStatus({ type: "model_request_queued", toolCallId: "tc-1" });
    expect(calls.waiting).toEqual([{ instance: INSTANCE, info: { cause: "slot" } }]);

    const signal = new AbortController().signal;
    const pending = admission.acquire({ model: MODEL, signal });
    await flush();
    expect(state.admits).toHaveLength(1);
    expect(state.admits[0]).toMatchObject({ runId: RUN, key: "prov/alpha", signal });
    state.admits[0]!.resolve(fakeTicket());
    await pending;
    // 拿到票：admitted 即 executing（持槽），随后的 started 不重发。
    runtime.emitStatus({ type: "model_request_admitted", queuedMs: 5, toolCallId: "tc-1" });
    runtime.emitStatus({ type: "model_request_started", toolCallId: "tc-1" });
    expect(calls.executing).toEqual([INSTANCE]);

    state.fast = true;
    expect(admission.tryAcquire!({ model: MODEL })).toBeDefined();
  });

  it("等槽位中 signal abort → acquire reject", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { port, state } = fakePort();
    state.fast = false;
    const { driver, factoryInputs } = makeDriver({ runtime, concurrency: port });
    await driver.createActorSession(ACTOR, {});
    const controller = new AbortController();
    const pending = factoryInputs[0]!.modelRequestAdmission!.acquire({
      model: MODEL,
      signal: controller.signal,
    });
    await flush();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("端口缺席：runtimeFactory 不收 admission", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, factoryInputs } = makeDriver({ runtime });
    await driver.createActorSession(ACTOR, {});
    expect(factoryInputs[0]?.modelRequestAdmission).toBeUndefined();
  });
});

describe("workflow driver — 按请求链聚合的子代理相位（v3 决策 46）", () => {
  const turn = (extra: Record<string, unknown> = {}) => ({
    queryId: "q-1",
    querySource: "workflow_child",
    ...extra,
  });
  const tool = (id: string, extra: Record<string, unknown> = {}) => ({
    queryId: "q-1",
    querySource: "web_search_tool",
    toolCallId: id,
    ...extra,
  });

  it("一条链在执行时另一条链排队不报 waiting；执行链结束、只剩等待者 → 报最新的等待", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    runtime.emitStatus({ type: "model_request_started", ...turn() });
    expect(calls.executing).toEqual([INSTANCE]);
    runtime.emitStatus({ type: "model_request_queued", ...tool("tc-a") });
    expect(calls.waiting).toEqual([]);
    // turn 请求完成：集合只剩排队中的工具链，子代理此刻才真的在等。
    runtime.emitStatus({ type: "model_request_completed", ...turn({ durationMs: 10 }) });
    expect(calls.waiting).toEqual([{ instance: INSTANCE, info: { cause: "slot" } }]);
    // 工具链拿到票：executing 重新报一次。
    runtime.emitStatus({ type: "model_request_admitted", queuedMs: 40, ...tool("tc-a") });
    expect(calls.executing).toEqual([INSTANCE, INSTANCE]);
  });

  it("重试换 requestId 仍是同一条链：backoff → 下一次尝试 started 不留幽灵等待者", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    runtime.emitStatus({ type: "model_request_started", requestId: "r-1", ...turn() });
    runtime.emitStatus({
      type: "model_request_failed",
      requestId: "r-1",
      reason: "rate_limited",
      retryable: true,
      message: "429",
      ...turn(),
    });
    runtime.emitStatus({
      type: "model_retry_scheduled",
      requestId: "r-1",
      reason: "rate_limited",
      delayMs: 2000,
      nextAttempt: 2,
      message: "429",
      ...turn(),
    });
    expect(calls.waiting).toHaveLength(1);
    runtime.emitStatus({ type: "model_request_started", requestId: "r-2", attempt: 2, ...turn() });
    expect(calls.executing).toEqual([INSTANCE, INSTANCE]);
    runtime.emitStatus({
      type: "model_request_completed",
      requestId: "r-2",
      attempt: 2,
      durationMs: 5,
      ...turn(),
    });
    // 集合为空：保持上一相位，不发任何事件。之后一条工具链排队 → 真正在等。
    expect(calls.waiting).toHaveLength(1);
    runtime.emitStatus({ type: "model_request_queued", ...tool("tc-b") });
    expect(calls.waiting).toHaveLength(2);
    expect(calls.waiting[1]!.info).toEqual({ cause: "slot" });
  });

  it("两条工具链并行：一条 executing 另一条 backoff 不报；两条都在等才报，再 started 才 executing", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    runtime.emitStatus({ type: "model_request_started", ...tool("tc-1") });
    runtime.emitStatus({ type: "model_request_started", ...tool("tc-2") });
    expect(calls.executing).toEqual([INSTANCE]);
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 1500,
      nextAttempt: 2,
      message: "429",
      ...tool("tc-2"),
    });
    expect(calls.waiting).toEqual([]);
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 3000,
      nextAttempt: 2,
      message: "429",
      ...tool("tc-1"),
    });
    expect(calls.waiting).toEqual([
      {
        instance: INSTANCE,
        info: { cause: "backoff", reason: "rate_limited", attempt: 2, delayMs: 3000 },
      },
    ]);
    runtime.emitStatus({ type: "model_request_started", attempt: 2, ...tool("tc-2") });
    expect(calls.executing).toEqual([INSTANCE, INSTANCE]);
    // 不可重试的失败结束一条链；另一条仍在执行，不报。
    runtime.emitStatus({
      type: "model_request_failed",
      reason: "auth_failed",
      retryable: false,
      message: "401",
      ...tool("tc-1"),
    });
    expect(calls.waiting).toHaveLength(1);
  });

  it("同一段等待里内容相同的等待只报一次（决策 49）：四条并行工具链同时排队 → 一条 waiting(slot)", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });

    for (const id of ["tc-1", "tc-2", "tc-3", "tc-4"]) {
      runtime.emitStatus({ type: "model_request_queued", ...tool(id) });
    }
    expect(calls.waiting).toEqual([{ instance: INSTANCE, info: { cause: "slot" } }]);
    // 内容不同的等待（退避）仍照报：相位信息变了。
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 1500,
      nextAttempt: 2,
      message: "429",
      ...tool("tc-1"),
    });
    expect(calls.waiting).toHaveLength(2);
    // 一条链拿到票 → executing；它完成后只剩等待者 → 同样的 slot 等待再报一次（新的一段等待）。
    runtime.emitStatus({ type: "model_request_admitted", queuedMs: 30, ...tool("tc-2") });
    expect(calls.executing).toEqual([INSTANCE]);
    runtime.emitStatus({ type: "model_request_completed", durationMs: 5, ...tool("tc-2") });
    expect(calls.waiting).toHaveLength(3);
    expect(calls.waiting[2]!.info).toMatchObject({ cause: "backoff" });
    // 最新等待信息从 backoff 变回 slot：报一次；紧随其后的同样 queued 不再重复。
    runtime.emitStatus({ type: "model_request_queued", ...tool("tc-5") });
    runtime.emitStatus({ type: "model_request_queued", ...tool("tc-6") });
    expect(calls.waiting).toHaveLength(4);
    expect(calls.waiting[3]!.info).toEqual({ cause: "slot" });
  });
});

describe("workflow driver — 模型侧错误的收容（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
  const adapterError = (context: Record<string, unknown>, message = "Model request failed") =>
    Object.assign(new Error(message), {
      name: "AiSdkModelAdapterError",
      code: "model_request_failed",
      context,
    });

  it("确定性错误（auth_failed）→ stopRun(ProviderStop) 携结构化明细，不结算节点", async () => {
    const runtime = stubRuntime(() =>
      Promise.reject(
        adapterError(
          {
            reason: "auth_failed",
            providerId: "prov",
            modelId: "alpha",
            providerCode: "1006",
            retryable: false,
          },
          "[1006] token expired",
        ),
      ),
    );
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, { name: "verifier" });
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await flush();
    expect(calls.failed).toEqual([]);
    expect(calls.stopped).toHaveLength(1);
    const error = calls.stopped[0]!;
    expect(error.code).toBe("ProviderStop");
    expect(error.providerStop).toEqual({
      kind: "auth",
      reason: "auth_failed",
      subagent: "actor#1@1",
      subagentName: "verifier",
      providerId: "prov",
      modelId: "alpha",
      providerCode: "1006",
      rawMessage: "[1006] token expired",
    });
    expect(error.message).toContain("verifier");
    expect(error.message).toContain("[1006]");
    expect(error.toJSON().providerStop?.kind).toBe("auth");
  });

  it("配额码（1308）→ stop/quota；包了一层 cause 时仍能读到", async () => {
    const inner = adapterError(
      { reason: "rate_limited", providerCode: "1308", retryable: false },
      "[1308] usage cap reached",
    );
    const runtime = stubRuntime(() => Promise.reject(new Error("turn failed", { cause: inner })));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await flush();
    expect(calls.stopped[0]?.providerStop).toMatchObject({ kind: "quota", providerCode: "1308" });
    // 匿名 actor：没有 subagentName，subagent 仍是结构化 ref。
    expect(calls.stopped[0]?.providerStop?.subagent).toBe("actor#1@1");
    expect("subagentName" in calls.stopped[0]!.providerStop!).toBe(false);
  });

  it("context_exceeded → askFailed(ContextLimit)（脚本可 catch，未 catch 则 errored）", async () => {
    const runtime = stubRuntime(() =>
      Promise.reject(adapterError({ reason: "context_exceeded", retryable: false })),
    );
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await flush();
    expect(calls.stopped).toEqual([]);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]!.error.code).toBe("ContextLimit");
    expect(calls.failed[0]!.error.message).toContain("context window");
  });

  it("非模型错误 → DriverError（不带任何模型归因字段）", async () => {
    const runtime = stubRuntime(() => Promise.reject(new Error("script bug")));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await flush();
    expect(calls.stopped).toEqual([]);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]!.error.code).toBe("DriverError");
    expect(calls.failed[0]!.error.message).toBe("Subagent turn failed: script bug");
    expect("providerStop" in calls.failed[0]!.error.toJSON()).toBe(false);
  });

  it("底层瞬态恢复耗尽只失败一次，不再等待或创建新 turn", async () => {
    const { clock, pending, advanceTo } = fakeClock();
    let turns = 0;
    const runtime = stubRuntime(() => {
      turns++;
      return Promise.reject(adapterError({ reason: "network_error", retryable: true }));
    });
    const { driver, calls } = makeDriver({ runtime, clock });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await flush();
    expect(calls.failed).toHaveLength(1);
    driver.respondToSubmit(INSTANCE, { kind: "nudge" });
    expect(calls.failed[0]?.error).toMatchObject({ code: "RecoveryExhausted" });
    expect(calls.waiting).toEqual([]);
    expect(calls.stopped).toEqual([]);
    expect(pending()).toHaveLength(0);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 3);
    await flush();
    expect(turns).toBe(1);
    expect(calls.failed).toHaveLength(1);
    expect(calls.askStalled).toEqual([]);
    driver.dispose();
  });
});

describe("run 级 stall 时钟（决策 4）", () => {
  it("20 分钟内没有一次成功、且排定过重试 → onStalled 恰好一次，带占多数的 reason 与 cap", () => {
    const { clock, advanceTo } = fakeClock();
    const stalled: RunStallInfo[] = [];
    const stall = createRunStallClock({ ...clock, onStalled: (info) => stalled.push(info) });
    stall.noteCap(4);
    advanceTo(60_000);
    stall.noteRetryScheduled("rate_limited");
    stall.noteRetryScheduled("network_error");
    stall.noteRetryScheduled("rate_limited");
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS - 1);
    expect(stalled).toEqual([]);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
    expect(stalled).toEqual([
      { sinceMs: WORKFLOW_STALL_NOTIFY_AFTER_MS, reason: "rate_limited", cap: 4 },
    ]);
    // 同一段里再多的重试也不再通知。
    stall.noteRetryScheduled("rate_limited");
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 3);
    expect(stalled).toHaveLength(1);
  });

  it("一次成功归零并重新上膛：时钟量的是「距上次成功」，不是「距首次重试」", () => {
    const { clock, advanceTo } = fakeClock();
    const stalled: RunStallInfo[] = [];
    const stall = createRunStallClock({ ...clock, onStalled: (info) => stalled.push(info) });
    stall.noteRetryScheduled("server_error");
    advanceTo(10 * 60_000);
    stall.noteSuccess();
    advanceTo(25 * 60_000);
    // 成功之后没有新的重试：不是 stall（哪怕已经 15 分钟没成功）。
    expect(stalled).toEqual([]);
    // 25 分钟时排定重试：距上次成功（10 分钟）已 15 分钟，再过 5 分钟就满 20 分钟。
    stall.noteRetryScheduled("server_error");
    advanceTo(30 * 60_000 - 1);
    expect(stalled).toEqual([]);
    advanceTo(30 * 60_000);
    expect(stalled).toEqual([{ sinceMs: WORKFLOW_STALL_NOTIFY_AFTER_MS, reason: "server_error" }]);
  });

  it("没有重试就没有 stall；dispose 撤闹钟", () => {
    const { clock, advanceTo, pending } = fakeClock();
    const stalled: RunStallInfo[] = [];
    const stall = createRunStallClock({ ...clock, onStalled: (info) => stalled.push(info) });
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 2);
    expect(stalled).toEqual([]);
    stall.noteRetryScheduled("timeout");
    expect(pending()).toHaveLength(1);
    stall.dispose();
    expect(pending()).toHaveLength(0);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 4);
    expect(stalled).toEqual([]);
  });

  it("driver 接线：actor 的 retry_scheduled 上膛、completed 归零，到点经 sink.runStalled 报出", async () => {
    const { clock, advanceTo } = fakeClock();
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime, clock: { ...clock, stallAfterMs: 1_000 } });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    runtime.emitStatus({ type: "model_request_started", attempt: 1 });
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 500,
      nextAttempt: 2,
      message: "429",
    });
    advanceTo(999);
    expect(calls.stalled).toEqual([]);
    advanceTo(1_000);
    expect(calls.stalled).toEqual([{ sinceMs: 1_000, reason: "rate_limited" }]);
    // 一次成功归零；之后再重试要重新等满。
    runtime.emitStatus({ type: "model_request_completed", attempt: 2, durationMs: 10 });
    runtime.emitStatus({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 500,
      nextAttempt: 3,
      message: "429",
    });
    advanceTo(1_999);
    expect(calls.stalled).toHaveLength(1);
    advanceTo(2_000);
    expect(calls.stalled).toHaveLength(2);
    driver.dispose();
  });
});

// ── 工具活动观察（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」）──
describe("workflow driver — askMutating 观察（子代理的第一笔工作区写入）", () => {
  it("在飞 ask 的子代理发出会改写工作区的 ToolCallStarted → askMutating 一次；只读工具不算；换 ask 再报一次", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, { name: "fixer" });
    driver.startAsk(session, INSTANCE, { instructions: "fix", typed: false });
    await flush();

    runtime.emitToolStarted({ toolName: "Read", readOnly: true, sideEffectScope: "none" });
    runtime.emitToolStarted({ toolName: "Bash", readOnly: true, sideEffectScope: "none" });
    expect(calls.mutating).toEqual([]);
    runtime.emitToolStarted({ toolName: "Write", readOnly: false, sideEffectScope: "workspace" });
    runtime.emitToolStarted({ toolName: "Edit", readOnly: false, sideEffectScope: "workspace" });
    expect(calls.mutating).toEqual([INSTANCE]);

    // 第二个 ask：观察面归零，第一笔写入再报一次，且点的是新实例。
    driver.cancelAsk(INSTANCE);
    driver.startAsk(session, INSTANCE_2, { instructions: "fix again", typed: false });
    await flush();
    runtime.emitToolStarted({ toolName: "Bash", readOnly: false, sideEffectScope: "system" });
    expect(calls.mutating).toEqual([INSTANCE, INSTANCE_2]);
  });

  it("没有在飞 ask（已取消 / 尚未开始）时的写入不上报——迟到的观察对结算过的 ask 没有意义", async () => {
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, { name: "fixer" });
    runtime.emitToolStarted({ toolName: "Write", readOnly: false, sideEffectScope: "workspace" });
    expect(calls.mutating).toEqual([]);
    driver.startAsk(session, INSTANCE, { instructions: "fix", typed: false });
    await flush();
    driver.cancelAsk(INSTANCE);
    runtime.emitToolStarted({ toolName: "Write", readOnly: false, sideEffectScope: "workspace" });
    expect(calls.mutating).toEqual([]);
  });
});

describe("ask 独立模型重试停滞", () => {
  const retry = {
    type: "model_retry_scheduled",
    reason: "rate_limited",
    delayMs: 500,
    nextAttempt: 2,
    message: "429",
  };
  it("A 重试时 B 每分钟成功，20 分钟仅 A 通知一次", async () => {
    const { clock, advanceTo } = fakeClock();
    const runtime = stubRuntime(() => new Promise(() => {}));
    const otherRuntime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime, otherRuntime, clock });
    const a = await driver.createActorSession(ACTOR, {});
    const b = await driver.createActorSession({ siteId: "actor#2", ordinal: 1 }, {});
    driver.startAsk(a, INSTANCE, { instructions: "A", typed: false });
    driver.startAsk(b, INSTANCE_2, { instructions: "B", typed: false });
    runtime.emitStatus(retry);
    for (let minute = 1; minute < 20; minute++) {
      advanceTo(minute * 60_000);
      otherRuntime.emitStatus({ type: "model_request_completed" });
    }
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS - 1);
    expect(calls.askStalled).toEqual([]);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
    expect(calls.askStalled).toEqual([
      {
        instance: INSTANCE,
        info: { sinceMs: WORKFLOW_STALL_NOTIFY_AFTER_MS, reason: "rate_limited" },
      },
    ]);
    expect(calls.stalled).toEqual([]);
    runtime.emitStatus(retry);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 2);
    expect(calls.askStalled).toHaveLength(1);
    driver.dispose();
  });

  it("自己的成功清段，新重试才能再次上膛", async () => {
    const { clock, advanceTo } = fakeClock();
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime, clock });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "A", typed: false });
    runtime.emitStatus(retry);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
    expect(calls.askStalled).toHaveLength(1);
    runtime.emitStatus({ type: "model_request_completed" });
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 2);
    expect(calls.askStalled).toHaveLength(1);
    runtime.emitStatus(retry);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 2);
    expect(calls.askStalled).toHaveLength(2);
    driver.dispose();
  });

  it.each(["cancel", "accept", "settled-ok", "settled-failed", "dispose"])(
    "%s 释放时钟，迟到状态与取消回调不能复活",
    async (end) => {
      const { clock, advanceTo, state } = fakeClock();
      const runtime = stubRuntime(() => new Promise(() => {}));
      const { driver, calls } = makeDriver({ runtime, clock });
      const session = await driver.createActorSession(ACTOR, {});
      driver.startAsk(session, INSTANCE, { instructions: "A", typed: false });
      runtime.emitStatus(retry);
      const callbacks = state.timers.map((timer) => timer.callback);
      if (end === "cancel") driver.cancelAsk(INSTANCE);
      else if (end === "accept") driver.respondToSubmit(INSTANCE, { kind: "accept" });
      else if (end === "dispose") driver.dispose();
      else
        driver.emit({
          type: "node-settled",
          instance: INSTANCE,
          outcome: end === "settled-ok" ? "ok" : "failed",
        });
      runtime.emitStatus({ type: "model_request_completed" });
      runtime.emitStatus(retry);
      advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
      for (const callback of callbacks) callback();
      expect(calls.askStalled).toEqual([]);
      driver.dispose();
    },
  );

  it("下一 ask 不继承上一 ask 的重试；没有有效重试的长等待不通知", async () => {
    const { clock, advanceTo, state } = fakeClock();
    const runtime = stubRuntime(() => new Promise(() => {}));
    const { driver, calls } = makeDriver({ runtime, clock });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "A", typed: false });
    runtime.emitStatus(retry);
    const callbacks = state.timers.map((timer) => timer.callback);
    driver.cancelAsk(INSTANCE);
    driver.startAsk(session, INSTANCE_2, { instructions: "B", typed: false });
    runtime.emitStatus({ ...retry, reason: "auth_refresh" });
    runtime.emitStatus({ ...retry, reason: "reasoning_signature_repair" });
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
    for (const callback of callbacks) callback();
    expect(calls.askStalled).toEqual([]);
    runtime.emitStatus(retry);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
    expect(calls.askStalled.map((call) => call.instance)).toEqual([INSTANCE_2]);
    driver.dispose();
  });
});

it("typed accept 后旧 query 的迟到 retry/completed 不改变下一 ask 的时钟", async () => {
  const { clock, advanceTo } = fakeClock();
  const runtime = stubRuntime(() => new Promise(() => {}));
  const { driver, calls } = makeDriver({ runtime, clock });
  const session = await driver.createActorSession(ACTOR, {});
  const retry = {
    type: "model_retry_scheduled",
    reason: "timeout",
    delayMs: 500,
    nextAttempt: 2,
    message: "timeout",
  };
  driver.startAsk(session, INSTANCE, {
    instructions: "A",
    typed: true,
    schema: { type: "string" },
  });
  runtime.emitStatus({
    type: "model_request_started",
    queryId: "old",
    querySource: "tool",
    toolCallId: "old-tool",
  });
  driver.respondToSubmit(INSTANCE, { kind: "accept" });
  driver.startAsk(session, INSTANCE_2, { instructions: "B", typed: false });
  runtime.emitStatus({ ...retry, queryId: "old", querySource: "tool", toolCallId: "old-tool" });
  advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS);
  expect(calls.askStalled).toEqual([]);
  runtime.emitStatus({ type: "model_request_completed", queryId: "new", querySource: "turn" });
  runtime.emitStatus({ ...retry, queryId: "new", querySource: "turn" });
  advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS + 60_000);
  runtime.emitStatus({
    type: "model_request_completed",
    queryId: "old",
    querySource: "tool",
    toolCallId: "old-tool",
  });
  advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 2);
  expect(calls.askStalled.map((call) => call.instance)).toEqual([INSTANCE_2]);
  driver.dispose();
});

it("真实 Core 11 次调用和 10 次恢复后 RecoveryExhausted，不重驱也不上膛 ask 钟", async () => {
  const { clock, advanceTo, pending } = fakeClock();
  const { sink, calls } = recordingSink();
  const events: SessionEvent[] = [];
  let modelCalls = 0;
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: RUN,
    caps: { maxConcurrency: 16 },
    spentTokens: 0,
    status: "running",
  });
  const driver = createAgentRuntimeWorkflowDriver({
    journal,
    emit: () => {},
    runId: RUN,
    cwd: process.cwd(),
    clock: { ...clock, random: () => 1 },
    escalationRegistry: createWorkflowEscalationRegistry(),
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    runtimeFactory: ({ sessionId }) => {
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          taskType: "workflow_child",
          modelStreaming: "on",
        },
        {
          eventStore: createInMemorySessionEventStore(),
          modelFactory: createTestModelFactory({
            async *streamText(_request, observation) {
              modelCalls++;
              const requestId = `broken-stream-${modelCalls}`;
              const status = observation.invocationContext?.statusSink;
              const base = {
                requestId,
                attempt: 1,
                maxAttempts: 0,
                providerId: String(observation.model.providerId),
                modelId: String(observation.model.modelId),
                timestamp: new Date().toISOString(),
                traceId: "wf3",
              };
              await status?.publish({ ...base, type: "model_request_started" });
              yield { type: "text_delta", text: "partial" };
              await status?.publish({
                ...base,
                type: "model_request_failed",
                reason: "network_error",
                retryable: false,
                message: "connection reset",
              });
              // 与真实adapter状态集合回归同一边界：可见输出后不在adapter内重放。
              throw Object.assign(new Error("connection reset"), {
                name: "AiSdkModelAdapterError",
                code: "model_network_error",
                context: { reason: "network_error", retryable: true },
              });
            },
          }),
        },
      );
      runtime.subscribeEvents({
        onSessionEvent: (event) => {
          events.push(event);
        },
      });
      return runtime;
    },
  })(sink);
  try {
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    await vi.waitFor(() => expect(calls.failed).toHaveLength(1));
    expect(modelCalls).toBe(11);
    expect(
      events.filter((event) => event.type === SessionEventType.StreamRecoveryRetryStarted),
    ).toHaveLength(10);
    expect(calls.failed[0]?.error.code).toBe("RecoveryExhausted");
    expect(calls.waiting).toEqual([]);
    expect(calls.stopped).toEqual([]);
    expect(pending()).toHaveLength(0);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 3);
    await flush();
    expect(modelCalls).toBe(11);
    expect(calls.failed).toHaveLength(1);
    expect(calls.askStalled).toEqual([]);
    expect(calls.stalled).toEqual([]);
  } finally {
    driver.cancelAsk(INSTANCE);
    driver.dispose();
  }
});

describe("WF4 实例与 generation 隔离", () => {
  const transientError = () =>
    Object.assign(new Error("connection reset"), {
      name: "AiSdkModelAdapterError",
      code: "model_network_error",
      context: { reason: "network_error", retryable: true },
    });
  function controlledRuntime() {
    const turns: Array<{
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      signal?: AbortSignal;
    }> = [];
    const runtime = stubRuntime(
      () => new Promise((resolve, reject) => turns.push({ resolve, reject })),
    );
    const execute = runtime.executeTurn;
    runtime.executeTurn = ((...args: unknown[]) => {
      const result = execute();
      turns.at(-1)!.signal = (args[2] as { abortSignal?: AbortSignal })?.abortSignal;
      return result;
    }) as never;
    return { runtime, turns };
  }
  const result = { response: "done", events: [], usage: undefined };

  it.each(["cancel", "accept", "dispose"])("%s 优先于当前 turn 的最终模型失败", async (end) => {
    const { runtime, turns } = controlledRuntime();
    const { driver, calls } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    if (end === "cancel") driver.cancelAsk(INSTANCE);
    if (end === "accept") driver.respondToSubmit(INSTANCE, { kind: "accept" });
    if (end === "dispose") driver.dispose();
    turns[0]!.reject(transientError());
    await flush();
    expect(calls.failed).toEqual([]);
    expect(calls.stopped).toEqual([]);
    expect(calls.waiting).toEqual([]);
    expect(turns).toHaveLength(1);
    driver.dispose();
  });

  it("清理旧实例先于 askFailed 同步派发后继，后继 signal 和升级项保留", async () => {
    const { runtime, turns } = controlledRuntime();
    const { driver, calls, sink, factoryInputs, escalationRegistry } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "first", typed: false });
    const oldQuestion = factoryInputs[0]!.escalatePort.escalate({ question: "old" });
    const oldOutcome = oldQuestion.catch((error: unknown) => error);
    const failed = sink.askFailed;
    let nextOutcome: Promise<unknown> | undefined;
    sink.askFailed = (instance, error) => {
      expect(turns[0]!.signal?.aborted).toBe(true);
      expect(escalationRegistry.pendingFor(RUN)).toEqual([]);
      failed(instance, error);
      driver.startAsk(session, INSTANCE_2, { instructions: "next", typed: false });
      nextOutcome = factoryInputs[0]!.escalatePort
        .escalate({ question: "next" })
        .catch((e: unknown) => e);
    };
    turns[0]!.reject(transientError());
    await flush();
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]?.error.code).toBe("RecoveryExhausted");
    expect(await oldOutcome).toMatchObject({ code: "Cancelled" });
    expect(turns[1]!.signal?.aborted).toBe(false);
    expect(escalationRegistry.pendingFor(RUN).map((q) => q.question)).toEqual(["next"]);
    driver.cancelAsk(INSTANCE_2);
    await nextOutcome;
    turns[1]!.resolve(result);
    await flush();
    driver.dispose();
  });

  it.each(["reject", "resolve"])(
    "旧实例迟到 %s 和旧 cancel/accept 不触碰后继升级项或终态",
    async (outcome) => {
      // 防御边界：直接驱动端口模拟旧回调迟到，不声称真实 runtime 会并行执行同 actor turn。
      const { runtime, turns } = controlledRuntime();
      const { driver, calls, sink, factoryInputs, escalationRegistry } = makeDriver({ runtime });
      const ended = vi.fn();
      sink.askTurnEnded = ended;
      const session = await driver.createActorSession(ACTOR, {});
      driver.startAsk(session, INSTANCE, { instructions: "old", typed: false });
      driver.startAsk(session, INSTANCE_2, { instructions: "next", typed: false });
      const question = factoryInputs[0]!.escalatePort
        .escalate({ question: "next" })
        .catch((e: unknown) => e);
      driver.cancelAsk(INSTANCE);
      driver.respondToSubmit(INSTANCE, { kind: "accept" });
      if (outcome === "reject") turns[0]!.reject(transientError());
      else turns[0]!.resolve(result);
      await flush();
      expect(calls.failed).toEqual([]);
      expect(calls.stopped).toEqual([]);
      expect(ended).not.toHaveBeenCalled();
      expect(turns[1]!.signal?.aborted).toBe(false);
      expect(escalationRegistry.pendingFor(RUN).map((q) => q.question)).toEqual(["next"]);
      driver.cancelAsk(INSTANCE_2);
      await question;
      turns[1]!.resolve(result);
      await flush();
      driver.dispose();
    },
  );

  it("旧 generation 的迟到 reject 不撤 nudge 新轮的升级项", async () => {
    const { runtime, turns } = controlledRuntime();
    const { driver, calls, factoryInputs, escalationRegistry } = makeDriver({ runtime });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    driver.respondToSubmit(INSTANCE, { kind: "nudge" });
    const question = factoryInputs[0]!.escalatePort
      .escalate({ question: "new generation" })
      .catch((e: unknown) => e);
    turns[0]!.reject(transientError());
    await flush();
    expect(calls.failed).toEqual([]);
    expect(escalationRegistry.pendingFor(RUN)).toHaveLength(1);
    expect(turns[1]!.signal?.aborted).toBe(false);
    driver.cancelAsk(INSTANCE);
    await question;
    turns[1]!.resolve(result);
    await flush();
    driver.dispose();
  });

  it("转录计数 await 后复核 generation，旧轮不能结算 nudge 的新轮", async () => {
    const { runtime, turns } = controlledRuntime();
    let counted!: (rows: unknown[]) => void;
    const store = {
      messages: () =>
        new Promise((resolve) => {
          counted = resolve;
        }),
    } as unknown as ActorTranscriptStore;
    const { driver, sink } = makeDriver({ runtime, actorTranscriptStore: store });
    const ended = vi.fn();
    sink.askTurnEnded = ended;
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    turns[0]!.resolve(result);
    await flush();
    driver.respondToSubmit(INSTANCE, { kind: "nudge" });
    counted([]);
    await flush();
    expect(ended).not.toHaveBeenCalled();
    driver.cancelAsk(INSTANCE);
    driver.dispose();
  });

  it("accepted resolve 在 dispose 后仍保留合法用量及转录边界", async () => {
    const { runtime, turns } = controlledRuntime();
    const store = { messages: async () => [1, 2, 3] } as unknown as ActorTranscriptStore;
    const { driver, sink, journal } = makeDriver({ runtime, actorTranscriptStore: store });
    const stats = vi.fn();
    const ended = vi.fn();
    sink.askStats = stats;
    sink.askTurnEnded = ended;
    const session = await driver.createActorSession(ACTOR, {});
    journal.putNode({
      runId: RUN,
      siteId: INSTANCE.siteId,
      ordinal: INSTANCE.ordinal,
      kind: "ask",
      status: "completed",
    } as never);
    driver.startAsk(session, INSTANCE, { instructions: "go", typed: false });
    driver.respondToSubmit(INSTANCE, { kind: "accept" });
    driver.dispose();
    turns[0]!.resolve({ ...result, usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8 } });
    await flush(16);
    expect(stats).toHaveBeenCalledWith(INSTANCE, expect.objectContaining({ tokens: 20 }));
    expect(ended).not.toHaveBeenCalled();
    expect(journal.getNode(RUN, INSTANCE.siteId, INSTANCE.ordinal)?.messageBoundary).toBe(3);
  });

  it("没有模型错误的长等待不失败也不创建新 turn", async () => {
    const { runtime, turns } = controlledRuntime();
    const { clock, advanceTo } = fakeClock();
    const { driver, calls } = makeDriver({ runtime, clock });
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, { instructions: "wait", typed: false });
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 100);
    await flush();
    expect(calls.failed).toEqual([]);
    expect(calls.askStalled).toEqual([]);
    expect(turns).toHaveLength(1);
    driver.cancelAsk(INSTANCE);
    turns[0]!.resolve(result);
    await flush();
    driver.dispose();
  });
});

it("已成功执行的有副作用工具在模型恢复耗尽后不被 Driver 重放", async () => {
  const { clock, advanceTo } = fakeClock();
  const { sink, calls } = recordingSink();
  const registry = createToolRegistry();
  let effects = 0;
  let modelCalls = 0;
  // 用真实工具执行器完成一次受控副作用；只证明不重调度，不声称外部操作可回滚或已停止。
  registry.register({
    capability: "Controlled workflow effect",
    inputSchema: {},
    outputSchema: { type: "string" },
    timeout: { kind: "none" },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "cancelled" },
    permission: {
      permission: "edit",
      reason: "Fixture",
      riskLevel: "low",
      sideEffectScope: "workspace",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 1024, maxModelBytes: 1024, strategy: "inline" },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    metadata: {
      name: "CommittedEffect",
      concurrentSafe: false,
      destructive: false,
      needsApproval: false,
      readOnly: false,
      riskLevel: "low",
      sideEffectScope: "workspace",
    },
    handler: async () => {
      effects++;
      return "effect committed";
    },
  });
  const driver = createAgentRuntimeWorkflowDriver({
    journal: new InMemoryJournalStore(),
    emit: () => {},
    cwd: process.cwd(),
    runId: RUN,
    clock,
    escalationRegistry: createWorkflowEscalationRegistry(),
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    runtimeFactory: ({ sessionId }) =>
      createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          taskType: "workflow_child",
          modelStreaming: "on",
          toolSearch: { mode: "off" },
        },
        {
          eventStore: createInMemorySessionEventStore(),
          toolRegistry: registry,
          modelFactory: createTestModelFactory({
            async *streamText() {
              modelCalls++;
              if (modelCalls === 1) {
                yield {
                  type: "tool_call",
                  toolCall: { id: "committed-effect", name: "CommittedEffect", input: {} },
                };
                yield { type: "finish", finishReason: "tool-calls", usage: {} };
                return;
              }
              expect(effects).toBe(1);
              yield { type: "text_delta", text: "partial" };
              throw Object.assign(new Error("connection reset"), {
                name: "AiSdkModelAdapterError",
                code: "model_network_error",
                context: { reason: "network_error", retryable: true },
              });
            },
          }),
        },
      ),
  })(sink);
  try {
    const session = await driver.createActorSession(ACTOR, {});
    driver.startAsk(session, INSTANCE, {
      instructions: "perform effect then report",
      typed: false,
    });
    await vi.waitFor(() => expect(calls.failed).toHaveLength(1));
    expect(calls.failed[0]?.error.code).toBe("RecoveryExhausted");
    expect(effects).toBe(1);
    expect(modelCalls).toBe(12);
    advanceTo(WORKFLOW_STALL_NOTIFY_AFTER_MS * 100);
    await flush();
    expect(modelCalls).toBe(12);
    expect(effects).toBe(1);
  } finally {
    driver.cancelAsk(INSTANCE);
    driver.dispose();
  }
});
