// 载荷=当天诊断日志+CLI 配置安全投影；不含数据库（硬红线，spec §6A）。
// 本地保留期 OQ-A13 未定，outputRootDir 由调用方管。
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiagnosticBundleArchiveBuilder } from "@zcode/services/audit-telemetry";
import { createFeedbackDiagnosticArchive } from "@zcode/services/node";
import { getAppConfigDir, getZCodeDataRootDir } from "@zcode/services/node";

export function createFeedbackDiagnosticBundleBuilder(options: {
  outputRootDir: string;
  now?: () => Date;
  workingDirectory?: string;
  cliLogDirectory?: string;
  appConfigDirectory?: string;
}): DiagnosticBundleArchiveBuilder {
  return {
    async build() {
      const logsDirectory = join(options.workingDirectory ?? process.cwd(), "logs");
      const sources = [
        ...(await access(logsDirectory).then(() => [{ directory: logsDirectory, archivePrefix: "logs" }]).catch(() => [])),
        { directory: options.cliLogDirectory ?? join(getZCodeDataRootDir(), "cli", "log"), archivePrefix: ".zcode/cli/log" },
        {
          directory: options.appConfigDirectory ?? getAppConfigDir(),
          archivePrefix: ".zcode/cli",
          includeFileNames: ["config.json"],
          contentPolicy: "cli-config" as const,
          onlyCurrentDay: false,
        },
      ];
      const archive = await createFeedbackDiagnosticArchive({ sources, outputRootDir: options.outputRootDir, now: options.now });
      const bytes = await readFile(archive.path);
      return {
        path: archive.path,
        fileName: basename(archive.path),
        sizeBytes: archive.size,
        digestHex: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  };
}
