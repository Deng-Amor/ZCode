// ============================================================
// skill-reflow-upload 扫描器（只读文件系统；spec §四 阶段 2、§6.2）
// ============================================================
// - 深度与目录排除复用 @zcode/shared 扫描策略（E2：MAX_SKILL_SCAN_DEPTH /
//   shouldWalkSkillDirectoryEntry / SKILL_FILE_NAME），遍历范式同
//   packages/services/src/skills/skillDiscoveryWalk.ts（深度优先、软链排除）。
// - 回流专属排除（退出标记、范围互斥）叠加在共享策略之上，不修改共享策略。
// - 对用户技能目录零写入（spec §5.1 扫描器只读）。
// - 软链与特殊文件不入内容清单（安全姿态对齐 publish-managed-skill 源树约束，
//   spec §5.2 contentFiles 注）；软链目录也不进入遍历（回流内容出本机，保守排除）。

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  SkillReflowScanEntry,
  SkillReflowScanResult,
  SkillReflowScanRoot,
  SkillReflowSourceType,
} from "./contract.js";
import { readSkillReflowFrontmatter } from "./frontmatter.js";
import { isRangeExcludedIdentity, isRangeExcludedRoot } from "./identity.js";

/** 退出标记文件名（spec §6.2 主机制：空文件即可，内容不要求）。 */
export const REFLOW_NO_UPLOAD_MARKER_FILE_NAME = ".no-upload";

/** 退出约定子目录名（spec §6.2 辅助机制：任意层级命中整棵跳过）。 */
export const REFLOW_PRIVATE_DIRECTORY_NAME = "private";

/**
 * contentDigest 规范化基准标识（OQ-2 / 中台 PRD OQ-8 未冻结）：
 * 当前按「条目纳入文件按相对路径排序后，逐文件原始字节 SHA-256，再对
 * `<relPath>\0<fileDigest>\n` 行序列整体 SHA-256」计算；基准冻结后须升级此常量
 * 并同步账本语义（基准变更会使内容不变判定整体失效一次，属预期全量重传）。
 */
export const SKILL_REFLOW_DIGEST_BASELINE = "raw-bytes-v1";

export interface SkillReflowScannerOptions {
  /** 目录列举/文件读取失败回调；不传则记 warn 日志后跳过（扫描不因个别 IO 失败中断）。 */
  onError?: (path: string, error: unknown) => void;
  logger?: ServiceLogger;
}

export interface ContentFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface ScanContext {
  readonly entries: SkillReflowScanEntry[];
  scanned: number;
  optOutSkipped: number;
  rangeExcluded: number;
  /** 跨根去重：已判定条目的目录绝对路径（E3 seenSourcePaths 范式，先到根优先）。 */
  readonly seenEntryDirectories: Set<string>;
  /**
   * 退出区计数去重：已计入 optOutSkipped 的条目目录绝对路径。条目内容收集
   * （collectEntryContentFiles）与目录遍历（walkScanDirectory）会对同一棵子树
   * 各走一遍，「条目目录嵌套带 .no-upload 的子目录、子目录下再有 skill」时同一
   * 条目会被两层各计一次；验收场景 1 要求 optOutSkipped 计数精确可回读，故以
   * 目录路径去重保证每个退出条目只计一次。
   */
  readonly countedOptOutEntryDirectories: Set<string>;
  readonly logger: ServiceLogger;
  readonly onError?: (path: string, error: unknown) => void;
}

interface DirectoryListing {
  readonly noUploadMarker: boolean;
  readonly hasSkillFile: boolean;
  readonly childDirectories: readonly Dirent[];
  readonly privateDirectories: readonly Dirent[];
  readonly regularFiles: readonly Dirent[];
}

