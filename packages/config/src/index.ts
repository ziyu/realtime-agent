import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

type Environment = Record<string, string | undefined>;

export interface CloudflareConfig { accountId: string; apiToken: string }
export type ModelProvider = 'direct' | 'cloudflare';
export const LOCAL_VOICE_ROOM = { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' } as const;

function environmentReader(options: { appDirectory: string; environment?: Environment }) {
  const layers = [options.environment ?? process.env, ...runtimeConfigFiles(options.appDirectory).map(readEnvironment)];
  return (...names: string[]): string | undefined => {
    for (const layer of layers) for (const name of names) if (layer[name] !== undefined) return layer[name]!.trim();
    return undefined;
  };
}

function cloudflareSettings(pick: ReturnType<typeof environmentReader>): CloudflareConfig {
  const accountId = pick('CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID') ?? '';
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID.');
  // CLOUDFLARE_API_KEY is a compatibility alias for an API TOKEN, not the Global API Key.
  return { accountId, apiToken: pick('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY') ?? '' };
}

function modelProvider(pick: ReturnType<typeof environmentReader>, cloudflare: CloudflareConfig): ModelProvider {
  const selected = pick('AI_PROVIDER') || (cloudflare.apiToken || cloudflare.accountId ? 'cloudflare' : 'direct');
  if (selected !== 'direct' && selected !== 'cloudflare') throw new Error('AI_PROVIDER must be cloudflare or direct.');
  return selected;
}

export function cloudflareAiBase(accountId: string): string {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('A valid CLOUDFLARE_ACCOUNT_ID is required.');
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
}

export function isCloudflareAiUrl(value: string): boolean {
  const url = new URL(apiBaseUrl(value));
  return url.hostname === 'api.cloudflare.com' && /^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\//i.test(url.pathname);
}

/** Accept raw model output and Cloudflare's REST envelope; errors never carry provider text. */
export function cloudflareResult(raw: unknown): unknown {
  let result = raw;
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (value.success === false || value.error || Array.isArray(value.errors) && value.errors.length) {
      throw new Error('Cloudflare 模型请求失败，请检查 API Token 权限、账户余额与模型访问权限。');
    }
    if (value.success === true && Object.hasOwn(value, 'result')) result = value.result;
  }
  // The unified /ai/run REST API wraps the model result again as
  // { state: 'Completed', result: <model output>, gatewayMetadata: ... }.
  // Some Cloudflare-compatible endpoints return the model output directly, so
  // only unwrap this documented runner shape when the state marker is present.
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    if (typeof value.state === 'string') {
      if (value.state !== 'Completed' || !Object.hasOwn(value, 'result')) {
        throw new Error('Cloudflare 模型请求失败，请检查 API Token 权限、账户余额与模型访问权限。');
      }
      return value.result;
    }
  }
  return result;
}

function workspaceRoot(appDirectory: string): string {
  let current = resolve(appDirectory);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot locate pnpm-workspace.yaml for this application.');
    current = parent;
  }
}

/** The same ordered paths used by the loader; safe to display without reading credential values. */
export function runtimeConfigFiles(appDirectory: string): string[] {
  const app = resolve(appDirectory);
  return [join(app, '.env'), join(workspaceRoot(app), '.env')];
}

function readEnvironment(file: string): Environment {
  if (!existsSync(file)) return {};
  try { return parseEnv(readFileSync(file, 'utf8')); }
  catch { throw new Error('An environment file could not be loaded. Check its permissions and syntax.'); }
}

