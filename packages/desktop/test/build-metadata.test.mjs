import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { collectBuildMetadata } from "../scripts/build-metadata.mjs";

test("CCode 发布版本与上游运行时兼容版本独立", async () => {
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const metadata = collectBuildMetadata();
  assert.equal(metadata.productVersion, root.ccodeRelease.version);
  assert.equal(metadata.productChannel, "preview");
  assert.equal(metadata.appVersion, root.version);
  assert.notEqual(metadata.productVersion, metadata.appVersion);
});
