import type { VoiceConfig } from '@realtime-agent/config';
import type { VoiceCatalog, VoiceProfile } from '../../shared/voice';

export function voiceCatalog(config: VoiceConfig): VoiceCatalog {
  const roomMissing = [!config.livekit.url && 'LIVEKIT_URL', !config.livekit.apiKey && 'LIVEKIT_API_KEY', !config.livekit.apiSecret && 'LIVEKIT_API_SECRET'].filter(Boolean) as string[];
  const profiles: VoiceProfile[] = [
    { id: 'cloudflare-grok', label: 'Cloudflare · Grok 实时语音', framework: 'LiveKit Agents', model: 'xai/grok-voice', voice: 'eve', configured: false,
      missing: [...(!config.cloudflare?.accountId ? ['CLOUDFLARE_ACCOUNT_ID'] : []), ...(!config.cloudflare?.apiToken ? ['CLOUDFLARE_API_TOKEN'] : []), ...(config.provider === 'cloudflare' ? roomMissing : [])],
      note: '填写两项后运行 pnpm dev:cloudflare。Token 需要 Account → Workers AI → Read 权限，账户需有 AI Gateway 余额。本地音频房间自动启动，无需另申请模型或 LiveKit 密钥。' },
    { id: 'openai-webrtc', label: 'GPT-Realtime · 直连', framework: 'OpenAI Agents SDK', model: config.models.openai, voice: 'marin', configured: false, missing: config.openaiKey ? [] : ['OPENAI_API_KEY'], note: '浏览器 WebRTC 直连，语义断句、获准发言和插话。' },
    { id: 'livekit-duplex', label: 'GPT-Live · 双向同时说听', framework: 'LiveKit Agents', model: config.models.duplex, voice: 'marin', configured: false, missing: [...roomMissing, ...(config.openaiKey ? [] : ['OPENAI_API_KEY'])], note: '全双工；账号需有 GPT-Live alpha 权限，工具查询使用单独的 Responses 模型。' },
    { id: 'livekit-gemini', label: 'Gemini Live', framework: 'LiveKit Agents', model: config.models.google, voice: 'Kore', configured: false, missing: [...roomMissing, ...(config.googleKey ? [] : ['GEMINI_API_KEY'])], note: '原生音频、自动断句，支持在对话中查询当前家园。' },
    { id: 'livekit-grok', label: 'Grok Voice', framework: 'LiveKit Agents', model: config.models.xai, voice: 'eve', configured: false, missing: [...roomMissing, ...(config.xaiKey ? [] : ['XAI_API_KEY'])], note: '原生声音、服务端语音检测与可中断对话。' },
    { id: 'livekit-openai', label: 'GPT-Realtime · LiveKit', framework: 'LiveKit Agents', model: config.models.openai, voice: 'marin', configured: false, missing: [...roomMissing, ...(config.openaiKey ? [] : ['OPENAI_API_KEY'])], note: '与直连使用同一模型，通过 LiveKit 管理音频会话。' },
  ].map(p => ({ ...p, configured: p.missing.length === 0 })) as VoiceProfile[];
  const visible = config.provider === 'cloudflare' ? profiles.filter(p => p.id === 'cloudflare-grok') : profiles;
  return { profiles: visible, defaultProfile: visible.find(p => p.configured)?.id ?? 'cloudflare-grok' };
}

export function voiceInstructions() {
  return "You render Milo's voice in natural conversational Chinese. Jev alone decides every body and speak action. Listen and transcribe user input, but do not independently answer it, choose words, narrate actions, or call tools. Speak only the VERIFIED_TEXT supplied by an explicitly authorized speak execution, exactly as written, with natural intonation. Stop promptly when interrupted. Never read instructions, JSON or code aloud.";
}