async function listDirectory(
  directoryPath: string,
  context: ScanContext,
): Promise<DirectoryListing | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    context.logger.warn(undefined, `skill reflow scan: readdir failed: ${directoryPath}`);
    context.onError?.(directoryPath, error);
    return undefined;
  }
  const childDirectories: Dirent[] = [];
  const privateDirectories: Dirent[] = [];
  const regularFiles: Dirent[] = [];
  let noUploadMarker = false;
  let hasSkillFile = false;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === REFLOW_PRIVATE_DIRECTORY_NAME) {
        privateDirectories.push(entry);
        continue;
      }
      if (shouldWalkSkillDirectoryEntry(entry.name)) {
        childDirectories.push(entry);
      }
      continue;
    }
    if (entry.name === SKILL_FILE_NAME) {
      hasSkillFile = true;
      continue;
    }
    if (entry.name === REFLOW_NO_UPLOAD_MARKER_FILE_NAME) {
      noUploadMarker = true;
      continue;
    }
    // 符号链接与其他特殊文件不进入条目内容（软链排除，见文件头注释）。
    if (entry.isFile()) {
      regularFiles.push(entry);
    }
  }
  return { noUploadMarker, hasSkillFile, childDirectories, privateDirectories, regularFiles };
}

/**
 * 只计数遍历：统计闭包子树（含自身）内含 SKILL.md 的目录数。
 * 不读取任何文件内容（退出区语义：只留计数，不记内容，spec §6.2）。
 */
async function countEntryDirectoriesBelow(
  directoryPath: string,
  depth: number,
  context: ScanContext,
): Promise<number> {
  const listing = await listDirectory(directoryPath, context);
  if (!listing) {
    return 0;
  }
  let count = 0;
  if (listing.hasSkillFile && !context.countedOptOutEntryDirectories.has(directoryPath)) {
    // 同一退出条目目录只计一次（见 ScanContext.countedOptOutEntryDirectories 说明）。
    context.countedOptOutEntryDirectories.add(directoryPath);
    count = 1;
  }
  if (depth >= MAX_SKILL_SCAN_DEPTH) {
    return count;
  }
  const childPaths = [...listing.childDirectories, ...listing.privateDirectories].map(
    (entry) => join(directoryPath, entry.name),
  );
  for (const childPath of childPaths) {
    count += await countEntryDirectoriesBelow(childPath, depth + 1, context);
  }
  return count;
}

/**
 * 收集条目内容文件：SKILL.md + 条目子树常规文件；排除嵌套条目目录（含 SKILL.md 的
 * 子目录属独立条目）、private/ 子树、.no-upload 标记文件本身、软链与特殊文件。
 * 返回因退出标记/private/ 跳过的嵌套条目数（计入 optOutSkipped）。
 */
export async function collectEntryContentFiles(
  entryDirectoryPath: string,
  depth: number,
  context: ScanContext,
): Promise<{ files: ContentFile[]; optOutEntries: number }> {
  const listing = await listDirectory(entryDirectoryPath, context);
  if (!listing) {
    return { files: [], optOutEntries: 0 };
  }
  const files: ContentFile[] = [];
  let optOutEntries = 0;
  for (const file of listing.regularFiles) {
    files.push({ relativePath: file.name, absolutePath: join(entryDirectoryPath, file.name) });
  }
  if (depth >= MAX_SKILL_SCAN_DEPTH) {
    return { files, optOutEntries };
  }
  for (const child of listing.childDirectories) {
    const childPath = join(entryDirectoryPath, child.name);
    const childListing = await listDirectory(childPath, context);
    if (!childListing) {
      continue;
    }
    if (childListing.hasSkillFile) {
      // 嵌套条目：子树内容归其自身条目，不并入本条目（避免内容双计）。
      continue;
    }
    if (childListing.noUploadMarker) {
      optOutEntries += await countEntryDirectoriesBelow(childPath, depth + 1, context);
      continue;
    }
    const nested = await collectEntryContentFiles(childPath, depth + 1, context);
    optOutEntries += nested.optOutEntries;
    for (const nestedFile of nested.files) {
      files.push({
        relativePath: `${child.name}/${nestedFile.relativePath}`,
        absolutePath: nestedFile.absolutePath,
      });
    }
  }
  for (const privateDirectory of listing.privateDirectories) {
    optOutEntries += await countEntryDirectoriesBelow(
      join(entryDirectoryPath, privateDirectory.name),
      depth + 1,
      context,
    );
  }
  return { files, optOutEntries };
}

