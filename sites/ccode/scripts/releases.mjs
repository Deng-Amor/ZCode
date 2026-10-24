import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const installerPattern = /^CCode-(\d+\.\d+\.\d+)-win-x64\.exe$/;

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertExecutable(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);
    if (buffer.toString('ascii') !== 'MZ') throw new Error('安装包不是有效的 Windows EXE 文件');
  } finally {
    await handle.close();
  }
}

export async function prepareRelease(source, publicDir) {
  const fileName = basename(source);
  const match = installerPattern.exec(fileName);
  if (!match) throw new Error('文件名必须为 CCode-版本号-win-x64.exe');
  await assertExecutable(source);
  const targetDir = join(publicDir, 'downloads');
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, fileName);
  if (resolve(source) !== resolve(target)) {
    await copyFile(source, `${target}.tmp`);
    await rename(`${target}.tmp`, target);
  }
  const release = {
    version: match[1], platform: 'windows', arch: 'x64', fileName,
    size: (await stat(target)).size,
    sha256: await digest(target), url: `/downloads/${fileName}`,
  };
  await writeFile(join(publicDir, 'release.json.tmp'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  await rename(join(publicDir, 'release.json.tmp'), join(publicDir, 'release.json'));
  return release;
}

export async function readRelease(publicDir) {
  let text;
  try {
    text = await readFile(join(publicDir, 'release.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const release = JSON.parse(text);
  const match = typeof release.fileName === 'string' && installerPattern.exec(release.fileName);
  if (!match || release.version !== match[1] || release.platform !== 'windows' || release.arch !== 'x64'
    || release.url !== `/downloads/${release.fileName}` || !Number.isSafeInteger(release.size)
    || release.size < 2 || !/^[a-f0-9]{64}$/.test(release.sha256)) {
    throw new Error('下载清单格式无效');
  }
  const file = join(publicDir, 'downloads', release.fileName);
  let fileStat;
  try { fileStat = await stat(file); } catch { throw new Error('清单对应的安装包不存在，请重新准备发布'); }
  if (fileStat.size !== release.size || await digest(file) !== release.sha256) {
    throw new Error('安装包校验失败，请重新准备发布');
  }
  await assertExecutable(file);
  return release;
}
