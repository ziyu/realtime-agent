import { describe, expect, it } from 'vitest';
import type { VoiceConfig } from '@realtime-agent/config';
import { createVoiceModel } from '../server/voice/livekit';
import { voiceCatalog } from '../server/voice/profiles';

const config: VoiceConfig = {
  openaiKey: 'fixture-openai', googleKey: 'fixture-google', xaiKey: 'fixture-xai',
  livekit: { url: 'ws://127.0.0.1:7880', apiKey: 'fixture-room', apiSecret: 'fixture-secret' },
  models: { openai: 'gpt-realtime-2.1', duplex: 'gpt-live-1', google: 'gemini-3.8-live', xai: 'grok-voice-think-fast-2.0', backend: 'gpt-5.6-luna' },
};

describe('installed realtime provider integrations', () => {
  it('constructs all four real plugin classes with the selected model and audio capabilities without opening sessions', async () => {
    for (const profile of voiceCatalog(config).profiles.filter(profile => profile.id !== 'openai-webrtc')) {
      const model = await createVoiceModel(profile, config);
      expect(model.model).toBe(profile.model);
      expect(model.capabilities.userTranscription).toBe(true);
      expect(typeof model.session).toBe('function');
      await model.close();
    }
  });
});
