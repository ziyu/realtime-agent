import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadVoiceConfig } from '@realtime-agent/config';
import { voiceCatalog } from './server/voice/profiles';

const profile = voiceCatalog(loadVoiceConfig({ appDirectory: process.cwd() })).profiles.find(item => item.id === (process.env.VOICE_TEST_PROFILE || 'openai-webrtc'));
if (!profile) throw new Error('VOICE_TEST_PROFILE must name an available native voice profile.');
if (!profile.configured) throw new Error(`Native API test needs: ${profile.missing.join(', ')}. No model calls were started.`);
const wav = process.env.VOICE_TEST_AUDIO && resolve(process.env.VOICE_TEST_AUDIO);
if (!wav || !existsSync(wav) || !wav.toLowerCase().endsWith('.wav')) throw new Error('Set VOICE_TEST_AUDIO to a PCM WAV containing “去睡觉”, then “改去喝水” after a short pause. No model calls were started.');

export default defineConfig({
  testDir: './tests/voice-api', outputDir: 'test-results/playwright-voice-api',
  workers: 1, fullyParallel: false, timeout: 45000, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'chrome', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--mute-audio'] },
  },
  webServer: { command: 'pnpm dev', env: { AGENT_MODE: 'live', AGENT_DATA_DIR: `.live-test-data/voice-api-${process.pid}` },
    url: 'http://127.0.0.1:5174/api/health', reuseExistingServer: false, timeout: 40000 },
});
