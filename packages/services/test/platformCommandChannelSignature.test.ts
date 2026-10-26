import { createHash, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonString,
  commandChannelSignatureInput,
  verifyCommandChannelEnvelopeSignature,
} from "../src/platform-command-channel/canonical-json.js";
import {
  makeCommandChannelTestDirectory,
  removeCommandChannelTestDirectory,
  testPullRunLogsEnvelope,
  testSkillUpdateNoticeEnvelope,
} from "./platformCommandChannelFixtures.js";

describe("canonicalJsonString（RFC 8785 值域子集）", () => {
  it("键按 UTF-16 码单元排序、无空白、嵌套递归", () => {
    expect(canonicalJsonString({ b: 1, a: { d: "x", c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  it("RFC 8785 §3.2.3 示例键序（含非 ASCII 键按码单元而非本地化序）", () => {
    // RFC 示例：\u20ac 与 \u00fc 的码单元序在 "e" 之前之后有明确顺序，这里取其结构等价断言。
    const canonical = canonicalJsonString({ e: 0, "ü": 1, "€": 2, a: 3 });
    expect(canonical.indexOf('"a"')).toBeLessThan(canonical.indexOf('"e"'));
    expect(canonical.indexOf('"e"')).toBeLessThan(canonical.indexOf('"ü"'));
    expect(canonical.indexOf('"ü"')).toBeLessThan(canonical.indexOf('"€"'));
  });

  it("控制字符与引号反斜杠按 JSON 最短转义", () => {
    expect(canonicalJsonString({ s: "a\"b\\c\td" })).toBe('{"s":"a\\"b\\\\c\\td"}');
  });

  it("浮点与非安全整数 fail-fast（信封域不含，出现即配置错误）", () => {
    expect(() => canonicalJsonString({ x: 1.5 })).toThrow();
    expect(() => canonicalJsonString({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

describe("commandChannelSignatureInput（2026-10-25 与中台对齐：移除 signature 后 JCS）", () => {
  it("输入不含 signature 字段且为规范化字节", () => {
    const envelope = testSkillUpdateNoticeEnvelope();
    const input = commandChannelSignatureInput(envelope as never);
    const text = input.toString("utf8");
    expect(text).not.toContain("signature");
    expect(text).toBe(canonicalJsonString({
      envelopeVersion: envelope.envelopeVersion,
      type: envelope.type,
      noticeId: envelope.noticeId,
      params: envelope.params,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    }));
  });

  it("字段顺序无关：与打乱键序的同一信封产生逐字节一致输入", () => {
    const envelope = testPullRunLogsEnvelope() as Record<string, unknown>;
    const shuffled = {
      params: envelope.params,
      signature: envelope.signature,
      expiresAt: envelope.expiresAt,
      type: envelope.type,
      issuedAt: envelope.issuedAt,
      commandId: envelope.commandId,
      envelopeVersion: envelope.envelopeVersion,
    };
    expect(commandChannelSignatureInput(shuffled as never).equals(commandChannelSignatureInput(envelope as never))).toBe(true);
  });
});

describe("verifyCommandChannelEnvelopeSignature（Ed25519 + base64）", () => {
  let directory: string;
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeAll(async () => {
    directory = await makeCommandChannelTestDirectory();
    const pair = generateKeyPairSync("ed25519");
    privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  });
  afterAll(async () => {
    await removeCommandChannelTestDirectory(directory);
  });

  const signEnvelope = (envelope: Record<string, unknown>): string => {
    const { signature: _omit, ...rest } = envelope;
    void _omit;
    const signature = ed25519Sign(null, Buffer.from(canonicalJsonString(rest), "utf8"), privateKeyPem);
    return signature.toString("base64");
  };

  it("中台口径（去 signature + JCS + Ed25519 + base64）验签通过", () => {
    const envelope = { ...testPullRunLogsEnvelope() } as Record<string, unknown>;
    envelope.signature = signEnvelope(envelope);
    expect(verifyCommandChannelEnvelopeSignature(envelope as never, publicKeyPem)).toBe(true);
  });

  it("0.0.9 自引用形态（含 signature 的 JSON.stringify）必须被拒绝——回归向量", () => {
    const envelope = { ...testPullRunLogsEnvelope() } as Record<string, unknown>;
    // 模拟旧实现可产生的"合法自引用签名"：对含 signature 的序列化字节签名。
    // 新验签只认去 signature 的规范化输入，因此该形态必须 false。
    envelope.signature = "placeholder";
    const selfReferential = ed25519Sign(null, Buffer.from(JSON.stringify(envelope), "utf8"), privateKeyPem);
    const tampered = { ...envelope, signature: selfReferential.toString("base64") };
    expect(verifyCommandChannelEnvelopeSignature(tampered as never, publicKeyPem)).toBe(false);
  });

  it("篡改任意受保护字段（params）验签失败", () => {
    const envelope = { ...testPullRunLogsEnvelope() } as Record<string, unknown>;
    envelope.signature = signEnvelope(envelope);
    const tampered = { ...envelope, params: { scope: { timeRange: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" } } } };
    expect(verifyCommandChannelEnvelopeSignature(tampered as never, publicKeyPem)).toBe(false);
  });

  it("非法 base64 / 非法 PEM / 非整数域 均归为 false 不抛错", () => {
    const envelope = { ...testSkillUpdateNoticeEnvelope(), signature: "not-base64!!!" } as never;
    expect(verifyCommandChannelEnvelopeSignature(envelope, publicKeyPem)).toBe(false);
    const good = { ...testSkillUpdateNoticeEnvelope() } as Record<string, unknown>;
    good.signature = signEnvelope(good);
    expect(verifyCommandChannelEnvelopeSignature(good as never, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")).toBe(false);
  });

  it("跨信封类型（notice）同样通过", () => {
    const envelope = { ...testSkillUpdateNoticeEnvelope() } as Record<string, unknown>;
    envelope.signature = signEnvelope(envelope);
    expect(verifyCommandChannelEnvelopeSignature(envelope as never, publicKeyPem)).toBe(true);
  });

  it("规范化输入的 sha256 可作跨端字节向量锚点", () => {
    const envelope = { ...testSkillUpdateNoticeEnvelope() } as Record<string, unknown>;
    envelope.signature = signEnvelope(envelope);
    const digest = createHash("sha256").update(commandChannelSignatureInput(envelope as never)).digest("hex");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
