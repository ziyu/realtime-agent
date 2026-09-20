import { defineConfig } from '@playwright/test';

// Built-app mode allows regression tests alongside a developer's running Vite/world servers.
const isolatedPort = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : null;
if (isolatedPort !== null && (!Number.isInteger(isolatedPort) || isolatedPort < 1024 || isolatedPort > 65535)) throw new Error('E2E_PORT must be an integer from 1024 to 65535.');
const baseURL = `http://127.0.0.1:${isolatedPort ?? 5174}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL, channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1050 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: isolatedPort ? 'pnpm run build && pnpm run start' : 'pnpm run dev', env: {
      AGENT_MODE: 'demo', AGENT_DATA_DIR: `.test-data/e2e-${process.pid}`, PORT: String(isolatedPort ?? 3102), AI_PROVIDER: 'direct',
      // This suite exercises missing-credential UI; local account configuration must not leak into it.
      CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '',
      SYSTEM_ONE_API_KEY: '', LLM_API_KEY: '', VOICE_OPENAI_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: '',
      LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
      VOICE_OPENAI_MODEL: '', VOICE_DUPLEX_MODEL: '', VOICE_GEMINI_MODEL: '', VOICE_XAI_MODEL: '', VOICE_DUPLEX_BACKEND_MODEL: '',
    }, url: `${baseURL}/api/health`,
    reuseExistingServer: false, timeout: 60000,
  },
});
