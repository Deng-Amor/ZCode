import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFeedbackDiagnosticBundleBuilder } from "../src/main/ccode-platform-runtime-wiring/diagnostic-builder.js";

describe("feedback diagnostic bundle builder", () => {
  it("builds an archive and returns its digest metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-diagnostic-builder-"));
    try {
      const workingDirectory = join(root, "work");
      const cliLogDirectory = join(root, "cli-log");
      const appConfigDirectory = join(root, "config");
      const outputRootDir = join(root, "output");
      const now = new Date(2026, 9, 23, 12, 0, 0);
      const logPath = join(workingDirectory, "logs", "today.log");
      await mkdir(join(workingDirectory, "logs"), { recursive: true });
      await mkdir(cliLogDirectory, { recursive: true });
      await mkdir(appConfigDirectory, { recursive: true });
      await writeFile(logPath, "diagnostic log\n", "utf8");
      await utimes(logPath, now, now);
      await writeFile(join(cliLogDirectory, "cli.log"), "cli log\n", "utf8");
      await writeFile(join(appConfigDirectory, "config.json"), JSON.stringify({ telemetry: { enabled: true } }), "utf8");

      const archive = await createFeedbackDiagnosticBundleBuilder({
        outputRootDir,
        now: () => now,
        workingDirectory,
        cliLogDirectory,
        appConfigDirectory,
      }).build();
      const bytes = await readFile(archive.path);

      expect(archive.fileName).toBeTruthy();
      expect(archive.sizeBytes).toBe(bytes.length);
      expect(archive.digestHex).toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds successfully when all source directories are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccode-diagnostic-builder-empty-"));
    try {
      const archive = await createFeedbackDiagnosticBundleBuilder({
        outputRootDir: join(root, "output"),
        workingDirectory: join(root, "work"),
        cliLogDirectory: join(root, "cli-log"),
        appConfigDirectory: join(root, "config"),
      }).build();
      expect(archive.fileName).toBeTruthy();
      expect(archive.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
