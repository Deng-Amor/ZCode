import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataBaseDir } from "../paths.js";
import type { RunLogsSource, ScopedRecord } from "./executors.js";

export interface RunLogRecord extends ScopedRecord { readonly message: string; readonly sourcePath: string }
export interface RunLogsReadStats { readonly malformedLines: number; readonly totalMatched: number }
export interface RunLogsSourceOptions {
  readonly dataBaseDir?: string;
  readonly from: string;
  readonly to: string;
  readonly page?: number;
  readonly pageSize?: number;
}

// 路径语义锚点=packages/desktop/src/main/exportLogs.ts 的 getZCodeCliLogDir；
// 与 services paths.ts 的 dataBaseDir 派生一致：{dataBaseDir}/.zcode/cli/log。
export function createRunLogsSource(options: RunLogsSourceOptions): RunLogsSource<RunLogRecord> & { lastReadStats(): RunLogsReadStats } {
  let stats: RunLogsReadStats = { malformedLines: 0, totalMatched: 0 };
  const from = Date.parse(options.from); const to = Date.parse(options.to);
  const page = Math.max(0, options.page ?? 0); const pageSize = Math.max(1, options.pageSize ?? 100);
  const source: RunLogsSource<RunLogRecord> & { lastReadStats(): RunLogsReadStats } = {
    async read() {
      let malformedLines = 0; const records: RunLogRecord[] = [];
      for (const file of await filesUnder(join(options.dataBaseDir ?? getDataBaseDir(), ".zcode", "cli", "log"))) {
        const lines = (await readFile(file, "utf8")).split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          const match = /^(\d{4}-\d\d-\d\dT[^\s]+)\s?(.*)$/.exec(line);
          const timestamp = match?.[1];
          const occurredAt = timestamp ? new Date(timestamp).toISOString() : null;
          if (!occurredAt) { malformedLines++; continue; }
          const time = Date.parse(occurredAt);
          if (time >= from && time < to) records.push({ occurredAt, message: match?.[2] ?? "", sourcePath: file });
        }
      }
      stats = { malformedLines, totalMatched: records.length };
      return records.slice(page * pageSize, (page + 1) * pageSize);
    },
    lastReadStats: () => stats,
  };
  return source;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
