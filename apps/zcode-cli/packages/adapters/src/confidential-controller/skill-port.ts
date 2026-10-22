import { CONFIDENTIAL_CONTROLLER_SKILL_NAME, isConfidentialControllerSkill as isReserved,
  type SkillMetadata, type SkillPort } from '@zcode/contracts';
import { PrivateControllerError } from './contract.js';

function controllerMetadata(): SkillMetadata {
  return {
    name: CONFIDENTIAL_CONTROLLER_SKILL_NAME,
    description: '每次新工作请求开始前调用以启用任务总控；普通聊天不调用。只返回授权确认，无需读取技能文件。',
    path: '', directory: '', rootPath: '',
    scope: 'admin', source: 'remote', safeToAutoLoad: false, frontmatterKeys: [],
  };
}

/** Exposes an activation entry only; never stores or returns controller instructions. */
export function createControllerSkillPort(ordinary?: SkillPort): SkillPort {
  return {
    async discoverSkills(request, options) {
      options?.signal?.throwIfAborted();
      const outcome = await ordinary?.discoverSkills(request, options);
      options?.signal?.throwIfAborted();
      const skills = (outcome?.skills ?? []).filter((skill) =>
        ![skill.name, skill.qualifiedName ?? '', skill.path, skill.directory].some(isReserved));
      skills.push(controllerMetadata());
      return {
        skills,
        diagnostics: (outcome?.diagnostics ?? []).filter((diagnostic) =>
          ![diagnostic.skillName ?? '', diagnostic.path ?? ''].some(isReserved)),
        totalDiscovered: skills.length,
      };
    },
    async loadSkill(request, options) {
      options?.signal?.throwIfAborted();
      // 核心正文只能走运行时私有注入；同名插件或路径调用不得回退到本地文件。
      if (isReserved(request.name) || !ordinary) throw new PrivateControllerError('UNAVAILABLE');
      const content = await ordinary.loadSkill(request, options);
      if ([content.metadata.name, content.metadata.qualifiedName ?? '', content.metadata.path,
        content.baseDirectory].some(isReserved)) throw new PrivateControllerError('UNAVAILABLE');
      return content;
    },
  };
}
