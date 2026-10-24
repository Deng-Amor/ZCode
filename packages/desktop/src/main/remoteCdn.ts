import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;

const DOMESTIC_REMOTE_CDN_RELEASE_ROOT =
  "https://cdn.codegeex.cn/zcode/electron/releases";
const TEST_REMOTE_CDN_RELEASE_ROOT =
  "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

export function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }

  const version = options.version ?? ZCODE_VERSION;

  if (options.env === "test") {
    return [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
  }

  const configuredReleaseRoots =
    typeof __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __ZCODE_REMOTE_CDN_RELEASE_ROOTS__;
  if (configuredReleaseRoots.length > 0) {
    // Bugfix：remote runtime 的 manifest/components 下载根不能继续写死旧 CDN。
    // 构建期按 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入有序列表，切换时只改 CI 变量。
    return configuredReleaseRoots.map(
      (releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`,
    );
  }

  // CCode 面向国内用户，不因语言或时区切换到海外 CDN，也不设置海外回退源。
  return [`${DOMESTIC_REMOTE_CDN_RELEASE_ROOT}/${version}`];
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
