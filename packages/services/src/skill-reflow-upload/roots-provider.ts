import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SkillReflowRootProvider, SkillReflowScanRoot } from "./contract.js";

// 语义锚点=adapters/src/skills/roots.ts L21-L73，双边改动必须同步。
// 回流只实现 home 与项目根链，故不读取 extraRoots 等 CLI 配置。
export interface SkillReflowRootsProviderOptions {
  readonly homeDirectory?: string;
  readonly workingDirectory?: string | (() => string);
  readonly stat?: typeof stat;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectoryResolver?: () => string;
}

export function createSkillReflowRootsProvider(
  options: SkillReflowRootsProviderOptions = {},
): SkillReflowRootProvider {
  const statFn = options.stat ?? stat;
  return {
    async listRoots(): Promise<readonly SkillReflowScanRoot[]> {
      const working = resolve(typeof options.workingDirectory === "function" ? options.workingDirectory() : options.workingDirectory ?? process.cwd());
      const home = resolve(options.homeDirectory ?? options.environment?.ZCODE_DESKTOP_HOME_DIR?.trim() ?? options.homeDirectoryResolver?.() ?? homedir());
      const projectDirectories = await projectChain(working, statFn);
      return [
        ...rootsFor(home, "user"),
        ...projectDirectories.flatMap((directory) => rootsFor(directory, "project")),
      ];
    },
  };
}

async function projectChain(working: string, statFn: typeof stat): Promise<string[]> {
  let markerRoot: string | undefined;
  let current = working;
  while (true) {
    try {
      await statFn(join(current, ".git"));
      markerRoot = current;
      break;
    } catch { /* marker absent */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const result: string[] = [];
  current = working;
  while (true) {
    result.push(current);
    if (!markerRoot || current === markerRoot || current === dirname(current)) break;
    current = dirname(current);
  }
  return result;
}

function rootsFor(base: string, scope: "user" | "project"): SkillReflowScanRoot[] {
  return [
    { id: `${scope}:zcode:${base}`, path: join(base, ".zcode", "skills"), scope, source: "zcode" },
    { id: `${scope}:agents:${base}`, path: join(base, ".agents", "skills"), scope, source: "agents" },
  ];
}