/** Validate without including raw configuration or credentials in an error. */
export function apiBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('Model base URL must be an absolute HTTPS URL or loopback HTTP URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Model base URL must use HTTPS or loopback HTTP and cannot contain credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function chatCompletionEndpoint(baseUrl: string): string {
  const base = apiBaseUrl(baseUrl);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** DeepSeek uses max_tokens and defaults to extended reasoning. Request a bounded JSON reply for the interactive loop. */
export function chatCompletionOptions(baseUrl: string): Record<string, unknown> {
  if (isCloudflareAiUrl(baseUrl)) return { max_tokens: 1400 };
  if (new URL(apiBaseUrl(baseUrl)).hostname === 'api.deepseek.com') {
    return { max_tokens: 1400, thinking: { type: 'disabled' } };
  }
  return { max_completion_tokens: 1400 };
}

export interface RuntimeConfig {
  provider: ModelProvider;
  mode: 'demo' | 'live';
  port: number;
  dataDirectory: string;
  systemOne: { apiKey: string; model: string; baseUrl: string };
  llm: { apiKey: string; model: string; baseUrl: string };
}

export interface VoiceConfig {
  provider?: ModelProvider;
  cloudflare?: CloudflareConfig;
  openaiKey: string;
  googleKey: string;
  xaiKey: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
  models: { openai: string; duplex: string; google: string; xai: string; backend: string };
}

/** Cloudflare mode shares one account token across voice, Jev and the text model. */
export function loadVoiceConfig(options: { appDirectory: string; environment?: Environment }): VoiceConfig {
  const pick = environmentReader(options);
  const cloudflare = cloudflareSettings(pick), provider = modelProvider(pick, cloudflare);
  const roomConfigured = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].some(key => pick(key) !== undefined);
  const room = provider === 'cloudflare' && !roomConfigured ? { ...LOCAL_VOICE_ROOM }
    : { url: pick('LIVEKIT_URL') ?? '', apiKey: pick('LIVEKIT_API_KEY') ?? '', apiSecret: pick('LIVEKIT_API_SECRET') ?? '' };
  const { url } = room;
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('LIVEKIT_URL must be a WebSocket URL.'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !(parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) {
      throw new Error('LIVEKIT_URL must use WSS, or WS on loopback, without embedded credentials.');
    }
  }
  return {
    provider, cloudflare,
    openaiKey: provider === 'cloudflare' ? '' : pick('VOICE_OPENAI_API_KEY', 'OPENAI_API_KEY') ?? '',
    googleKey: provider === 'cloudflare' ? '' : pick('GEMINI_API_KEY', 'GOOGLE_API_KEY') ?? '',
    xaiKey: provider === 'cloudflare' ? '' : pick('XAI_API_KEY') ?? '',
    livekit: room,
    models: {
      openai: pick('VOICE_OPENAI_MODEL') || 'gpt-realtime-2.1',
      duplex: pick('VOICE_DUPLEX_MODEL') || 'gpt-live-1',
      google: pick('VOICE_GEMINI_MODEL') || 'gemini-3.8-live',
      xai: pick('VOICE_XAI_MODEL') || 'grok-voice-think-fast-2.0',
      backend: pick('VOICE_DUPLEX_BACKEND_MODEL') || 'gpt-5.6-luna',
    },
  };
}

/** Server-only. Process > app .env > workspace .env, including aliases across layers. Never mutates process.env. */
export function loadRuntimeConfig(options: { appDirectory: string; defaultPort: number; environment?: Environment }): RuntimeConfig {
  const appDirectory = resolve(options.appDirectory);
  const pick = environmentReader(options);
  const cloudflare = cloudflareSettings(pick), provider = modelProvider(pick, cloudflare);
  const cfBase = provider === 'cloudflare' && cloudflare.accountId ? cloudflareAiBase(cloudflare.accountId) : '';
  const systemOne = provider === 'cloudflare' ? {
    apiKey: cloudflare.apiToken, model: 'typesafe/jev', baseUrl: cfBase ? `${cfBase}/run` : '',
  } : {
    apiKey: pick('SYSTEM_ONE_API_KEY', 'TYPESAFE_API_KEY') ?? '',
    model: pick('SYSTEM_ONE_MODEL', 'TYPESAFE_MODEL', 'JEV_MODEL') || 'jev-latest',
    baseUrl: apiBaseUrl(pick('SYSTEM_ONE_BASE_URL', 'TYPESAFE_BASE_URL') || 'https://api.typesafe.ai/v1'),
  };
  const mode = pick('AGENT_MODE') || (provider === 'cloudflare' || systemOne.apiKey ? 'live' : 'demo');
  if (mode !== 'demo' && mode !== 'live') throw new Error('AGENT_MODE must be demo or live.');
  if (mode === 'live' && provider === 'cloudflare' && (!cloudflare.apiToken || !cloudflare.accountId)) throw new Error('Cloudflare 模式需要 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN；不会回退使用原厂密钥。');
  if (mode === 'live' && !systemOne.apiKey) throw new Error('Live mode requires SYSTEM_ONE_API_KEY (or TYPESAFE_API_KEY).');
  const port = Number(pick('PORT') || options.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  return {
    mode, port, systemOne, provider,
    dataDirectory: resolve(appDirectory, pick('AGENT_DATA_DIR') || 'data'),
    llm: provider === 'cloudflare' ? {
      apiKey: cloudflare.apiToken,
      model: pick('CLOUDFLARE_LLM_MODEL') || 'openai/gpt-4.1-mini',
      baseUrl: cfBase ? `${cfBase}/v1` : '',
    } : {
      apiKey: pick('LLM_API_KEY') ?? '',
      model: pick('LLM_MODEL') ?? '',
      baseUrl: apiBaseUrl(pick('LLM_BASE_URL') || 'https://api.openai.com/v1'),
    },
  };
}
