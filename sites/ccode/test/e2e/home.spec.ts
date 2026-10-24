import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

for (const device of [
  { name: 'iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', touchMac: false },
  { name: 'Android', ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', touchMac: false },
  { name: 'iPad', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', touchMac: true },
]) {
  test(`${device.name} 显示手机版待开发，隐藏 Windows 下载操作`, async ({ browser }) => {
    const context = await browser.newContext({ userAgent: device.ua, viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      if (device.touchMac) await context.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
        Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
      });
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('.hero-actions')).toContainText('手机版待开发');
      await expect(page.locator('#download').getByRole('button', { name: '手机版待开发' })).toBeDisabled();
      await expect(page.locator('#download a[download]')).toBeHidden();
      await expect(page.getByRole('button', { name: '复制下载链接' })).toBeHidden();
      await expect(page.locator('.release-pill .desktop-download')).toBeHidden();
      await expect(page.locator('.release-pill .mobile-download')).toBeVisible();
      expect(await page.locator('.release-pill').innerText()).not.toContain('Windows');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/ccode-${device.name}-pending.png`, fullPage: true });
    } finally { await context.close(); }
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`${width}px：官网内容、下载信息和布局`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('可交付');
    await expect(page.locator('#download')).toContainText('Windows');
    await expect(page.locator('#download')).toContainText('3.16.2');
    await expect(page.locator('#download a[download]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/ccode-${width}-hero.png` });
    await page.screenshot({ path: `test-results/ccode-${width}.png`, fullPage: true });
  });
}

test('手机菜单、主题持久化、演示场景与 FAQ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: '打开导航菜单' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '整理项目' }).click();
  await expect(page.locator('[data-demo-prompt]')).toContainText('项目');
  await expect(page.locator('[data-demo-file-title]')).toHaveText('项目结构说明');
  await page.getByText('手机上也能使用吗？', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText('Windows 桌面');
  await page.screenshot({ path: 'test-results/ccode-mobile-dark.png', fullPage: true });
});

test('存储不可用、减少动画与禁用脚本时核心内容仍可访问', async ({ browser, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((element) => getComputedStyle(element).scrollBehavior)).toBe('auto');
  expect(errors).toEqual([]);
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const noScript = await context.newPage();
    await noScript.goto('/');
    await expect(noScript.locator('#download a[download]')).toBeVisible();
    await noScript.getByText('安装后就能直接使用模型吗？', { exact: true }).click();
    await expect(noScript.locator('details[open]')).toContainText('API');
  } finally { await context.close(); }
});

test('下载是真实 EXE 文件，复制失败仍可手动选取地址', async ({ page, request }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await page.goto('/');
  const download = page.locator('#download a[download]');
  const href = await download.getAttribute('href');
  expect(href).toMatch(/^\/downloads\/CCode-.*-win-x64\.exe$/);
  const response = await request.head(href!);
  expect(response.ok()).toBe(true);
  expect(Number(response.headers()['content-length'])).toBeGreaterThan(1_000_000);
  const downloadEvent = page.waitForEvent('download');
  await download.click();
  const downloaded = await downloadEvent;
  expect(await downloaded.failure()).toBeNull();
  expect(downloaded.suggestedFilename()).toBe('CCode-3.16.2-win-x64.exe');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream((await downloaded.path())!)) hash.update(chunk);
  const release = await (await request.get('/release.json')).json();
  expect(hash.digest('hex')).toBe(release.sha256);
  await page.getByRole('button', { name: '复制下载链接' }).click();
  await expect(page.getByLabel('下载地址')).toBeVisible();
  await expect(page.getByLabel('下载地址')).toHaveValue(new RegExp('CCode-3.16.2-win-x64.exe'));
});
