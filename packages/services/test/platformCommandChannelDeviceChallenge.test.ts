import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "../src/platform-command-channel/canonical-json.js";

/**
 * D2 挑战签名字节合同——冻结跨端向量（2026-10-26 与中台定稿）。
 * 签名输入 = JCS({challengeId, deviceId, nonce, purpose}) 的 UTF-8 字节；
 * Ed25519（设备安装密钥）签名，base64。
 * 钥匙与向量为合同测试夹具，禁止作为生产密钥来源（PRD §4.7 钥匙卫生拍板）。
 */

// 测试专用固定钥匙（pkcs8 / spki，跨端复现同一组字节）
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIK0tIxnZ6hAgeRhphgw+QL3FiJ5Y7WefZWcOfApg8Cc/
-----END PRIVATE KEY-----`;
const TEST_PUBLIC_SPKI_B64 = "MCowBQYDK2VwAyEA8AtSQ1Ook9jtGNJ8xmu0gabn0NGFK+jyDk5htxj4Eqs=";

const FROZEN_CHALLENGE_RESPONSE = {
  challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
  deviceId: "dev-918273645f",
  nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
  purpose: "poll",
} as const;

// 冻结的规范化输入（142 字节）与其 sha256 / 签名
const FROZEN_CANONICAL =
  '{"challengeId":"3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012","deviceId":"dev-918273645f","nonce":"n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG","purpose":"poll"}';
const FROZEN_CANONICAL_SHA256 = "f92d400edf5a88af6c922988e5cb09deb7d274a95ce3cac89f38eeb70dd5aa02";
const FROZEN_SIGNATURE_B64 =
  "rCz6fcgKLm0sUWAv/FRpbVvLGTQqy2p4YbpKOrq10pXhXXGs/aRGNvU9q97pz25IlZ5MvUsRvCj9IP0NRtZdCg==";

describe("D2 挑战签名字节合同（冻结向量）", () => {
  it("规范化输入字节冻结：JCS 键序 challengeId<deviceId<nonce<purpose，142 字节，sha256 一致", () => {
    const canonical = canonicalJsonString(FROZEN_CHALLENGE_RESPONSE);
    expect(canonical).toBe(FROZEN_CANONICAL);
    const bytes = Buffer.from(canonical, "utf8");
    expect(bytes.length).toBe(142);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FROZEN_CANONICAL_SHA256);
  });

  it("冻结测试钥对固定向量签名的字节逐位一致（跨端复现锚点）", () => {
    const signature = ed25519Sign(null, Buffer.from(FROZEN_CANONICAL, "utf8"), TEST_PRIVATE_KEY_PEM);
    expect(signature.toString("base64")).toBe(FROZEN_SIGNATURE_B64);
  });

  it("冻结公钥可验冻结签名（服务端复现路径）", () => {
    const privateKey = createPrivateKey(TEST_PRIVATE_KEY_PEM);
    // 派生公钥与冻结 SPKI 一致，验签通过——服务端用 TEST_PUBLIC_SPKI_B64 即可复现。
    const publicKey = createPublicKey(privateKey);
    expect(publicKey.export({ type: "spki", format: "der" }).toString("base64")).toBe(TEST_PUBLIC_SPKI_B64);
    expect(
      ed25519Verify(null, Buffer.from(FROZEN_CANONICAL, "utf8"), publicKey, Buffer.from(FROZEN_SIGNATURE_B64, "base64")),
    ).toBe(true);
  });

  it("任何字段改动（含 purpose 换 receipts）签名验证失败——用途绑定回归", () => {
    const publicKey = createPublicKey(TEST_PRIVATE_KEY_PEM);
    const tampered = canonicalJsonString({ ...FROZEN_CHALLENGE_RESPONSE, purpose: "receipts" });
    expect(
      ed25519Verify(null, Buffer.from(tampered, "utf8"), publicKey, Buffer.from(FROZEN_SIGNATURE_B64, "base64")),
    ).toBe(false);
  });
});
