// ============================================================
// skill-reflow-upload frontmatter 读取（name / description）
// ============================================================
// 范式复用 packages/services/src/settings-sync/settingsSyncService.ts 的
// readSkillMetadataFromMarkdown（E3 锚点）：yaml 优先、解析失败/缺字段时宽松正则
// 回退，保持与既有导入链路同形的宽松语义；本模块为纯函数（无 IO），文件读取由扫描器负责。

import { parse as parseYaml } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readLooseScalar(frontmatterText: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(frontmatterText);
  const value = stripYamlScalarQuotes(match?.[1] ?? "");
  return value.length > 0 ? value : undefined;
}

export interface SkillReflowFrontmatter {
  readonly name: string;
  readonly description?: string;
}

/**
 * 从 SKILL.md 文本读取 name（回退目录名）与 description（缺省省略）。
 * frontmatter 缺失或不可解析时仍返回回退名，不抛错——条目枚举不因个别
 * 畸形 frontmatter 中断（与 settings-sync 宽松回退语义一致）。
 */
export function readSkillReflowFrontmatter(
  content: string,
  fallbackName: string,
): SkillReflowFrontmatter {
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    return { name: fallbackName };
  }
  const frontmatterText = frontmatterMatch[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch {
    // yaml 解析失败走宽松正则回退，与 settings-sync catch 分支同形。
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : (readLooseScalar(frontmatterText, "name") ?? fallbackName);
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : readLooseScalar(frontmatterText, "description");
    return { name, ...(description ? { description } : {}) };
  }
  const name = readLooseScalar(frontmatterText, "name") ?? fallbackName;
  const description = readLooseScalar(frontmatterText, "description");
  return { name, ...(description ? { description } : {}) };
}
