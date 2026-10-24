import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { SessionEventType } from "@zcode/contracts";
import { AgentRuntime, type AgentRuntimeDeps } from "@zcode/core";
import type {
  DynamicWorkflowRunProgressPayload,
  EventId,
  FileSystemPort,
  ProjectId,
  SessionEvent,
  SessionId,
  TraceId,
} from "@zcode/contracts";
import { compileWorkflowScript, type RunEvent } from "@zcode/dynamic-workflow";
import {
  conversationTopic,
  V4_NOTIFICATIONS,
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  conversationTopicWireCandidateSchema,
  applyConversationDeltas,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type CommandEnvelope,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import { createDynamicWorkflowRunProgressSink } from "../src/app/dynamic-workflow-run-progress-sink.js";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { createWorkflowHostObservationAdapter } from "../src/zcode-protocol/workflow-host-observation-adapter.js";
import type { WorkflowHostObservationOutcome } from "../src/zcode-protocol/workflow-host-observation/contract.js";

type Store = Awaited<ReturnType<typeof createSqliteSessionStore>>;
type Service = ReturnType<typeof createDynamicWorkflowRunService>;
type Gateway = ReturnType<typeof createConversationV4Gateway>;

const PARENT = "sess_wf5_resubscribe" as SessionId;
const RUN = "dwfrun-wf5-resubscribe";
const TOOL = "call-wf5-resubscribe";
const FIRST = { siteId: "world#1", ordinal: 1 };
const UNKNOWN = { siteId: "world#2", ordinal: 1 };
const SCRIPT = 'await world.run("E2E_WF5_ONE"); await world.run("E2E_WF5_TWO");';

async function seed(store: Store, cwd: string): Promise<void> {
  expect(compileWorkflowScript(SCRIPT)).toMatchObject({ ok: true, diagnostics: [] });
  await store.createSession({
    id: PARENT,
    projectID: "project_wf5_resubscribe" as ProjectId,
    slug: "wf5-resubscribe",
    directory: cwd,
    path: cwd,
    title: "Synthetic WF5 stopped history",
    version: "test",
    time: { created: 1, updated: 2 },
  });
  const journal = store.workflowJournalStore();
  // 合成历史只验拒绝前门：inputHash 不冒充可成功恢复的生产哈希，脚本从不执行。
  journal.createRun({
    runId: RUN,
    parentSessionId: PARENT,
    cwd,
    toolCallId: TOOL,
    scriptText: SCRIPT,
    scriptHash: createHash("sha256").update(SCRIPT, "utf8").digest("hex"),
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "stopped",
    stopReason: "interrupted",
  });
  journal.putNode({
    runId: RUN,
    ...FIRST,
    kind: "world-run",
    inputHash: "synthetic-refusal-only-one",
    status: "completed",
    result: { marker: "E2E_WF5_KEPT", exitCode: 0 },
  });
  journal.putNode({
    runId: RUN,
    ...UNKNOWN,
    kind: "world-run",
    inputHash: "synthetic-refusal-only-two",
    status: "running",
  });
  const events: RunEvent[] = [
    { type: "run-started", runId: RUN, caps: { maxConcurrency: 1 } },
    { type: "run-launched", inputId: "input-wf5", toolCallId: TOOL, parentSessionId: PARENT },
    { type: "node-queued", instance: FIRST, kind: "world-run" },
    { type: "node-dispatched", instance: FIRST, kind: "world-run" },
    { type: "node-settled", instance: FIRST, outcome: "ok" },
    { type: "node-queued", instance: UNKNOWN, kind: "world-run" },
    { type: "node-dispatched", instance: UNKNOWN, kind: "world-run" },
    { type: "run-settled", status: "stopped", stopReason: "interrupted" },
  ];
  for (const event of events) journal.appendEvent(RUN, event);
}

function makeService(
  store: Store,
  onRunReconciled?: Parameters<typeof createDynamicWorkflowRunService>[0]["onRunReconciled"],
) {
  const prepareController = vi.fn(async () => {
    throw new Error("uncertain refusal must precede controller authorization");
  });
  const createActorRuntime = vi.fn((): never => {
    throw new Error("uncertain refusal must not launch an actor");
  });
  const onRunEvent = vi.fn();
  const unexpectedIo = vi.fn((): never => {
    throw new Error("uncertain refusal must not execute filesystem or process IO");
  });
  const service = createDynamicWorkflowRunService({
    journal: store.workflowJournalStore(),
    parentSessionId: PARENT,
    fileSystemPort: new Proxy({} as FileSystemPort, { get: () => unexpectedIo }),
    executionPort: { run: unexpectedIo },
    prepareController,
    createActorRuntime,
    onRunEvent,
    ...(onRunReconciled === undefined ? {} : { onRunReconciled }),
    availableParallelism: () => 1,
  });
  return { service, prepareController, createActorRuntime, onRunEvent, unexpectedIo };
}

function makeBridge(store: Store, service: Service, cwd: string, pendingFanout = false) {
  const eventStore = createInMemorySessionEventStore();
  const modelFactory = vi.fn<AgentRuntimeDeps["modelFactory"]>(() => {
    throw new Error("host observation must not instantiate a model");
  });
  const runtime = new AgentRuntime(
    PARENT,
    {
      workingDirectory: cwd,
      mode: "build",
      modelSelection: { providerId: "glm", modelId: "glm-4-air" },
      mcp: { enabled: false },
      titleGeneration: { enabled: false },
    },
    { eventStore, sessionStore: store, modelFactory },
  );
  const materializations: string[][] = [];
  const record = {
    app: {
      sessionId: PARENT,
      listModels: () => [],
      getMode: () => "build",
      readToolResultArtifact: async () => ({ content: "" }),
      resumeWorkflowRun: ({ workId }: { workId: string }) => service.resume!(workId),
      replayDynamicWorkflowRuns: (input: { excludeRunIds: ReadonlySet<string> }) => {
        materializations.push([...input.excludeRunIds]);
        return service.replayProgressForSession!(input);
      },
      runtime,
    },
    eventStore,
    createdAt: 0,
    updatedAt: 0,
    persistence: "immediate",
    stateRevision: 1,
    workspace: { workspaceKey: cwd, workspacePath: cwd },
  } as unknown as ZCodeProtocolSessionRecord;
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  const frames: ConversationTopicFrame[] = [];
  const clients = new Map<string, ConversationSnapshot>();
  const clientHeads = new Map<string, { logEpoch: string; toSeq: number }>();
  const assemblyFaults: unknown[] = [];
  const failedSubscriptions = new Set<string>();
  const failedEmits: string[] = [];
  const assembler = new TopicWireFrameAssembler<ConversationTopicFrame>(
    conversationTopicFrameSchema,
  );
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    },
    deps: { sessionStore: store },
    sessions: new Map([[PARENT, record]]),
    workspaceModelCatalogs: new Map(),
    v4Interactions: { resolve: () => false },
    notify: (notification: { method: string; params: unknown }) => {
      if (notification.method !== V4_NOTIFICATIONS.conversationFrame) return;
      const candidate = conversationTopicWireCandidateSchema.parse(notification.params);
      if (failedSubscriptions.has(candidate.subscriptionId)) {
        failedEmits.push(candidate.subscriptionId);
        throw new Error("controlled physical emit failure");
      }
      for (const result of assembler.accept(candidate)) {
        if (result.kind === "fault") {
          assemblyFaults.push(result.fault);
          continue;
        }
        const frame = result.frame;
        frames.push(frame);
        const previous = clients.get(frame.subscriptionId);
        const head = clientHeads.get(frame.subscriptionId);
        if (head && frame.payload.kind === "deltas") {
          if (
            previous?.logEpoch !== head.logEpoch ||
            frame.fromSeq !== head.toSeq ||
            frame.toSeq < frame.fromSeq
          ) {
            throw new Error("online wire sequence gap or epoch mismatch");
          }
        }
        clientHeads.set(frame.subscriptionId, {
          logEpoch:
            frame.payload.kind === "snapshot"
              ? frame.payload.snapshot.logEpoch
              : previous!.logEpoch,
          toSeq: frame.toSeq,
        });
        if (frame.payload.kind === "snapshot")
          clients.set(frame.subscriptionId, frame.payload.snapshot);
        else {
          if (!previous) throw new Error("online delta has no accepted initial snapshot");
          clients.set(
            frame.subscriptionId,
            applyConversationDeltas(previous, frame.payload.deltas),
          );
        }
      }
    },
    requestClient: async (): Promise<never> => {
      throw new Error("refusal snapshot must not issue reverse requests");
    },
    logger: {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (message: string, context?: Record<string, unknown>) =>
        warnings.push({ message, context }),
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const gateway = createConversationV4Gateway(context);
  context.v4Gateway = gateway;
  const outcomes: WorkflowHostObservationOutcome[] = [];
  let active = true;
  const current = () => active && context.sessions.get(PARENT) === record;
  const verifyStored = vi.fn(async (event: SessionEvent) => {
    const matches = (await eventStore.getEvents(PARENT)).filter((item) => item.id === event.id);
    expect(matches).toEqual([event]);
    return matches[0]!;
  });
  const ensureCommit = vi.fn(gateway.ensureWorkflowHostObservationCommit.bind(gateway));
  const observationAdapter = createWorkflowHostObservationAdapter({
    isCurrent: current,
    now: () => performance.now(),
    verifyStored,
    ensureCommit: (event, owner) => ensureCommit(PARENT, { eventId: event.id, runId: RUN }, owner),
    report: (outcome) => outcomes.push(outcome),
  });
  let releaseFanout!: () => void;
  const fanout = new Promise<void>((resolve) => {
    releaseFanout = resolve;
  });
  let fanoutEntered = false;
  // 修复回归依据：普通 sink 排在协议订阅之前，不能让其 pending 阻断已存事实的独立核实。
  const unsubscribePending = pendingFanout
    ? runtime.subscribeEvents({
        onSessionEvent(event) {
          if (pendingFanout && event.type === SessionEventType.DynamicWorkflowRunProgress) {
            fanoutEntered = true;
            return fanout;
          }
        },
      })
    : () => {};
  const forwarded: SessionEvent[] = [];
  const forwardFailures: unknown[] = [];
  // 镜像生产 onSessionEvent 的关键转发接缝；不是完整 server/物理 transport 验收。
  const unsubscribeRuntime = runtime.subscribeEvents({
    onSessionEvent(event) {
      forwarded.push(event);
      try {
        if (
          (event.payload as DynamicWorkflowRunProgressPayload).observationSource ===
          "host-reconciliation"
        )
          observationAdapter.accept(event, () => gateway.ingest(PARENT, event));
        else gateway.ingest(PARENT, event);
      } catch (error) {
        forwardFailures.push(error);
        throw error;
      }
    },
  });
  const executor = new V4CommandExecutor({
    getRecord: (sessionId) => (sessionId === PARENT ? record : undefined),
  });
  expect(record.app.runtime).toBe(runtime);
  expect(record.eventStore).toBe(eventStore);
  expect(runtime.getSessionEventStore()).toBe(eventStore);
  return {
    gateway,
    executor,
    eventStore,
    materializations,
    warnings,
    runtime,
    modelFactory,
    frames,
    clients,
    assemblyFaults,
    context,
    forwarded,
    forwardFailures,
    unsubscribeRuntime,
    observationAdapter,
    outcomes,
    verifyStored,
    ensureCommit,
    record,
    clientHeads,
    failedSubscriptions,
    failedEmits,
    releaseFanout,
    fanoutEntered: () => fanoutEntered,
    retire: () => {
      active = false;
      observationAdapter.dispose();
    },
    unsubscribePending,
  };
}

function makeConnectedBridge(store: Store, cwd: string, pendingFanout = false) {
  let runtime: AgentRuntime | undefined;
  let bridge: ReturnType<typeof makeBridge>;
  const sink = createDynamicWorkflowRunProgressSink({
    sessionId: PARENT,
    onWorkflowHostObservationStored: (event) => bridge.observationAdapter.accept(event),
    getRuntime: () => {
      if (!runtime) throw new Error("parent runtime not ready");
      return runtime;
    },
  });
  const onRunReconciled = vi.fn(sink);
  const owner = makeService(store, onRunReconciled);
  bridge = makeBridge(store, owner.service, cwd, pendingFanout);
  runtime = bridge.runtime;
  return { ...owner, ...bridge, onRunReconciled };
}

async function closeBridge(bridge: ReturnType<typeof makeBridge>): Promise<void> {
  bridge.retire();
  bridge.releaseFanout();
  bridge.unsubscribePending();
  bridge.runtime.beginShutdown();
  bridge.unsubscribeRuntime();
  bridge.gateway.dispose();
  await bridge.runtime.closeBrowserSession();
}

async function subscribe(
  bridge: ReturnType<typeof makeBridge>,
  connectionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
) {
  const result = await bridge.gateway.subscribeReserved({
    topic: conversationTopic(PARENT),
    connectionId,
    clientMode,
    workflowRunDeltas: true,
  });
  // 模拟 server ACK/初始 wire 已接纳；只有这一步是测试本地派发，后续通知必须由 gateway 自动发出。
  for (const wire of result.initialWires)
    bridge.context.notify({ method: V4_NOTIFICATIONS.conversationFrame, params: wire });
  expect(result.commit()).toBe(true);
  if (result.initialFrame?.payload.kind !== "snapshot") throw new Error("snapshot missing");
  const accepted = bridge.clients.get(result.ack.subscriptionId);
  expect(accepted).toEqual(result.initialFrame.payload.snapshot);
  const run = accepted?.workflowRuns?.runs.find((item) => item.runId === RUN);
  if (!run) throw new Error("seeded run missing from snapshot");
  return { run, subscriptionId: result.ack.subscriptionId };
}

function unsubscribe(gateway: Gateway, subscriptionId: string, connectionId: string): void {
  gateway.unsubscribe({ topic: conversationTopic(PARENT), subscriptionId, connectionId });
}

async function appendControlledMemory(
  bridge: ReturnType<typeof makeBridge>,
  service: Service,
): Promise<void> {
  const replay = await service.replayProgressForSession!({ excludeRunIds: new Set() });
  let sequence = 0;
  // 条件对照明确注入旧stopped进度；不是实际Desktop/runtime执行链。
  for (const payload of replay) {
    sequence += 1;
    const event: SessionEvent = {
      id: `wf5-memory-${sequence}` as EventId,
      sessionId: PARENT,
      type: SessionEventType.DynamicWorkflowRunProgress,
      timestamp: new Date(sequence),
      traceId: "trace-wf5-memory" as TraceId,
      sequenceNumber: sequence,
      payload: payload satisfies DynamicWorkflowRunProgressPayload,
    } as SessionEvent;
    await bridge.eventStore.append(event);
  }
}

function view(run: WorkflowRunState) {
  return {
    status: run.status,
    resumable: run.resumable,
    stopReason: run.stopReason,
    error: run.error,
  };
}

const profiles = ["desktop-continuous", "web-remote-replayable"] as const;
it.each(
  (["resume", "amend"] as const).flatMap((operation) =>
    (["live", "pending", "emit", "replace", "close"] as const).map((scenario) => ({
      operation,
      scenario,
    })),
  ),
)(
  "B17/B18/B21/B22 real $operation refusal / $scenario",
  async ({ operation, scenario }) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-b5-joint-"));
    const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    let hot: ReturnType<typeof makeConnectedBridge> | undefined;
    let replacement: ReturnType<typeof makeConnectedBridge> | undefined;
    try {
      await seed(store, root);
      const pending = scenario === "pending" || scenario === "replace" || scenario === "close";
      hot = makeConnectedBridge(store, root, pending);
      const h = hot;
      const subscriptions = await Promise.all(
        profiles.map((profile) => subscribe(h, profile, profile)),
      );
      const oldSnapshots = subscriptions.map((sub) => h.clients.get(sub.subscriptionId)!);
      const oldHeads = subscriptions.map((sub) => h.clientHeads.get(sub.subscriptionId)!);
      const journal = store.workflowJournalStore();
      const nodes = journal.listNodes(RUN, { kinds: "all", withResult: true });
      const events = journal.listEvents(RUN, { types: "all", reportItems: "all" });
      const rawBefore = await h.eventStore.getLatestSequenceNumber(PARENT);
      if (scenario === "emit")
        subscriptions.forEach((sub) => h.failedSubscriptions.add(sub.subscriptionId));
      const refusal =
        operation === "resume"
          ? await h.service.resume!(RUN)
          : await h.service.amend!({
              predecessorRunId: RUN,
              scriptText: SCRIPT,
              cwd: root,
              trace: { traceId: "trace-b5-amend" as TraceId, sessionId: PARENT },
            });
      expect(refusal).toMatchObject({ ok: false, reason: "recovery_uncertain" });
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));
      expect(h.outcomes[0]).toMatchObject({
        event: "workflow.host_observation.sync.completed",
        strictAttempted: expect.any(Boolean),
      });
      if (pending) expect(h.outcomes[0]!.strictAttempted).toBe(true);
      const stored = await h.eventStore.getEventsAfter(PARENT, rawBefore);
      expect(stored).toHaveLength(1);
      const host = stored[0]!;
      expect(host.sequenceNumber).toBe(rawBefore + 1);
      expect(host.payload).toMatchObject({
        observationSource: "host-reconciliation",
        sequence: 0,
        payload: { status: "errored", error: { code: "RecoveryUncertain" } },
      });
      expect(h.verifyStored).toHaveBeenCalledWith(host, expect.any(AbortSignal));
      expect(h.ensureCommit).toHaveBeenCalledTimes(1);
      if (pending) {
        expect(h.fanoutEntered()).toBe(true);
        expect(h.forwarded).toEqual([]);
      }
      const strictLoads = h.materializations.length;
      if (scenario === "emit") {
        expect(new Set(h.failedEmits)).toEqual(
          new Set(subscriptions.map((sub) => sub.subscriptionId)),
        );
        h.failedSubscriptions.clear();
        for (const [index, sub] of subscriptions.entries()) {
          const recovery = await h.gateway.resyncReserved({
            topic: conversationTopic(PARENT),
            connectionId: profiles[index],
            subscriptionId: sub.subscriptionId,
            base: { logEpoch: oldHeads[index]!.logEpoch, seq: oldHeads[index]!.toSeq },
          });
          for (const wire of recovery.initialWires)
            h.context.notify({ method: V4_NOTIFICATIONS.conversationFrame, params: wire });
          expect(recovery.commit()).toBe(true);
        }
      }
      await vi.waitFor(() => {
        for (const sub of subscriptions) {
          const run = h.clients
            .get(sub.subscriptionId)!
            .workflowRuns!.runs.find((item) => item.runId === RUN)!;
          expect(run).toMatchObject({ status: "errored" });
          expect(run.error).toMatch(/unknown.*verif/iu);
          expect(run.resumable).toBeUndefined();
          expect(run.stopReason).toBeUndefined();
        }
      });
      for (const [index, sub] of subscriptions.entries()) {
        expect
          .soft(h.clients.get(sub.subscriptionId)!.workflowRuns!.runs[0]!.nodes)
          .toEqual(oldSnapshots[index]!.workflowRuns!.runs[0]!.nodes);
      }
      for (const [index, sub] of subscriptions.entries()) {
        unsubscribe(h.gateway, sub.subscriptionId, profiles[index]!);
        const reconnect = await h.gateway.subscribeReserved({
          topic: conversationTopic(PARENT),
          connectionId: `reconnect-${index}`,
          clientMode: profiles[index],
          workflowRunDeltas: true,
          base: { logEpoch: oldHeads[index]!.logEpoch, seq: oldHeads[index]!.toSeq },
        });
        h.clients.set(reconnect.ack.subscriptionId, oldSnapshots[index]!);
        h.clientHeads.set(reconnect.ack.subscriptionId, oldHeads[index]!);
        for (const wire of reconnect.initialWires)
          h.context.notify({ method: V4_NOTIFICATIONS.conversationFrame, params: wire });
        expect(reconnect.commit()).toBe(true);
        expect(h.clients.get(reconnect.ack.subscriptionId)!.workflowRuns!.runs[0]).toMatchObject({
          status: "errored",
        });
        unsubscribe(h.gateway, reconnect.ack.subscriptionId, `reconnect-${index}`);
      }
      if (scenario === "replace") {
        replacement = makeConnectedBridge(store, root);
        h.context.sessions.set(PARENT, replacement.record);
        h.retire();
      } else if (scenario === "close") {
        h.retire();
        h.gateway.dispose();
      }
      h.releaseFanout();
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      if (pending) {
        await vi.waitFor(() => expect(h.outcomes).toHaveLength(2));
        expect(h.outcomes[1]).toMatchObject(
          scenario === "pending"
            ? { event: "workflow.host_observation.sync.completed", strictAttempted: true }
            : { event: "workflow.host_observation.sync.failed", reasonCode: "disposed" },
        );
        expect(h.ensureCommit).toHaveBeenCalledTimes(scenario === "pending" ? 2 : 1);
      }
      expect(h.materializations).toHaveLength(strictLoads);
      expect(await h.eventStore.getEventsAfter(PARENT, rawBefore)).toEqual([host]);
      if (replacement) {
        expect(await replacement.eventStore.getLatestSequenceNumber(PARENT)).toBe(0);
        expect(replacement.frames).toEqual([]);
        expect(replacement.outcomes).toEqual([]);
      }
      expect(journal.getRun(RUN)).toMatchObject({
        status: "errored",
        failure: { code: "RecoveryUncertain" },
      });
      expect(journal.getRun(RUN)?.stopReason).toBeUndefined();
      expect(journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual(nodes);
      expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual(events);
      for (const forbidden of [
        h.modelFactory,
        h.prepareController,
        h.createActorRuntime,
        h.onRunEvent,
        h.unexpectedIo,
      ])
        expect(forbidden).not.toHaveBeenCalled();
      expect(h.assemblyFaults).toEqual([]);
      expect(h.forwardFailures).toEqual([]);
    } finally {
      try {
        await Promise.all(
          [hot, replacement].map(async (bridge) => {
            if (!bridge) return;
            try {
              await closeBridge(bridge);
            } finally {
              await bridge.service.close();
            }
          }),
        );
      } finally {
        try {
          store.close();
        } finally {
          await cleanupPrivateRoot(root);
        }
      }
    }
  },
  30_000,
);

