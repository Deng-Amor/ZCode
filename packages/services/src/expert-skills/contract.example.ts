import { createExpertSkillCacheStore } from "./index.js";
import type { ExpertSkillVerifiedInput } from "./index.js";

/**
 * 标准调用示例：Main 作为唯一写入者创建一次 store；put 只接受验签产物 + payload
 * digest，get 返回前已逐文件复验，被篡改内容以 ExpertSkillCacheError 拒绝。
 */
export async function cacheVerifiedExpertSkill(
  baseDir: string,
  identity: string,
  input: ExpertSkillVerifiedInput,
): Promise<void> {
  const store = createExpertSkillCacheStore({ baseDir });
  await store.put(identity, input);
}
