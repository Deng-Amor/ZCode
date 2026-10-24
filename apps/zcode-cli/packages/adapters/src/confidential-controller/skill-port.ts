import { CONFIDENTIAL_CONTROLLER_SKILL_NAME, isConfidentialControllerSkill as isReserved,
  type SkillMetadata, type SkillPort } from '@zcode/contracts';
import { PrivateControllerError, type ControllerLockedContentPort } from './contract.js';

function controllerMetadata(): SkillMetadata {
  return {
    name: CONFIDENTIAL_CONTROLLER_SKILL_NAME,
    description: '用户请求开始、执行、继续或落实任务，或要求交付物/修改文件时调用本技能加载；普通聊天、问候、概念解释或讨论想法时不调用。正文只在命中加载时进入上下文。',
    path: '', directory: '', rootPath: '',
    scope: 'admin', source: 'remote', safeToAutoLoad: false, frontmatterKeys: [],
  };
}

/** 暴露两层触发入口；锁定正文只经注入端口读取。 */
export function createControllerSkillPort(ordinary?: SkillPort, locked?: ControllerLockedContentPort): SkillPort {
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
      if (isReserved(request.name)) {
        if (!locked) throw new PrivateControllerError('UNAVAILABLE');
        try {
          const content = await locked.load();
          const sizeBytes = new TextEncoder().encode(content.skillMd).byteLength;
          return {
            metadata: { ...controllerMetadata(), name: CONFIDENTIAL_CONTROLLER_SKILL_NAME },
            content: content.skillMd, baseDirectory: '', bytesRead: sizeBytes, sizeBytes, truncated: false,
          };
        } catch {
          throw new PrivateControllerError('UNAVAILABLE');
        }
      }
      if (!ordinary) throw new PrivateControllerError('UNAVAILABLE');
      const content = await ordinary.loadSkill(request, options);
      if ([content.metadata.name, content.metadata.qualifiedName ?? '', content.metadata.path,
        content.baseDirectory].some(isReserved)) throw new PrivateControllerError('UNAVAILABLE');
      return content;
    },
  };
}
