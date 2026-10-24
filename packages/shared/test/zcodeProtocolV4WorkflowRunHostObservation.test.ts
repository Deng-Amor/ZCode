import { describe, expect, it } from "vitest";
import * as protocol from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";

const host = () =>
  ({
    runId: "dwfrun-host-1",
    toolCallId: "tool-host-1",
    observationSource: "host-reconciliation",
    sequence: 0,
    eventType: "run-settled",
    payload: { status: "errored", error: { code: "RecoveryUncertain", message: "Result unknown" } },
  }) as const;

const parse = protocol.parseWorkflowRunProgressObservation;

function stopped(): WorkflowRunsState {
  return {
    revision: 4,
    runs: [
      {
        runId: "dwfrun-host-1",
        toolCallId: "tool-host-1",
        status: "stopped",
        resumable: true,
        stopReason: "superseded",
        supersededBy: "dwfrun-next",
        error: "old error",
        resumedFrom: "dwfrun-before",
        usage: { spentTokens: 7, nodesUsed: 2 },
        actors: [],
        nodes: [
          { siteId: "unknown", ordinal: 1, phase: "executing" },
          { siteId: "kept", ordinal: 1, phase: "settled", outcome: "ok" },
        ],
        lastEventSequence: 19,
      },
    ],
  };
}

describe("host reconciliation observation boundary", () => {
  it("recognizes only absent own source as legacy and preserves the strict valid observation", () => {
    expect(parse({ eventType: "run-settled" }).kind).toBe("legacy");
    expect(parse(Object.create({ observationSource: "future" })).kind).toBe("legacy");
    expect(parse(host())).toEqual({ kind: "host-reconciliation", value: host() });
  });

  const invalid: [string, () => Record<string, unknown>][] = [
    ["unknown source", () => ({ ...host(), observationSource: "future" })],
    ["explicit undefined", () => ({ ...host(), observationSource: undefined })],
    ["explicit null", () => ({ ...host(), observationSource: null })],
    ["wrong event", () => ({ ...host(), eventType: "run-started" })],
    ["nonzero cursor", () => ({ ...host(), sequence: 1 })],
    ["negative cursor", () => ({ ...host(), sequence: -1 })],
    ["string cursor", () => ({ ...host(), sequence: "0" })],
    ["unsafe identity", () => ({ ...host(), runId: "../private" })],
    ["empty identity", () => ({ ...host(), runId: "" })],
    ["long identity", () => ({ ...host(), runId: "a".repeat(129) })],
    ["wrong status", () => ({ ...host(), payload: { ...host().payload, status: "stopped" } })],
    [
      "wrong code",
      () => ({
        ...host(),
        payload: { status: "errored", error: { code: "Other", message: "bad" } },
      }),
    ],
    [
      "empty message",
      () => ({
        ...host(),
        payload: { status: "errored", error: { code: "RecoveryUncertain", message: " " } },
      }),
    ],
    [
      "long message",
      () => ({
        ...host(),
        payload: {
          status: "errored",
          error: { code: "RecoveryUncertain", message: "x".repeat(2049) },
        },
      }),
    ],
    ...["actorSessionId", "launchInputId", "truncated"].map(
      (field): [string, () => Record<string, unknown>] => [
        field,
        () => ({ ...host(), [field]: "forbidden" }),
      ],
    ),
    ...["resumable", "stopReason", "supersededBy", "input"].map(
      (field): [string, () => Record<string, unknown>] => [
        field,
        () => ({ ...host(), payload: { ...host().payload, [field]: "forbidden" } }),
      ],
    ),
    [
      "extra error field",
      () => ({
        ...host(),
        payload: { status: "errored", error: { ...host().payload.error, input: "private" } },
      }),
    ],
  ];

  it.each(invalid)("rejects %s before state or journal-watermark mutation", (_name, make) => {
    const input = make();
    expect(parse(input)).toMatchObject({ kind: "invalid", reasonCode: expect.any(String) });
    const prior = stopped();
    const before = structuredClone(prior);
    expect(protocol.reduceWorkflowRunsState(prior, input)).toBeNull();
    expect(prior).toEqual(before);
  });

  it("replaces stale terminal fields while retaining nodes, usage, lineage and the journal watermark", () => {
    const prior = stopped();
    const next = protocol.reduceWorkflowRunsState(prior, host());
    expect(next).not.toBeNull();
    expect(next!.runs[0]).toMatchObject({
      status: "errored",
      error: "Result unknown",
      lastEventSequence: 19,
      resumedFrom: "dwfrun-before",
      nodes: prior.runs[0]!.nodes,
      usage: prior.runs[0]!.usage,
    });
    for (const field of ["resumable", "stopReason", "supersededBy"])
      expect(next!.runs[0]).not.toHaveProperty(field);
    expect(protocol.reduceWorkflowRunsState(next!, host())).toBeNull();
    expect(prior).toEqual(stopped());
    expect(protocol.workflowRunsStateSchema.safeParse(next).success).toBe(true);
  });

  it("starts an absent run at journal cursor zero and makes repeated host facts idempotent", () => {
    const first = protocol.reduceWorkflowRunsState(undefined, host());
    expect(first!.runs[0]).toMatchObject({ status: "errored", lastEventSequence: 0 });
    expect(protocol.reduceWorkflowRunsState(first!, host())).toBeNull();
  });

  it("clears obsolete error and stop fields on ordinary Engine completion too", () => {
    const next = protocol.reduceWorkflowRunsState(stopped(), {
      runId: "dwfrun-host-1",
      sequence: 20,
      eventType: "run-settled",
      payload: { status: "completed" },
    });
    expect(next!.runs[0].status).toBe("completed");
    for (const field of ["resumable", "stopReason", "supersededBy", "error"])
      expect(next!.runs[0]).not.toHaveProperty(field);
  });
});
