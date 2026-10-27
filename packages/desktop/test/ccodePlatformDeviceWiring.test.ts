import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceProofSigner } from "@zcode/services/platform-command-channel";
import { createDesktopCcodePlatformRuntimeWiring } from "../src/main/ccode-platform-runtime-wiring/index.js";

/** 设备证明接线（D2 三头/门控/D3 游标，2026-10-27）：全部走真长轮询 transport + stub fetch。 */

const DEVICE_ID = "6f14c2d9-8b3e-4a57-9c21-d0e5f7a8b123";
const CHALLENGE_NONCE = "qRsT4uVwXyZ0123456789abcdefghijklmnopqrstuv"; // 32B→43 字符
const CHALLENGE_ID = "3f1c2b8a-9d4e-4f67-a5b1-c8e2f7a9d012";

function makeDevice() {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signer = createDeviceProofSigner(pem);
  return { signer, deviceId: DEVICE_ID };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function baseEnv() {
  const account = {
    getState: vi.fn(async () => ({ authenticated: true, tenantId: "7", userId: "9" })),
    onStateChanged: () => () => undefined,
    getAuthHeaders: vi.fn(async () => ({ authorization: "Bearer t", "tenant-id": "7" })),
  };
  return { account };
}

describe("desktop 设备证明接线", () => {
  it("无 deviceId 时登录后不产生 poll 请求（门控），notify 后开始 poll 并带三证明头", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-device-"));
    try {
      const { account } = baseEnv();
      const device = makeDevice();
      let registered = false;
      const requests: { url: string; headers: Headers; body?: unknown }[] = [];
      let runtimeDeps: { startTransport(): Promise<void>; stopTransport(): Promise<void> } | undefined;
      const runtime = {
        start: vi.fn(async () => { await runtimeDeps?.startTransport(); }),
        stop: vi.fn(async () => { await runtimeDeps?.stopTransport(); }),
        dispose: vi.fn(async () => undefined),
        processCommand: vi.fn(async () => ({ response: {}, serializedResponse: '{"status":"dispatched","noticeId":"n-1"}', replay: false })),
        auditTelemetry: undefined,
      };
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/device/challenge")) {
          requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
          return jsonRes(200, { challengeId: CHALLENGE_ID, nonce: CHALLENGE_NONCE, expiresAt: Date.now() + 60_000 });
        }
        if (url.includes("/poll")) {
          requests.push({ url, headers: new Headers(init?.headers) });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return jsonRes(200, { envelopes: [], nextCursor: "1" });
        }
        if (url.includes("/receipts")) {
          requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
          return jsonRes(200, { code: 0 });
        }
        return jsonRes(200, { code: 0 });
      });
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/admin-api/",
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        minEmptyPollIntervalMs: 10,
        deviceIdentity: { get: async () => (registered ? { deviceId: device.deviceId, signer: device.signer } : { signer: device.signer }) },
        createRuntime: (deps) => { runtimeDeps = deps as typeof runtimeDeps; return runtime as never; },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      // 未注册：无任何 /device 或 /poll 请求。
      expect(requests.filter((r) => r.url.includes("/poll")).length).toBe(0);

      registered = true;
      wiring.notifyDeviceIdentityChanged();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const polls = requests.filter((r) => r.url.includes("/poll"));
      expect(polls.length).toBeGreaterThanOrEqual(1);
      expect(polls[0]!.headers.get("x-ccode-device-id")).toBe(DEVICE_ID);
      expect(polls[0]!.headers.get("x-ccode-challenge-id")).toBe(CHALLENGE_ID);
      expect(polls[0]!.headers.get("x-ccode-device-signature")).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      await wiring.dispose();
      // 游标按 deviceId 隔离落盘。
      await expect(readFile(join(storageRoot, "command-channel", `cursor-${DEVICE_ID}.txt`), "utf8")).resolves.toBe("1");
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("回执上行经证明头包装：challenge→receipts 均带三头，且 receipts 用原始字节签名", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "ccode-wiring-device2-"));
    try {
      const { account } = baseEnv();
      const device = makeDevice();
      const challengeCalls: { headers: Headers; body: unknown }[] = [];
      const receiptCalls: { headers: Headers; rawBody: string }[] = [];
      let pollCount = 0;
      let runtimeDeps: { startTransport(): Promise<void>; stopTransport(): Promise<void> } | undefined;
      const runtime = {
        start: vi.fn(async () => { await runtimeDeps?.startTransport(); }),
        stop: vi.fn(async () => { await runtimeDeps?.stopTransport(); }),
        dispose: vi.fn(async () => undefined),
        processCommand: vi.fn(async () => ({ response: { status: "executed", commandId: "c-1", resultRef: "r" }, serializedResponse: '{"status":"executed","commandId":"c-1","resultRef":"r"}', replay: false })),
        auditTelemetry: undefined,
      };
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/device/challenge")) {
          challengeCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
          return jsonRes(200, { challengeId: CHALLENGE_ID, nonce: CHALLENGE_NONCE, expiresAt: Date.now() + 60_000 });
        }
        if (url.includes("/poll")) {
          pollCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          const envelopes = pollCount === 1 ? [{ envelopeVersion: 1 }] : [];
          return jsonRes(200, { envelopes, nextCursor: "1" });
        }
        receiptCalls.push({ headers: new Headers(init?.headers), rawBody: String(init?.body) });
        return jsonRes(200, { code: 0 });
      });
      const wiring = createDesktopCcodePlatformRuntimeWiring({
        account, storageDirectory: storageRoot, apiBaseUrl: "https://example.test/admin-api/",
        commandSignerPublicKeyPem: "key", homeDirectory: "home", workingDirectory: "work",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        minEmptyPollIntervalMs: 10,
        deviceIdentity: { get: async () => ({ deviceId: device.deviceId, signer: device.signer }) },
        createRuntime: (deps) => { runtimeDeps = deps as typeof runtimeDeps; return runtime as never; },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await wiring.dispose();
      expect(challengeCalls.length).toBeGreaterThanOrEqual(2); // poll 与 receipts 各领一次
      expect(challengeCalls.some((c) => c.body?.purpose === "receipts")).toBe(true);
      expect(receiptCalls.length).toBeGreaterThanOrEqual(1);
      expect(receiptCalls[0]!.headers.get("x-ccode-device-id")).toBe(DEVICE_ID);
      expect(receiptCalls[0]!.headers.get("x-ccode-challenge-id")).toBe(CHALLENGE_ID);
      expect(receiptCalls[0]!.headers.get("x-ccode-device-signature")).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      // receipts 签名口径 = 原始请求体字节（同一挑战下换 body 必拒——由冻结向量测试保证，此处验管线贯通）。
      expect(JSON.parse(receiptCalls[0]!.rawBody)).toMatchObject({ schemaVersion: 1 });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
