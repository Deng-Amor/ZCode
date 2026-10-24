/**
 * ccode-platform-runtime-wiring 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 * Main 的真实调用见 packages/desktop/src/main/index.ts（ccodePlatform 实例化 + will-quit dispose）。
 */
import { createDesktopCcodePlatformRuntimeWiring } from "./ccodePlatformRuntime.js";
import type { DesktopCcodeAccount } from "./contract.js";

export function exampleCcodePlatformRuntimeWiring(account: DesktopCcodeAccount): void {
  const wiring = createDesktopCcodePlatformRuntimeWiring({
    account,
    storageDirectory: "<userData>/ccode-platform",
    apiBaseUrl: "https://dp.sccsai.com/admin-api/",
    commandSignerPublicKeyPem: "-----BEGIN PUBLIC KEY-----",
    homeDirectory: "<os homedir>",
    workingDirectory: "<app cwd>",
  });
  // 登录后自动 start（内部订阅 onStateChanged）；登出自动 stop。应用退出时：
  void wiring.dispose();
}
