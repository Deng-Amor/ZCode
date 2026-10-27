import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "../src/platform-command-channel/canonical-json.js";

/**
 * D2 挑战签名字节合同——冻结跨端向量（2026-10-26 定稿 + 同日修订：绑定请求内容）。
 *
 * 签名输入 = JCS({schemaVersion:1, challengeId, deviceId, nonce, purpose, requestSha256}) 的 UTF-8 字节；
 * Ed25519（设备安装密钥）签名，base64。
 *   - poll：requestSha256 = sha256(游标参数原文的 UTF-8 字节；无 cursor 参数时对空串计算)；
 *   - receipts：requestSha256 = sha256(实际发送的原始请求体字节)；
 * 服务端从收到的请求重算并验签，挑战原子消费（绑定账号/租户/设备/用途）。
 * deviceId wire 格式 = 小写标准 UUID 文本（服务端严格解码为 16 字节设备 ID）。
 *
 * 钥匙与向量为合同测试夹具，禁止作为生产密钥来源（PRD §4.7 钥匙卫生拍板）。
 */

// 测试专用固定钥匙（跨端复现同一组字节）
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINx2Yh4yscAr3Q1dc6xyy0PNOjSmxUvVUlR3LiXSUMDg
-----END PRIVATE KEY-----`;
const TEST_PUBLIC_SPKI_B64 = "MCowBQYDK2VwAyEAkm63oa39Yp60CIGBOyDAuo78f0AIpnU7Gkw4yVS5E0o=";

const DEVICE_ID = "6f14c2d9-8b3e-4a57-9c21-d0e5f7a8b123";

// requestSha256 计算口径（客户端/服务端共用定义）
const pollRequestSha256 = (cursor: string | undefined) =>
  createHash("sha256").update(cursor ?? "", "utf8").digest("hex");
const receiptsRequestSha256 = (rawBodyBytes: Buffer) =>
  createHash("sha256").update(rawBodyBytes).digest("hex");

// ---- 向量1：poll（cursor="0"）----
const POLL_CURSOR = "0";
const POLL_CANONICAL =
  '{"challengeId":"3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012","deviceId":"' + DEVICE_ID +
  '","nonce":"n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG","purpose":"poll","requestSha256":"5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9","schemaVersion":1}';
const POLL_CANONICAL_SHA256 = "117c10d9ced34a8a5b9de826c61001ec16c978f15e8e600326fec72d89f922cf";
const POLL_SIGNATURE_B64 =
  "ss/bm9AZUEEZqbnwRAjFKrscIqqcbKgV32LwV1SjTg74BIUzyhXW3MNw3Tx0hp7F9us+1qJwANE79WokJtyCBg==";

// ---- 向量2：receipts（原始请求体字节）----
const RECEIPTS_BODY =
  '{"schemaVersion":1,"receipts":[{"status":"executed","commandId":"0b8ee37e-9f3d-4f2a-8f0f-3a9f7db4f1a1","resultRef":"runlogs-20261026-abc"}]}';
const RECEIPTS_BODY_SHA256 = "694c6888e3df71955b840bf819918a1031717edb2d0a2c94fbd49a5e5015712f";
const RECEIPTS_CANONICAL =
  '{"challengeId":"8a2f4c1e-6b7d-4e39-a8f5-2c7d9e0b1a34","deviceId":"' + DEVICE_ID +
  '","nonce":"r-9Xk3Pq7wM2vB5nT8yJ4cH6dL1sA0eZ","purpose":"receipts","requestSha256":"' + RECEIPTS_BODY_SHA256 + '","schemaVersion":1}';
const RECEIPTS_CANONICAL_SHA256 = "38ba6dbe3717a6f3d7f7bf4b419e1294685229130c753f22cb45aaa05fdf3239";
const RECEIPTS_SIGNATURE_B64 =
  "N64HvFlAo5KeQ/OZDzDrq16GP4fpcLSY5AtG1E3M2qgoq4ogk8JnipVYs0guLreSuzLOTDlQ1XQKlMa+u/kNBw==";

function publicKeyOfFixture() {
  const privateKey = createPrivateKey(TEST_PRIVATE_KEY_PEM);
  const publicKey = createPublicKey(privateKey);
  expect(publicKey.export({ type: "spki", format: "der" }).toString("base64")).toBe(TEST_PUBLIC_SPKI_B64);
  return publicKey;
}

describe("D2 挑战签名字节合同（修订版冻结向量：绑定请求内容）", () => {
  it("poll 向量：requestSha256 口径、canonical 265 字节与 sha256 冻结一致", () => {
    expect(pollRequestSha256(POLL_CURSOR)).toBe("5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9");
    const canonical = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "poll",
      requestSha256: pollRequestSha256(POLL_CURSOR),
    });
    expect(canonical).toBe(POLL_CANONICAL);
    expect(Buffer.byteLength(canonical)).toBe(265);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(POLL_CANONICAL_SHA256);
  });

  it("poll 向量：冻结测试钥签名逐位一致，服务端用冻结公钥可复现验签", () => {
    expect(ed25519Sign(null, Buffer.from(POLL_CANONICAL, "utf8"), TEST_PRIVATE_KEY_PEM).toString("base64")).toBe(POLL_SIGNATURE_B64);
    expect(
      ed25519Verify(null, Buffer.from(POLL_CANONICAL, "utf8"), publicKeyOfFixture(), Buffer.from(POLL_SIGNATURE_B64, "base64")),
    ).toBe(true);
  });

  it("receipts 向量：原始请求体字节口径、canonical 269 字节与签名冻结一致", () => {
    const bodyBytes = Buffer.from(RECEIPTS_BODY, "utf8");
    expect(receiptsRequestSha256(bodyBytes)).toBe(RECEIPTS_BODY_SHA256);
    const canonical = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "8a2f4c1e-6b7d-4e39-a8f5-2c7d9e0b1a34",
      deviceId: DEVICE_ID,
      nonce: "r-9Xk3Pq7wM2vB5nT8yJ4cH6dL1sA0eZ",
      purpose: "receipts",
      requestSha256: receiptsRequestSha256(bodyBytes),
    });
    expect(canonical).toBe(RECEIPTS_CANONICAL);
    expect(Buffer.byteLength(canonical)).toBe(269);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(RECEIPTS_CANONICAL_SHA256);
    expect(ed25519Sign(null, Buffer.from(RECEIPTS_CANONICAL, "utf8"), TEST_PRIVATE_KEY_PEM).toString("base64")).toBe(RECEIPTS_SIGNATURE_B64);
    expect(
      ed25519Verify(null, Buffer.from(RECEIPTS_CANONICAL, "utf8"), publicKeyOfFixture(), Buffer.from(RECEIPTS_SIGNATURE_B64, "base64")),
    ).toBe(true);
  });

  it("失败向量A（替换 cursor）：同签名换游标（cursor=\"1\"）服务端重算 requestSha256 后验签必败", () => {
    const tamperedCanonical = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "poll",
      requestSha256: pollRequestSha256("1"),
    });
    expect(tamperedCanonical).not.toBe(POLL_CANONICAL);
    expect(
      ed25519Verify(null, Buffer.from(tamperedCanonical, "utf8"), publicKeyOfFixture(), Buffer.from(POLL_SIGNATURE_B64, "base64")),
    ).toBe(false);
  });

  it("失败向量B（替换回执正文）：同签名换请求体（改 resultRef）服务端重算 requestSha256 后验签必败", () => {
    const tamperedBody = RECEIPTS_BODY.replace("runlogs-20261026-abc", "runlogs-20261026-xyz");
    expect(tamperedBody).not.toBe(RECEIPTS_BODY);
    const tamperedCanonical = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "8a2f4c1e-6b7d-4e39-a8f5-2c7d9e0b1a34",
      deviceId: DEVICE_ID,
      nonce: "r-9Xk3Pq7wM2vB5nT8yJ4cH6dL1sA0eZ",
      purpose: "receipts",
      requestSha256: receiptsRequestSha256(Buffer.from(tamperedBody, "utf8")),
    });
    expect(
      ed25519Verify(null, Buffer.from(tamperedCanonical, "utf8"), publicKeyOfFixture(), Buffer.from(RECEIPTS_SIGNATURE_B64, "base64")),
    ).toBe(false);
  });

  it("用途绑定回归：poll 向量改 purpose=receipts 必拒", () => {
    const tampered = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "receipts",
      requestSha256: pollRequestSha256(POLL_CURSOR),
    });
    expect(
      ed25519Verify(null, Buffer.from(tampered, "utf8"), publicKeyOfFixture(), Buffer.from(POLL_SIGNATURE_B64, "base64")),
    ).toBe(false);
  });
});

/**
 * D1 注册签名字节合同——冻结向量（2026-10-26 客户端草案，待中台确认）。
 *
 * 注册时 deviceId 尚未分配，签名输入改为绑定「待注册公钥」防换钥攻击：
 * 输入 = JCS({schemaVersion:1, challengeId, nonce, purpose:"register", installKeySpkiSha256}) 的
 * UTF-8 字节，Ed25519（安装密钥）签名，base64；
 * installKeySpkiSha256 = sha256(安装公钥 SPKI DER 字节) 的 hex（与 trust-roots keyId 同口径）。
 */
const REGISTER_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKCqcL+GbCxRErben0GZ6bnk23L9wo2DIVuV20a1Cbw/
-----END PRIVATE KEY-----`;
const REGISTER_INSTALL_SPKI_B64 = "MCowBQYDK2VwAyEAQBKzOvb1O98fs1B4YFw+GOE5LsIN1WC5m8VOp4gcV18=";
const REGISTER_INSTALL_SPKI_SHA256 = "71d346ae42ef08d547d26b9cadc46b4057b43337722253553caab4bd94d4ab1c";
const REGISTER_CANONICAL =
  '{"challengeId":"c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f","installKeySpkiSha256":"' + REGISTER_INSTALL_SPKI_SHA256 +
  '","nonce":"g-4Rt8Wq2xN6yB3mK9pJ7cV5dH1sL0aZ","purpose":"register","schemaVersion":1}';
