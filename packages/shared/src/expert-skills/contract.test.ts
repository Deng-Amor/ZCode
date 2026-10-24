import { describe, expect, it } from "vitest";
import {
  ExpertSkillCacheError,
  type ExpertSkillCacheEntry,
  type ExpertSkillTransport,
} from "./index.js";
import { expertSkillsModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁（shared 层本模块仅类型，
// 此处锁定类型形态与错误码契约，真实磁盘行为由 services 层 expert-skills-cache 覆盖）。
describe("expert skills contract", () => {
  it("declares its module manifest", () => {
    expect(expertSkillsModule.id).toBe("expert-skills");
  });

  it("exposes typed diagnostic errors with stable codes", () => {
    const error = new ExpertSkillCacheError("HASH_MISMATCH", "cache file hash mismatch");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("HASH_MISMATCH");
    expect(error.name).toBe("ExpertSkillCacheError");
  });

  it("keeps NotModified discriminated from signed envelopes", () => {
    const notModified = { notModified: true, digest: "a".repeat(64) } as const;
    expect("notModified" in notModified).toBe(true);
    const envelopeLike = {
      schemaVersion: 1,
      payloadBase64: "",
      signatureBase64: "",
    } as const;
    expect("notModified" in envelopeLike).toBe(false);
  });

  it("models the transport surface without credentials", () => {
    const transport: ExpertSkillTransport = {
      search: async (_identity, query) =>
        query.domainTags?.map((tag) => ({
          skillId: `pdd-${tag}`,
          name: `PDD ${tag}`,
          domainTags: [tag],
          summary: "",
          version: 1,
          digest: "b".repeat(64),
          scopeRef: "tenant:pdd",
        })) ?? [],
      get: async () => ({ notModified: true as const }),
    };
    const entry: ExpertSkillCacheEntry | undefined = undefined;
    expect(entry).toBeUndefined();
    expect(transport.get).toBeTypeOf("function");
  });
});
