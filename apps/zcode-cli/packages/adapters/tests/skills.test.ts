import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSkillAdapter } from "../src/skills/index.js";

function managedFixture(files: Record<string, string> = { "SKILL.md": "# Signed controller" }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      skillId: "controller-id",
      name: "controller",
      version: 2,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        contentBase64: Buffer.from(content).toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    }),
  );
  return {
    trust: {
      skillId: "controller-id",
      name: "controller",
      minimumVersion: 2,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    bundle: {
      schemaVersion: 1,
      payloadBase64: payload.toString("base64"),
      signatureBase64: sign(null, payload, privateKey).toString("base64"),
    },
  };
}

describe("managed skill policy", () => {
  it.each(["controller/team", "controller:team", "controller\\team", "vendor/controller/team"])(
    "rejects qualified managed identity %s before a missing bundle can enable fallback",
    (identity) => {
      const entry = managedFixture();
      for (const field of ["name", "skillId"] as const) {
        expect(() =>
          createNodeSkillAdapter({
            managedSkills: [
              {
                trust: { ...entry.trust, [field]: identity },
                bundle: undefined,
              },
            ],
          }),
        ).toThrow("Invalid managed skill identity");
      }
    },
  );

  it("consumes a fixed signed snapshot and signed references without writable paths", async () => {
    const entry = managedFixture({
      "SKILL.md": "# Signed controller",
      "references/rules.md": "Signed rules",
    });
    const managedSkills = [entry];
    const adapter = createNodeSkillAdapter({ managedSkills });
    entry.trust.name = "replacement";
    entry.bundle.payloadBase64 = "corrupt";
    managedSkills.length = 0;
    const request = { name: "controller", workingDirectory: tmpdir(), roots: [] };
    const first = await adapter.loadSkill(request);
    expect(first.content).toContain("# Signed controller");
    expect(first.content).toContain("references/rules.md");
    expect(first.content).toContain("Signed rules");
    expect(first.baseDirectory).toBe("managed-skill://controller-id/2");
    expect(first.truncated).toBe(false);
    first.metadata.name = "poisoned";
    expect((await adapter.loadSkill(request)).metadata.name).toBe("controller");
    expect((await adapter.loadSkill({ ...request, name: "controller-id" })).content).toBe(
      first.content,
    );
    await expect(adapter.loadSkill({ ...request, maxBytes: 5 })).rejects.toThrow(/limit/i);
  });

  it("blocks reserved identities through explicit roots, extra roots and namespaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-managed-skills-"));
    try {
      for (const name of ["controller", "CONTROLLER-ID", "vendor/controller", "safe"]) {
        const skillDir = join(dir, name.replaceAll("/", "-"));
        await mkdir(skillDir, { recursive: true });
        await writeSkill(skillDir, name, "Local impostor");
      }
      const adapter = createNodeSkillAdapter({
        managedSkills: [managedFixture()],
        extraRoots: [dir],
        homeDirectory: join(dir, "home"),
      });
      const roots = [
        {
          path: dir,
          namespace: "vendor",
          scope: "project" as const,
          source: "zcode" as const,
          priority: -1,
        },
      ];
      for (const rootOverride of [roots, undefined]) {
        const outcome = await adapter.discoverSkills({
          workingDirectory: dir,
          roots: rootOverride,
        });
        expect(outcome.skills.map((s) => s.name)).toEqual(["controller", "safe"]);
        expect(outcome.diagnostics.filter((d) => d.code === "skill_duplicate_name")).toHaveLength(
          3,
        );
      }
      await expect(
        adapter.loadSkill({ name: "vendor/controller", workingDirectory: dir, roots }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "corrupt", "rollback", "script", "binary"])(
    "fails closed for %s bundles",
    async (failure) => {
      const entry = managedFixture(
        failure === "script"
          ? { "SKILL.md": "Body", "scripts/run.js": "run()" }
          : failure === "binary"
            ? { "SKILL.md": "Body", "references/blob.bin": "binary" }
            : undefined,
      );
      if (failure === "corrupt") entry.bundle.payloadBase64 = "corrupt";
      if (failure === "rollback") entry.trust.minimumVersion = 3;
      const adapter = createNodeSkillAdapter({
        managedSkills: [{ ...entry, bundle: failure === "missing" ? undefined : entry.bundle }],
      });
      const outcome = await adapter.discoverSkills({ workingDirectory: tmpdir(), roots: [] });
      expect(outcome.skills).toEqual([]);
      expect(outcome.diagnostics[0]?.severity).toBe("error");
      await expect(
        adapter.loadSkill({ name: "controller", workingDirectory: tmpdir(), roots: [] }),
      ).rejects.toThrow(/Managed skill unavailable/);
    },
  );

  it("rejects ambiguous trusted reservations", () => {
    const entry = managedFixture();
    expect(() => createNodeSkillAdapter({ managedSkills: [entry, entry] })).toThrow(
      /Duplicate managed/,
    );
    const collision = managedFixture();
    collision.trust.skillId = "CONTROLLER";
    expect(() => createNodeSkillAdapter({ managedSkills: [entry, collision] })).toThrow(
      /Duplicate managed/,
    );
    expect(() =>
      createNodeSkillAdapter({
        managedSkills: [{ ...entry, trust: { ...entry.trust, name: " " } }],
      }),
    ).toThrow(/Invalid managed/);
  });

  it("never falls back to a local namespaced impostor when the signed bundle is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-managed-missing-"));
    try {
      await writeSkill(dir, "controller", "Untrusted local fallback");
      const entry = managedFixture();
      const adapter = createNodeSkillAdapter({ managedSkills: [{ ...entry, bundle: undefined }] });
      const roots = [
        {
          path: dir,
          namespace: "plugin",
          source: "plugin" as const,
          scope: "user" as const,
          priority: -100,
        },
      ];
      expect((await adapter.discoverSkills({ workingDirectory: dir, roots })).skills).toEqual([]);
      for (const name of [
        "controller",
        "controller-id",
        "plugin/controller",
        "plugin:controller",
        `${dir}/controller/SKILL.md`,
      ]) {
        await expect(adapter.loadSkill({ workingDirectory: dir, roots, name })).rejects.toThrow(
          /Managed skill/,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { "SKILL.md": "---\nname: impostor\ndescription: test\n---\nBody" },
    { "SKILL.md": "Body", "references/rules.txt": "bad\0text" },
    { "SKILL.md": "x".repeat(200_001) },
  ])("rejects inconsistent identity, non-text and oversized content", async (files) => {
    const adapter = createNodeSkillAdapter({ managedSkills: [managedFixture(files)] });
    await expect(
      adapter.loadSkill({ name: "controller", workingDirectory: tmpdir(), roots: [] }),
    ).rejects.toThrow(/Managed skill unavailable/);
  });

  it("keeps policy reservations after discovery results are modified or the bundle is replaced", async () => {
    const entry = managedFixture();
    const adapter = createNodeSkillAdapter({ managedSkills: [entry] });
    const outcome = await adapter.discoverSkills({ workingDirectory: tmpdir(), roots: [] });
    outcome.skills[0]!.path = "mutable-path";
    outcome.skills[0]!.frontmatterKeys.push("unsafe");
    entry.trust.minimumVersion = 100;
    const loaded = await adapter.loadSkill({
      name: "controller",
      workingDirectory: tmpdir(),
      roots: [],
    });
    expect(loaded.metadata.path).toBe("managed-skill://controller-id/2/SKILL.md");
    expect(loaded.metadata.frontmatterKeys).toEqual([]);
  });
});

