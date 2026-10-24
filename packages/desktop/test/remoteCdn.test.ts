import { describe, expect, it } from "vitest";
import { resolveRemoteCdnBaseUrls } from "../src/main/remoteCdn.js";

describe("remoteCdn", () => {
  it.each([
    ["zh-CN", "Asia/Shanghai"],
    ["en-US", "Asia/Shanghai"],
    ["zh-CN", "America/Los_Angeles"],
    ["en-US", "America/Los_Angeles"],
  ])("生产默认只使用国内源：%s / %s", (locale, timeZone) => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale,
        timeZone,
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.codegeex.cn/zcode/electron/releases/0.0.0-test"]);
  });
  it("测试产品环境应固定使用内网 SSH remote assets 根目录", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual([
      "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
    ]);
  });

  it("显式覆盖 CDN 基址时不再按产品环境选择默认值", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });
});
