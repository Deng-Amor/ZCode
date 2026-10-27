import { describe, expect, it } from "vitest";
import {
  createDeviceProofSigner,
  deviceChallengeSignatureInput,
  deviceRegisterSignatureInput,
  installKeySpkiSha256Hex,
  isServerNonce,
  pollRequestSha256Hex,
  receiptsRequestSha256Hex,
} from "../src/platform-command-channel/device-proof.js";

/**
 * 设备证明签名核心实现一致性测试：实现必须逐字节复现
 * platformCommandChannelDeviceChallenge.test.ts 中的全部冻结向量
 * （D1 注册 226B / D2 poll 265B / D2 receipts 269B），任一偏差即合同破坏。
 */

// 与冻结向量同源的三把测试钥（仅合同夹具）
const REGISTER_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKCqcL+GbCxRErben0GZ6bnk23L9wo2DIVuV20a1Cbw/
-----END PRIVATE KEY-----`;
const CHALLENGE_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINx2Yh4yscAr3Q1dc6xyy0PNOjSmxUvVUlR3LiXSUMDg
-----END PRIVATE KEY-----`;

const DEVICE_ID = "6f14c2d9-8b3e-4a57-9c21-d0e5f7a8b123";

describe("device-proof 冻结向量一致性（D1/D2 定稿合同）", () => {
  it("D1 注册：实现复现 226 字节 canonical 与冻结签名逐位一致", () => {
    const signer = createDeviceProofSigner(REGISTER_PRIVATE_KEY_PEM);
    expect(signer.spkiSha256Hex()).toBe("71d346ae42ef08d547d26b9cadc46b4057b43337722253553caab4bd94d4ab1c");
    const input = deviceRegisterSignatureInput(
      { challengeId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", nonce: "g-4Rt8Wq2xN6yB3mK9pJ7cV5dH1sL0aZ" },
      signer.spkiSha256Hex(),
    );
    expect(Buffer.byteLength(input)).toBe(226);
    expect(input.toString("utf8")).toBe(
      '{"challengeId":"c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f","installKeySpkiSha256":"71d346ae42ef08d547d26b9cadc46b4057b43337722253553caab4bd94d4ab1c","nonce":"g-4Rt8Wq2xN6yB3mK9pJ7cV5dH1sL0aZ","purpose":"register","schemaVersion":1}',
    );
    expect(signer.sign(input)).toBe(
      "+KFUAOAX97f2PYopmeldeX6kpIhsLBhC2vmNWS1OR5f4slEvwsrVEMt5IGEX/ZZuoJ09yymt6YuFz8i5VZZkDw==",
    );
  });

  it("D2 poll：requestSha256 口径 + 实现复现 265 字节 canonical 与冻结签名", () => {
    const signer = createDeviceProofSigner(CHALLENGE_PRIVATE_KEY_PEM);
    expect(pollRequestSha256Hex("0")).toBe("5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9");
    const input = deviceChallengeSignatureInput({
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "poll",
      requestSha256: pollRequestSha256Hex("0"),
    });
    expect(Buffer.byteLength(input)).toBe(265);
    expect(signer.sign(input)).toBe(
      "ss/bm9AZUEEZqbnwRAjFKrscIqqcbKgV32LwV1SjTg74BIUzyhXW3MNw3Tx0hp7F9us+1qJwANE79WokJtyCBg==",
    );
  });

  it("D2 receipts：请求体字节口径 + 实现复现 269 字节 canonical 与冻结签名", () => {
    const signer = createDeviceProofSigner(CHALLENGE_PRIVATE_KEY_PEM);
    const body = Buffer.from(
      '{"schemaVersion":1,"receipts":[{"status":"executed","commandId":"0b8ee37e-9f3d-4f2a-8f0f-3a9f7db4f1a1","resultRef":"runlogs-20261026-abc"}]}',
      "utf8",
    );
    expect(receiptsRequestSha256Hex(body)).toBe("694c6888e3df71955b840bf819918a1031717edb2d0a2c94fbd49a5e5015712f");
    const input = deviceChallengeSignatureInput({
      challengeId: "8a2f4c1e-6b7d-4e39-a8f5-2c7d9e0b1a34",
      deviceId: DEVICE_ID,
      nonce: "r-9Xk3Pq7wM2vB5nT8yJ4cH6dL1sA0eZ",
      purpose: "receipts",
      requestSha256: receiptsRequestSha256Hex(body),
    });
    expect(Buffer.byteLength(input)).toBe(269);
    expect(signer.sign(input)).toBe(
      "N64HvFlAo5KeQ/OZDzDrq16GP4fpcLSY5AtG1E3M2qgoq4ogk8JnipVYs0guLreSuzLOTDlQ1XQKlMa+u/kNBw==",
    );
  });

  it("游标替换防护：换 cursor 重算 requestSha256 后输入字节必变", () => {
    const a = deviceChallengeSignatureInput({
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "poll",
      requestSha256: pollRequestSha256Hex("0"),
    });
    const b = deviceChallengeSignatureInput({
      challengeId: "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012",
      deviceId: DEVICE_ID,
      nonce: "n-7QZx2mK9vRtL4pW8sY3bN6cJ1hD5fG",
      purpose: "poll",
      requestSha256: pollRequestSha256Hex("1"),
    });
    expect(a.equals(b)).toBe(false);
  });
});

describe("device-proof wire 护栏", () => {
  it("nonce 格式：32 字符无填充 base64url 通过，其余拒绝", () => {
    expect(isServerNonce("qRsT4uVwXyZ0123456789abcdefABCDE")).toBe(true);
    expect(isServerNonce("qRsT4uVwXyZ0123456789abcdefABCDEF")).toBe(false); // 33 字符
    expect(isServerNonce("qRsT4uVwXyZ0123456789abcdefABCD=")).toBe(false); // 带填充
    expect(isServerNonce("qRsT4uVwXyZ0123456789abcdefABCD+")).toBe(false); // 非 url 字母表
    expect(isServerNonce(123)).toBe(false);
  });

  it("公钥指纹口径：非 Ed25519 公钥拒绝", () => {
    expect(() => installKeySpkiSha256Hex("not-a-key")).toThrow();
  });
});
