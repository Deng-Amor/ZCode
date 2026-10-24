import { describe, expect, it } from 'vitest';
import type { SkillPort } from '@zcode/contracts/skills';
import {
  ExpertSkillError,
  createExpertSkillPort,
  type ExpertSkillCatalogEntry,
  type ExpertSkillLoadedContent,
} from '../src/expert-skills/index.js';

const request = (name: string) => ({ name, workingDirectory: 'C:/workspace' });
const entry = (skillId: string): ExpertSkillCatalogEntry => ({
  skillId, name: `Name ${skillId}`, description: `Description ${skillId}`, version: 3,
});
const loaded = (skillId: string): ExpertSkillLoadedContent => ({
  ...entry(skillId), digestHex: 'ab'.repeat(32), content: 'expert body', files: [], baseDirectory: 'remote://expert',
});
const ordinary: SkillPort = {
  discoverSkills: async () => ({
    skills: [{ name: 'local', description: 'local', path: 'local', directory: 'local', rootPath: 'local', scope: 'user', source: 'agents', safeToAutoLoad: true, frontmatterKeys: [] }],
    diagnostics: [], totalDiscovered: 1,
  }),
  loadSkill: async (req) => ({ metadata: { name: req.name, description: '', path: '', directory: '', rootPath: '', scope: 'user', source: 'agents', safeToAutoLoad: true, frontmatterKeys: [] }, content: 'ordinary', baseDirectory: '', bytesRead: 8, sizeBytes: 8, truncated: false }),
};

function makePort(entries = [entry('foo'), entry('bar')], load = async (id: string) => loaded(id)) {
  return createExpertSkillPort({ catalog: { list: async () => entries }, content: { load } }, ordinary);
}

describe('expert skill port', () => {
  it('injects catalog entries as remote admin metadata', async () => {
    const result = await makePort().discoverSkills({ workingDirectory: 'C:/workspace' });
    expect(result.skills.map((skill) => [skill.name, skill.source, skill.scope, skill.safeToAutoLoad])).toEqual([
      ['local', 'agents', 'user', true], ['expert:foo', 'remote', 'admin', false], ['expert:bar', 'remote', 'admin', false],
    ]);
    expect(result.totalDiscovered).toBe(3);
  });

  it('filters user entries occupying the expert namespace including fullwidth identity', async () => {
    const local = { ...ordinary, discoverSkills: async () => ({ skills: [
      { ...((await ordinary.discoverSkills({ workingDirectory: '' })).skills[0]), name: 'expert:foo' },
      { ...((await ordinary.discoverSkills({ workingDirectory: '' })).skills[0]), name: 'ｅｘｐｅｒｔ：x' },
    ], diagnostics: [{ code: 'skill_duplicate_name', severity: 'warning', message: 'x', skillName: 'expert:foo' }], totalDiscovered: 2 }) };
    const result = await createExpertSkillPort({ catalog: { list: async () => [] }, content: { load: async (id) => loaded(id) } }, local).discoverSkills({ workingDirectory: '' });
    expect(result.skills).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('loads verified content from the content port and computes byte sizes', async () => {
    const result = await makePort().loadSkill(request('expert:foo'));
    expect(result).toMatchObject({ content: 'expert body', baseDirectory: 'remote://expert', truncated: false, bytesRead: 11, sizeBytes: 11, metadata: { name: 'expert:foo', source: 'remote', scope: 'admin' } });
  });

  it('rejects invalid and reserved identities with fixed errors', async () => {
    for (const [name, code] of [['expert:foo/bar', 'INVALID_IDENTITY'], ['expert:foo:bar', 'INVALID_IDENTITY'], ['expert:controller', 'RESERVED_IDENTITY'], ['expert:总控派单', 'RESERVED_IDENTITY']] as const) {
      await expect(makePort().loadSkill(request(name))).rejects.toMatchObject({ code });
    }
  });

  it('hides content port errors behind LOAD_FAILED', async () => {
    await expect(makePort([], async () => { throw new Error('secret backend failure'); }).loadSkill(request('expert:foo'))).rejects.toSatisfy((error: ExpertSkillError) => error.code === 'LOAD_FAILED' && !error.message.includes('secret backend failure'));
  });

  it('delegates non-expert loads unchanged', async () => {
    let received: unknown;
    const delegate: SkillPort = { ...ordinary, loadSkill: async (req) => { received = req; return ordinary.loadSkill(req); } };
    await createExpertSkillPort({ catalog: { list: async () => [] }, content: { load: async (id) => loaded(id) } }, delegate).loadSkill(request('local'));
    expect(received).toEqual(request('local'));
  });

  it('converts catalog failures to LOAD_FAILED', async () => {
    await expect(createExpertSkillPort({ catalog: { list: async () => { throw new Error('secret catalog failure'); } }, content: { load: async (id) => loaded(id) } }, ordinary).discoverSkills({ workingDirectory: '' })).rejects.toMatchObject({ code: 'LOAD_FAILED' });
  });
});
