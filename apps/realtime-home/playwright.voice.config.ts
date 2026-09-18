import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import base from './playwright.live.config';

// Optional native speech-service probe. This uses real browser recognition, not JS fixtures.
const audio = resolve(process.env.VOICE_TEST_AUDIO ?? '.live-test-data/voice-probe/commands.wav');
if (!existsSync(audio)) throw new Error('Provide a 16-bit PCM WAV via VOICE_TEST_AUDIO before running the native voice probe.');

export default defineConfig({
  ...base,
  testDir: './tests/voice-live',
  outputDir: 'test-results/playwright-voice',
  use: {
    ...base.use,
    headless: process.env.VOICE_TEST_HEADED !== '1',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audio}`] },
  },
});
