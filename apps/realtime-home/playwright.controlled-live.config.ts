import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Text-driven provider verification keeps the synthetic microphone silent to avoid stray VAD turns.
const fixture = resolve('.test-data/controlled-live-silence.wav');
mkdirSync(resolve('.test-data'), { recursive: true });
const wav = Buffer.alloc(44 + 24000 * 2 * 60);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
writeFileSync(fixture, wav);

export default defineConfig({
  testDir: './tests/voice-api', testMatch: 'controlled.spec.ts', outputDir: 'test-results/playwright-controlled-live',
  workers: 1, fullyParallel: false, timeout: 60000, retries: 0,
  use: { baseURL: 'http://127.0.0.1:3105', channel: 'chrome', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}%noloop`, '--mute-audio'] } },
  webServer: { command: 'pnpm run build && pnpm exec tsx scripts/controlled-live-server.ts',
    url: 'http://127.0.0.1:3105/__verification', reuseExistingServer: false, timeout: 45000 },
});