const REGISTER_CANONICAL_SHA256 = "72de68c4e2b67b2bcd3ed8796c074285c63441594316e98f9a0f19a09b88d684";
const REGISTER_SIGNATURE_B64 =
  "+KFUAOAX97f2PYopmeldeX6kpIhsLBhC2vmNWS1OR5f4slEvwsrVEMt5IGEX/ZZuoJ09yymt6YuFz8i5VZZkDw==";

describe("D1 注册签名字节合同（草案冻结向量）", () => {
  it("installKeySpkiSha256 口径与 SPKI DER 绑定，canonical 226 字节与 sha256 冻结一致", () => {
    const privateKey = createPrivateKey(REGISTER_PRIVATE_KEY_PEM);
    const publicKey = createPublicKey(privateKey);
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    expect(spkiDer.toString("base64")).toBe(REGISTER_INSTALL_SPKI_B64);
    expect(createHash("sha256").update(spkiDer).digest("hex")).toBe(REGISTER_INSTALL_SPKI_SHA256);
    const canonical = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
      nonce: "g-4Rt8Wq2xN6yB3mK9pJ7cV5dH1sL0aZ",
      purpose: "register",
      installKeySpkiSha256: REGISTER_INSTALL_SPKI_SHA256,
    });
    expect(canonical).toBe(REGISTER_CANONICAL);
    expect(Buffer.byteLength(canonical)).toBe(226);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(REGISTER_CANONICAL_SHA256);
  });

  it("冻结测试钥签名逐位一致，服务端复现验签通过", () => {
    expect(ed25519Sign(null, Buffer.from(REGISTER_CANONICAL, "utf8"), REGISTER_PRIVATE_KEY_PEM).toString("base64")).toBe(REGISTER_SIGNATURE_B64);
    const publicKey = createPublicKey(createPrivateKey(REGISTER_PRIVATE_KEY_PEM));
    expect(
      ed25519Verify(null, Buffer.from(REGISTER_CANONICAL, "utf8"), publicKey, Buffer.from(REGISTER_SIGNATURE_B64, "base64")),
    ).toBe(true);
  });

  it("换钥攻击回归：换公钥指纹（installKeySpkiSha256）后旧签名必拒", () => {
    const tampered = canonicalJsonString({
      schemaVersion: 1,
      challengeId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
      nonce: "g-4Rt8Wq2xN6yB3mK9pJ7cV5dH1sL0aZ",
      purpose: "register",
      installKeySpkiSha256: "ff".repeat(32),
    });
    const publicKey = createPublicKey(createPrivateKey(REGISTER_PRIVATE_KEY_PEM));
    expect(
      ed25519Verify(null, Buffer.from(tampered, "utf8"), publicKey, Buffer.from(REGISTER_SIGNATURE_B64, "base64")),
    ).toBe(false);
  });
});
