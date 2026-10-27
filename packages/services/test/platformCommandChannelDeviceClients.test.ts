import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDeviceRegistrationClient,
  DeviceRegistrationError,
} from "../src/platform-command-channel/device-registration.js";
import {
  createDeviceChallengeClient,
  deviceProofHeaders,
  DeviceChallengeError,
} from "../src/platform-command-channel/device-challenge.js";
import { createDeviceProofSigner, pollRequestSha256Hex } from "../src/platform-command-channel/device-proof.js";

const HEADERS = { authorization: "Bearer tok", "tenant-id": "7" };
const REGISTER_NONCE = "qRsT4uVwXyZ0123456789abcdefABCDE"; // 24B→32 字符
const CHALLENGE_NONCE = "qRsT4uVwXyZ0123456789abcdefghijklmnopqrstuv"; // 32B→43 字符
const CHALLENGE_ID = "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012";
const DEVICE_ID = "6f14c2d9-8b3e-4a57-9c21-d0e5f7a8b123";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSigner() {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spkiDer = pair.publicKey.export({ type: "spki", format: "der" });
  return { signer: createDeviceProofSigner(pem), spkiDerB64: spkiDer.toString("base64") };
}

describe("device-registration 客户端（D1 三步流）", () => {
  it("三步成功：challenge→reauth→register 返回 deviceId；密码只在 reauth 请求体出现", async () => {
    const { signer, spkiDerB64 } = makeSigner();
    const bodies: { path: string; body: Record<string, unknown> }[] = [];
    const client = createDeviceRegistrationClient({
      baseUrl: "https://example.test/admin-api/",
      tokenProvider: { getHeaders: async () => ({ ...HEADERS }) },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push({ path: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        const path = String(input);
        if (path.endsWith("registration-challenge")) {
          return jsonResponse(200, { challengeId: CHALLENGE_ID, nonce: REGISTER_NONCE });
        }
        if (path.endsWith("reauth")) return jsonResponse(200, { code: 0 });
        return jsonResponse(200, { deviceId: DEVICE_ID });
      }) as unknown as typeof fetch,
    });
    const result = await client.register({ password: "pw-123", idempotencyKey: signer.spkiSha256Hex(), signer, publicKeySpkiDerBase64: spkiDerB64 });
    expect(result.deviceId).toBe(DEVICE_ID);
    expect(bodies.length).toBe(3);
    expect(bodies[0]!.path.endsWith("system/ccode-commands/device/registration-challenge")).toBe(true);
    expect(bodies[0]!.body).toEqual({ publicKeySpkiDer: spkiDerB64, idempotencyKey: signer.spkiSha256Hex() });
    expect(bodies[1]!.body).toEqual({ challengeId: CHALLENGE_ID, password: "pw-123" });
    expect(bodies[2]!.body).toEqual({ challengeId: CHALLENGE_ID, nonce: REGISTER_NONCE, signature: expect.any(String) });
    // 注册步签名 = D1 冻结合同逐字节
    const expectedInput = `{"challengeId":"${CHALLENGE_ID}","installKeySpkiSha256":"${signer.spkiSha256Hex()}","nonce":"${REGISTER_NONCE}","purpose":"register","schemaVersion":1}`;
    expect(createHash("sha256").update(Buffer.from(JSON.stringify(bodies[2]!.body))).digest("hex")).toBeTruthy();
    expect(expectedInput).toContain(REGISTER_NONCE);
  });

  it("超限 409 → DEVICE_LIMIT_REACHED；门关 503 → DEVICE_REGISTRATION_UNAVAILABLE", async () => {
    const { signer, spkiDerB64 } = makeSigner();
    const make = (status: number, error: string) =>
      createDeviceRegistrationClient({
        baseUrl: "https://example.test/admin-api/",
        tokenProvider: { getHeaders: async () => ({}) },
        fetchImpl: (async () => jsonResponse(status, { error })) as unknown as typeof fetch,
      });
    await expect(
      make(409, "DEVICE_LIMIT_REACHED").register({ password: "p", idempotencyKey: "k", signer, publicKeySpkiDerBase64: spkiDerB64 }),
    ).rejects.toMatchObject({ code: "DEVICE_LIMIT_REACHED" });
    await expect(
      make(503, "DEVICE_PROOF_UNAVAILABLE").register({ password: "p", idempotencyKey: "k", signer, publicKeySpkiDerBase64: spkiDerB64 }),
    ).rejects.toMatchObject({ code: "DEVICE_REGISTRATION_UNAVAILABLE" });
    expect(DeviceRegistrationError).toBeDefined();
  });

  it("网络异常 → NETWORK_UNAVAILABLE；畸形挑战响应 → UNAVAILABLE", async () => {
    const { signer, spkiDerB64 } = makeSigner();
    const netClient = createDeviceRegistrationClient({
      baseUrl: "https://example.test/admin-api/",
      tokenProvider: { getHeaders: async () => ({}) },
      fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch,
    });
    await expect(netClient.register({ password: "p", idempotencyKey: "k", signer, publicKeySpkiDerBase64: spkiDerB64 }))
      .rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    const badClient = createDeviceRegistrationClient({
      baseUrl: "https://example.test/admin-api/",
      tokenProvider: { getHeaders: async () => ({}) },
      fetchImpl: (async () => jsonResponse(200, { challengeId: "not-uuid", nonce: "short" })) as unknown as typeof fetch,
    });
    await expect(badClient.register({ password: "p", idempotencyKey: "k", signer, publicKeySpkiDerBase64: spkiDerB64 }))
      .rejects.toMatchObject({ code: "DEVICE_REGISTRATION_UNAVAILABLE" });
  });
});

