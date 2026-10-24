// 独立 renderer fixture；不附着用户浏览器、开发服务或真实业务运行。
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const filename = fileURLToPath(import.meta.url);
const repo = resolve(dirname(filename), "../../../../../../..");
const desktop = resolve(repo, "packages/desktop");
const fixture = resolve(repo, "packages/ui/test/fixtures/workflow-recovery.fixture.tsx");
const desktopRequire = createRequire(resolve(desktop, "package.json"));
const serverMode = process.argv.includes("--workflow-recovery-server");
const deadline = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

async function runServer() {
  let server;
  const configTempDirectory = resolve(desktop, "node_modules/.vite-temp");
  const configTempBefore = await readdir(configTempDirectory).catch(() => []);
  try {
    assert.equal(resolve(process.cwd()), desktop, "Vite loadEnv cwd must be desktop");
    const { createServer, normalizePath } = await import(
      pathToFileURL(desktopRequire.resolve("vite")).href
    );
    const fixtureImport = `/@fs/${normalizePath(fixture)}`;
    server = await createServer({
      configFile: resolve(desktop, "vite.config.ts"),
      root: resolve(desktop, "src/renderer"),
      cacheDir: resolve(process.env.E2E_RECOVERY_PRIVATE_ROOT, "vite-cache"),
      // 首次浏览前等待真实依赖扫描/优化提交，避免冷缓存中途换 hash 造成 504。
      optimizeDeps: { entries: [normalizePath(fixture)], holdUntilCrawlEnd: false },
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, fs: { allow: [repo] } },
      plugins: [
        {
          name: "workflow-recovery-fixture-html",
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url?.split("?")[0] !== "/__workflow_recovery") return next();
              void vite
                .transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="${fixtureImport}"></script></body></html>`,
                )
                .then((html) => {
                  response.setHeader("Content-Type", "text/html");
                  response.end(html);
                })
                .catch((error) => {
                  response.statusCode = 500;
                  response.end(String(error));
                });
            });
          },
        },
      ],
    });
    // Vite 8 的 server.listen 把 0 当作默认端口；其自有 HTTP listener 保留内核随机端口语义。
    const listening = once(server.httpServer, "listening");
    server.httpServer.listen({ host: "127.0.0.1", port: 0 });
    await deadline(listening, 45_000, "Vite listen");
    const optimizer = server.environments.client.depsOptimizer;
    await deadline(
      (async () => {
        await optimizer?.scanProcessing;
        await Promise.all(
          Object.values(optimizer?.metadata.discovered ?? {}).map((dep) => dep.processing),
        );
      })(),
      45_000,
      "fixture dependency optimization",
    );
    const address = server.httpServer.address();
    assert.equal(typeof address, "object");
    const configTempAfterLoad = (await readdir(configTempDirectory).catch(() => [])).filter(
      (name) => !configTempBefore.includes(name),
    );
    process.send({
      kind: "ready",
      origin: `http://127.0.0.1:${address.port}`,
      pid: process.pid,
      cwd: process.cwd(),
      envDir: resolve(process.cwd(), "../.."),
      cacheDir: server.config.cacheDir,
      root: server.config.root,
      optimizedDependencies: Object.keys(optimizer?.metadata.optimized ?? {}),
      configTempDirectory,
      configTempAfterLoad,
    });
    await new Promise((done) => {
      process.once("disconnect", done);
      process.on("message", (message) => {
        if (message?.kind === "close") done();
      });
    });
  } catch (error) {
    process.exitCode = 1;
    if (process.connected) process.send({ kind: "error", message: String(error) });
  } finally {
    try {
      if (server) await deadline(server.close(), 10_000, "Vite close");
      const configTempAdded = (await readdir(configTempDirectory).catch(() => [])).filter(
        (name) => !configTempBefore.includes(name),
      );
      if (process.connected)
        process.send({ kind: "cleanup", configTempDirectory, configTempAdded });
    } finally {
      if (process.connected) process.disconnect();
    }
  }
}

async function removeOwned(privateRoot, path) {
  const child = relative(privateRoot, path);
  assert.ok(
    child && !child.startsWith("..") && !isAbsolute(child),
    "cleanup must stay inside private root",
  );
  await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}

