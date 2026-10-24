import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillReflowScanRoot } from "../src/skill-reflow-upload/index.js";

/** skill 回流上传单测共享夹具：技能树构建器与临时目录（spec §七 验收场景的客户端侧判据）。 */

export async function makeSkillReflowTestDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skill-reflow-test-"));
}

export async function removeSkillReflowTestDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

/** 最小合法 SKILL.md（frontmatter name/description，正文一行）。 */
export function skillMarkdown(options?: {
  name?: string;
  description?: string;
  body?: string;
}): string {
  const name = options?.name ?? "unnamed-skill";
  const descriptionLine = options?.description
    ? `description: ${options.description}\n`
    : "";
  return `---\nname: ${name}\n${descriptionLine}---\n\n${options?.body ?? "# skill body"}\n`;
}

export interface SkillTreeOptions {
  skillMd?: string;
  /** 技能目录内附加常规文件（相对技能目录的 POSIX 相对路径）。 */
  files?: Record<string, string>;
  /** 置空则不写 SKILL.md（用于构造中间目录）。 */
  omitSkillMd?: boolean;
}

/** 写一个技能条目目录（SKILL.md + 附加常规文件），返回其绝对路径。 */
export async function writeSkillEntry(
  rootDirectory: string,
  relativeDirectory: string,
  options: SkillTreeOptions = {},
): Promise<string> {
  const directory = join(rootDirectory, ...relativeDirectory.split("/"));
  await mkdir(directory, { recursive: true });
  if (!options.omitSkillMd) {
    await writeFile(
      join(directory, "SKILL.md"),
      options.skillMd ?? skillMarkdown({ name: relativeDirectory.split("/").pop() }),
      "utf8",
    );
  }
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const target = join(directory, ...relativePath.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return directory;
}

/** 写退出标记文件（内容不要求，空文件即可，spec §6.2）。 */
export async function writeNoUploadMarker(
  rootDirectory: string,
  relativeDirectory: string,
): Promise<void> {
  const directory = join(rootDirectory, ...relativeDirectory.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".no-upload"), "", "utf8");
}

/** 标准 user-scope 扫描根（端口注入形态；id 参与 key 消歧）。 */
export function userScanRoot(path: string, id = "user-root"): SkillReflowScanRoot {
  return { id, path, scope: "user", source: "zcode" };
}

/** 标准 project-scope 扫描根。 */
export function projectScanRoot(path: string, id = "project-root"): SkillReflowScanRoot {
  return { id, path, scope: "project", source: "agents" };
}
