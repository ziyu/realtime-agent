import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

type Environment = Record<string, string | undefined>;

function workspaceRoot(appDirectory: string): string {
  let current = resolve(appDirectory);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot locate pnpm-workspace.yaml for this application.');
    current = parent;
  }
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

export function systemOneEndpoint(baseUrl = 'https://api.typesafe.ai/v1'): string {
  const base = apiBaseUrl(baseUrl);
  if (base.endsWith('/systemone')) return base;
  return new URL(base).pathname === '/' || new URL(base).pathname === '' ? `${base}/v1/systemone` : `${base}/systemone`;
}

export function chatCompletionEndpoint(baseUrl: string): string {
  const base = apiBaseUrl(baseUrl);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** DeepSeek uses max_tokens and defaults to extended reasoning. Request a bounded JSON reply for the interactive loop. */
export function chatCompletionOptions(baseUrl: string): Record<string, unknown> {
  if (new URL(apiBaseUrl(baseUrl)).hostname === 'api.deepseek.com') {
    return { max_tokens: 1400, thinking: { type: 'disabled' } };
  }
  return { max_completion_tokens: 1400 };
}

export interface RuntimeConfig {
  mode: 'demo' | 'live';
  port: number;
  dataDirectory: string;
  systemOne: { apiKey: string; model: string; baseUrl: string };
  llm: { apiKey: string; model: string; baseUrl: string };
}

export interface VoiceConfig {
  openaiKey: string;
  googleKey: string;
  xaiKey: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
  models: { openai: string; duplex: string; google: string; xai: string; backend: string };
}

/** Voice providers have separate credentials; a text-completions key is never reused. */
export function loadVoiceConfig(options: { appDirectory: string; environment?: Environment }): VoiceConfig {
  const appDirectory = resolve(options.appDirectory);
  const layers = [options.environment ?? process.env, readEnvironment(join(appDirectory, '.env')), readEnvironment(join(workspaceRoot(appDirectory), '.env'))];
  const pick = (...names: string[]) => {
    for (const layer of layers) for (const name of names) if (layer[name] !== undefined) return layer[name]!.trim();
    return '';
  };
  const url = pick('LIVEKIT_URL');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('LIVEKIT_URL must be a WebSocket URL.'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !(parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) {
      throw new Error('LIVEKIT_URL must use WSS, or WS on loopback, without embedded credentials.');
    }
  }
  return {
    openaiKey: pick('VOICE_OPENAI_API_KEY', 'OPENAI_API_KEY'),
    googleKey: pick('GEMINI_API_KEY', 'GOOGLE_API_KEY'),
    xaiKey: pick('XAI_API_KEY'),
    livekit: { url, apiKey: pick('LIVEKIT_API_KEY'), apiSecret: pick('LIVEKIT_API_SECRET') },
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
  const root = workspaceRoot(appDirectory);
  const layers = [options.environment ?? process.env, readEnvironment(join(appDirectory, '.env')), readEnvironment(join(root, '.env'))];
  const pick = (...names: string[]) => {
    for (const layer of layers) for (const name of names) {
      if (layer[name] !== undefined) return layer[name]!.trim();
    }
    return undefined;
  };
  const systemOne = {
    apiKey: pick('SYSTEM_ONE_API_KEY', 'TYPESAFE_API_KEY') ?? '',
    model: pick('SYSTEM_ONE_MODEL', 'TYPESAFE_MODEL', 'JEV_MODEL') || 'jev-latest',
    baseUrl: apiBaseUrl(pick('SYSTEM_ONE_BASE_URL', 'TYPESAFE_BASE_URL') || 'https://api.typesafe.ai/v1'),
  };
  const mode = pick('AGENT_MODE') || (systemOne.apiKey ? 'live' : 'demo');
  if (mode !== 'demo' && mode !== 'live') throw new Error('AGENT_MODE must be demo or live.');
  if (mode === 'live' && !systemOne.apiKey) throw new Error('Live mode requires SYSTEM_ONE_API_KEY (or TYPESAFE_API_KEY).');
  const port = Number(pick('PORT') || options.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  return {
    mode, port, systemOne,
    dataDirectory: resolve(appDirectory, pick('AGENT_DATA_DIR') || 'data'),
    llm: {
      apiKey: pick('LLM_API_KEY') ?? '',
      model: pick('LLM_MODEL') ?? '',
      baseUrl: apiBaseUrl(pick('LLM_BASE_URL') || 'https://api.openai.com/v1'),
    },
  };
}
