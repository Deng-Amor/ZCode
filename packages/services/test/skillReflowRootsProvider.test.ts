import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillReflowRootsProvider } from "../src/skill-reflow-upload/roots-provider.js";

describe("createSkillReflowRootsProvider", () => {
  it("returns home and every project ancestor roots, including both providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-roots-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: fixture");

    const roots = await createSkillReflowRootsProvider({ homeDirectory: home, workingDirectory: nested }).listRoots();
    expect(roots.map((item) => item.path)).toEqual([
      join(home, ".zcode", "skills"), join(home, ".agents", "skills"),
      join(nested, ".zcode", "skills"), join(nested, ".agents", "skills"),
      join(repo, "packages", ".zcode", "skills"), join(repo, "packages", ".agents", "skills"),
      join(repo, ".zcode", "skills"), join(repo, ".agents", "skills"),
    ]);
    expect(roots.map((item) => item.scope)).toEqual([
      "user", "user", "project", "project", "project", "project", "project", "project",
    ]);
  });
});