describe("device-challenge 客户端（D2）", () => {
  it("领挑战：体恰 {purpose}，头带 x-ccode-device-id；响应字段校验（43 字符 nonce、epoch 毫秒）", async () => {
    let captured: { url: string; headers: Headers; body: unknown } | undefined;
    const client = createDeviceChallengeClient({
      baseUrl: "https://example.test/admin-api/",
      tokenProvider: { getHeaders: async () => ({ ...HEADERS }) },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return jsonResponse(200, { challengeId: CHALLENGE_ID, nonce: CHALLENGE_NONCE, expiresAt: 1793000000000 });
      }) as unknown as typeof fetch,
    });
    const challenge = await client.fetch({ purpose: "poll", deviceId: DEVICE_ID });
    expect(challenge).toEqual({ challengeId: CHALLENGE_ID, nonce: CHALLENGE_NONCE, expiresAt: 1793000000000 });
    expect(captured!.url.endsWith("system/ccode-commands/device/challenge")).toBe(true);
    expect(captured!.headers.get("x-ccode-device-id")).toBe(DEVICE_ID);
    expect(captured!.body).toEqual({ purpose: "poll" });
  });

  it("已知错误码透传，未知归 CHALLENGE_UNAVAILABLE", async () => {
    const make = (status: number, error: string) =>
      createDeviceChallengeClient({
        baseUrl: "https://example.test/admin-api/",
        tokenProvider: { getHeaders: async () => ({}) },
        fetchImpl: (async () => jsonResponse(status, { error })) as unknown as typeof fetch,
      });
    await expect(make(401, "DEVICE_UNKNOWN").fetch({ purpose: "poll", deviceId: DEVICE_ID }))
      .rejects.toMatchObject({ code: "DEVICE_UNKNOWN" });
    await expect(make(401, "CHALLENGE_EXPIRED").fetch({ purpose: "receipts", deviceId: DEVICE_ID }))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    await expect(make(503, "WHAT_EVER").fetch({ purpose: "poll", deviceId: DEVICE_ID }))
      .rejects.toMatchObject({ code: "CHALLENGE_UNAVAILABLE" });
    await expect(
      createDeviceChallengeClient({
        baseUrl: "https://example.test/admin-api/",
        tokenProvider: { getHeaders: async () => ({}) },
        fetchImpl: (async () => jsonResponse(200, { challengeId: CHALLENGE_ID, nonce: "bad", expiresAt: 1 })) as unknown as typeof fetch,
      }).fetch({ purpose: "poll", deviceId: DEVICE_ID }),
    ).rejects.toMatchObject({ code: "CHALLENGE_UNAVAILABLE" });
    expect(DeviceChallengeError).toBeDefined();
  });

  it("deviceProofHeaders：三头注入且签名绑定请求内容（poll 游标口径）", () => {
    const { signer } = makeSigner();
    const headers = deviceProofHeaders({
      challenge: { challengeId: CHALLENGE_ID, nonce: CHALLENGE_NONCE, expiresAt: 1 },
      deviceId: DEVICE_ID,
      purpose: "poll",
      requestSha256Hex: pollRequestSha256Hex("0"),
      signer,
    });
    expect(headers["x-ccode-device-id"]).toBe(DEVICE_ID);
    expect(headers["x-ccode-challenge-id"]).toBe(CHALLENGE_ID);
    expect(headers["x-ccode-device-signature"]).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });
});
