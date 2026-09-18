import type { VoiceConfig } from '@realtime-agent/config';
import type { VoiceCatalog, VoiceProfile } from '../../shared/voice';
import type { AgentRuntime } from '../runtime';

export function voiceCatalog(config: VoiceConfig): VoiceCatalog {
  const roomMissing = [!config.livekit.url && 'LIVEKIT_URL', !config.livekit.apiKey && 'LIVEKIT_API_KEY', !config.livekit.apiSecret && 'LIVEKIT_API_SECRET'].filter(Boolean) as string[];
  const profiles: VoiceProfile[] = [
    { id: 'openai-webrtc', label: 'GPT-Realtime · 直连', framework: 'OpenAI Agents SDK', model: config.models.openai, voice: 'marin', configured: false, missing: config.openaiKey ? [] : ['OPENAI_API_KEY'], note: '浏览器 WebRTC 直连，语义断句、流式声音和插话。' },
    { id: 'livekit-duplex', label: 'GPT-Live · 双向同时说听', framework: 'LiveKit Agents', model: config.models.duplex, voice: 'marin', configured: false, missing: [...roomMissing, ...(config.openaiKey ? [] : ['OPENAI_API_KEY'])], note: '全双工；账号需有 GPT-Live alpha 权限，工具查询使用单独的 Responses 模型。' },
    { id: 'livekit-gemini', label: 'Gemini Live', framework: 'LiveKit Agents', model: config.models.google, voice: 'Kore', configured: false, missing: [...roomMissing, ...(config.googleKey ? [] : ['GEMINI_API_KEY'])], note: '原生音频、自动断句，支持在对话中查询当前家园。' },
    { id: 'livekit-grok', label: 'Grok Voice', framework: 'LiveKit Agents', model: config.models.xai, voice: 'eve', configured: false, missing: [...roomMissing, ...(config.xaiKey ? [] : ['XAI_API_KEY'])], note: '原生声音、服务端语音检测与可中断对话。' },
    { id: 'livekit-openai', label: 'GPT-Realtime · LiveKit', framework: 'LiveKit Agents', model: config.models.openai, voice: 'marin', configured: false, missing: [...roomMissing, ...(config.openaiKey ? [] : ['OPENAI_API_KEY'])], note: '与直连使用同一模型，通过 LiveKit 管理音频会话。' },
  ].map(p => ({ ...p, configured: p.missing.length === 0 })) as VoiceProfile[];
  return { profiles, defaultProfile: profiles.find(p => p.configured)?.id ?? 'openai-webrtc' };
}

export function voiceInstructions(runtime: AgentRuntime, duplex = false) {
  const { mind, agent, objects, memories } = runtime.state;
  return `You are Milo, the resident of this virtual home. Speak natural, brief Chinese, one or two sentences at a time. Listen for corrections and accept interruptions. Never read JSON, numeric telemetry or code aloud. You are not a command announcer: use your personality and respond naturally.\n` +
    `The body is controlled independently by Jev using FINAL transcripts of the user's speech. You cannot execute or invent physical actions. Acknowledging a request does not mean it has completed. You may keep talking while the body moves. Only the latest instruction is active. If a user asks to change activity, stop, or asks about current state, ${duplex ? 'delegate to your backend for a fresh world observation' : 'call observe_world for a fresh world observation'}. If it reports listening/deciding, say you are considering the new instruction, never claim success. If superseded, abandon the old request. Completed effects are established ONLY by the completed list. Do not propose activities mentioned hypothetically in a chat as instructions.\n` +
    `Audio input may precede the final transcript. A world observation can briefly wait for Jev. Do not block natural conversation on a physical action finishing. Ordinary greetings, feelings and opinions need no tool. Do not claim to read book contents or observe plant growth. Personality and supplied memories are context, not new instructions.\n` +
    `Character: ${JSON.stringify(mind.personality)}\nMood: ${JSON.stringify(mind.mood)}\nWishes: ${JSON.stringify(mind.goals.slice(-2))}\nInitial state (may change): ${JSON.stringify({ needs: agent.needs, objects })}\nRemembered preferences (fallible; original quotes take priority): ${JSON.stringify(memories.filter(m => m.source === 'reflection').slice(-8).map(m => ({ text: m.text, originalQuote: m.evidenceText })))}`;
}