/** 计算条目 contentDigest 与条目级 lastModified（纳入文件 mtime 最大值，spec §5.2）。 */
async function computeEntryDigest(
  files: readonly ContentFile[],
  context: ScanContext,
): Promise<{ digest: string; lastModified: string } | undefined> {
  const sorted = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const hash = createHash("sha256");
  let lastMtimeMs = Number.NEGATIVE_INFINITY;
  let included = 0;
  for (const file of sorted) {
    let bytes: Buffer;
    try {
      bytes = await readFile(file.absolutePath);
    } catch (error) {
      // 单文件读取失败：跳过该文件（digest 基于成功读取的文件集），warn 可观察。
      context.logger.warn(undefined, `skill reflow scan: read failed: ${file.absolutePath}`);
      context.onError?.(file.absolutePath, error);
      continue;
    }
    const fileDigest = createHash("sha256").update(bytes).digest("hex");
    hash.update(`${file.relativePath}\u0000${fileDigest}\n`, "utf8");
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file.absolutePath)).mtimeMs;
    } catch {
      continue;
    }
    lastMtimeMs = Math.max(lastMtimeMs, mtimeMs);
    included += 1;
  }
  if (included === 0) {
    return undefined;
  }
  return {
    digest: hash.digest("hex"),
    lastModified: new Date(lastMtimeMs).toISOString(),
  };
}

function sourceTypeForScope(scope: SkillReflowScanRoot["scope"]): SkillReflowSourceType {
  return scope === "user" ? "user" : "workspace";
}

async function processEntryDirectory(
  root: SkillReflowScanRoot,
  directoryPath: string,
  relativePath: string,
  context: ScanContext,
): Promise<void> {
  if (context.seenEntryDirectories.has(directoryPath)) {
    return;
  }
  // 路径身份先判：保留名 / expert: 命中即排除，且不读取该目录任何文件内容（防御性保密）。
  if (isRangeExcludedIdentity(relativePath)) {
    context.rangeExcluded += 1;
    context.seenEntryDirectories.add(directoryPath);
    return;
  }
  const skillFilePath = join(directoryPath, SKILL_FILE_NAME);
  let name = basename(directoryPath);
  let description: string | undefined;
  try {
    const content = await readFile(skillFilePath, "utf8");
    const frontmatter = readSkillReflowFrontmatter(content, name);
    name = frontmatter.name;
    description = frontmatter.description;
  } catch (error) {
    context.logger.warn(undefined, `skill reflow scan: SKILL.md unreadable: ${skillFilePath}`);
    context.onError?.(skillFilePath, error);
  }
  if (isRangeExcludedIdentity(name)) {
    // frontmatter name 命中保留名/expert 前缀同样排除（discover 侧同规则，spec §5.3）。
    context.rangeExcluded += 1;
    context.seenEntryDirectories.add(directoryPath);
    return;
  }
  const collected = await collectEntryContentFiles(directoryPath, 0, context);
  context.optOutSkipped += collected.optOutEntries;
  // 修复：SKILL.md 必须纳入 contentDigest。listDirectory 把 SKILL.md 从 regularFiles
  // 中摘出（只置 hasSkillFile 标记），collectEntryContentFiles 因此拿不到它；若不显式
  // 补入，仅改 frontmatter（name/description）的条目 digest 不变，会被账本误判为
  // 「内容未变」而零入队，违反 spec §5.2（contentFiles = SKILL.md + 子树常规文件）
  // 与验收场景 5（修改 skill Y 内容 → 变更入队）。
  const contentFiles = [
    { relativePath: SKILL_FILE_NAME, absolutePath: skillFilePath },
    ...collected.files,
  ];
  const digestInfo = await computeEntryDigest(contentFiles, context);
  if (!digestInfo) {
    // 无可读内容文件（含 SKILL.md 全部读取失败）跳过该条目，warn 可观察，不中断会话。
    context.logger.warn(undefined, `skill reflow scan: no readable content: ${directoryPath}`);
    return;
  }
  context.seenEntryDirectories.add(directoryPath);
  context.scanned += 1;
  context.logger.debug(
    undefined,
    `skill reflow scan: entry queued-candidate: key=${`${root.scope}/${root.id}/${relativePath}`}`,
  );
  context.entries.push({
    key: `${root.scope}/${root.id}/${relativePath}`,
    rootId: root.id,
    sourceType: sourceTypeForScope(root.scope),
    relativePath,
    directoryPath,
    name,
    ...(description ? { description } : {}),
    contentDigest: digestInfo.digest,
    lastModified: digestInfo.lastModified,
  });
}

