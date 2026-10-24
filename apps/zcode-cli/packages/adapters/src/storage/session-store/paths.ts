import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, link, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { withFileLock } from "@zcode/shared/node";

export function getDefaultSessionDbPath(): string {
  if (process.env.ZCODE_DESKTOP_HOME_DIR?.trim()) {
    const root = process.env.ZCODE_STORAGE_DIR?.trim()
      || join(process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.ZCODE_DESKTOP_HOME_DIR.trim(), ".zcode");
    return join(root, "cli", "db", "db.sqlite");
  }
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 只迁移已有品牌实例的共享正文库，不改写原库、会话身份或 Host 组织态。 */
export async function migrateLegacyDesktopSessionDb(dbPath: string): Promise<void> {
  const legacy = process.env.CCODE_LEGACY_SESSION_DB?.trim();
  if (!legacy || !process.env.ZCODE_DESKTOP_HOME_DIR?.trim()
      || resolve(dbPath) !== resolve(getDefaultSessionDbPath())
      || resolve(legacy) === resolve(dbPath)) return;
  if (await exists(dbPath)) return;
  await mkdir(dirname(dbPath), { recursive: true });
  await withFileLock(`${dbPath}.ccode-import`, async () => {
    if (await exists(dbPath) || !(await exists(legacy))) return;
    const temporary = join(dirname(dbPath), `.ccode-import-${randomUUID()}.sqlite`);
    const source = new DatabaseSync(legacy, { readOnly: true });
    try {
      // 共享库可能仍处于 WAL 模式；文件复制会漏掉已提交消息，必须使用 SQLite 快照。
      source.exec("BEGIN");
      const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      const counts = tables.map((row) => {
        const name = String(row.name);
        const quoted = `"${name.replaceAll('"', '""')}"`;
        return { quoted, count: source.prepare(`SELECT count(*) AS n FROM ${quoted}`).get()!.n };
      });
      await backup(source, temporary);
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      try {
        if (snapshot.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
          throw new Error("CCode session snapshot integrity check failed");
        }
        for (const { quoted, count } of counts) {
          if (snapshot.prepare(`SELECT count(*) AS n FROM ${quoted}`).get()?.n !== count) {
            throw new Error("CCode session snapshot row count mismatch");
          }
        }
      } finally { snapshot.close(); }
      // 同目录硬链接发布是原子的，且目标已存在时绝不覆盖；各进程锁内复查保证幂等。
      await link(temporary, dbPath);
    } finally {
      source.close();
      await rm(temporary, { force: true });
    }
  }, { lockMaxWaitMs: 120_000 });
}
