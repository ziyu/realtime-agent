import { defineConfig } from '@playwright/test';
import native from './playwright.native.config';

export default defineConfig({ ...native, testMatch: 'livekit.spec.ts', outputDir: 'test-results/playwright-livekit',
  webServer: { command: 'pnpm build && pnpm exec tsx tests/native-e2e/server.ts', env: { NATIVE_TEST_LIVEKIT: '1' },
    url: 'http://127.0.0.1:3104/__fixture', reuseExistingServer: false, timeout: 45000 },
});