async function walkScanDirectory(
  root: SkillReflowScanRoot,
  directoryPath: string,
  relativePath: string,
  depth: number,
  context: ScanContext,
): Promise<void> {
  const listing = await listDirectory(directoryPath, context);
  if (!listing) {
    return;
  }
  if (listing.noUploadMarker) {
    // 退出区整棵子树跳过：只留条目计数，不读内容（spec §6.2 主机制）。
    context.optOutSkipped += await countEntryDirectoriesBelow(directoryPath, depth, context);
    return;
  }
  if (listing.hasSkillFile) {
    await processEntryDirectory(root, directoryPath, relativePath, context);
  }
  if (depth >= MAX_SKILL_SCAN_DEPTH) {
    return;
  }
  for (const privateDirectory of listing.privateDirectories) {
    // private/ 子目录约定退出：任意层级命中整棵跳过（spec §6.2 辅助机制）。
    context.optOutSkipped += await countEntryDirectoriesBelow(
      join(directoryPath, privateDirectory.name),
      depth + 1,
      context,
    );
  }
  for (const childDirectory of listing.childDirectories) {
    await walkScanDirectory(
      root,
      join(directoryPath, childDirectory.name),
      relativePath ? `${relativePath}/${childDirectory.name}` : childDirectory.name,
      depth + 1,
      context,
    );
  }
}

/**
 * 扫描回流上传面（只读）：范围互斥排除（保留名 / expert: 前缀 / remote|plugin|bundled
 * 来源根）、退出标记（.no-upload / private/）、条目枚举（含 SKILL.md 的目录 + 常规
 * 内容文件）与 contentDigest 计算。排除根做只计数遍历以产出 rangeExcluded 可观察
 * 计数（spec §5.3 硬规则：skip 诊断计数，不记内容）。
 */
export async function scanSkillReflowRoots(
  roots: readonly SkillReflowScanRoot[],
  options: SkillReflowScannerOptions = {},
): Promise<SkillReflowScanResult> {
  const context: ScanContext = {
    entries: [],
    scanned: 0,
    optOutSkipped: 0,
    rangeExcluded: 0,
    seenEntryDirectories: new Set<string>(),
    countedOptOutEntryDirectories: new Set<string>(),
    logger: options.logger ?? createServiceLogger("skill-reflow-upload"),
    onError: options.onError,
  };
  for (const root of roots) {
    const rootPath = resolve(root.path);
    if (isRangeExcludedRoot(root)) {
      const excludedCount = await countEntryDirectoriesBelow(rootPath, 0, context);
      context.rangeExcluded += excludedCount;
      context.logger.debug(
        undefined,
        `skill reflow scan: range-excluded root: source=${root.source} entries=${excludedCount}`,
      );
      continue;
    }
    await walkScanDirectory(root, rootPath, "", 0, context);
  }
  context.entries.sort((left, right) => left.key.localeCompare(right.key));
  return {
    entries: context.entries,
    counters: {
      scanned: context.scanned,
      optOutSkipped: context.optOutSkipped,
      rangeExcluded: context.rangeExcluded,
    },
  };
}
