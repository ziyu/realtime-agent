import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:5174', channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1050 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm run dev', env: { AGENT_MODE: 'demo', AGENT_DATA_DIR: `.test-data/e2e-${process.pid}` }, url: 'http://127.0.0.1:5174/api/health',
    reuseExistingServer: false, timeout: 60000,
  },
});
