import "@/styles.css";
import { createRoot } from "react-dom/client";
import type { Locale } from "@zcode/shared";
import type {
  ToolCallGetWorkflowRunDisplay,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import type {
  ToolCallBlockRenderContext,
  WorkflowRunCardSummary,
} from "@/ToolCallBlocks/shared.js";
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import { workflowRunResultView } from "@/app-shell/workflowRunPanel.js";

// 只给真实 renderer 喂合成读取值；没有 Engine、journal、IPC 或授权执行。
const params = new URLSearchParams(location.search);
const uncertain = params.get("sample") === "wf5";
const surface = params.get("surface") ?? "query";
const locale: Locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
const dark = params.get("theme") === "dark";
document.documentElement.className = dark ? "dark theme-zai-dark" : "theme-zai-light";
document.documentElement.lang = locale;
const code = uncertain ? "RecoveryUncertain" : "RecoveryExhausted";
const message = uncertain
  ? "E2E_WF5_UNKNOWN 外部结果未知，需核实，拒绝重复效果。External result unknown; verify before any repeated effect."
  : "E2E_WF4_EXHAUSTED A 的有限恢复预算已耗尽；B 已完成。A exhausted its bounded recovery budget; B remains completed.";
const longMessage = `${message}\n${Array.from({ length: 60 }, (_, index) => `E2E_RECOVERY_DETAIL_${index} ${message}`).join("\n")}`;
const completedResult = `E2E_WF4_B_RESULT\n${Array.from({ length: 60 }, (_, index) => `B completed result line ${index}: retained synthetic output 已完成结果保持。`).join("\n")}`;

const run: WorkflowRunState = {
  runId: uncertain ? "E2E_WF5_RENDERER" : "E2E_WF4_RENDERER",
  toolCallId: "E2E_RECOVERY_CREATE",
  status: "errored",
  error: longMessage,
  usage: { spentTokens: 1234, nodesUsed: 2 },
  actors: uncertain
    ? []
    : [
        { siteId: "actor#A", ordinal: 1, name: "A", status: "completed" },
        { siteId: "actor#B", ordinal: 1, name: "B", status: "completed" },
      ],
  nodes: uncertain
    ? [
        { siteId: "world#1", ordinal: 1, kind: "world-read", phase: "settled", outcome: "ok" },
        { siteId: "world#2", ordinal: 1, kind: "world-read", phase: "executing" },
      ]
    : [
        {
          siteId: "ask#A",
          ordinal: 1,
          kind: "ask",
          phase: "settled",
          outcome: "failed",
          actorSiteId: "actor#A",
          actorOrdinal: 1,
        },
        {
          siteId: "ask#B",
          ordinal: 1,
          kind: "ask",
          phase: "settled",
          outcome: "ok",
          actorSiteId: "actor#B",
          actorOrdinal: 1,
        },
      ],
  lastEventSequence: 7,
};
const display: ToolCallGetWorkflowRunDisplay = {
  kind: "get_workflow_run",
  runId: run.runId,
  label: code,
  status: "errored",
  error: { code, message: longMessage },
  usage: {
    spentTokens: 1234,
    nodesObserved: 2,
    nodesCompleted: 1,
    nodesFailed: uncertain ? 0 : 1,
    nodesRunning: uncertain ? 1 : 0,
  },
  actors: [],
  logTail: [],
};
const context: ToolCallBlockRenderContext = {
  nestedToolRenderer: () => null,
  toolCallNode: {
    toolCall: {
      toolId: `E2E_RECOVERY_QUERY_${code}`,
      kind: "GetWorkflowRun",
      toolName: "GetWorkflowRun",
      title: "GetWorkflowRun",
      input: { runId: run.runId },
      status: "completed",
      raw: { display },
    },
    childToolCalls: [],
  },
  workspacePath: "/synthetic-renderer-fixture",
  displayModel: {
    inlinePreview: { type: "none" },
    planResult: null,
    viewerSource: null,
    viewerLabelId: "codeViewer.viewCode",
    showSummaryFileLink: false,
    showInput: false,
    showOutput: false,
    showKind: false,
  },
  viewerSource: null,
  rawFileSummaries: [],
  isRunning: false,
  statusLabel: "",
  childToolList: null,
  canToggle: true,
  forceOpen: false,
  theme: dark ? "dark" : "light",
};
const summary: WorkflowRunCardSummary = {
  runId: run.runId,
  toolCallId: run.toolCallId,
  status: run.status,
  nodesSettled: uncertain ? 1 : 2,
  nodesTotal: 2,
  run,
};
const graph: NonNullable<WorkflowRunDigestProps["graph"]> = {
  steps: [
    {
      id: "ask#A",
      kind: "ask",
      label: "A",
      line: 2,
      column: 1,
      lane: "actor#A",
      phase: "phase#work",
    },
    {
      id: "ask#B",
      kind: "ask",
      label: "B",
      line: 3,
      column: 1,
      lane: "actor#B",
      phase: "phase#work",
    },
  ],
  lanes: [
    { id: "actor#A", name: "A", line: 1, column: 1 },
    { id: "actor#B", name: "B", line: 1, column: 2 },
  ],
  participants: [
    { id: "phase#work:actor#A", phase: "phase#work", lane: "actor#A", steps: ["ask#A"] },
    { id: "phase#work:actor#B", phase: "phase#work", lane: "actor#B", steps: ["ask#B"] },
  ],
  handoffs: [],
  phases: [{ id: "phase#work", name: "work", line: 1 }],
  phaseEdges: [],
  exits: ["phase#work"],
};
// B 独立完成结果预览只证明这个导出分区消费 preview 的显示，不冒充父 run 的持久化结果。
const resultRun: WorkflowRunState =
  surface === "result"
    ? {
        ...run,
        runId: "E2E_WF4_B_RESULT_PREVIEW",
        status: "completed",
        error: undefined,
        actors: [],
        nodes: [],
        resultPreview: completedResult,
      }
    : run;

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <style>{`html,body,#root{width:100%;height:100%;margin:0;min-height:0;overflow:hidden} .recovery-boundary{min-height:0;min-width:0;overflow:hidden}`}</style>
      <main
        className="recovery-boundary flex h-full flex-col bg-background text-foreground"
        data-testid="recovery-page"
      >
        <header
          className="shrink-0 border-b border-border px-3 py-2 text-ui-xs"
          data-testid="fixture-heading"
        >
          Renderer fixture · {code} · {surface} · {locale}
        </header>
        <section className="recovery-boundary flex flex-1 flex-col p-3" data-testid="recovery-tab">
          <div className="recovery-boundary flex flex-1 flex-col gap-3" data-testid="recovery-card">
            {surface === "query" ? (
              <GetWorkflowRunToolCallBlock {...context} />
            ) : (
              <>
                <WorkflowRunStatusHeader
                  cancellable={false}
                  onCancel={() => {}}
                  onResume={() => {}}
                  resumable={false}
                  run={resultRun}
                  title={resultRun.runId}
                  usage={resultRun.usage}
                  summaryParts={undefined}
                />
                {surface === "detail" && !uncertain ? (
                  <WorkflowRunDigest
                    graph={graph}
                    name="E2E WF4 A failed / B completed"
                    runId={run.runId}
                    summary={summary}
                    testIdKey="recovery"
                  />
                ) : null}
                <WorkflowRunResultSections result={workflowRunResultView(resultRun)} />
              </>
            )}
          </div>
        </section>
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
