import { writeE2EJsonFileAtomically } from "./e2e-atomic-json-file.js";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AdmissionOptions {
  specs: readonly string[];
  desktopDir: string;
  optIn: string | undefined;
  mode: string;
  toolsearchProxy: boolean;
  codingPlanProxy: boolean;
}

const WF4_SPEC =
  "test/e2e/conversation-session/manual-review/pending/conversation-session-workflow-recovery-exhausted.test.ts";

export function resolveWorkflowRecoverySafeCapture(options: AdmissionOptions): "off" | "enabled" {
  try {
    const normalize = (path: string) => {
      const absolute = resolve(
        options.desktopDir,
        path.startsWith("file:") ? fileURLToPath(path) : path.replaceAll("\\", "/"),
      );
      return process.platform === "win32" ? absolute.toLowerCase() : absolute;
    };
    const target = normalize(WF4_SPEC);
    const targets = options.specs.map(normalize);
    if (!targets.includes(target) && options.optIn === undefined) return "off";
    if (
      targets.length !== 1 ||
      targets[0] !== target ||
      options.optIn !== "1" ||
      options.mode !== "replay" ||
      options.toolsearchProxy ||
      options.codingPlanProxy
    ) {
      throw new Error("invalid admission");
    }
    return "enabled";
  } catch {
    throw new Error("WF4_SAFE_CAPTURE_ADMISSION_FAILED");
  }
}

export function createWorkflowRecoverySafeCapture(persist = writeE2EJsonFileAtomically) {
  let failed = false;
  return {
    artifactWriter: (async (path, value) => {
      try {
        await persist(path, projectArtifact(value));
      } catch {
        // 修复依据：串行 writer 后续可成功，不能清除此前丢失证据的失败事实。
        failed = true;
        throw createWorkflowRecoverySafeError();
      }
    }) satisfies typeof writeE2EJsonFileAtomically,
    markFailed() {
      failed = true;
    },
    assertHealthy() {
      if (failed) throw createWorkflowRecoverySafeError();
    },
  };
}

export function createWorkflowRecoveryProof(
  binding: { artifactDir: string; runId: string; ownerId: string },
  persist = writeE2EJsonFileAtomically,
) {
  const root = resolve(binding.artifactDir);
  const directory = resolve(root, "wf4-safe-capture-owner");
  const statePath = resolve(directory, "state.json");
  const claimPath = resolve(directory, "claimed");
  let claimed = false;
  let finished = false;
  const fail = () => {
    throw createWorkflowRecoverySafeError();
  };
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const checkDirectory = async (path: string) => {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical(await realpath(path)) !== canonical(path)
    )
      fail();
  };
  const checkRoot = async () => {
    if (
      !/^[\w.-]{1,160}$/.test(binding.runId) ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(binding.ownerId)
    )
      fail();
    await checkDirectory(root);
  };
  const readState = async () => {
    await checkRoot();
    await checkDirectory(directory);
    const stat = await lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048) fail();
    const value = object(JSON.parse(await readFile(statePath, "utf8")));
    if (
      Object.keys(value).sort().join(",") !== "code,ownerId,runId,state,version" ||
      value.version !== 1 ||
      value.runId !== binding.runId ||
      value.ownerId !== binding.ownerId
    )
      fail();
    const codes = { pending: "WF4_PENDING", healthy: "WF4_HEALTHY", failed: "WF4_FAILED" };
    if (
      typeof value.state !== "string" ||
      !Object.hasOwn(codes, value.state) ||
      value.code !== codes[value.state as keyof typeof codes]
    )
      fail();
    return value.state;
  };
  const writeState = async (state: "pending" | "healthy" | "failed") =>
    persist(statePath, {
      version: 1,
      runId: binding.runId,
      ownerId: binding.ownerId,
      state,
      code: { pending: "WF4_PENDING", healthy: "WF4_HEALTHY", failed: "WF4_FAILED" }[state],
    });
  const fixed = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch {
      throw createWorkflowRecoverySafeError();
    }
  };
  return {
    initialize: () =>
      fixed(async () => {
        await mkdir(root, { recursive: true });
        await checkRoot();
        // 修复依据：拒绝旧 run 的证明目录；不以“找不到 failed”推断成功。
        await mkdir(directory, { mode: 0o700 });
        await writeState("pending");
      }),
    claim: () =>
      fixed(async () => {
        if ((await readState()) !== "pending") fail();
        // 单个 worker 认领，重复 worker/重试不得覆盖前任的最终状态。
        await mkdir(claimPath, { mode: 0o700 });
        claimed = true;
      }),
    finish: (healthy: boolean) =>
      fixed(async () => {
        if (!claimed || finished) fail();
        finished = true;
        if ((await readState()) !== "pending") fail();
        await checkDirectory(claimPath);
        await writeState(healthy ? "healthy" : "failed");
      }),
    assertHealthy: () =>
      fixed(async () => {
        if ((await readState()) !== "healthy") fail();
        await checkDirectory(claimPath);
      }),
  };
}

export function createWorkflowRecoverySafeError(): Error {
  return new Error("WF4_SAFE_CAPTURE_FAILED");
}

const actors = {
  "parent-skill": "parent",
  "parent-create-after-skill": "parent",
  "actor-b-success": "B",
  "actor-a-fault": "A",
} as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw createWorkflowRecoverySafeError();
  return value as Record<string, unknown>;
}

function time(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function projectArtifact(value: unknown) {
  const records = object(value).records;
  if (!Array.isArray(records)) throw createWorkflowRecoverySafeError();
  return {
    schemaVersion: 1,
    records: records.map((value: unknown, index: number) => {
      const row = object(value);
      if (
        typeof row.id !== "string" ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(row.id) ||
        !["pending", "complete", "error"].includes(String(row.status))
      )
        throw createWorkflowRecoverySafeError();
      const candidate = row.replay === undefined ? undefined : object(row.replay).fixtureId;
      const known = typeof candidate === "string" && Object.hasOwn(actors, candidate);
      const fixtureId = known ? (candidate as keyof typeof actors) : "unclassified";
      // 从固定枚举派生身份；不复制请求文本、未知字段或异常对象。
      return {
        ordinal: index + 1,
        id: row.id,
        fixtureId,
        actor: fixtureId === "unclassified" ? "unknown" : actors[fixtureId],
        state:
          row.status === "pending"
            ? "pending"
            : row.status === "error"
              ? "failed"
              : known
                ? "complete"
                : "unmatched",
        ...(typeof row.statusCode === "number" &&
        Number.isInteger(row.statusCode) &&
        row.statusCode >= 100 &&
        row.statusCode <= 599
          ? { httpStatus: row.statusCode }
          : {}),
        ...(time(row.startedAt) ? { startedAt: time(row.startedAt) } : {}),
        ...(time(row.completedAt) ? { completedAt: time(row.completedAt) } : {}),
      };
    }),
  };
}