async function cleanupPrivateRoot(root: string): Promise<void> {
  const child = relative(resolve(tmpdir()), resolve(root));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("unsafe private fixture cleanup");
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
}

it.each([false, true])(
  "WF5 host observation reaches both online profiles, warm resubscribe and cold read (controlled memory: %s)",
  async (controlledMemory) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-wf5-resubscribe-"));
    const dbPath = join(root, "session.sqlite");
    let store: Store | undefined;
    let service: Service | undefined;
    let gateway: Gateway | undefined;
    let bridge: ReturnType<typeof makeBridge> | undefined;
    try {
      store = await createSqliteSessionStore({ dbPath });
      await seed(store, root);
      const hotService = makeConnectedBridge(store, root);
      service = hotService.service;
      const hot = hotService;
      bridge = hot;
      gateway = hot.gateway;
      if (controlledMemory) await appendControlledMemory(hot, service);
      const first = await subscribe(hot, "connection-first");
      const firstWeb = await subscribe(hot, "web-first", "web-remote-replayable");
      expect(first.run).toMatchObject({ status: "stopped", resumable: true });
      expect(firstWeb.run).toEqual(first.run);
      const onlineStart = hot.frames.length;
      const rawBefore = await hot.eventStore.getLatestSequenceNumber(PARENT);
      const journal = store.workflowJournalStore();
      const nodesBefore = journal.listNodes(RUN, { kinds: "all", withResult: true });
      const eventsBefore = journal.listEvents(RUN, { types: "all", reportItems: "all" });
      const envelope: CommandEnvelope = {
        commandId: "command-wf5-resume",
        clientId: "client-wf5-probe",
        issuedAt: Date.now(),
        sessionId: PARENT,
        type: "resumeWorkflowRun",
        payload: { workId: RUN },
      };
      await expect(hot.executor.execute(envelope)).rejects.toMatchObject({
        reasonCode: "fault.command.workflowRunResumeRejected.recovery_uncertain",
        message: expect.stringContaining("external outcome is unknown"),
      });
      expect(journal.getRun(RUN)).toMatchObject({
        status: "errored",
        failure: { code: "RecoveryUncertain" },
      });
      expect(journal.getRun(RUN)?.stopReason).toBeUndefined();
      expect(journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual(nodesBefore);
      expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual(eventsBefore);
      expect(hotService.prepareController).not.toHaveBeenCalled();
      expect(hotService.createActorRuntime).not.toHaveBeenCalled();
      expect(hotService.onRunEvent).not.toHaveBeenCalled();
      expect(hotService.unexpectedIo).not.toHaveBeenCalled();
      await vi.waitFor(async () => {
        const observations = (await hot.eventStore.getEventsAfter(PARENT, rawBefore)).filter(
          (event) =>
            event.type === SessionEventType.DynamicWorkflowRunProgress &&
            (event.payload as DynamicWorkflowRunProgressPayload).observationSource ===
              "host-reconciliation",
        );
        expect(observations).toHaveLength(1);
      });
      const correction = (await hot.eventStore.getEventsAfter(PARENT, rawBefore)).find(
        (event) =>
          event.type === SessionEventType.DynamicWorkflowRunProgress &&
          (event.payload as DynamicWorkflowRunProgressPayload).observationSource ===
            "host-reconciliation",
      )!;
      expect(correction.sequenceNumber).toBeGreaterThan(rawBefore);
      expect(correction.turnId).toBeUndefined();
      expect(correction.payload).toMatchObject({
        observationSource: "host-reconciliation",
        sequence: 0,
        eventType: "run-settled",
        runId: RUN,
        toolCallId: TOOL,
        payload: { status: "errored", error: { code: "RecoveryUncertain" } },
      });
      expect(hot.forwarded.find((event) => event.id === correction.id)).toBe(correction);
      await gateway.waitForProjectionEventCommit(PARENT, String(correction.id));
      await vi.waitFor(
        () => {
          for (const subscription of [first, firstWeb]) {
            const online = hot.clients
              .get(subscription.subscriptionId)
              ?.workflowRuns?.runs.find((run) => run.runId === RUN);
            expect(online).toMatchObject({
              status: "errored",
              nodes: first.run.nodes,
              usage: first.run.usage,
              lastEventSequence: first.run.lastEventSequence,
            });
            expect(online).not.toHaveProperty("resumable");
            expect(online).not.toHaveProperty("stopReason");
            expect(online).not.toHaveProperty("supersededBy");
            expect(online?.error).toMatch(/unknown.*verif/iu);
            expect(
              hot.frames
                .slice(onlineStart)
                .some((frame) => frame.subscriptionId === subscription.subscriptionId),
            ).toBe(true);
          }
        },
        { timeout: 5000, interval: 10 },
      );
      expect(hot.onRunReconciled).toHaveBeenCalledTimes(1);
      expect(hot.modelFactory).not.toHaveBeenCalled();
      expect(hot.forwardFailures).toEqual([]);
      expect(hot.assemblyFaults).toEqual([]);
      expect(hot.warnings).toEqual([]);
      console.info(
        "WF5 host online observation",
        JSON.stringify({
          controlledMemory,
          rawBefore,
          rawAfter: correction.sequenceNumber,
          hostJournalSequence: (correction.payload as DynamicWorkflowRunProgressPayload).sequence,
          profiles: [first, firstWeb].map((subscription, index) => ({
            clientMode: index === 0 ? "desktop-continuous" : "web-remote-replayable",
            onlineFrames: hot.frames
              .slice(onlineStart)
              .filter((frame) => frame.subscriptionId === subscription.subscriptionId).length,
            run: view(
              hot.clients
                .get(subscription.subscriptionId)!
                .workflowRuns!.runs.find((run) => run.runId === RUN)!,
            ),
          })),
          hostObservations: hot.onRunReconciled.mock.calls.length,
          engineEvents: hot.onRunEvent.mock.calls.length,
          modelCalls: hot.modelFactory.mock.calls.length,
        }),
      );
      unsubscribe(gateway, first.subscriptionId, "connection-first");
      unsubscribe(gateway, firstWeb.subscriptionId, "web-first");
      expect(gateway.hasConversationSubscribers(PARENT)).toBe(false);
      const warm = await subscribe(hot, "connection-warm");
      const warmWeb = await subscribe(hot, "web-warm", "web-remote-replayable");
      expect(warm.subscriptionId).not.toBe(first.subscriptionId);
      console.info(
        "WF5 same-gateway observation",
        JSON.stringify({
          controlledMemory,
          first: view(first.run),
          warm: view(warm.run),
          materializations: hot.materializations,
          warnings: hot.warnings,
        }),
      );
      // 权威事实已经errored；保留验收期望，不能把观察到的stale stopped改成expected。
      expect.soft(warm.run.status).toBe("errored");
      expect.soft(warm.run.resumable).not.toBe(true);
      expect.soft(warm.run.stopReason).toBeUndefined();
      expect(warmWeb.run).toEqual(warm.run);
      unsubscribe(gateway, warm.subscriptionId, "connection-warm");
      unsubscribe(gateway, warmWeb.subscriptionId, "web-warm");
      await closeBridge(hot);
      bridge = undefined;
      gateway = undefined;
      await service.close();
      service = undefined;
      store.close();
      store = undefined;

      // 冷对照同时新建store/service/gateway/context/空eventStore；不重seed、不沿用registry。
      store = await createSqliteSessionStore({ dbPath });
      const coldService = makeConnectedBridge(store, root);
      service = coldService.service;
      const cold = coldService;
      bridge = cold;
      gateway = cold.gateway;
      expect(await cold.eventStore.getLatestSequenceNumber(PARENT)).toBe(0);
      const snapshot = await subscribe(cold, "connection-cold");
      const snapshotWeb = await subscribe(cold, "web-cold", "web-remote-replayable");
      console.info(
        "WF5 fresh-service observation",
        JSON.stringify({
          controlledMemory,
          cold: view(snapshot.run),
          materializations: cold.materializations,
          warnings: cold.warnings,
        }),
      );
      expect(snapshot.run.status).toBe("errored");
      expect(snapshot.run.resumable).not.toBe(true);
      expect(snapshot.run.stopReason).toBeUndefined();
      expect(snapshot.run.error).toMatch(/unknown.*verif/iu);
      expect(snapshotWeb.run).toEqual(snapshot.run);
      expect(snapshot.run.nodes).toEqual(first.run.nodes);
      expect(
        store.workflowJournalStore().listNodes(RUN, { kinds: "all", withResult: true }),
      ).toEqual(nodesBefore);
      expect(coldService.prepareController).not.toHaveBeenCalled();
      expect(coldService.createActorRuntime).not.toHaveBeenCalled();
      expect(coldService.unexpectedIo).not.toHaveBeenCalled();
      expect(coldService.onRunEvent).not.toHaveBeenCalled();
      expect(coldService.onRunReconciled).not.toHaveBeenCalled();
      expect(cold.modelFactory).not.toHaveBeenCalled();
      expect(cold.assemblyFaults).toEqual([]);
      expect(cold.forwardFailures).toEqual([]);
      expect(cold.warnings).toEqual([]);
      unsubscribe(gateway, snapshot.subscriptionId, "connection-cold");
      unsubscribe(gateway, snapshotWeb.subscriptionId, "web-cold");
    } finally {
      try {
        if (bridge) await closeBridge(bridge);
        else gateway?.dispose();
      } finally {
        try {
          await service?.close();
        } finally {
          try {
            store?.close();
          } finally {
            await cleanupPrivateRoot(root);
          }
        }
      }
      console.info(
        "WF5 private fixture cleanup",
        JSON.stringify({ controlledMemory, directoryRemoved: true }),
      );
    }
  },
  30_000,
);
