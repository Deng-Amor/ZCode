import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfidentialControllerError, type PlatformSessionStore } from "./contract.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** OS key ownership stays in Desktop; this adapter never supplies a fallback key. */
export function createEncryptedPlatformSessionStore(options: {
  filePath: string;
  encryption: {
    isAvailable(): Promise<boolean>;
    encrypt(plaintext: string): Promise<Uint8Array>;
    decrypt(ciphertext: Uint8Array): Promise<string>;
  };
}): PlatformSessionStore {
  const requireEncryption = async () => {
    if (!(await options.encryption.isAvailable()))
      throw new ConfidentialControllerError("UNAVAILABLE");
  };
  return {
    async load() {
      const file = await open(options.filePath, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new ConfidentialControllerError("UNAVAILABLE");
      });
      if (!file) return undefined;
      let ciphertext: Buffer;
      try {
        const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (!bytesRead || bytesRead > MAX_CREDENTIAL_BYTES) return null;
        ciphertext = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      await requireEncryption();
      let plaintext: string;
      try {
        plaintext = await options.encryption.decrypt(ciphertext);
      } catch {
        // 系统钥匙服务可能暂时拒绝解密，不能据此认定密文损坏并删除登录。
        throw new ConfidentialControllerError("UNAVAILABLE");
      }
      try {
        if (Buffer.byteLength(plaintext, "utf8") > MAX_CREDENTIAL_BYTES) return null;
        return JSON.parse(plaintext) as unknown;
      } catch {
        // 只有成功解密后的非法结构才交给认证 owner 判无效并删除。
        return null;
      }
    },
    async save(session) {
      await requireEncryption();
      const ciphertext = await options.encryption.encrypt(JSON.stringify(session));
      if (!ciphertext.length || ciphertext.length > MAX_CREDENTIAL_BYTES)
        throw new ConfidentialControllerError("UNAVAILABLE");
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${options.filePath}.${randomUUID()}.tmp`;
      try {
        // 临时文件也只含系统密文；原子替换防止重启读到半份刷新凭据。
        await writeFile(temporary, ciphertext, { mode: 0o600, flag: "wx" });
        await rename(temporary, options.filePath);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async clear() {
      await rm(options.filePath, { force: true });
    },
  };
}
