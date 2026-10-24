import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareRelease, readRelease } from '../scripts/releases.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ccode-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  return { root, publicDir };
}

test('从未准备安装包时返回 null', async (t) => {
  const { publicDir } = await fixture(t);
  assert.equal(await readRelease(publicDir), null);
});

test('发布清单匹配暂存文件，且不包含本地源路径', async (t) => {
  const { root, publicDir } = await fixture(t);
  const data = Buffer.from('MZ-test-installer');
  const source = join(root, 'CCode-3.16.2-win-x64.exe');
  await writeFile(source, data);
  const release = await prepareRelease(source, publicDir);
  assert.equal(release.version, '3.16.2');
  assert.equal(release.size, data.length);
  assert.equal(release.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(release.url, '/downloads/CCode-3.16.2-win-x64.exe');
  assert.deepEqual(await readRelease(publicDir), release);
  assert.equal((await readFile(join(publicDir, 'release.json'), 'utf8')).includes(root), false);
});

test('拒绝非 CCode Windows x64 文件名与非 EXE 文件', async (t) => {
  const { root, publicDir } = await fixture(t);
  const wrongName = join(root, 'ZCode-3.16.2-win-x64.exe');
  await writeFile(wrongName, 'MZ-data');
  await assert.rejects(prepareRelease(wrongName, publicDir), /文件名/);
  const wrongContent = join(root, 'CCode-3.16.2-win-x64.exe');
  await writeFile(wrongContent, '<html>error</html>');
  await assert.rejects(prepareRelease(wrongContent, publicDir), /EXE/);
});

test('文件被替换或删除后，旧清单禁止被构建使用', async (t) => {
  const { root, publicDir } = await fixture(t);
  const source = join(root, 'CCode-3.16.2-win-x64.exe');
  await writeFile(source, 'MZ-good');
  const release = await prepareRelease(source, publicDir);
  const staged = join(publicDir, 'downloads', release.fileName);
  await writeFile(staged, 'MZ-evil');
  await assert.rejects(readRelease(publicDir), /校验/);
  await rm(staged);
  await assert.rejects(readRelease(publicDir), /安装包/);
});

test('拒绝目录穿越和外部 URL 清单', async (t) => {
  const { publicDir } = await fixture(t);
  await writeFile(join(publicDir, 'release.json'), JSON.stringify({
    version: '3.16.2', fileName: '../secret.exe', url: 'https://example.com/installer.exe',
    platform: 'windows', arch: 'x64', size: 2, sha256: 'a'.repeat(64),
  }));
  await assert.rejects(readRelease(publicDir), /清单/);
});
