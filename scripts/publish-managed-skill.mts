import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
// 仓库发行 CLI 使用公开源码入口；根包不依赖 @zcode/shared，不能依赖测试别名解析。
import {
  MANAGED_SKILL_BUNDLE_LIMITS,
  verifyManagedSkillBundle,
} from "../packages/shared/src/managed-skills/index.ts";

export interface PublishManagedSkillOptions {
  source: string;
  privateKey: string;
  output: string;
  skillId: string;
  name: string;
  version: number;
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (info.nlink > 1) throw new Error("Hard links are not allowed in publishing inputs");
    if (!info.isFile() || info.size > limit) throw new Error("Publishing file size limit exceeded");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error("Publishing file size limit exceeded");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** 只在外部发布环境调用；不注册为客户端模型工具，也不生成生产信任根。 */
export async function publishManagedSkill(options: PublishManagedSkillOptions) {
  const sourceInput = resolve(options.source);
  if ((await lstat(sourceInput)).isSymbolicLink())
    throw new Error("Skill source must not be a link");
  const source = await realpath(sourceInput);
  const privateKeyPath = await realpath(resolve(options.privateKey));
  const output = resolve(options.output);
  const outputParent = await realpath(dirname(output));
  if (inside(source, privateKeyPath))
    throw new Error("Signing key must be outside the skill source");
  if (inside(source, output) || inside(source, outputParent)) {
    throw new Error("Release output must be outside the skill source");
  }
  const signingMaterial = await readBoundedFile(privateKeyPath, 64 * 1024);
  const key = createPrivateKey(signingMaterial);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");

  const files: { path: string; contentBase64: string; sha256: string }[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  async function walk(directory: string, prefix = "", depth = 0): Promise<void> {
    if (depth > 32) throw new Error("Skill directory nesting exceeds 32 levels");
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++entryCount > 4096) throw new Error("Skill directory entry limit exceeded");
      const filePath = join(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(filePath);
      // 原因：签发过程不能把链接目标或特殊文件当作技能资源一起发布。
      if (info.isSymbolicLink()) throw new Error(`Skill links are not allowed: ${path}`);
      if (!inside(source, await realpath(filePath)))
        throw new Error("Skill source escaped its root");
      if (info.isDirectory()) {
        await walk(filePath, path, depth + 1);
      } else if (info.isFile()) {
        if (
          files.length >= MANAGED_SKILL_BUNDLE_LIMITS.files ||
          info.size > MANAGED_SKILL_BUNDLE_LIMITS.fileBytes
        )
          throw new Error("Skill file limit exceeded");
        const bytes = await readBoundedFile(filePath, MANAGED_SKILL_BUNDLE_LIMITS.fileBytes);
        // 原因：仅校验私钥路径不能阻止误复制的密钥进入签名包。
        if (
          bytes.includes(signingMaterial) ||
          /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(bytes.toString("utf8"))
        ) {
          throw new Error("Private signing material must not be published");
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MANAGED_SKILL_BUNDLE_LIMITS.totalFileBytes)
          throw new Error("Skill bundle size limit exceeded");
        files.push({
          path,
          contentBase64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        throw new Error(`Special files are not allowed: ${path}`);
      }
    }
  }
  await walk(source);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      skillId: options.skillId,
      name: options.name,
      version: options.version,
      files,
    }),
  );
  const envelope = {
    schemaVersion: 1,
    payloadBase64: payload.toString("base64"),
    signatureBase64: sign(null, payload, key).toString("base64"),
  };
  verifyManagedSkillBundle(envelope, {
    skillId: options.skillId,
    name: options.name,
    minimumVersion: options.version,
    publicKeyPem: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
  });
  const temporary = join(outputParent, `.managed-skill-${randomUUID()}.tmp`);
  const staging = await open(temporary, "wx", 0o600);
  try {
    try {
      await staging.writeFile(`${JSON.stringify(envelope)}\n`);
    } finally {
      await staging.close();
    }
    // 同目录 hard link 原子发布且拒绝覆盖已有版本；失败不留下半份正式发行包。
    await link(temporary, output);
  } finally {
    await unlink(temporary);
  }
  return { outputPath: output, version: options.version, fileCount: files.length };
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      "private-key": { type: "string" },
      output: { type: "string" },
      "skill-id": { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !values.source ||
    !values["private-key"] ||
    !values.output ||
    !values["skill-id"] ||
    !values.name ||
    !values.version ||
    !/^[1-9]\d*$/.test(values.version)
  ) {
    throw new Error(
      "Required: --source --private-key --output --skill-id --name --version (positive integer)",
    );
  }
  const result = await publishManagedSkill({
    source: values.source,
    privateKey: values["private-key"],
    output: values.output,
    skillId: values["skill-id"],
    name: values.name,
    version: Number(values.version),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Managed skill release failed"}\n`,
    );
    process.exitCode = 1;
  });
}