async function assertLayout(page, content, anchor) {
  await deadline(
    page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    }),
    5_000,
    "renderer finite animations",
  );
  const boundaries = await page.locator('[data-testid^="recovery-"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const css = getComputedStyle(node);
      return {
        id: node.dataset.testid,
        minHeight: css.minHeight,
        x: css.overflowX,
        y: css.overflowY,
        top: node.scrollTop,
        left: node.scrollLeft,
      };
    }),
  );
  for (const boundary of boundaries) {
    assert.equal(boundary.minHeight, "0px", boundary.id);
    assert.equal(boundary.x, "hidden", boundary.id);
    assert.equal(boundary.y, "hidden", boundary.id);
    assert.equal(boundary.top, 0, boundary.id);
    assert.equal(boundary.left, 0, boundary.id);
  }
  const overflow = await page.evaluate(() =>
    [document.documentElement, document.body].map((node) => ({
      width: node.scrollWidth,
      height: node.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
  );
  for (const box of overflow) {
    assert.ok(
      box.width <= box.viewportWidth && box.height <= box.viewportHeight,
      JSON.stringify(box),
    );
    assert.equal(box.top, 0);
    assert.equal(box.left, 0);
  }
  assert.equal(await content.isVisible(), true);
  const before = await anchor.boundingBox();
  const scroll = await content.evaluate((node) => {
    const css = getComputedStyle(node);
    node.scrollTop = node.scrollHeight;
    return {
      overflow: css.overflowY,
      height: node.clientHeight,
      total: node.scrollHeight,
      top: node.scrollTop,
    };
  });
  assert.equal(scroll.overflow, "auto");
  assert.ok(scroll.total > scroll.height && scroll.top > 0, JSON.stringify(scroll));
  assert.deepEqual(
    await anchor.boundingBox(),
    before,
    "header/action must remain stable while content scrolls",
  );
  await content.evaluate((node) => {
    node.scrollTop = 0;
  });
  return { boundaries, overflow, scroll };
}

if (serverMode) {
  await runServer();
} else {
  test(
    "E2E1-P1 RecoveryExhausted/RecoveryUncertain renderer fixture",
    { timeout: 300_000 },
    async (t) => {
      const started = Date.now();
      const privateRoot = await mkdtemp(resolve(tmpdir(), "zcode-workflow-recovery-renderer-"));
      const artifactDir = resolve(privateRoot, "artifacts");
      await mkdir(artifactDir);
      const manifest = {
        evidence:
          "renderer fixture only; synthetic props; no Engine/IPC/provider/controller authorization",
        repo,
        privateRoot,
        artifactDir,
        startedAt: new Date().toISOString(),
        cases: [],
        errors: [],
        cleanup: {},
        sourceSHA: {},
      };
      let child, context, origin, exited, browserPID;
      const logs = [];
      try {
        for (const path of [
          filename,
          fixture,
          resolve(desktop, "vite.config.ts"),
          resolve(repo, "packages/ui/src/ToolCallBlocks/renderers/get-workflow-run.tsx"),
          resolve(repo, "packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx"),
          resolve(repo, "packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx"),
          resolve(repo, "packages/ui/src/i18n/locales/en-US.ts"),
          resolve(repo, "packages/ui/src/i18n/locales/zh-CN.ts"),
        ]) {
          manifest.sourceSHA[relative(repo, path)] = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
        }
        child = fork(filename, ["--workflow-recovery-server"], {
          cwd: desktop,
          env: { ...process.env, E2E_RECOVERY_PRIVATE_ROOT: privateRoot },
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        child.on("message", (message) => {
          if (message.kind === "cleanup") manifest.serverCleanup = message;
        });
        exited = new Promise((done) => child.once("exit", done));
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (data) => {
            if (logs.length < 500) logs.push(data.toString());
          });
        const ready = await deadline(
          new Promise((accept, reject) => {
            child.on("message", (message) => {
              if (message.kind === "ready") accept(message);
              if (message.kind === "error") reject(new Error(message.message));
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              reject(new Error(`Vite child exited before ready: ${code}`)),
            );
          }),
          60_000,
          "Vite startup",
        );
        manifest.server = ready;
        origin = ready.origin;
        assert.equal(ready.envDir, repo);
        assert.equal(resolve(ready.cacheDir), resolve(privateRoot, "vite-cache"));
        const { chromium } = desktopRequire("playwright-core");
        const executablePath =
          process.env.E2E_RECOVERY_BROWSER_PATH ??
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
        context = await chromium.launchPersistentContext(resolve(privateRoot, "browser-profile"), {
          executablePath,
          headless: true,
          timeout: 30_000,
          viewport: { width: 1200, height: 800 },
        });
        manifest.browser = {
          executablePath,
          version: context.browser().version(),
          profile: resolve(privateRoot, "browser-profile"),
        };
        const cdp = await context.browser().newBrowserCDPSession();
        try {
          const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
          browserPID = processInfo.find((entry) => entry.type === "browser")?.id;
          assert.ok(Number.isInteger(browserPID) && browserPID > 0, "owned browser PID");
          manifest.browser.pid = browserPID;
        } finally {
          await cdp.detach();
        }
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) =>
          manifest.errors.push({ type: "pageerror", message: String(error) }),
        );
        page.on("console", (message) => {
          if (message.type() === "error")
            manifest.errors.push({ type: "console", message: message.text() });
        });
        page.on("requestfailed", (request) =>
          manifest.errors.push({
            type: "requestfailed",
            url: request.url(),
            failure: request.failure(),
          }),
        );
        page.on("response", (response) => {
          if (response.status() >= 400)
            manifest.errors.push({ type: "http", url: response.url(), status: response.status() });
        });
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (new URL(url).origin === origin || url.startsWith("data:")) return route.continue();
          manifest.errors.push({ type: "external-request", url });
          return route.abort("blockedbyclient");
        });
        for (const width of [1200, 390])
          for (const locale of ["en-US", "zh-CN"])
            for (const theme of ["light", "dark"]) {
              await page.setViewportSize({ width, height: 800 });
              for (const sample of ["wf4", "wf5"])
                for (const surface of ["query", "detail"]) {
                  const label = `${sample}-${surface}-${width}-${locale}-${theme}`;
                  assert.ok(
                    Date.now() - started < 150_000,
                    "renderer matrix deadline before next navigation",
                  );
                  const query = new URLSearchParams({ sample, surface, locale, theme });
                  await page.goto(`${origin}/__workflow_recovery?${query}`, {
                    waitUntil: "networkidle",
                    timeout: 60_000,
                  });
                  await page.getByTestId("fixture-heading").waitFor();
                  let content, anchor;
                  if (surface === "query") {
                    await page
                      .locator(
                        '[data-testid="recovery-card"] [role="button"][aria-expanded="false"]',
                      )
                      .first()
                      .click();
                    content = page.getByTestId("workflow-status-body").locator("p").first();
                    const text = await content.innerText();
                    assert.match(
                      text,
                      sample === "wf4"
                        ? /RecoveryExhausted: E2E_WF4_EXHAUSTED/
                        : /RecoveryUncertain: E2E_WF5_UNKNOWN/,
                    );
                    assert.doesNotMatch(text, /Query denied/);
                    anchor = page
                      .locator(
                        '[data-testid="recovery-card"] [role="button"][aria-expanded="true"]',
                      )
                      .first();
                  } else {
                    content = page.getByTestId("workflow-run-error-message");
                    assert.match(
                      await content.innerText(),
                      sample === "wf4" ? /E2E_WF4_EXHAUSTED/ : /外部结果未知，需核实，拒绝重复效果/,
                    );
                    assert.equal(await page.getByTestId("workflow-run-resume").count(), 0);
                    anchor = page.getByTestId("workflow-run-cancel");
                    assert.equal(await anchor.isDisabled(), true);
                    if (sample === "wf4") {
                      const pills = page.getByTestId("workflow-agent-pill");
                      assert.equal(await pills.count(), 2);
                      assert.equal(
                        await pills.filter({ hasText: "A" }).getAttribute("data-agent-status"),
                        "failed",
                      );
                      assert.equal(
                        await pills.filter({ hasText: "B" }).getAttribute("data-agent-status"),
                        "done",
                      );
                    }
                  }
                  const layout = await assertLayout(page, content, anchor);
                  await page.screenshot({ path: resolve(artifactDir, `${label}.png`) });
                  manifest.cases.push({
                    label,
                    width,
                    height: 800,
                    locale,
                    theme,
                    sample,
                    surface,
                    layout,
                    status: "passed",
                  });
                  assert.deepEqual(manifest.errors, []);
                }
              const query = new URLSearchParams({
                sample: "wf4",
                surface: "result",
                locale,
                theme,
              });
              assert.ok(
                Date.now() - started < 150_000,
                "renderer result deadline before next navigation",
              );
              await page.goto(`${origin}/__workflow_recovery?${query}`, {
                waitUntil: "networkidle",
              });
              const content = page.getByTestId("workflow-run-result").locator("pre");
              assert.match(await content.innerText(), /E2E_WF4_B_RESULT/);
              const layout = await assertLayout(
                page,
                content,
                page.getByTestId("workflow-run-cancel"),
              );
              const label = `wf4-result-${width}-${locale}-${theme}`;
              await page.screenshot({ path: resolve(artifactDir, `${label}.png`) });
              manifest.cases.push({
                label,
                width,
                height: 800,
                locale,
                theme,
                surface: "independent-completed-result-preview",
                layout,
                status: "passed",
              });
            }
        assert.deepEqual(manifest.errors, []);
        manifest.status = "passed";
      } catch (error) {
        manifest.status = "failed";
        manifest.failure = String(error);
        if (context?.pages()[0])
          await context
            .pages()[0]
            .screenshot({ path: resolve(artifactDir, "failure.png") })
            .catch(() => {});
        throw error;
      } finally {
        const cleanupErrors = [];
        if (context)
          try {
            await deadline(context.close(), 15_000, "browser close");
            manifest.cleanup.browserClosed = true;
          } catch (error) {
            cleanupErrors.push(String(error));
            // PID 来自本 runner 自有浏览器的 CDP，绝不按进程名终止用户浏览器。
            if (browserPID)
              try {
                process.kill(browserPID);
                manifest.cleanup.browserKilled = true;
              } catch (killError) {
                if (killError.code !== "ESRCH") cleanupErrors.push(String(killError));
              }
          }
        if (browserPID) {
          for (let attempt = 0; attempt < 50; attempt++) {
            try {
              process.kill(browserPID, 0);
            } catch (error) {
              if (error.code === "ESRCH") {
                manifest.cleanup.browserExited = true;
                break;
              }
              cleanupErrors.push(String(error));
              break;
            }
            await delay(100);
          }
          if (!manifest.cleanup.browserExited)
            cleanupErrors.push("owned browser PID remains after close");
        }
        if (child) {
          if (child.connected) child.send({ kind: "close" }, () => {});
          try {
            await deadline(exited, 15_000, "Vite child exit");
          } catch {
            cleanupErrors.push("Vite graceful close deadline exceeded");
            child.kill();
            try {
              await deadline(exited, 5_000, "Vite killed child exit");
            } catch (error) {
              cleanupErrors.push(String(error));
            }
          }
          manifest.cleanup.serverExitCode = child.exitCode;
          manifest.cleanup.serverSignal = child.signalCode;
          manifest.cleanup.serverExited = child.exitCode !== null || child.signalCode !== null;
          if (child.exitCode !== 0 || child.signalCode !== null)
            cleanupErrors.push("Vite child did not exit cleanly");
          if (origin && !manifest.serverCleanup)
            cleanupErrors.push("Vite child cleanup evidence missing");
          if (manifest.serverCleanup?.configTempAdded.length)
            cleanupErrors.push("new Vite bundled config temp files remain");
        }
        if (origin)
          try {
            await fetch(origin, { signal: AbortSignal.timeout(2_000) });
            cleanupErrors.push("owned server still accepts HTTP after close");
          } catch {
            manifest.cleanup.portClosed = true;
          }
        for (const name of ["browser-profile", "vite-cache"])
          try {
            await removeOwned(privateRoot, resolve(privateRoot, name));
            manifest.cleanup[`${name}Removed`] = true;
          } catch (error) {
            cleanupErrors.push(String(error));
          }
        manifest.cleanup.errors = cleanupErrors;
        manifest.finishedAt = new Date().toISOString();
        if (cleanupErrors.length) manifest.status = "failed";
        await writeFile(resolve(artifactDir, "server.log"), logs.join(""), "utf8");
        await writeFile(
          resolve(artifactDir, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        t.diagnostic(`Renderer fixture artifacts: ${artifactDir}`);
        assert.deepEqual(cleanupErrors, [], "owned resources must close");
      }
    },
  );
}
