import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/native-e2e', testMatch: 'audio.spec.ts', outputDir: 'test-results/playwright-native',
  workers: 1, fullyParallel: false, timeout: 35000, expect: { timeout: 10000 }, retries: 0,
  use: { baseURL: 'http://127.0.0.1:3104', channel: 'chrome', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] },
  },
  webServer: { command: 'pnpm build && pnpm exec tsx tests/native-e2e/server.ts', url: 'http://127.0.0.1:3104/__fixture', reuseExistingServer: false, timeout: 45000 },
});
