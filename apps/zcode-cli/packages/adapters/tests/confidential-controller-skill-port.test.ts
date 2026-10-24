import { describe, expect, it } from 'vitest';
import type { SkillPort } from '@zcode/contracts';
import { CONFIDENTIAL_CONTROLLER_SKILL_NAME } from '@zcode/contracts';
import { createControllerSkillPort, PrivateControllerError, type ControllerLockedContentPort } from '../src/confidential-controller/index.js';

const request = (name: string) => ({ name, workingDirectory: 'C:/workspace' });
const ordinary: SkillPort = {
  discoverSkills: async () => ({ skills: [{ name: 'ordinary', description: 'ordinary', path: 'ordinary', directory: 'ordinary', rootPath: 'ordinary', scope: 'user', source: 'agents', safeToAutoLoad: true, frontmatterKeys: [] }], diagnostics: [], totalDiscovered: 1 }),
  loadSkill: async () => ({ metadata: { name: 'ordinary', description: '', path: '', directory: '', rootPath: '', scope: 'user', source: 'agents', safeToAutoLoad: true, frontmatterKeys: [] }, content: 'ordinary body', baseDirectory: '', bytesRead: 13, sizeBytes: 13, truncated: false }),
};
const locked: ControllerLockedContentPort = { load: async () => ({ version: 7, digest: 'a'.repeat(64), skillMd: '# locked body', files: [] }) };

describe('confidential controller skill port', () => {
  it('loads the reserved skill from the locked content port', async () => {
    const result = await createControllerSkillPort(ordinary, locked).loadSkill(request(CONFIDENTIAL_CONTROLLER_SKILL_NAME));
    expect(result).toMatchObject({ content: '# locked body', baseDirectory: '', bytesRead: 13, sizeBytes: 13, truncated: false, metadata: { name: CONFIDENTIAL_CONTROLLER_SKILL_NAME, source: 'remote', scope: 'admin', safeToAutoLoad: false } });
  });

  it('keeps reserved loads unavailable without a locked port', async () => {
    await expect(createControllerSkillPort(ordinary).loadSkill(request(CONFIDENTIAL_CONTROLLER_SKILL_NAME))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('hides locked port failures and does not expose their message', async () => {
    const port = { load: async () => { throw new Error('secret locked body'); } } satisfies ControllerLockedContentPort;
    await expect(createControllerSkillPort(ordinary, port).loadSkill(request(CONFIDENTIAL_CONTROLLER_SKILL_NAME))).rejects.toSatisfy((error: PrivateControllerError) => error.code === 'UNAVAILABLE' && !error.message.includes('secret locked body'));
  });

  it('publishes the two-layer stub and still filters reserved ordinary entries', async () => {
    const result = await createControllerSkillPort({ ...ordinary, discoverSkills: async () => ({ ...await ordinary.discoverSkills({ workingDirectory: '' }), skills: [{ ...(await ordinary.discoverSkills({ workingDirectory: '' })).skills[0]!, name: CONFIDENTIAL_CONTROLLER_SKILL_NAME }] }) }).discoverSkills({ workingDirectory: '' });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toContain('开始、执行、继续或落实任务');
    expect(result.skills[0]?.description).toContain('普通聊天');
  });
});
