import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import {
  link,
  open,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishManagedSkill } from "../../../scripts/publish-managed-skill.mts";
import { verifyManagedSkillBundle } from "@zcode/shared/managed-skills";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(actual.open);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-publish-managed-"));
  roots.push(root);
  const source = join(root, "skill");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: 总控派单\ndescription: fixture\n---\n测试技能\n",
  );
  await writeFile(join(source, "references", "rules.md"), "只读引用");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyPath = join(root, "signing.pem");
  await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  return {
    root,
    source,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    options: {
      source,
      privateKey: keyPath,
      output: join(root, "release.json"),
      skillId: "controller",
      name: "总控派单",
      version: 1,
    },
  };
}

describe("external managed skill publisher", () => {
  it("runs the actual CLI from the repository without test aliases", async () => {
    const { options, publicKeyPem } = await fixture();
    const cli = fileURLToPath(
      new URL("../../../scripts/publish-managed-skill.mts", import.meta.url),
    );
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "--source",
        options.source,
        "--private-key",
        options.privateKey,
        "--output",
        options.output,
        "--skill-id",
        options.skillId,
        "--name",
        options.name,
        "--version",
        "1",
      ],
      { cwd },
    );
    expect(JSON.parse(stdout)).toMatchObject({ version: 1, fileCount: 2 });
    expect(
      verifyManagedSkillBundle(JSON.parse(await readFile(options.output, "utf8")), {
        ...options,
        minimumVersion: 1,
        publicKeyPem,
      }).version,
    ).toBe(1);
  });
  it("reports usage from the real CLI when arguments are missing", async () => {
    const cli = fileURLToPath(
      new URL("../../../scripts/publish-managed-skill.mts", import.meta.url),
    );
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    await expect(
      promisify(execFile)(process.execPath, ["--import", "tsx", cli], { cwd }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Required:") });
  });
  it("rejects hard links to the signing key", async () => {
    const { options, source } = await fixture();
    await link(options.privateKey, join(source, "linked-key.pem"));
    await expect(publishManagedSkill(options)).rejects.toThrow("Hard links");
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a copied signing key inside source resources", async () => {
    const { options, source } = await fixture();
    await writeFile(
      join(source, "references", "copied-key.txt"),
      await readFile(options.privateKey),
    );
    await expect(publishManagedSkill(options)).rejects.toThrow("Private signing material");
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans its own staging file when writing fails", async () => {
    const { options, root } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        vi.spyOn(handle, "writeFile").mockRejectedValue(
          Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }),
        );
      }
      return handle;
    });
    await expect(publishManagedSkill(options)).rejects.toMatchObject({ code: "ENOSPC" });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects oversized files before creating a release", async () => {
    const { options, source } = await fixture();
    await writeFile(join(source, "references", "large.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(publishManagedSkill(options)).rejects.toThrow("limit");
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("publishes the complete directory and verifies using an independently supplied public key", async () => {
    const { options, publicKeyPem } = await fixture();
    expect(await publishManagedSkill(options)).toMatchObject({ version: 1, fileCount: 2 });
    const result = verifyManagedSkillBundle(JSON.parse(await readFile(options.output, "utf8")), {
      skillId: options.skillId,
      name: options.name,
      minimumVersion: 1,
      publicKeyPem,
    });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/rules.md",
    ]);
    expect(
      Buffer.from(result.files.find((file) => file.path === "references/rules.md")!.bytes).toString(
        "utf8",
      ),
    ).toBe("只读引用");
  });
  it("never replaces an existing release and cleans staging files", async () => {
    const { options, root } = await fixture();
    await writeFile(options.output, "existing release");
    await expect(publishManagedSkill(options)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(options.output, "utf8")).toBe("existing release");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("rejects signing material in the published directory", async () => {
    const { options, source } = await fixture();
    const privateKey = join(source, "private.pem");
    await writeFile(privateKey, await readFile(options.privateKey));
    await expect(publishManagedSkill({ ...options, privateKey })).rejects.toThrow("outside");
  });
  it("rejects an output nested in the source", async () => {
    const { options, source } = await fixture();
    await expect(
      publishManagedSkill({ ...options, output: join(source, "release.json") }),
    ).rejects.toThrow("outside");
  });
  it("rejects directory links instead of signing external resources", async () => {
    const { options, root, source } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "external.md"), "not a skill resource");
    await symlink(
      outside,
      join(source, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(publishManagedSkill(options)).rejects.toThrow("links");
  });
  it("rejects invalid version metadata before publishing", async () => {
    const { options } = await fixture();
    await expect(publishManagedSkill({ ...options, version: 0 })).rejects.toThrow();
    await expect(readFile(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
