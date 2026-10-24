import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prepareRelease } from './releases.mjs';

const source = process.argv[2];
if (!source) throw new Error('用法：npm run prepare:release -- <CCode-版本号-win-x64.exe 路径>');
const release = await prepareRelease(resolve(source), fileURLToPath(new URL('../public/', import.meta.url)));
process.stdout.write(`CCode ${release.version} · Windows x64 · ${release.size} bytes\nSHA-256 ${release.sha256}\n`);
