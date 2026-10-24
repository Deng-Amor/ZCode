import { isExpertSkillIdentity, isReservedExpertSkillIdentity, type SkillContent, type SkillMetadata, type SkillPort } from '@zcode/contracts/skills';
import type { ExpertSkillCatalogPort, ExpertSkillLoadedContent } from './contract.js';
import { ExpertSkillError } from './contract.js';

interface Options {
  catalog: ExpertSkillCatalogPort;
  content: { load(skillId: string): Promise<ExpertSkillLoadedContent> };
  logger?: { warn?(message: string): void };
}

function metadata(entry: ExpertSkillLoadedContent | { skillId: string; name: string; description: string }): SkillMetadata {
  return {
    name: `expert:${entry.skillId}`, description: entry.description, path: '', directory: '', rootPath: '',
    scope: 'admin', source: 'remote', safeToAutoLoad: false, frontmatterKeys: [],
  };
}

function skillIdFrom(name: string): string {
  const normalized = name.normalize('NFKC').trim();
  const parts = normalized.split(/[\\/:]/u);
  const skillId = parts[1] ?? '';
  if (parts.length !== 2 || parts[0] !== 'expert' || !skillId || /[\\/:]/u.test(skillId)) {
    throw new ExpertSkillError('INVALID_IDENTITY');
  }
  return skillId;
}

export function createExpertSkillPort(options: Options, ordinary?: SkillPort): SkillPort {
  return {
    async discoverSkills(request, operationOptions) {
      operationOptions?.signal?.throwIfAborted();
      let entries: Awaited<ReturnType<ExpertSkillCatalogPort['list']>>;
      try {
        entries = await options.catalog.list();
      } catch {
        throw new ExpertSkillError('LOAD_FAILED');
      }
      const outcome = await ordinary?.discoverSkills(request, operationOptions);
      const skills = (outcome?.skills ?? []).filter((skill) =>
        ![skill.name, skill.qualifiedName ?? '', skill.path, skill.directory].some(isExpertSkillIdentity));
      const diagnostics = (outcome?.diagnostics ?? []).filter((diagnostic) =>
        ![diagnostic.skillName ?? '', diagnostic.path ?? ''].some(isExpertSkillIdentity));
      skills.push(...entries.map((entry) => metadata(entry)));
      return { skills, diagnostics, totalDiscovered: skills.length };
    },
    async loadSkill(request, operationOptions) {
      operationOptions?.signal?.throwIfAborted();
      if (!isExpertSkillIdentity(request.name)) {
        if (!ordinary) throw new ExpertSkillError('LOAD_FAILED');
        return ordinary.loadSkill(request, operationOptions);
      }
      const skillId = skillIdFrom(request.name);
      if (isReservedExpertSkillIdentity(skillId)) throw new ExpertSkillError('RESERVED_IDENTITY');
      let loaded: ExpertSkillLoadedContent;
      try {
        loaded = await options.content.load(skillId);
      } catch {
        throw new ExpertSkillError('LOAD_FAILED');
      }
      const bytesRead = new TextEncoder().encode(loaded.content).byteLength;
      return { metadata: metadata(loaded), content: loaded.content, baseDirectory: loaded.baseDirectory, bytesRead, sizeBytes: bytesRead, truncated: false } satisfies SkillContent;
    },
  };
}
