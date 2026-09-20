import { GrokRealtimeModel } from './grok-model';
import type { VoiceConfig } from '@realtime-agent/config';
import { LOCAL_VOICE_ROOM } from '@realtime-agent/config';
import type { VoiceProfile } from '../../shared/voice';
import type { VoiceBridge } from './bridge';
import type { VoiceBackend } from './gateway';
import { VoiceError } from './gateway';
import { startLiveKit } from './livekit';
import { createCloudflareRelay } from './cloudflare-relay';
import type { VoiceSocketConnector } from './cloudflare-relay';

/** All model traffic uses the documented Cloudflare account endpoint and one API token. */
export async function startCloudflareVoice(
  profile: VoiceProfile, bridge: VoiceBridge, instructions: string, config: VoiceConfig,
  signal: AbortSignal, connect?: VoiceSocketConnector,
): Promise<VoiceBackend> {
  const cf = config.cloudflare;
  if (!cf?.apiToken || !cf.accountId) throw new VoiceError(503, '请配置 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN。');
  const localDefaults = !config.livekit.url && !config.livekit.apiKey && !config.livekit.apiSecret;
  const room = localDefaults ? { ...LOCAL_VOICE_ROOM } : config.livekit;
  // Fail before opening any paid model connection when the local media server is absent.
  try {
    const health = await fetch(room.url.replace(/^ws/, 'http'), { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'error' });
    void health.body?.cancel().catch(() => undefined);
    if (!health.ok) throw new Error();
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new VoiceError(503, room.url === LOCAL_VOICE_ROOM.url ? '本机音频房间未启动。请从根目录运行 pnpm dev:cloudflare，它会自动启动房间。' : '无法连接已配置的 LiveKit 音频房间，请检查地址与服务状态。');
  }
  const relay = await createCloudflareRelay(cf, signal, message => bridge.fail(message), connect);
  let backend: VoiceBackend | undefined;
  try {
    // The xAI constructor forwards these inherited OpenAI options. A named object
    // avoids its 1.9.0 declaration's Omit<OptionalOptions> excess-property issue.
    const modelOptions = { baseURL: relay.baseUrl, apiKey: relay.apiKey, model: 'grok-voice-latest', voice: profile.voice };
    backend = await startLiveKit(profile, bridge, instructions, { ...config, livekit: room }, signal,
      async () => new GrokRealtimeModel(modelOptions));
    await relay.ready;
    signal.throwIfAborted();
    if (bridge.state.error) throw new VoiceError(502, bridge.state.error);
    return { ...backend, async close() { await relay.close(); await backend!.close(); } };
  } catch (error) {
    await relay.close(); await backend?.close().catch(() => undefined);
    if (bridge.state.error) throw new VoiceError(502, bridge.state.error);
    throw error;
  }
}
