import { defineConfig } from '@playwright/test';

// Explicit paid integration test: never part of the ordinary demo/fixture suites.
export default defineConfig({
  testDir: './tests/live',
  outputDir: 'test-results/playwright-live',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 12000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    trace: 'off', video: 'off', screenshot: 'off',
  },
  webServer: {
    command: 'pnpm run dev',
    env: { AGENT_MODE: 'live', AGENT_DATA_DIR: `.live-test-data/run-${process.pid}` },
    url: 'http://127.0.0.1:5174/api/health',
    reuseExistingServer: false,
    timeout: 40000,
  },
});