describe("NodeSkillAdapter", () => {
  it("discovers project skills from SKILL.md metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const skillDir = join(dir, ".zcode", "skills", "demo-skill");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo-skill",
          "description: Use this for demo workflows",
          "---",
          "",
          "# Demo",
        ].join("\n"),
      );

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["demo-skill"]);
      expect(outcome.skills[0]?.description).toBe("Use this for demo workflows");
      expect(outcome.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("filters out skills disabled via config (enable:false path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const keptDir = join(dir, ".zcode", "skills", "kept-skill");
    const disabledDir = join(dir, ".zcode", "skills", "disabled-skill");

    try {
      await mkdir(keptDir, { recursive: true });
      await mkdir(disabledDir, { recursive: true });
      await writeSkill(keptDir, "kept-skill", "Stays available");
      await writeSkill(disabledDir, "disabled-skill", "Should be filtered");

      const adapter = createNodeSkillAdapter({
        homeDirectory: join(dir, "home"),
        disabledPaths: [join(disabledDir, "SKILL.md")],
      });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });

      // 仅保留未被禁用的 skill；load 复用 discover 也应拒绝被禁用项
      expect(outcome.skills.map((skill) => skill.name)).toEqual(["kept-skill"]);
      await expect(
        adapter.loadSkill({ name: "disabled-skill", workingDirectory: dir }),
      ).rejects.toThrow(/Skill not found/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads skill body without frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const skillDir = join(dir, ".zcode", "skills", "agent-skill");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-skill",
          "description: Agent-compatible skill",
          "---",
          "",
          "# Agent Skill",
          "",
          "Follow this workflow.",
        ].join("\n"),
      );

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const loaded = await adapter.loadSkill({ name: "agent-skill", workingDirectory: dir });

      expect(loaded.content).toContain("# Agent Skill");
      expect(loaded.content).not.toContain("description:");
      expect(loaded.baseDirectory).toBe(skillDir);
      expect(loaded.truncated).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers user skills imported as directory symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const sourceSkill = join(dir, "external-skills", "linked-skill");
    const userSkillRoot = join(dir, "home", ".zcode", "skills");
    const linkedSkill = join(userSkillRoot, "linked-skill");

    try {
      await mkdir(sourceSkill, { recursive: true });
      await mkdir(userSkillRoot, { recursive: true });
      await writeSkill(sourceSkill, "linked-skill", "Imported via symlink");
      await symlink(sourceSkill, linkedSkill, process.platform === "win32" ? "junction" : "dir");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });
      const loaded = await adapter.loadSkill({ name: "linked-skill", workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["linked-skill"]);
      expect(outcome.skills[0]?.description).toBe("Imported via symlink");
      expect(outcome.skills[0]?.path).toBe(join(linkedSkill, "SKILL.md"));
      expect(outcome.diagnostics).toEqual([]);
      expect(loaded.content).toContain("# Body");
      expect(loaded.baseDirectory).toBe(linkedSkill);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("filters disabled skills when the scanned skill is a symlink to the configured path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const sourceSkill = join(dir, "cloud-skills", "linked-disabled-skill");
    const userSkillRoot = join(dir, "home", ".zcode", "skills");
    const linkedSkill = join(userSkillRoot, "linked-disabled-skill");

    try {
      await mkdir(sourceSkill, { recursive: true });
      await mkdir(userSkillRoot, { recursive: true });
      await writeSkill(sourceSkill, "linked-disabled-skill", "Disabled by real path");
      await symlink(sourceSkill, linkedSkill, process.platform === "win32" ? "junction" : "dir");

      const adapter = createNodeSkillAdapter({
        homeDirectory: join(dir, "home"),
        disabledPaths: [join(sourceSkill, "SKILL.md")],
      });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });

      expect(outcome.skills).toEqual([]);
      await expect(
        adapter.loadSkill({ name: "linked-disabled-skill", workingDirectory: dir }),
      ).rejects.toThrow(/Skill not found/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads skills without frontmatter by folder name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const skillDir = join(dir, ".zcode", "skills", "plain-skill");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Plain Skill\nFollow this workflow.");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });
      const loaded = await adapter.loadSkill({ name: "plain-skill", workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["plain-skill"]);
      expect(outcome.skills[0]?.description).toBe("");
      expect(outcome.skills[0]?.frontmatterKeys).toEqual([]);
      expect(outcome.diagnostics).toEqual([]);
      expect(loaded.content).toContain("# Plain Skill");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps same-name skills from different paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const projectSkill = join(dir, ".zcode", "skills", "same-skill");
    const userSkill = join(dir, "home", ".zcode", "skills", "same-skill");

    try {
      await mkdir(projectSkill, { recursive: true });
      await mkdir(userSkill, { recursive: true });
      await writeSkill(projectSkill, "same-skill", "Project description");
      await writeSkill(userSkill, "same-skill", "User description");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });
      const loaded = await adapter.loadSkill({ name: "same-skill", workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.description).toSorted()).toEqual([
        "Project description",
        "User description",
      ]);
      expect(loaded.metadata.description).toBe("User description");
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
        "skill_duplicate_name",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers project skills from ancestors up to the worktree root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const nestedDirectory = join(dir, "packages", "core");
    const rootSkill = join(dir, ".zcode", "skills", "root-skill");

    try {
      await mkdir(join(dir, ".git"), { recursive: true });
      await mkdir(nestedDirectory, { recursive: true });
      await mkdir(rootSkill, { recursive: true });
      await writeSkill(rootSkill, "root-skill", "Root-level agent skill");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: nestedDirectory });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["root-skill"]);
      expect(outcome.skills[0]?.rootPath).toBe(join(dir, ".zcode", "skills"));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps same-name skills from nearest and ancestor roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const nestedDirectory = join(dir, "packages", "core");
    const ancestorSkill = join(dir, ".zcode", "skills", "same-skill");
    const nearestSkill = join(nestedDirectory, ".zcode", "skills", "same-skill");

    try {
      await mkdir(join(dir, ".git"), { recursive: true });
      await mkdir(nestedDirectory, { recursive: true });
      await mkdir(ancestorSkill, { recursive: true });
      await mkdir(nearestSkill, { recursive: true });
      await writeSkill(ancestorSkill, "same-skill", "Ancestor description");
      await writeSkill(nearestSkill, "same-skill", "Nearest description");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: nestedDirectory });

      expect(outcome.skills.map((skill) => skill.description).toSorted()).toEqual([
        "Ancestor description",
        "Nearest description",
      ]);
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
        "skill_duplicate_name",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers skills under .agents/skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const skillDir = join(dir, ".agents", "skills", "agents-dir-skill");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeSkill(skillDir, "agents-dir-skill", "Lives under .agents/skills");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["agents-dir-skill"]);
      expect(outcome.skills[0]?.source).toBe("agents");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads plugin skills by fully qualified plugin alias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-skills-"));
    const pluginRoot = join(dir, "superpowers");
    const manifestDir = join(pluginRoot, ".claude-plugin");
    const skillRoot = join(pluginRoot, "skills");
    const skillDir = join(skillRoot, "test-driven-development");
    const roots = [
      {
        path: skillRoot,
        scope: "system" as const,
        source: "plugin" as const,
        priority: 0,
      },
    ];

    try {
      await mkdir(manifestDir, { recursive: true });
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(manifestDir, "plugin.json"),
        JSON.stringify({ name: "superpowers", version: "5.1.0" }),
      );
      await writeSkill(skillDir, "test-driven-development", "Superpowers TDD");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ roots, workingDirectory: dir });
      const skill = outcome.skills[0];

      expect(skill).toMatchObject({
        name: "test-driven-development",
        pluginName: "superpowers",
        qualifiedName: "superpowers:test-driven-development",
      });
      await expect(
        adapter.loadSkill({
          name: "superpowers:test-driven-development",
          roots,
          workingDirectory: dir,
        }),
      ).resolves.toMatchObject({
        metadata: {
          name: "test-driven-development",
          qualifiedName: "superpowers:test-driven-development",
        },
      });
      await expect(
        adapter.loadSkill({
          name: "test-driven-development",
          roots,
          workingDirectory: dir,
        }),
      ).resolves.toMatchObject({
        metadata: {
          name: "test-driven-development",
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("parses multiline descriptions from .agents/skills frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const foldedSkillDir = join(dir, ".agents", "skills", "folded-skill");
    const literalSkillDir = join(dir, ".agents", "skills", "literal-skill");

    try {
      await mkdir(foldedSkillDir, { recursive: true });
      await mkdir(literalSkillDir, { recursive: true });
      await writeFile(
        join(foldedSkillDir, "SKILL.md"),
        [
          "---",
          "name: folded-skill",
          "description: >",
          "  First trigger sentence.",
          "  Second trigger sentence.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      await writeFile(
        join(literalSkillDir, "SKILL.md"),
        [
          "---",
          "name: literal-skill",
          "description: |",
          "  First trigger sentence.",
          "  Second trigger sentence.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });
      const byName = new Map(outcome.skills.map((skill) => [skill.name, skill]));

      expect(byName.get("folded-skill")?.description).toBe(
        "First trigger sentence. Second trigger sentence.",
      );
      expect(byName.get("literal-skill")?.description).toBe(
        "First trigger sentence.\nSecond trigger sentence.",
      );
      expect(outcome.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("merges .zcode/skills and .agents/skills with .zcode winning same-name loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const zcodeSkill = join(dir, ".zcode", "skills", "dup");
    const agentsSkill = join(dir, ".agents", "skills", "dup");
    const agentsOnlySkill = join(dir, ".agents", "skills", "agents-only");

    try {
      await mkdir(zcodeSkill, { recursive: true });
      await mkdir(agentsSkill, { recursive: true });
      await mkdir(agentsOnlySkill, { recursive: true });
      await writeSkill(zcodeSkill, "dup", "From .zcode");
      await writeSkill(agentsSkill, "dup", "From .agents");
      await writeSkill(agentsOnlySkill, "agents-only", "Agents only");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });
      const loaded = await adapter.loadSkill({ name: "dup", workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name).toSorted()).toEqual([
        "agents-only",
        "dup",
        "dup",
      ]);
      expect(outcome.skills.map((skill) => skill.description).toSorted()).toEqual([
        "Agents only",
        "From .agents",
        "From .zcode",
      ]);
      expect(loaded.metadata.description).toBe("From .zcode");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Bugfix 回归（差一层目录）：技能根自身含 SKILL.md 时根自身就是一个技能（插件 manifest
  // skills 数组项语义），此前只扫一层子目录导致这类根扫描结果恒为空。
  it("discovers a skill whose SKILL.md sits directly in the skill root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-root-own-"));
    const rootOwnSkill = join(dir, "bundle", "engineering", "tdd");
    const nestedSkill = join(dir, "bundle", "nested-skill");

    try {
      await mkdir(rootOwnSkill, { recursive: true });
      await mkdir(nestedSkill, { recursive: true });
      await writeSkill(rootOwnSkill, "tdd", "Root-own skill");
      await writeSkill(nestedSkill, "nested-skill", "Nested skill");

      const outcome = await createNodeSkillAdapter().discoverSkills({
        roots: [
          { path: join(dir, "bundle"), priority: 0, scope: "user", source: "plugin" },
          { path: rootOwnSkill, priority: 1, scope: "user", source: "plugin" },
        ],
        workingDirectory: dir,
      });

      // 同一个 SKILL.md 经「根自身」与「父目录一层扫描」命中时按路径去重，只出一个。
      expect(outcome.skills.map((skill) => skill.name).sort()).toEqual(["nested-skill", "tdd"]);
      expect(outcome.totalDiscovered).toBe(2);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns no skills and no diagnostics for an empty skill root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-empty-root-"));
    const emptyRoot = join(dir, "empty");

    try {
      await mkdir(emptyRoot, { recursive: true });
      const outcome = await createNodeSkillAdapter().discoverSkills({
        roots: [{ path: emptyRoot, priority: 0, scope: "user", source: "plugin" }],
        workingDirectory: dir,
      });

      expect(outcome.skills).toEqual([]);
      expect(outcome.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // Bugfix 回归（评审跟进）：共享 scan helper 曾把所有错误吞成空数组，导致权限错误
  // （EACCES 等）退化为静默空、skill_scan_failed 诊断永不触发。helper 契约改为
  // 只吞 ENOENT/ENOTDIR（目录缺失是常态），其余错误抛给调用方发诊断。
  // Windows 上 chmod 000 不能剥夺目录读权限，跳过。
  it.skipIf(process.platform === "win32")(
    "reports a scan diagnostic when the skill root is unreadable",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-skills-eacces-"));
      const lockedRoot = join(dir, "locked");
      const skillDir = join(lockedRoot, "hidden-skill");

      try {
        await mkdir(skillDir, { recursive: true });
        await writeSkill(skillDir, "hidden-skill", "Should stay hidden");
        await chmod(lockedRoot, 0o000);

        const outcome = await createNodeSkillAdapter().discoverSkills({
          roots: [{ path: lockedRoot, priority: 0, scope: "user", source: "plugin" }],
          workingDirectory: dir,
        });

        expect(outcome.skills).toEqual([]);
        expect(outcome.diagnostics).toEqual([
          expect.objectContaining({
            code: "skill_scan_failed",
            path: lockedRoot,
            severity: "warning",
          }),
        ]);
      } finally {
        await chmod(lockedRoot, 0o755).catch(() => {});
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it("ignores node_modules and dot directories directly under a skill root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    const skillsRoot = join(dir, ".zcode", "skills");
    const realDir = join(skillsRoot, "real-skill");
    // Bugfix（ZCT-2070384010482601984）：agent 端与桌面端共享排除策略，
    // node_modules / 点目录不应被当作技能目录，两端判定保持一致。
    const nodeModulesDir = join(skillsRoot, "node_modules", "dep-skill");
    const dotDir = join(skillsRoot, ".cursor");

    try {
      await mkdir(realDir, { recursive: true });
      await mkdir(nodeModulesDir, { recursive: true });
      await mkdir(dotDir, { recursive: true });
      await writeSkill(realDir, "real-skill", "Real skill");
      await writeSkill(nodeModulesDir, "dep-skill", "Should be ignored");
      await writeSkill(dotDir, "cursor-skill", "Should be ignored");

      const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverSkills({ workingDirectory: dir });

      expect(outcome.skills.map((skill) => skill.name)).toEqual(["real-skill"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await writeFile(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n"),
  );
}

describe("附加目录技能", () => {
  it("保留同名能力，以目录限定名加载，并且不读取附加目录祖先", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-additional-skills-"));
    try {
      const main = join(root, "frontend"),
        extra = join(root, "backend");
      for (const dir of [main, extra, root]) {
        const skill = join(dir, ".agents", "skills", "review");
        await mkdir(skill, { recursive: true });
        await writeFile(
          join(skill, "SKILL.md"),
          `---\nname: review\ndescription: review\n---\n${dir}`,
        );
      }
      const adapter = createNodeSkillAdapter({
        homeDirectory: join(root, "home"),
        additionalDirectories: [extra, extra, main],
      });
      const result = await adapter.discoverSkills({ workingDirectory: main });
      expect(result.skills).toHaveLength(2);
      expect(result.skills.map((s) => s.qualifiedName)).toContain("backend/review");
      const loaded = await adapter.loadSkill({ workingDirectory: main, name: "backend/review" });
      expect(loaded.content).toBe(extra);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
