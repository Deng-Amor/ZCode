import type { ExpertSkillTransport } from "./contract.js";

/**
 * 标准调用示例：transport 只取签名包，验签与目录复核由调用方执行。
 * 展示 digest 协商的典型一次命中获取。
 */
export async function fetchExpertSkillEnvelope(
  transport: ExpertSkillTransport,
  identity: string,
  skillId: string,
  cachedDigest: string | undefined,
): Promise<{ envelope: unknown; notModified: boolean }> {
  const result = await transport.get(identity, skillId, { cachedDigest });
  if ("notModified" in result) return { envelope: undefined, notModified: true };
  return { envelope: result, notModified: false };
}
