import type { DatabaseSync } from "node:sqlite";
import type {
  CollaborationMode,
  ConfidentialControllerBinding,
  PermissionRuleset,
  ProjectId,
  SessionId,
} from "@zcode/contracts";
import { isCollaborationMode } from "../codecs.js";
import { decodeJson } from "../json.js";
import type { LocalSettingRow, PermissionRow } from "../rows.js";

export async function getProjectPermission(
  db: DatabaseSync,
  projectID: ProjectId,
): Promise<PermissionRuleset | null> {
  const setting = readLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (setting) {
    return decodeJson<PermissionRuleset>(setting.value) ?? null;
  }

  const row = db.prepare("select * from permission where project_id = ?").get(projectID) as
    | PermissionRow
    | undefined;
  return row ? (decodeJson<PermissionRuleset>(row.data) ?? null) : null;
}

export async function saveProjectPermission(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  },
): Promise<PermissionRuleset> {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify(input.permission),
  });

  const saved = await getProjectPermission(db, input.projectID);
  if (!saved) {
    throw new Error(`Project permission not found after write: ${input.projectID}`);
  }
  return saved;
}

export function getProjectPermissionMode(
  db: DatabaseSync,
  projectID: ProjectId,
): CollaborationMode | null {
  const setting = readLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (!setting) return null;

  const value = decodeJson<{ mode?: unknown }>(setting.value);
  return isCollaborationMode(value?.mode) ? value.mode : null;
}

export function saveProjectPermissionMode(
  db: DatabaseSync,
  input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  },
): CollaborationMode {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify({ mode: input.mode }),
  });
  return input.mode;
}

function controllerBinding(value: unknown): ConfidentialControllerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid controller binding");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Number.isSafeInteger(record.version) ||
    (record.version as number) <= 0 ||
    typeof record.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.digest)
  )
    throw new Error("Invalid controller binding");
  return { version: record.version as number, digest: record.digest };
}

function assertControllerRunKey(runKey: string): void {
  if (!/^(target|input|turn|workflow):[^\x00-\x1f\x7f]{1,512}$/.test(runKey))
    throw new Error("Invalid controller run identity");
}

export function getConfidentialControllerBinding(
  db: DatabaseSync,
  sessionID: SessionId,
  runKey: string,
): ConfidentialControllerBinding | null {
  assertControllerRunKey(runKey);
  const row = db
    .prepare(`select value, schema_version from local_setting
    where scope = 'session' and scope_id = ? and namespace = 'confidential-controller' and key = ?`)
    .get(sessionID, runKey) as { value: string; schema_version: number } | undefined;
  if (!row) return null;
  // 损坏绑定必须拒绝恢复，不能被当成无记录而重新选择最新版本。
  try {
    if (row.schema_version !== 1) throw new Error("Unsupported binding schema");
    return controllerBinding(decodeJson<unknown>(row.value));
  } catch {
    // JSON解析异常可能包含原始数据片段，仅返回固定错误。
    throw new Error("Invalid controller binding");
  }
}

export function bindConfidentialControllerRelease(
  db: DatabaseSync,
  sessionID: SessionId,
  runKey: string,
  binding: ConfidentialControllerBinding,
): void {
  assertControllerRunKey(runKey);
  const value = controllerBinding(binding);
  const now = Date.now();
  // 只有首个授权可以绑定；并发写者不能覆盖另一版本，不触碰会话排序时间。
  db.prepare(`insert into local_setting
    (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated)
    values ('session', ?, 'confidential-controller', ?, ?, 1, ?, ?)
    on conflict(scope, scope_id, namespace, key) do nothing`).run(
    sessionID,
    runKey,
    JSON.stringify(value),
    now,
    now,
  );
  const saved = getConfidentialControllerBinding(db, sessionID, runKey);
  if (!saved || saved.version !== value.version || saved.digest !== value.digest)
    throw new Error("Controller release binding conflict");
}

function readLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    scope: string;
    scopeID: string;
  },
): LocalSettingRow | undefined {
  return db
    .prepare(
      `
      select value from local_setting
      where scope = ? and scope_id = ? and namespace = ? and key = ?
      `,
    )
    .get(input.scope, input.scopeID, input.namespace, input.key) as LocalSettingRow | undefined;
}

function writeLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    schemaVersion: number;
    scope: string;
    scopeID: string;
    time: number;
    value: string;
  },
): void {
  db.prepare(
    `
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.scope,
    input.scopeID,
    input.namespace,
    input.key,
    input.value,
    input.schemaVersion,
    input.time,
    input.time,
  );
}
