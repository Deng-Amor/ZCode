import type { CommandChannelCommandEnvelope, CommandChannelExecutionOutcome, CommandChannelExecutor } from "./contract.js";

export interface ScopedRecord { readonly occurredAt: string; readonly sessionId?: string }
export interface RunLogsSource<T extends ScopedRecord = ScopedRecord> { read(): Promise<readonly T[]> }
export interface SkillUsageSource<T extends ScopedRecord = ScopedRecord> { read(): Promise<readonly T[]> }
export interface ChatLogsSource<T extends ScopedRecord = ScopedRecord> { read(): Promise<readonly T[]> }

export class ExecutorScopeError extends Error {
  readonly code = "SCOPE_INVALID" as const;
  constructor(message: string) { super(message); this.name = "ExecutorScopeError"; }
}

function filter<T extends ScopedRecord>(records: readonly T[], command: CommandChannelCommandEnvelope): readonly T[] {
  const scope = command.params.scope as { readonly timeRange?: { readonly from: string; readonly to: string }; readonly sessionId?: string };
  if (!scope.timeRange) throw new ExecutorScopeError("scope time range is required");
  const from = Date.parse(scope.timeRange.from);
  const to = Date.parse(scope.timeRange.to);
  if (!(from < to) || to - from > 31 * 24 * 60 * 60 * 1000) throw new ExecutorScopeError("scope time range is invalid");
  if ("sessionId" in scope && scope.sessionId !== undefined && !scope.sessionId.trim()) throw new ExecutorScopeError("sessionId is invalid");
  return records.filter((record) => { const at = Date.parse(record.occurredAt); return at >= from && at < to && (scope.sessionId === undefined || record.sessionId === scope.sessionId); });
}

function createExecutor<T extends ScopedRecord>(source: { read(): Promise<readonly T[]> }): CommandChannelExecutor {
  return { execute: async (command): Promise<CommandChannelExecutionOutcome> => {
    const records = filter(await source.read(), command);
    return { resultRef: `${command.commandId}:${records.length}` };
  } };
}

export function createPullRunLogsExecutor(options: { readonly source: RunLogsSource }): CommandChannelExecutor { return createExecutor(options.source); }
export function createPullSkillUsageStatsExecutor(options: { readonly source: SkillUsageSource }): CommandChannelExecutor { return createExecutor(options.source); }
export function createPullChatLogsExecutor(options: { readonly source: ChatLogsSource }): CommandChannelExecutor { return createExecutor(options.source); }
