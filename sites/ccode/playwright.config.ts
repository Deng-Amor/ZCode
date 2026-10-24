import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4321', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
