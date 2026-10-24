import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";
import { writeCCodePackagedEntry } from "../packages/desktop/scripts/run-production-build.mjs";

const root = resolve(import.meta.dirname, "..");
const desktop = resolve(root, "packages/desktop");
const env = {
  ...process.env,
  NODE_ENV: "production",
  ZCODE_ENV: "production",
  ZCODE_PREVIEW_IDENTITY: "1",
  ZCODE_AUTO_UPDATE: "1",
  ZCODE_DESKTOP_DIST_DIR: "dist-ccode-preview-update",
};
// 串行构建，固定Preview身份和更新开关，避免下次漏开自动更新。
// 主进程与 CLI 共用私有协议，先构建并暂存 CLI，避免安装包混入旧协议。
const agent = spawnSync(
  process.execPath,
  ["packages/desktop/scripts/prepare-agent-node-bundle.mjs"],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);
if (agent.error) throw agent.error;
if (agent.status !== 0) process.exit(agent.status ?? 1);
for (const args of [
  ["prepare:build-meta"],
  ["exec", "tsup"],
  ["exec", "vite", "build"],
  ["bundle", "--", "win", "x64", "--skip-prepare", "--skip-build"],
]) {
  if (args[0] === "bundle") await writeCCodePackagedEntry(desktop);
  const result = spawnSync("pnpm", args, {
    ...resolveSpawnRuntimeOptions("pnpm"),
    cwd: desktop,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
