import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeviceProofSigner, type DeviceProofSigner } from "@zcode/services/platform-command-channel";

/**
 * 桌面设备身份存储（D1/D3，2026-10-27）：安装密钥（Ed25519）生成一次、
 * safeStorage 端口加密落盘（模式对齐 ccode-account/session.enc）；deviceId
 * 与公钥为非敏感元数据明文存 device.json。重装=新密钥+新 deviceId（D3）；
 * 解密失败视为暂时性 UNAVAILABLE 不毁数据（与登录存储同纪律）。
 *
 * 文件布局（directory，缺省 userData/ccode-platform/device/）：
 *   install-key.enc  加密私钥 PEM（加密不可用时零写盘）
 *   device.json      { version:1, publicKeySpkiB64, deviceId? }
 */

export interface DeviceIdentityEncryption {
  isAvailable(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

export interface DesktopDeviceIdentity {
  readonly deviceId?: string;
  readonly signer: DeviceProofSigner;
  readonly publicKeySpkiDerBase64: string;
}

interface DeviceMetadata {
  version: 1;
  publicKeySpkiB64: string;
  deviceId?: string;
}

export class DeviceIdentityUnavailableError extends Error {
  constructor() {
    super("DEVICE_IDENTITY_UNAVAILABLE");
    this.name = "DeviceIdentityUnavailableError";
  }
}

export function createDesktopDeviceIdentityStore(options: { directory: string; encryption: DeviceIdentityEncryption }) {
  const keyPath = join(options.directory, "install-key.enc");
  const metaPath = join(options.directory, "device.json");

  async function readMetadata(): Promise<DeviceMetadata | undefined> {
    try {
      const raw = JSON.parse(await readFile(metaPath, "utf8")) as Partial<DeviceMetadata>;
      if (raw.version !== 1 || typeof raw.publicKeySpkiB64 !== "string" || raw.publicKeySpkiB64.length === 0) return undefined;
      if (raw.deviceId !== undefined && (typeof raw.deviceId !== "string" || raw.deviceId.length === 0)) return undefined;
      return { version: 1, publicKeySpkiB64: raw.publicKeySpkiB64, deviceId: raw.deviceId };
    } catch {
      return undefined;
    }
  }

  async function writeMetadata(next: DeviceMetadata): Promise<void> {
    await mkdir(options.directory, { recursive: true });
    const temporary = `${metaPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, metaPath);
  }

  return {
    /** 读取或生成本机安装密钥；加密不可用或解密暂时失败时抛 UNAVAILABLE（不毁数据、不重生成）。 */
    async loadOrCreate(): Promise<DesktopDeviceIdentity> {
      const metadata = await readMetadata();
      const ciphertext = await readFile(keyPath).catch(() => undefined);
      if (!metadata || !ciphertext) {
        // 无既有身份：生成新密钥并加密落盘（加密不可用 → 零写盘直接失败，下次再试）。
        if (!(await options.encryption.isAvailable())) throw new DeviceIdentityUnavailableError();
        const pair = generateKeyPairSync("ed25519");
        const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const spkiB64 = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
        const encrypted = await options.encryption.encrypt(privateKeyPem);
        if (!encrypted.length || encrypted.length > 64 * 1024) throw new DeviceIdentityUnavailableError();
        await mkdir(options.directory, { recursive: true });
        const temporary = `${keyPath}.${randomUUID().slice(0, 8)}.tmp`;
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporary, keyPath);
        await writeMetadata({ version: 1, publicKeySpkiB64: spkiB64 });
        return { signer: createDeviceProofSigner(privateKeyPem), publicKeySpkiDerBase64: spkiB64 };
      }
      // 既有身份：解密私钥（失败=暂时性，不重生成防双设备）。
      if (!(await options.encryption.isAvailable())) throw new DeviceIdentityUnavailableError();
      let privateKeyPem: string;
      try {
        privateKeyPem = await options.encryption.decrypt(new Uint8Array(ciphertext));
      } catch {
        throw new DeviceIdentityUnavailableError();
      }
      const signer = createDeviceProofSigner(privateKeyPem);
      // 防篡改复核：私钥派生公钥指纹必须与元数据公钥一致；不一致=身份损坏，不自动重置。
      const derivedSpkiB64 = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" }).toString("base64");
      if (derivedSpkiB64 !== metadata.publicKeySpkiB64) {
        throw new DeviceIdentityUnavailableError();
      }
      return { signer, publicKeySpkiDerBase64: metadata.publicKeySpkiB64, ...(metadata.deviceId ? { deviceId: metadata.deviceId } : {}) };
    },

    /** 注册成功后落 deviceId（幂等：同值直写）。 */
    async setDeviceId(deviceId: string): Promise<void> {
      const metadata = await readMetadata() ?? { version: 1 as const, publicKeySpkiB64: "" };
      await writeMetadata({ ...metadata, deviceId });
    },

    /** 本地吊销/重置（当前无 UI 入口，留作 D3 运维通道）。 */
    async reset(): Promise<void> {
      await rm(keyPath, { force: true });
      await rm(metaPath, { force: true });
    },
  };
}
