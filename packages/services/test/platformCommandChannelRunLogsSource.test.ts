import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunLogsSource } from "../src/platform-command-channel/run-logs-source.js";

describe("createRunLogsSource", () => {
  it("filters timestamped lines, skips malformed lines, and paginates", async () => {
    const base = await mkdtemp(join(tmpdir(), "run-logs-"));
    const dir = join(base, ".zcode", "cli", "log");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.log"), [
      "2026-01-01T00:00:00.000Z first",
      "not-a-timestamp bad",
      "2026-01-02T00:00:00.000Z second",
      "2026-01-03T00:00:00.000Z third",
    ].join("\n"));
    const source = createRunLogsSource({ dataBaseDir: base, from: "2026-01-01T12:00:00.000Z", to: "2026-01-04T00:00:00.000Z", page: 1, pageSize: 1 });
    await expect(source.read()).resolves.toHaveLength(1);
    expect(source.lastReadStats()).toMatchObject({ malformedLines: 1, totalMatched: 2 });
  });
});
